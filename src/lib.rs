//! Agent Mailbox: a private, asynchronous mailbox for AI agents, served as an MCP server on Cloudflare Workers.

pub mod auth;
pub mod authorize;
pub mod config;
pub mod crypto;
pub mod errors;
pub mod mcp;
pub mod oauth;
pub mod store;
pub mod tools;

use serde_json::json;
use worker::{event, Context, Env, Request, Response, ScheduleContext, ScheduledEvent};

use auth::{activate, admin_key_problem, authenticate_bearer, bearer, client_ip, is_disabled_agent_credential, is_locked_out, record_auth_failure, Identity, AUTH_RETRY_AFTER_SECONDS};
use crypto::timing_safe_eq;
use errors::{Error, Result};
use oauth::Provider;
use store::Store;

fn json_status(status: u16, body: serde_json::Value) -> Result<Response> {
    Ok(Response::from_json(&body)?.with_status(status))
}

fn internal() -> Response {
    Response::from_json(&json!({ "error": "internal" })).map(|r| r.with_status(500)).unwrap_or_else(|_| Response::error("internal", 500).unwrap())
}

fn rate_limited() -> Result<Response> {
    let mut r = json_status(429, json!({ "error": "rate_limited", "retry_after": AUTH_RETRY_AFTER_SECONDS }))?;
    r.headers_mut().set("Retry-After", &AUTH_RETRY_AFTER_SECONDS.to_string())?;
    Ok(r)
}

fn admin_key(env: &Env) -> Option<String> {
    env.secret("ADMIN_KEY").ok().map(|s| s.to_string()).or_else(|| env.var("ADMIN_KEY").ok().map(|v| v.to_string()))
}

struct Deps {
    store: Store,
    oauth: Provider,
    auth_limiter: worker::RateLimiter,
    send_limiter: worker::RateLimiter,
    admin_key: Option<String>,
}

fn deps(env: &Env) -> Result<Deps> {
    Ok(Deps {
        store: Store::new(env.d1("DB")?, config::from_env(env)?),
        oauth: Provider::new(env.kv("OAUTH_KV")?),
        auth_limiter: env.rate_limiter("AUTH_LIMITER")?,
        send_limiter: env.rate_limiter("SEND_LIMITER")?,
        admin_key: admin_key(env),
    })
}

/// Tokens the OAuth provider issued look like `<agent>:<grant_id>:<secret>`. Static credentials (`amk_…` keys,
/// the admin key) and malformed headers stay on the Bearer path so its 401/429 and audit behaviour applies.
fn is_provider_token(header: &str, admin_key: Option<&str>) -> bool {
    let Some(t) = bearer(header) else { return false };
    if t.starts_with("amk_") || t.split(':').count() != 3 {
        return false;
    }
    // An admin key that happens to contain two colons must still take the Bearer path.
    !matches!(admin_key, Some(k) if admin_key_problem(Some(k)).is_none() && timing_safe_eq(t, k))
}

fn is_mcp_path(p: &str) -> bool {
    p == "/mcp" || p.starts_with("/mcp/")
}

/// Static Bearer credentials on /mcp. Failures are counted toward the per-IP lockout, except requests whose
/// valid key belongs to a disabled agent.
async fn bearer_identity(req: &Request, header: &str, d: &Deps) -> Result<std::result::Result<Identity, Response>> {
    if let Some(p) = admin_key_problem(d.admin_key.as_deref()) {
        worker::console_error!("auth: {p}; refusing to authenticate requests; answering 500");
        return Ok(Err(internal()));
    }
    let key = d.admin_key.as_deref().unwrap_or_default();
    let mut disabled = false;
    if let Some(id) = authenticate_bearer(header, key, &d.store).await? {
        if activate(&id, &d.store).await? {
            return Ok(Ok(id));
        }
        disabled = true;
    }
    if !disabled && !is_disabled_agent_credential(header, &d.store).await? && !record_auth_failure(&client_ip(req), &d.auth_limiter, &d.store).await? {
        return Ok(Err(rate_limited()?));
    }
    let mut r = json_status(401, json!({ "error": "unauthorized" }))?;
    r.headers_mut().set("WWW-Authenticate", "Bearer")?;
    Ok(Err(r))
}

/// OAuth access tokens on /mcp. Rejected tokens are never counted: they expire hourly and claude.ai
/// connectors share a few egress IPs, so counting them would lock every connector out.
async fn oauth_identity(header: &str, origin: &str, d: &Deps) -> Result<std::result::Result<Identity, Response>> {
    let token = bearer(header).unwrap_or_default();
    match d.oauth.validate_access_token(token).await? {
        Some(agent) => {
            let id = Identity::Agent(agent);
            if activate(&id, &d.store).await? {
                Ok(Ok(id))
            } else {
                Ok(Err(json_status(401, json!({ "error": "unauthorized" }))?))
            }
        }
        None => Ok(Err(oauth::challenge(origin)?)),
    }
}

