//! A minimal OAuth 2.1 authorization server for claude.ai custom connectors: protected-resource and
//! authorization-server metadata, dynamic client registration, authorization codes with PKCE (S256),
//! and rotating refresh tokens. All state lives in OAUTH_KV:
//!
//! - `client:<client_id>`                       registered client
//! - `grant:<agent>:<grant_id>`                 one authorization (expires with its refresh token)
//! - `token:<agent>:<grant_id>:<sha256(token)>` live access token (expires after an hour)
//!
//! Codes, access tokens and refresh tokens all look like `<agent>:<grant_id>:<secret>`; only their SHA-256
//! hashes are stored. The worker routes any Bearer value of that shape here (see `is_provider_token`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use worker::{Headers, KvStore, Request, Response};

use crate::crypto::{pkce_s256, random_token, sha256_hex, timing_safe_eq};
use crate::errors::{Error, Result};
use crate::store::now_ms;

pub const ACCESS_TOKEN_TTL_SECONDS: i64 = 3600;
pub const REFRESH_TOKEN_TTL_SECONDS: i64 = 30 * 86_400;
const CODE_TTL_MS: i64 = 10 * 60_000;

#[derive(Serialize, Deserialize, Clone)]
pub struct Client {
    pub client_id: String,
    pub redirect_uris: Vec<String>,
    #[serde(default)]
    pub client_name: Option<String>,
    pub token_endpoint_auth_method: String,
    #[serde(default)]
    pub client_secret_hash: Option<String>,
    pub client_id_issued_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Grant {
    pub id: String,
    pub agent: String,
    pub client_id: String,
    #[serde(default)]
    pub scope: Vec<String>,
    pub created_at: i64,
    #[serde(default)]
    pub code_hash: Option<String>,
    #[serde(default)]
    pub code_expires_at: Option<i64>,
    #[serde(default)]
    pub code_challenge: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
    #[serde(default)]
    pub refresh_hash: Option<String>,
}

/// A parsed, validated `/authorize` request.
pub struct AuthRequest {
    pub client_id: String,
    pub redirect_uri: String,
    pub state: Option<String>,
    pub scope: Vec<String>,
    pub code_challenge: String,
}

fn kv_err(e: worker::kv::KvError) -> Error {
    Error::internal(format!("kv: {e:?}"))
}

pub fn grant_key(agent: &str, grant_id: &str) -> String {
    format!("grant:{agent}:{grant_id}")
}

/// Splits `<agent>:<grant_id>:<secret>`.
pub fn split_token(t: &str) -> Option<(&str, &str, &str)> {
    let mut it = t.splitn(3, ':');
    let (a, g, s) = (it.next()?, it.next()?, it.next()?);
    if a.is_empty() || g.is_empty() || s.is_empty() || s.contains(':') {
        return None;
    }
    Some((a, g, s))
}

fn issue(agent: &str, grant_id: &str) -> String {
    format!("{agent}:{grant_id}:{}", random_token())
}

pub fn json_response(status: u16, body: &Json) -> Result<Response> {
    let mut r = Response::from_json(body)?.with_status(status);
    let h = r.headers_mut();
    h.set("Cache-Control", "no-store")?;
    h.set("Access-Control-Allow-Origin", "*")?;
    Ok(r)
}

fn oauth_error(status: u16, error: &str, description: &str) -> Result<Response> {
    json_response(status, &json!({ "error": error, "error_description": description }))
}

pub fn resource_metadata_url(origin: &str) -> String {
    format!("{origin}/.well-known/oauth-protected-resource/mcp")
}

/// 401 for /mcp without a usable token: tells the client where to discover OAuth.
pub fn challenge(origin: &str) -> Result<Response> {
    let mut r = Response::from_json(&json!({ "error": "invalid_token", "error_description": "Missing or invalid access token" }))?
        .with_status(401);
    r.headers_mut().set(
        "WWW-Authenticate",
        &format!(
            "Bearer realm=\"OAuth\", resource_metadata=\"{}\", error=\"invalid_token\", error_description=\"Missing or invalid access token\"",
            resource_metadata_url(origin)
        ),
    )?;
    Ok(r)
}

pub fn protected_resource_metadata(origin: &str) -> Json {
    json!({
        "resource": format!("{origin}/mcp"),
        "authorization_servers": [origin],
        "bearer_methods_supported": ["header"],
        "resource_name": "Agent Mailbox",
    })
}

pub fn authorization_server_metadata(origin: &str) -> Json {
    json!({
        "issuer": origin,
        "authorization_endpoint": format!("{origin}/authorize"),
        "token_endpoint": format!("{origin}/token"),
        "registration_endpoint": format!("{origin}/register"),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "code_challenge_methods_supported": ["S256"],
    })
}

pub fn cors_preflight() -> Result<Response> {
    let mut r = Response::empty()?.with_status(204);
    let h = r.headers_mut();
    h.set("Access-Control-Allow-Origin", "*")?;
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    h.set("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-protocol-version")?;
    h.set("Access-Control-Max-Age", "86400")?;
    Ok(r)
}

/// Redirect URIs must be absolute https URLs, or http on a loopback host.
fn acceptable_redirect(u: &str) -> bool {
    match url::Url::parse(u) {
        Ok(p) if p.fragment().is_none() => match p.scheme() {
            "https" => true,
            "http" => matches!(p.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]")),
            _ => false,
        },
        _ => false,
    }
}

pub struct Provider {
    kv: KvStore,
}

impl Provider {
    pub fn new(kv: KvStore) -> Self {
        Provider { kv }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>> {
        self.kv.get(key).json::<T>().await.map_err(kv_err)
    }

    async fn put<T: Serialize>(&self, key: &str, v: &T, ttl_seconds: Option<i64>) -> Result<()> {
        let mut b = self.kv.put(key, serde_json::to_string(v)?).map_err(kv_err)?;
        if let Some(t) = ttl_seconds {
            b = b.expiration_ttl(t.max(60) as u64);
        }
        b.execute().await.map_err(kv_err)
    }

    pub async fn lookup_client(&self, client_id: &str) -> Result<Option<Client>> {
        if client_id.is_empty() || client_id.contains(':') {
            return Ok(None);
        }
        self.get(&format!("client:{client_id}")).await
    }

    /// RFC 7591 dynamic client registration.
    pub async fn register(&self, req: &mut Request) -> Result<Response> {
        let body: Json = match req.json().await {
            Ok(b) => b,
            Err(_) => return oauth_error(400, "invalid_client_metadata", "Body must be JSON."),
        };
        let uris: Vec<String> = match body.get("redirect_uris").and_then(Json::as_array) {
            Some(a) if !a.is_empty() && a.len() <= 10 => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            _ => return oauth_error(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array."),
        };
        if uris.is_empty() || !uris.iter().all(|u| acceptable_redirect(u)) {
            return oauth_error(400, "invalid_redirect_uri", "Each redirect URI must be an absolute https URL.");
        }
        let method = body.get("token_endpoint_auth_method").and_then(Json::as_str).unwrap_or("client_secret_basic").to_string();
        if !matches!(method.as_str(), "none" | "client_secret_post" | "client_secret_basic") {
            return oauth_error(400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
        }
        let name = body.get("client_name").and_then(Json::as_str).map(|s| s.chars().take(100).collect::<String>());
        let client_id = random_token()[..22].to_string();
        let secret = (method != "none").then(random_token);
        let client = Client {
            client_id: client_id.clone(),
            redirect_uris: uris.clone(),
            client_name: name.clone(),
            token_endpoint_auth_method: method.clone(),
            client_secret_hash: secret.as_deref().map(sha256_hex),
            client_id_issued_at: now_ms() / 1000,
        };
        self.put(&format!("client:{client_id}"), &client, None).await?;
        let mut out = json!({
            "client_id": client_id,
            "redirect_uris": uris,
            "token_endpoint_auth_method": method,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "client_id_issued_at": client.client_id_issued_at,
        });
        if let Some(n) = name {
            out["client_name"] = json!(n);
        }
        if let Some(s) = secret {
            out["client_secret"] = json!(s);
            out["client_secret_expires_at"] = json!(0);
        }
        json_response(201, &out)
    }

    /// Parses and checks an /authorize query. Errors are shown as a page, never redirected.
    pub async fn parse_auth_request(&self, url: &url::Url) -> std::result::Result<AuthRequest, String> {
        let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
        let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
        if get("response_type") != "code" {
            return Err("response_type must be \"code\".".into());
        }
        let client = match self.lookup_client(get("client_id")).await {
            Ok(Some(c)) => c,
            Ok(None) => return Err("Unknown client.".into()),
            Err(e) => return Err(format!("{e}")),
        };
        let redirect = get("redirect_uri");
        let redirect = if redirect.is_empty() && client.redirect_uris.len() == 1 { client.redirect_uris[0].as_str() } else { redirect };
        if !client.redirect_uris.iter().any(|u| u == redirect) {
            return Err("redirect_uri is not registered for this client.".into());
        }
        let challenge = get("code_challenge");
        if challenge.is_empty() || get("code_challenge_method") != "S256" {
            return Err("PKCE with code_challenge_method=S256 is required.".into());
        }
        Ok(AuthRequest {
            client_id: client.client_id,
            redirect_uri: redirect.to_string(),
            state: q.get("state").cloned(),
            scope: get("scope").split(' ').filter(|s| !s.is_empty()).map(String::from).collect(),
            code_challenge: challenge.to_string(),
        })
    }

    pub async fn client_name(&self, client_id: &str) -> String {
        match self.lookup_client(client_id).await {
            Ok(Some(Client { client_name: Some(n), .. })) if !n.is_empty() => n,
            _ => client_id.to_string(),
        }
    }

    /// Creates the grant and returns the redirect URL carrying the code.
    pub async fn complete_authorization(&self, req: &AuthRequest, agent: &str) -> Result<String> {
        let grant_id = random_token()[..16].replace(['-', '_'], "x");
        let code = issue(agent, &grant_id);
        let now = now_ms();
        let grant = Grant {
            id: grant_id.clone(),
            agent: agent.to_string(),
            client_id: req.client_id.clone(),
            scope: req.scope.clone(),
            created_at: now,
            code_hash: Some(sha256_hex(&code)),
            code_expires_at: Some(now + CODE_TTL_MS),
            code_challenge: Some(req.code_challenge.clone()),
            redirect_uri: Some(req.redirect_uri.clone()),
            refresh_hash: None,
        };
        // An unexchanged grant disappears with its code.
        self.put(&grant_key(agent, &grant_id), &grant, Some(CODE_TTL_MS / 1000)).await?;
        let mut u = url::Url::parse(&req.redirect_uri).map_err(|e| Error::internal(e.to_string()))?;
        u.query_pairs_mut().append_pair("code", &code);
        if let Some(s) = &req.state {
            u.query_pairs_mut().append_pair("state", s);
        }
        Ok(u.to_string())
    }

    fn authenticate_client(client: &Client, form: &std::collections::HashMap<String, String>, headers: &Headers) -> bool {
        if client.token_endpoint_auth_method == "none" {
            return true;
        }
        let Some(hash) = &client.client_secret_hash else { return false };
        let mut secret = form.get("client_secret").cloned();
        if let Ok(Some(h)) = headers.get("Authorization") {
            if let Some(b) = h.strip_prefix("Basic ") {
                use base64::Engine;
                if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b.trim()) {
                    if let Ok(s) = String::from_utf8(raw) {
                        if let Some((id, sec)) = s.split_once(':') {
                            if id == client.client_id {
                                secret = Some(sec.to_string());
                            }
                        }
                    }
                }
            }
        }
        secret.map(|s| timing_safe_eq(&sha256_hex(&s), hash)).unwrap_or(false)
    }

    /// POST /token: authorization_code and refresh_token grants.
    pub async fn token(&self, req: &mut Request) -> Result<Response> {
        let text = req.text().await.unwrap_or_default();
        let form: std::collections::HashMap<String, String> = url::form_urlencoded::parse(text.as_bytes()).into_owned().collect();
        let get = |k: &str| form.get(k).map(String::as_str).unwrap_or("");
        let mut client_id = get("client_id").to_string();
        if client_id.is_empty() {
            if let Ok(Some(h)) = req.headers().get("Authorization") {
                if let Some(b) = h.strip_prefix("Basic ") {
                    use base64::Engine;
                    if let Some(id) = base64::engine::general_purpose::STANDARD
                        .decode(b.trim())
                        .ok()
                        .and_then(|r| String::from_utf8(r).ok())
                        .and_then(|s| s.split_once(':').map(|(i, _)| i.to_string()))
                    {
                        client_id = id;
                    }
                }
            }
        }
        let Some(client) = self.lookup_client(&client_id).await? else {
            return oauth_error(401, "invalid_client", "Unknown client.");
        };
        if !Self::authenticate_client(&client, &form, req.headers()) {
            return oauth_error(401, "invalid_client", "Client authentication failed.");
        }
        match get("grant_type") {
            "authorization_code" => self.exchange_code(&client, &form).await,
            "refresh_token" => self.refresh(&client, get("refresh_token")).await,
            _ => oauth_error(400, "unsupported_grant_type", "Use authorization_code or refresh_token."),
        }
    }

    async fn load_grant_for(&self, token: &str, client: &Client) -> Result<Option<Grant>> {
        let Some((agent, grant_id, _)) = split_token(token) else { return Ok(None) };
        Ok(self.get::<Grant>(&grant_key(agent, grant_id)).await?.filter(|g| g.client_id == client.client_id))
    }

    async fn exchange_code(&self, client: &Client, form: &std::collections::HashMap<String, String>) -> Result<Response> {
        let get = |k: &str| form.get(k).map(String::as_str).unwrap_or("");
        let code = get("code");
        let invalid = || oauth_error(400, "invalid_grant", "Invalid or expired authorization code.");
        let Some(mut grant) = self.load_grant_for(code, client).await? else { return invalid() };
        let fresh = grant.code_expires_at.map(|t| t > now_ms()).unwrap_or(false);
        let matches = grant.code_hash.as_deref().map(|h| timing_safe_eq(h, &sha256_hex(code))).unwrap_or(false);
        if !fresh || !matches {
            return invalid();
        }
        let redirect = get("redirect_uri");
        if !redirect.is_empty() && grant.redirect_uri.as_deref() != Some(redirect) {
            return oauth_error(400, "invalid_grant", "redirect_uri does not match the authorization request.");
        }
        let verifier = get("code_verifier");
        let pkce_ok = grant.code_challenge.as_deref().map(|c| !verifier.is_empty() && timing_safe_eq(&pkce_s256(verifier), c)).unwrap_or(false);
        if !pkce_ok {
            return oauth_error(400, "invalid_grant", "PKCE verification failed.");
        }
        // Codes are single use.
        grant.code_hash = None;
        grant.code_expires_at = None;
        grant.code_challenge = None;
        self.issue_tokens(grant).await
    }

    async fn refresh(&self, client: &Client, token: &str) -> Result<Response> {
        let invalid = || oauth_error(400, "invalid_grant", "Invalid refresh token.");
        let Some(grant) = self.load_grant_for(token, client).await? else { return invalid() };
        let ok = grant.refresh_hash.as_deref().map(|h| timing_safe_eq(h, &sha256_hex(token))).unwrap_or(false);
        if !ok {
            return invalid();
        }
        self.issue_tokens(grant).await
    }

    /// Issues a new access token and a rotated refresh token for `grant`.
    async fn issue_tokens(&self, mut grant: Grant) -> Result<Response> {
        let access = issue(&grant.agent, &grant.id);
        let refresh = issue(&grant.agent, &grant.id);
        grant.refresh_hash = Some(sha256_hex(&refresh));
        self.put(&grant_key(&grant.agent, &grant.id), &grant, Some(REFRESH_TOKEN_TTL_SECONDS)).await?;
        let exp = now_ms() + ACCESS_TOKEN_TTL_SECONDS * 1000;
        self.put(&format!("token:{}:{}:{}", grant.agent, grant.id, sha256_hex(&access)), &json!({ "exp": exp }), Some(ACCESS_TOKEN_TTL_SECONDS))
            .await?;
        json_response(
            200,
            &json!({
                "access_token": access,
                "token_type": "bearer",
                "expires_in": ACCESS_TOKEN_TTL_SECONDS,
                "refresh_token": refresh,
                "scope": grant.scope.join(" "),
            }),
        )
    }

    /// The agent an access token acts for, or None when it is unknown, expired or revoked.
    pub async fn validate_access_token(&self, token: &str) -> Result<Option<String>> {
        let Some((agent, grant_id, _)) = split_token(token) else { return Ok(None) };
        #[derive(Deserialize)]
        struct T {
            exp: i64,
        }
        let Some(t) = self.get::<T>(&format!("token:{agent}:{grant_id}:{}", sha256_hex(token))).await? else { return Ok(None) };
        if t.exp <= now_ms() {
            return Ok(None);
        }
        // Revoking a grant also kills its live tokens, even if a token row outlived the delete.
        if self.get::<Json>(&grant_key(agent, grant_id)).await?.is_none() {
            return Ok(None);
        }
        Ok(Some(agent.to_string()))
    }

    async fn list_keys(&self, prefix: &str) -> Result<Vec<String>> {
        let mut out = vec![];
        let mut cursor: Option<String> = None;
        loop {
            let mut b = self.kv.list().prefix(prefix.to_string());
            if let Some(c) = cursor.take() {
                b = b.cursor(c);
            }
            let page = b.execute().await.map_err(kv_err)?;
            out.extend(page.keys.into_iter().map(|k| k.name));
            if page.list_complete || page.cursor.is_none() {
                break;
            }
            cursor = page.cursor;
        }
        Ok(out)
    }

    /// Ids of an agent's grants that have been exchanged for tokens (pending codes are not grants yet).
    pub async fn grant_ids(&self, agent: &str) -> Result<Vec<String>> {
        let prefix = format!("grant:{agent}:");
        let mut ids = vec![];
        for k in self.list_keys(&prefix).await? {
            if let Some(g) = self.get::<Grant>(&k).await? {
                if g.refresh_hash.is_some() {
                    ids.push(g.id);
                }
            }
        }
        ids.sort();
        Ok(ids)
    }

    pub async fn revoke_grant(&self, agent: &str, grant_id: &str) -> Result<()> {
        self.kv.delete(&grant_key(agent, grant_id)).await.map_err(kv_err)?;
        for k in self.list_keys(&format!("token:{agent}:{grant_id}:")).await? {
            self.kv.delete(&k).await.map_err(kv_err)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape() {
        assert_eq!(split_token("alpha:g1:s3cret"), Some(("alpha", "g1", "s3cret")));
        assert_eq!(split_token("alpha:g1"), None);
        assert_eq!(split_token("alpha::s"), None);
        assert_eq!(split_token("a:b:c:d"), None);
    }

    #[test]
    fn redirect_rules() {
        assert!(acceptable_redirect("https://claude.ai/api/mcp/auth_callback"));
        assert!(acceptable_redirect("http://localhost:3000/cb"));
        assert!(!acceptable_redirect("http://evil.example/cb"));
        assert!(!acceptable_redirect("javascript:alert(1)"));
        assert!(!acceptable_redirect("https://a/cb#frag"));
    }
}
