use crate::errors::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedFeedback {
    Silent,
    Reject,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub delete_on_ack: bool,
    pub ttl_days: u32,
    pub max_unread: u32,
    pub audit_log_bodies: bool,
    pub blocked_sender_feedback: BlockedFeedback,
    pub oauth_redirect_allowlist: Vec<String>,
    /// Enforce plan limits (agents, monthly messages). Usage is counted either way.
    pub billing_enabled: bool,
    /// Where a human can upgrade the plan; included in quota_exceeded hints.
    pub billing_upgrade_url: Option<String>,
}

pub const DEFAULT_REDIRECT: &str = "https://claude.ai/api/mcp/auth_callback";

impl Default for Config {
    fn default() -> Self {
        Config {
            delete_on_ack: true,
            ttl_days: 7,
            max_unread: 10,
            audit_log_bodies: false,
            blocked_sender_feedback: BlockedFeedback::Silent,
            oauth_redirect_allowlist: vec![DEFAULT_REDIRECT.to_string()],
            billing_enabled: false,
            billing_upgrade_url: None,
        }
    }
}

fn raw(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

fn boolean(name: &str, v: Option<&str>, def: bool) -> Result<bool> {
    match raw(v) {
        None => Ok(def),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(s) => Err(Error::internal(format!("{name} must be \"true\" or \"false\", got \"{s}\""))),
    }
}

fn int(name: &str, v: Option<&str>, def: u32, min: u32) -> Result<u32> {
    match raw(v) {
        None => Ok(def),
        Some(s) => match s.parse::<u32>() {
            Ok(n) if s.bytes().all(|b| b.is_ascii_digit()) && n >= min => Ok(n),
            _ => Err(Error::internal(format!("{name} must be an integer >= {min}, got \"{s}\""))),
        },
    }
}

/// Parses the worker's `[vars]`. `get` returns a variable's value, or None when it is unset.
pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Config> {
    let feedback = get("BLOCKED_SENDER_FEEDBACK");
    let feedback = match raw(feedback.as_deref()).unwrap_or("silent") {
        "silent" => BlockedFeedback::Silent,
        "reject" => BlockedFeedback::Reject,
        other => {
            return Err(Error::internal(format!(
                "BLOCKED_SENDER_FEEDBACK must be \"silent\" or \"reject\", got \"{other}\""
            )))
        }
    };
    let allow = get("OAUTH_REDIRECT_ALLOWLIST");
    let allow: Vec<String> = raw(allow.as_deref())
        .unwrap_or(DEFAULT_REDIRECT)
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    Ok(Config {
        delete_on_ack: boolean("DELETE_ON_ACK", get("DELETE_ON_ACK").as_deref(), true)?,
        ttl_days: int("MESSAGE_TTL_DAYS", get("MESSAGE_TTL_DAYS").as_deref(), 7, 0)?,
        max_unread: int("MAX_UNREAD", get("MAX_UNREAD").as_deref(), 10, 1)?,
        audit_log_bodies: boolean("AUDIT_LOG_BODIES", get("AUDIT_LOG_BODIES").as_deref(), false)?,
        blocked_sender_feedback: feedback,
        oauth_redirect_allowlist: allow,
        billing_enabled: boolean("BILLING_ENABLED", get("BILLING_ENABLED").as_deref(), false)?,
        billing_upgrade_url: raw(get("BILLING_UPGRADE_URL").as_deref()).map(String::from),
    })
}

pub fn from_env(env: &worker::Env) -> Result<Config> {
    parse(|name| env.var(name).ok().map(|v| v.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Result<Config> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        parse(|k| m.get(k).cloned())
    }

    #[test]
    fn defaults_for_empty_vars() {
        assert_eq!(cfg(&[]).unwrap(), Config::default());
    }

    #[test]
    fn empty_strings_are_defaults() {
        assert_eq!(cfg(&[("DELETE_ON_ACK", ""), ("MAX_UNREAD", "  ")]).unwrap(), Config::default());
    }

    #[test]
    fn booleans() {
        assert!(!cfg(&[("DELETE_ON_ACK", "false")]).unwrap().delete_on_ack);
        assert!(cfg(&[("AUDIT_LOG_BODIES", "true")]).unwrap().audit_log_bodies);
        assert!(cfg(&[("DELETE_ON_ACK", "yes")]).is_err());
    }

    #[test]
    fn ttl_days() {
        assert_eq!(cfg(&[("MESSAGE_TTL_DAYS", "0")]).unwrap().ttl_days, 0);
        assert_eq!(cfg(&[("MESSAGE_TTL_DAYS", "30")]).unwrap().ttl_days, 30);
        assert!(cfg(&[("MESSAGE_TTL_DAYS", "-1")]).is_err());
        assert!(cfg(&[("MESSAGE_TTL_DAYS", "1.5")]).is_err());
    }

    #[test]
    fn max_unread_at_least_one() {
        assert!(cfg(&[("MAX_UNREAD", "0")]).is_err());
        assert_eq!(cfg(&[("MAX_UNREAD", "1")]).unwrap().max_unread, 1);
    }

    #[test]
    fn blocked_sender_feedback() {
        assert_eq!(cfg(&[("BLOCKED_SENDER_FEEDBACK", "reject")]).unwrap().blocked_sender_feedback, BlockedFeedback::Reject);
        assert!(cfg(&[("BLOCKED_SENDER_FEEDBACK", "loud")]).is_err());
    }

    #[test]
    fn billing() {
        let c = cfg(&[("BILLING_ENABLED", "true"), ("BILLING_UPGRADE_URL", " https://example.com/upgrade ")]).unwrap();
        assert!(c.billing_enabled);
        assert_eq!(c.billing_upgrade_url.as_deref(), Some("https://example.com/upgrade"));
        assert!(cfg(&[("BILLING_ENABLED", "1")]).is_err());
    }

    #[test]
    fn redirect_allowlist() {
        let c = cfg(&[("OAUTH_REDIRECT_ALLOWLIST", " https://a/cb , ,https://b/cb ")]).unwrap();
        assert_eq!(c.oauth_redirect_allowlist, vec!["https://a/cb", "https://b/cb"]);
    }
}