async fn handle_mcp(req: Request, origin: &str, d: &Deps) -> Result<Response> {
    let Some(header) = req.headers().get("Authorization")? else {
        // No credentials: advertise OAuth discovery. Never counted, and no lockout check (nothing evaluated).
        return oauth::challenge(origin);
    };
    // Lockout comes before any credential is evaluated.
    if is_locked_out(&client_ip(&req), &d.store).await? {
        return rate_limited();
    }
    let resolved = if is_provider_token(&header, d.admin_key.as_deref()) {
        oauth_identity(&header, origin, d).await?
    } else {
        bearer_identity(&req, &header, d).await?
    };
    let identity = match resolved {
        Ok(i) => i,
        Err(resp) => return Ok(resp),
    };
    // Each session is bound to its creator; a mismatched or unknown session gets the transport's 404.
    let session = req.headers().get("mcp-session-id")?;
    if let Some(s) = &session {
        if !mcp::session_matches(&d.store, s, &identity).await? {
            return mcp::session_not_found();
        }
    }
    let cx = tools::Ctx { store: &d.store, oauth: &d.oauth, send_limiter: &d.send_limiter };
    mcp::handle(req, &identity, session, &cx).await
}

async fn route(mut req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let origin = url.origin().ascii_serialization();
    let path = url.path().to_string();
    let method = req.method();

    if method == worker::Method::Get && path == "/healthz" {
        return Ok(Response::ok("ok")?);
    }
    if method == worker::Method::Get && path == "/" {
        let mut res = Response::ok(include_str!("landing.html"))?;
        res.headers_mut().set("content-type", "text/html; charset=utf-8")?;
        return Ok(res);
    }
    let d = deps(env)?;
    if is_mcp_path(&path) {
        return handle_mcp(req, &origin, &d).await;
    }
    let discovery = matches!(
        path.as_str(),
        "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp" | "/.well-known/oauth-authorization-server" | "/register" | "/token"
    );
    if discovery && method == worker::Method::Options {
        return oauth::cors_preflight();
    }
    match (method, path.as_str()) {
        (worker::Method::Get, "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp") => {
            oauth::json_response(200, &oauth::protected_resource_metadata(&origin))
        }
        (worker::Method::Get, "/.well-known/oauth-authorization-server") => oauth::json_response(200, &oauth::authorization_server_metadata(&origin)),
        (worker::Method::Post, "/register") => d.oauth.register(&mut req).await,
        (worker::Method::Post, "/token") => d.oauth.token(&mut req).await,
        (_, "/authorize") => match authorize::handle(req, d.admin_key.clone(), &d.store, &d.oauth, &d.auth_limiter).await {
            Ok(r) => Ok(r),
            Err(e) => {
                worker::console_error!("authorize: internal error: {e}");
                authorize::respond(500, Some("Internal error".into()), &[])
            }
        },
        _ => Ok(Response::error("Not Found", 404)?),
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> worker::Result<Response> {
    match route(req, &env).await {
        Ok(r) => Ok(r),
        Err(Error::Mailbox(e)) => {
            worker::console_error!("unexpected mailbox error at top level: {:?}", e);
            Ok(internal())
        }
        Err(Error::Internal(m)) => {
            worker::console_error!("internal error: {m}");
            Ok(internal())
        }
    }
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let store = match env.d1("DB").map_err(Error::from).and_then(|db| Ok(Store::new(db, config::from_env(&env)?))) {
        Ok(s) => s,
        Err(e) => {
            worker::console_error!("cleanup: cannot start: {e}");
            return;
        }
    };
    let r = store.cleanup(5000).await;
    let failed = if r.failed.is_empty() { String::new() } else { format!("; failed: {}", r.failed.join(", ")) };
    worker::console_log!("cleanup: deleted {} messages, {} audit rows, {} sessions{}", r.messages, r.audit, r.sessions, failed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_token_routing() {
        assert!(is_provider_token("Bearer alpha:g:s", None));
        assert!(!is_provider_token("Bearer amk_x:y:z", None));
        assert!(!is_provider_token("Bearer a:b", None));
        let k = "a:b:cccccccccccccccccccccccccccccccc";
        assert!(!is_provider_token(&format!("Bearer {k}"), Some(k)));
    }

    #[test]
    fn mcp_paths() {
        assert!(is_mcp_path("/mcp"));
        assert!(is_mcp_path("/mcp/x"));
        assert!(!is_mcp_path("/mcpx"));
    }
}
