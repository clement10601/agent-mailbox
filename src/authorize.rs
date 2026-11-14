//! The consent page for claude.ai connectors. GET renders a form whose main field is a one-time binding code
//! (from admin_create_binding_code); the admin key plus an agent name is a fallback. POST checks lockout and CSRF,
//! then the credential, before looking at the agent; it completes the authorization and redirects back to the
//! client with a code. Only allowlisted redirect URIs are served.

use worker::{Request, Response};

use crate::auth::{admin_key_problem, client_ip, is_locked_out, record_auth_failure, AUTH_RETRY_AFTER_SECONDS};
use crate::crypto::{random_token, timing_safe_eq};
use crate::errors::{Error, ErrorCode, Result};
use crate::oauth::Provider;
use crate::store::{valid_name, AgentState, Store};

const CSRF_COOKIE: &str = "__Host-csrf";

/// Sent on every /authorize response. The page loads nothing external and must never be framed.
const SECURITY_HEADERS: &[(&str, &str)] = &[
    ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"),
    ("X-Frame-Options", "DENY"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
];

pub fn escape_html(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

pub fn respond(status: u16, body: Option<String>, extra: &[(&str, String)]) -> Result<Response> {
    let mut r = match body {
        Some(b) => Response::from_html(b)?,
        None => Response::empty()?,
    }
    .with_status(status);
    let h = r.headers_mut();
    for (k, v) in SECURITY_HEADERS {
        h.set(k, v)?;
    }
    for (k, v) in extra {
        h.set(k, v)?;
    }
    Ok(r)
}

fn shell(title: &str, inner: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{}</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}}
label{{display:block;margin-top:1rem;font-weight:600}}input{{width:100%;padding:.4rem;box-sizing:border-box}}
label.check{{font-weight:400}}label.check input{{width:auto;margin-right:.4rem}}
details{{margin-top:1.5rem}}summary{{cursor:pointer}}.hint{{font-size:.9rem}}
button{{margin-top:1.5rem;padding:.5rem 1rem}}.error{{color:#b00020}}.muted{{color:#555}}
</style></head><body>{}</body></html>"#,
        escape_html(title),
        inner
    )
}

pub fn error_page(status: u16, message: &str, extra: &[(&str, String)]) -> Result<Response> {
    respond(
        status,
        Some(shell("Authorization error", &format!("<h1>Authorization error</h1><p class=\"error\">{}</p>", escape_html(message)))),
        extra,
    )
}

/// The page shows nothing about existing agents: it is served before any credential is checked.
fn form_page(action: &str, csrf: &str, client_name: &str, error: Option<&str>) -> String {
    shell(
        "Authorize Agent Mailbox",
        &format!(
            r#"<h1>Connect to Agent Mailbox</h1>
<p class="muted"><strong>{}</strong> asks to act as one of your agents.</p>
{}
<form method="post" action="{}">
<input type="hidden" name="csrf" value="{}">
<label for="binding_code">Binding code</label>
<input id="binding_code" name="binding_code" type="password" autocomplete="off" placeholder="amb_…">
<p class="muted hint">Mint one with <code>admin_create_binding_code</code>. It picks the agent, works once and expires in minutes.</p>
<details>
<summary>Use the admin key instead</summary>
<label for="admin_key">Admin key</label>
<input id="admin_key" name="admin_key" type="password" autocomplete="current-password">
<label for="agent">Agent name</label>
<input id="agent" name="agent" type="text" autocomplete="off" placeholder="lowercase letters, digits, hyphen">
<label class="check"><input name="create" type="checkbox" value="1"> Create this agent if it doesn't exist</label>
</details>
<button type="submit">Authorize</button>
</form>"#,
            escape_html(client_name),
            error.map(|e| format!("<p class=\"error\">{}</p>", escape_html(e))).unwrap_or_default(),
            escape_html(action),
            escape_html(csrf),
        ),
    )
}

fn read_cookie(req: &Request, name: &str) -> Option<String> {
    let header = req.headers().get("Cookie").ok().flatten()?;
    header.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim() == name).then(|| v.trim().to_string())
    })
}

