use worker::{RateLimiter, Request};

use crate::crypto::timing_safe_eq;
use crate::errors::Result;
use crate::store::Store;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    Admin,
    Agent(String),
}

impl Identity {
    /// Stable string form, used to bind MCP sessions to the identity that created them.
    pub fn principal(&self) -> String {
        match self {
            Identity::Admin => "admin".into(),
            Identity::Agent(a) => format!("agent:{a}"),
        }
    }
}

/// ADMIN_KEY values shorter than this are treated as unset.
pub const MIN_ADMIN_KEY_LENGTH: usize = 32;
pub const AUTH_RETRY_AFTER_SECONDS: u32 = 60;
/// Failed authentications per IP within the window after which every attempt from it gets 429.
pub const AUTH_FAILURE_LIMIT: i64 = 10;
pub const AUTH_FAILURE_WINDOW_MS: i64 = 60_000;

/// Why ADMIN_KEY cannot be used, or None when it is usable.
pub fn admin_key_problem(v: Option<&str>) -> Option<String> {
    match v {
        None | Some("") => Some("ADMIN_KEY secret is not set".into()),
        Some(k) if k.chars().count() < MIN_ADMIN_KEY_LENGTH => {
            Some(format!("ADMIN_KEY secret is shorter than {MIN_ADMIN_KEY_LENGTH} characters; set a long random value"))
        }
        _ => None,
    }
}

/// The token in `Authorization: Bearer <token>`, or None for a missing or malformed header.
pub fn bearer(header: &str) -> Option<&str> {
    let (scheme, rest) = header.split_once([' ', '\t'])?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim_matches([' ', '\t']);
    (!token.is_empty() && !token.contains(char::is_whitespace)).then_some(token)
}

/// `Bearer <ADMIN_KEY>` -> admin; `Bearer amk_…` -> the key's active, unrevoked agent; anything else -> None.
/// The caller has already checked that the admin key is usable.
pub async fn authenticate_bearer(header: &str, admin_key: &str, store: &Store) -> Result<Option<Identity>> {
    let Some(token) = bearer(header) else { return Ok(None) };
    if timing_safe_eq(token, admin_key) {
        return Ok(Some(Identity::Admin));
    }
    if token.starts_with("amk_") {
        if let Some(agent) = store.resolve_key(token).await? {
            return Ok(Some(Identity::Agent(agent)));
        }
    }
    Ok(None)
}

/// True when the header carries a valid `amk_` key whose agent is disabled: refused, but not a guess.
pub async fn is_disabled_agent_credential(header: &str, store: &Store) -> Result<bool> {
    match bearer(header) {
        Some(t) if t.starts_with("amk_") => store.is_disabled_agent_key(t).await,
        _ => Ok(false),
    }
}

/// Per-request check for a resolved identity: an agent must still exist and be enabled. Records activity.
pub async fn activate(identity: &Identity, store: &Store) -> Result<bool> {
    match identity {
        Identity::Admin => Ok(true),
        Identity::Agent(a) => {
            if !store.is_active(a).await? {
                return Ok(false);
            }
            store.touch(a).await?;
            Ok(true)
        }
    }
}

pub fn client_ip(req: &Request) -> String {
    req.headers().get("CF-Connecting-IP").ok().flatten().unwrap_or_else(|| "unknown".into())
}

/// Must run BEFORE any credential is evaluated: an IP with AUTH_FAILURE_LIMIT or more `auth_failed` rows in
/// the last minute is refused even with a correct key, so guessing cannot continue behind the 429.
pub async fn is_locked_out(ip: &str, store: &Store) -> Result<bool> {
    Ok(store.recent_auth_failures(ip, AUTH_FAILURE_WINDOW_MS).await? >= AUTH_FAILURE_LIMIT)
}

/// Counts a failed authentication against AUTH_LIMITER and writes an `auth_failed` audit row.
/// Returns false when the IP is over its limit: the caller must answer 429 (nothing is audited then).
pub async fn record_auth_failure(ip: &str, limiter: &RateLimiter, store: &Store) -> Result<bool> {
    let allowed = limiter.limit(ip.to_string()).await?.success;
    if allowed {
        store.audit("auth_failed", ip, None, None).await?;
    }
    Ok(allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_key_strength() {
        assert!(admin_key_problem(None).is_some());
        assert!(admin_key_problem(Some("")).is_some());
        assert!(admin_key_problem(Some(&"k".repeat(31))).unwrap().contains("shorter than 32"));
        assert!(admin_key_problem(Some(&"k".repeat(32))).is_none());
    }

    #[test]
    fn bearer_parsing() {
        assert_eq!(bearer("Bearer abc"), Some("abc"));
        assert_eq!(bearer("bearer \tabc  "), Some("abc"));
        assert_eq!(bearer("Basic abc"), None);
        assert_eq!(bearer("Bearer"), None);
        assert_eq!(bearer("Bearer a b"), None);
    }

    #[test]
    fn principals() {
        assert_eq!(Identity::Admin.principal(), "admin");
        assert_eq!(Identity::Agent("x".into()).principal(), "agent:x");
    }
}