pub async fn handle(mut req: Request, admin_key: Option<String>, store: &Store, provider: &Provider, limiter: &worker::RateLimiter) -> Result<Response> {
    let method = req.method();
    if method != worker::Method::Get && method != worker::Method::Post {
        return respond(405, None, &[("Allow", "GET, POST".into())]);
    }
    let url = req.url()?;
    let auth_req = match provider.parse_auth_request(&url).await {
        Ok(a) => a,
        Err(msg) => return error_page(400, &msg, &[]),
    };
    if !store.config.oauth_redirect_allowlist.contains(&auth_req.redirect_uri) {
        return error_page(400, "This redirect URI is not allowed. Add it to OAUTH_REDIRECT_ALLOWLIST to permit it.", &[]);
    }
    let action = match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_string(),
    };
    let client_name = provider.client_name(&auth_req.client_id).await;
    let view = |csrf: &str, error: Option<&str>| form_page(&action, csrf, &client_name, error);

    if method == worker::Method::Get {
        let csrf = random_token();
        return respond(200, Some(view(&csrf, None)), &[("Set-Cookie", format!("{CSRF_COOKIE}={csrf}; Secure; HttpOnly; SameSite=Strict; Path=/"))]);
    }

    let too_many = || {
        error_page(429, "Too many failed attempts. Wait a minute and try again.", &[("Retry-After", AUTH_RETRY_AFTER_SECONDS.to_string())])
    };
    let ip = client_ip(&req);
    // Before the admin key is even looked at: a locked-out IP learns nothing, right key or wrong.
    if is_locked_out(&ip, store).await? {
        return too_many();
    }

    let text = req.text().await.unwrap_or_default();
    let form: std::collections::HashMap<String, String> = url::form_urlencoded::parse(text.as_bytes()).into_owned().collect();
    let field = |k: &str| form.get(k).cloned().unwrap_or_default();
    let cookie = read_cookie(&req, CSRF_COOKIE).unwrap_or_default();
    let token = field("csrf");
    if cookie.is_empty() || token.is_empty() || !timing_safe_eq(&cookie, &token) {
        return error_page(403, "The form expired or was not submitted from this page. Reload and try again.", &[]);
    }

    // Which agent, and whether a missing one may be created, comes from the binding code or the admin form.
    let code = field("binding_code").trim().to_string();
    let (agent_field, create, actor) = if !code.is_empty() {
        match store.redeem_binding_code(&code).await? {
            Some((agent, create)) => (agent, create, "binding_code"),
            None => {
                if !record_auth_failure(&ip, limiter, store).await? {
                    return too_many();
                }
                return respond(401, Some(view(&cookie, Some("This binding code is wrong, expired or already used."))), &[]);
            }
        }
    } else {
        if field("admin_key").is_empty() {
            return respond(400, Some(view(&cookie, Some("Enter a binding code, or the admin key and an agent name."))), &[]);
        }
        let key = match admin_key_problem(admin_key.as_deref()) {
            None => admin_key.unwrap_or_default(),
            Some(p) => {
                worker::console_error!("authorize: {p}; answering 500");
                return error_page(500, "The server is not configured.", &[]);
            }
        };
        if !timing_safe_eq(&field("admin_key"), &key) {
            if !record_auth_failure(&ip, limiter, store).await? {
                return too_many();
            }
            return respond(401, Some(view(&cookie, Some("Wrong admin key."))), &[]);
        }
        (field("agent"), field("create") == "1", "admin")
    };

    let agent = match valid_name(&agent_field) {
        Ok(a) => a,
        Err(Error::Mailbox(e)) if e.code == ErrorCode::InvalidInput => return respond(400, Some(view(&cookie, Some(&e.message))), &[]),
        Err(e) => return Err(e),
    };
    match store.agent_state(&agent).await? {
        Some(AgentState::Disabled) => {
            return respond(400, Some(view(&cookie, Some(&format!("Agent \"{agent}\" is disabled.")))), &[]);
        }
        None if !create => {
            return respond(400, Some(view(&cookie, Some(&format!("Agent \"{agent}\" not found.")))), &[]);
        }
        None => {
            // The key create_agent returns is deliberately dropped: this agent authenticates through OAuth.
            if let Err(e) = store.create_agent(&agent, "").await {
                if let Error::Mailbox(m) = &e {
                    if m.code == ErrorCode::InvalidInput {
                        return respond(400, Some(view(&cookie, Some(&m.message))), &[]);
                    }
                }
                return Err(e);
            }
        }
        Some(AgentState::Active) => {}
    }

    let redirect_to = provider.complete_authorization(&auth_req, &agent).await?;
    store.audit("oauth_granted", actor, Some(&agent), Some(&auth_req.client_id)).await?;
    respond(
        302,
        None,
        &[("Location", redirect_to), ("Set-Cookie", format!("{CSRF_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"))],
    )
}
