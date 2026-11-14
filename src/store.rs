//! Everything that touches D1. Times are milliseconds since the epoch, stored as INTEGER.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement};

use crate::config::{BlockedFeedback, Config};
use crate::crypto::{generate_binding_code, generate_key, new_id, sha256_hex};
use crate::errors::{Error, ErrorCode, Result};

const DAY_MS: i64 = 86_400_000;
const TOUCH_INTERVAL_MS: i64 = 60_000;
pub const MAX_SUBJECT_CHARS: usize = 200;
pub const MAX_BODY_BYTES: usize = 32_768;
pub const MAX_DATA_BYTES: usize = 65_536;
pub const MAX_ACK_IDS: usize = 50;
/// Lifetime of a DELETE_ON_ACK tombstone that has no expiry of its own (MESSAGE_TTL_DAYS=0).
const TOMBSTONE_TTL_MS: i64 = 7 * DAY_MS;
/// Bindings outlive any realistic MCP session; an expired binding makes the client re-initialize.
pub const SESSION_TTL_MS: i64 = 30 * DAY_MS;

/// A bind parameter.
pub enum P<'a> {
    S(&'a str),
    I(i64),
    Null,
}

impl From<&P<'_>> for JsValue {
    fn from(p: &P<'_>) -> JsValue {
        match p {
            P::S(s) => JsValue::from_str(s),
            P::I(n) => JsValue::from_f64(*n as f64),
            P::Null => JsValue::NULL,
        }
    }
}

fn opt<'a>(s: Option<&'a str>) -> P<'a> {
    s.map(P::S).unwrap_or(P::Null)
}

fn opt_i(n: Option<i64>) -> P<'static> {
    n.map(P::I).unwrap_or(P::Null)
}

pub fn iso(ms: i64) -> String {
    let d = js_sys::Date::new(&JsValue::from_f64(ms as f64));
    d.to_iso_string().into()
}

pub fn parse_iso(s: &str) -> Option<i64> {
    let ms = js_sys::Date::parse(s);
    if ms.is_nan() {
        None
    } else {
        Some(ms as i64)
    }
}

pub fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

pub fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

/// 1-32 chars of lowercase letters, digits and hyphen, starting with a letter or digit.
pub fn is_valid_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn valid_name(name: &str) -> Result<String> {
    let n = normalize_name(name);
    if !is_valid_name(&n) {
        return Err(Error::invalid(
            format!("Invalid agent name \"{n}\"."),
            "Use 1-32 chars: lowercase letters, digits, hyphen; must start with a letter or digit.",
        ));
    }
    Ok(n)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub reply_to: Option<String>,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub data: Option<Json>,
    pub sent_at: String,
}

#[derive(Deserialize)]
struct Row {
    id: String,
    thread_id: String,
    reply_to: Option<String>,
    from_agent: String,
    to_agent: String,
    subject: Option<String>,
    body: Option<String>,
    data: Option<String>,
    created_at: f64,
}

const COLS: &str = "id, thread_id, reply_to, from_agent, to_agent, subject, body, data, created_at";

impl Row {
    fn into_message(self) -> Message {
        Message {
            id: self.id,
            thread_id: self.thread_id,
            reply_to: self.reply_to,
            from: self.from_agent,
            to: self.to_agent,
            subject: self.subject.unwrap_or_default(),
            body: self.body.unwrap_or_default(),
            data: self.data.and_then(|d| serde_json::from_str(&d).ok()),
            sent_at: iso(self.created_at as i64),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub description: String,
    pub unread: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentListing {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize)]
pub struct AdminAgent {
    pub name: String,
    pub description: String,
    pub disabled: bool,
    pub unread: i64,
    pub last_seen_at: Option<String>,
    pub active_keys: i64,
}

#[derive(Debug, Serialize)]
pub struct AuditEntry {
    pub ts: String,
    pub event: String,
    pub actor: Option<String>,
    pub target: Option<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Failed {
    pub agent: String,
    pub code: ErrorCode,
}

#[derive(Debug, Serialize)]
pub struct SendResult {
    pub id: String,
    pub thread_id: String,
    pub delivered: Vec<String>,
    pub failed: Vec<Failed>,
}

#[derive(Debug, Serialize)]
pub struct AckFailed {
    pub id: String,
    pub code: ErrorCode,
}

#[derive(Debug, Serialize)]
pub struct AckResult {
    pub acked: Vec<String>,
    pub failed: Vec<AckFailed>,
}

#[derive(Debug, Serialize)]
pub struct CleanupResult {
    pub messages: usize,
    pub audit: usize,
    pub sessions: usize,
    pub binding_codes: usize,
    pub failed: Vec<String>,
}

pub struct SendInput {
    pub to: String,
    pub subject: String,
    pub body: String,
    pub data: Option<Json>,
    pub reply_to: Option<String>,
}

pub enum AgentState {
    Active,
    Disabled,
}

pub struct Store {
    db: D1Database,
    pub config: Config,
}

#[derive(Deserialize)]
struct N {
    n: f64,
}

impl Store {
    pub fn new(db: D1Database, config: Config) -> Self {
        Store { db, config }
    }

    fn stmt(&self, sql: &str, params: &[P]) -> Result<D1PreparedStatement> {
        let vals: Vec<JsValue> = params.iter().map(JsValue::from).collect();
        Ok(self.db.prepare(sql).bind(&vals)?)
    }

    async fn first<T: for<'de> Deserialize<'de>>(&self, sql: &str, params: &[P<'_>]) -> Result<Option<T>> {
        Ok(self.stmt(sql, params)?.first::<T>(None).await?)
    }

    async fn exists(&self, sql: &str, params: &[P<'_>]) -> Result<bool> {
        Ok(self.first::<Json>(sql, params).await?.is_some())
    }

    async fn all<T: for<'de> Deserialize<'de>>(&self, sql: &str, params: &[P<'_>]) -> Result<Vec<T>> {
        Ok(self.stmt(sql, params)?.all().await?.results::<T>()?)
    }

    async fn run(&self, sql: &str, params: &[P<'_>]) -> Result<usize> {
        let r = self.stmt(sql, params)?.run().await?;
        Ok(r.meta()?.and_then(|m| m.changes).unwrap_or(0))
    }

    async fn count(&self, sql: &str, params: &[P<'_>]) -> Result<i64> {
        Ok(self.first::<N>(sql, params).await?.map(|r| r.n as i64).unwrap_or(0))
    }

    fn expiry(&self, now: i64) -> Option<i64> {
        (self.config.ttl_days > 0).then(|| now + self.config.ttl_days as i64 * DAY_MS)
    }

    // ---- audit ----

    fn audit_stmt(
        &self,
        event: &str,
        actor: &str,
        target: Option<&str>,
        subject: Option<&str>,
        body: Option<&str>,
    ) -> Result<D1PreparedStatement> {
        let ts = now_ms();
        let body = if self.config.audit_log_bodies { body } else { None };
        self.stmt(
            "INSERT INTO audit_log (ts, event, actor, target, subject, body, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[P::I(ts), P::S(event), P::S(actor), opt(target), opt(subject), opt(body), opt_i(self.expiry(ts))],
        )
    }

    pub async fn audit(&self, event: &str, actor: &str, target: Option<&str>, subject: Option<&str>) -> Result<()> {
        self.audit_stmt(event, actor, target, subject, None)?.run().await?;
        Ok(())
    }

    pub async fn audit_log(&self, since: Option<i64>, agent: Option<&str>, limit: i64) -> Result<Vec<AuditEntry>> {
        let mut sql = String::from("SELECT ts, event, actor, target, subject, body FROM audit_log");
        let mut wh: Vec<&str> = vec![];
        let like;
        let mut params: Vec<P> = vec![];
        if let Some(s) = since {
            wh.push("ts >= ?");
            params.push(P::I(s));
        }
        if let Some(a) = agent {
            // target may be a comma-joined list of recipients; match whole names only.
            wh.push("(actor = ? OR target = ? OR ',' || target || ',' LIKE ? ESCAPE '\\')");
            let esc: String = a.chars().flat_map(|c| if "\\%_".contains(c) { vec!['\\', c] } else { vec![c] }).collect();
            like = format!("%,{esc},%");
            params.extend([P::S(a), P::S(a), P::S(&like)]);
        }
        if !wh.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wh.join(" AND "));
        }
        sql.push_str(" ORDER BY ts DESC, id DESC LIMIT ?");
        params.push(P::I(limit));
        #[derive(Deserialize)]
        struct R {
            ts: f64,
            event: String,
            actor: Option<String>,
            target: Option<String>,
            subject: Option<String>,
            body: Option<String>,
        }
        let rows: Vec<R> = self.all(&sql, &params).await?;
        Ok(rows
            .into_iter()
            .map(|r| AuditEntry { ts: iso(r.ts as i64), event: r.event, actor: r.actor, target: r.target, subject: r.subject, body: r.body })
            .collect())
    }

    /// Number of `auth_failed` rows for `ip` in the last `window_ms`.
    pub async fn recent_auth_failures(&self, ip: &str, window_ms: i64) -> Result<i64> {
        self.count(
            "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'auth_failed' AND actor = ? AND ts >= ?",
            &[P::S(ip), P::I(now_ms() - window_ms)],
        )
        .await
    }

    // ---- agents & keys ----

    async fn require_agent(&self, name: &str) -> Result<String> {
        let n = normalize_name(name);
        if !self.exists("SELECT 1 AS x FROM agents WHERE name = ?", &[P::S(&n)]).await? {
            return Err(Error::new(ErrorCode::NotFound, format!("Agent \"{n}\" does not exist."), "Check the name with admin_list_agents."));
        }
        Ok(n)
    }

    /// Creates an agent with a first key. Returns (name, key, key_id).
    pub async fn create_agent(&self, name: &str, description: &str) -> Result<(String, String, String)> {
        let n = valid_name(name)?;
        let dup = || Error::invalid(format!("Agent \"{n}\" already exists."), "Use admin_issue_key to issue another key for it.");
        if self.exists("SELECT 1 AS x FROM agents WHERE name = ?", &[P::S(&n)]).await? {
            return Err(dup());
        }
        let key = generate_key();
        let key_id = new_id();
        let hash = sha256_hex(&key);
        let now = now_ms();
        let batch = vec![
            self.stmt("INSERT INTO agents (name, description, created_at) VALUES (?, ?, ?)", &[P::S(&n), P::S(description), P::I(now)])?,
            self.stmt(
                "INSERT INTO keys (id, agent_name, key_hash, created_at) VALUES (?, ?, ?, ?)",
                &[P::S(&key_id), P::S(&n), P::S(&hash), P::I(now)],
            )?,
        ];
        if let Err(e) = self.db.batch(batch).await {
            let s = e.to_string();
            // Lost a creation race on the primary key.
            if s.contains("UNIQUE") || s.contains("constraint") {
                return Err(dup());
            }
            return Err(e.into());
        }
        self.audit("agent_created", "admin", Some(&n), None).await?;
        Ok((n, key, key_id))
    }

    pub async fn issue_key(&self, name: &str) -> Result<(String, String)> {
        let n = self.require_agent(name).await?;
        let key = generate_key();
        let key_id = new_id();
        self.run(
            "INSERT INTO keys (id, agent_name, key_hash, created_at) VALUES (?, ?, ?, ?)",
            &[P::S(&key_id), P::S(&n), P::S(&sha256_hex(&key)), P::I(now_ms())],
        )
        .await?;
        self.audit("key_issued", "admin", Some(&n), Some(&key_id)).await?;
        Ok((key, key_id))
    }

    pub async fn revoke_key(&self, key_id: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct R {
            agent_name: String,
        }
        let Some(row) = self.first::<R>("SELECT agent_name FROM keys WHERE id = ?", &[P::S(key_id)]).await? else {
            return Err(Error::new(ErrorCode::NotFound, format!("Key \"{key_id}\" does not exist."), "List keys with admin_list_agents."));
        };
        self.run("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", &[P::I(now_ms()), P::S(key_id)]).await?;
        self.audit("key_revoked", "admin", Some(&row.agent_name), Some(key_id)).await
    }

    pub async fn set_disabled(&self, name: &str, disabled: bool) -> Result<()> {
        let n = self.require_agent(name).await?;
        self.run("UPDATE agents SET disabled = ? WHERE name = ?", &[P::I(disabled as i64), P::S(&n)]).await?;
        self.audit(if disabled { "agent_disabled" } else { "agent_enabled" }, "admin", Some(&n), None).await
    }

    /// The agent an active, unrevoked key belongs to.
    pub async fn resolve_key(&self, raw: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct R {
            name: String,
        }
        Ok(self
            .first::<R>(
                "SELECT k.agent_name AS name FROM keys k JOIN agents a ON a.name = k.agent_name
                 WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.disabled = 0",
                &[P::S(&sha256_hex(raw))],
            )
            .await?
            .map(|r| r.name))
    }

    /// True when `raw` is an issued, unrevoked key whose agent is disabled.
    pub async fn is_disabled_agent_key(&self, raw: &str) -> Result<bool> {
        self.exists(
            "SELECT 1 AS x FROM keys k JOIN agents a ON a.name = k.agent_name
             WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.disabled = 1",
            &[P::S(&sha256_hex(raw))],
        )
        .await
    }

    pub async fn is_active(&self, name: &str) -> Result<bool> {
        self.exists("SELECT 1 AS x FROM agents WHERE name = ? AND disabled = 0", &[P::S(&normalize_name(name))]).await
    }

    pub async fn agent_state(&self, name: &str) -> Result<Option<AgentState>> {
        #[derive(Deserialize)]
        struct R {
            disabled: f64,
        }
        Ok(self
            .first::<R>("SELECT disabled FROM agents WHERE name = ?", &[P::S(&normalize_name(name))])
            .await?
            .map(|r| if r.disabled == 0.0 { AgentState::Active } else { AgentState::Disabled }))
    }

    /// Records activity, at most once per minute per agent.
    pub async fn touch(&self, name: &str) -> Result<()> {
        let now = now_ms();
        self.run(
            "UPDATE agents SET last_seen_at = ? WHERE name = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
            &[P::I(now), P::S(&normalize_name(name)), P::I(now - TOUCH_INTERVAL_MS)],
        )
        .await?;
        Ok(())
    }

    pub async fn list_agents(&self) -> Result<Vec<AgentListing>> {
        self.all("SELECT name, description FROM agents WHERE disabled = 0 ORDER BY name", &[]).await
    }

    pub async fn admin_list_agents(&self) -> Result<Vec<AdminAgent>> {
        #[derive(Deserialize)]
        struct R {
            name: String,
            description: String,
            disabled: f64,
            last_seen_at: Option<f64>,
            unread: f64,
            active_keys: f64,
        }
        let rows: Vec<R> = self
            .all(
                "SELECT a.name, a.description, a.disabled, a.last_seen_at,
                  (SELECT COUNT(*) FROM messages m WHERE m.to_agent = a.name AND m.acked_at IS NULL AND m.suppressed = 0
                     AND (m.expires_at IS NULL OR m.expires_at > ?)) AS unread,
                  (SELECT COUNT(*) FROM keys k WHERE k.agent_name = a.name AND k.revoked_at IS NULL) AS active_keys
                 FROM agents a ORDER BY a.name",
                &[P::I(now_ms())],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| AdminAgent {
                name: r.name,
                description: r.description,
                disabled: r.disabled != 0.0,
                unread: r.unread as i64,
                last_seen_at: r.last_seen_at.map(|t| iso(t as i64)),
                active_keys: r.active_keys as i64,
            })
            .collect())
    }

    pub async fn get_profile(&self, name: &str) -> Result<Profile> {
        let n = normalize_name(name);
        #[derive(Deserialize)]
        struct R {
            name: String,
            description: String,
            unread: f64,
        }
        let row = self
            .first::<R>(
                "SELECT a.name, a.description,
                  (SELECT COUNT(*) FROM messages m WHERE m.to_agent = a.name AND m.acked_at IS NULL AND m.suppressed = 0
                     AND (m.expires_at IS NULL OR m.expires_at > ?)) AS unread
                 FROM agents a WHERE a.name = ?",
                &[P::I(now_ms()), P::S(&n)],
            )
            .await?;
        match row {
            Some(r) => Ok(Profile { name: r.name, description: r.description, unread: r.unread as i64 }),
            None => Err(Error::new(ErrorCode::NotFound, format!("Agent \"{n}\" does not exist."), "Check the name with list_agents.")),
        }
    }

    pub async fn update_profile(&self, name: &str, description: &str) -> Result<()> {
        let n = self.require_agent(name).await?;
        self.run("UPDATE agents SET description = ? WHERE name = ?", &[P::S(description), P::S(&n)]).await?;
        Ok(())
    }

    // ---- messages ----

    pub async fn send(&self, from_raw: &str, input: SendInput) -> Result<SendResult> {
        let from = normalize_name(from_raw);
        let data_json = validate_send(&input)?;
        let to = normalize_name(&input.to);
        let broadcast = to == "all";
        if !broadcast {
            valid_name(&to)?;
        }
        let now = now_ms();
        let mut thread_id = new_id();
        let mut reply_to: Option<String> = None;
        if let Some(r) = input.reply_to.as_deref().filter(|r| !r.is_empty()) {
            #[derive(Deserialize)]
            struct R {
                thread_id: String,
            }
            let found = self
                .first::<R>(
                    "SELECT thread_id FROM messages WHERE id = ? AND (from_agent = ? OR (to_agent = ? AND suppressed = 0))
                     AND (expires_at IS NULL OR expires_at > ?)",
                    &[P::S(r), P::S(&from), P::S(&from), P::I(now)],
                )
                .await?;
            let Some(found) = found else {
                return Err(Error::new(
                    ErrorCode::InvalidReplyTo,
                    "reply_to does not refer to a message you sent or received that still exists.",
                    "Use the id of a message from check_inbox or read_thread.",
                ));
            };
            thread_id = found.thread_id;
            reply_to = Some(r.to_string());
        }

        let recipients: Vec<String> = if broadcast {
            self.all::<AgentListing>("SELECT name, '' AS description FROM agents WHERE disabled = 0 AND name != ? ORDER BY name", &[P::S(&from)])
                .await?
                .into_iter()
                .map(|r| r.name)
                .collect()
        } else {
            vec![to]
        };

        let expires_at = self.expiry(now);
        let mut delivered: Vec<String> = vec![];
        let mut failed: Vec<Failed> = vec![];
        let mut stmts: Vec<D1PreparedStatement> = vec![];
        let mut first_id: Option<String> = None;

        for r in recipients {
            if !self.exists("SELECT 1 AS x FROM agents WHERE name = ? AND disabled = 0", &[P::S(&r)]).await? {
                failed.push(Failed { agent: r, code: ErrorCode::UnknownRecipient });
                continue;
            }
            let mut suppressed = 0i64;
            if self.exists("SELECT 1 AS x FROM blocks WHERE agent_name = ? AND blocked_sender = ?", &[P::S(&r), P::S(&from)]).await? {
                if self.config.blocked_sender_feedback == BlockedFeedback::Reject {
                    failed.push(Failed { agent: r, code: ErrorCode::Blocked });
                    continue;
                }
                suppressed = 1; // silent: real row, invisible to the recipient
            }
            // Fullness is the recipient's visible unread. A silently blocked sender also counts its own live
            // suppressed rows to this recipient, so it hits inbox_full exactly when it would if its mail were
            // visible (otherwise "never inbox_full" would reveal the block).
            let unread = self
                .count(
                    "SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND acked_at IS NULL
                     AND (suppressed = 0 OR (? = 1 AND from_agent = ?)) AND (expires_at IS NULL OR expires_at > ?)",
                    &[P::S(&r), P::I(suppressed), P::S(&from), P::I(now)],
                )
                .await?;
            if unread >= self.config.max_unread as i64 {
                failed.push(Failed { agent: r, code: ErrorCode::InboxFull });
                continue;
            }
            let id = new_id();
            first_id.get_or_insert_with(|| id.clone());
            stmts.push(self.stmt(
                "INSERT INTO messages (id, thread_id, reply_to, from_agent, to_agent, subject, body, data, created_at, expires_at, suppressed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    P::S(&id),
                    P::S(&thread_id),
                    opt(reply_to.as_deref()),
                    P::S(&from),
                    P::S(&r),
                    P::S(&input.subject),
                    P::S(&input.body),
                    opt(data_json.as_deref()),
                    P::I(now),
                    opt_i(expires_at),
                    P::I(suppressed),
                ],
            )?);
            delivered.push(r);
        }
        let joined = delivered.join(",");
        stmts.push(self.audit_stmt(
            "send",
            &from,
            (!delivered.is_empty()).then_some(joined.as_str()),
            Some(&input.subject),
            Some(&input.body),
        )?);
        self.db.batch(stmts).await?;
        Ok(SendResult { id: first_id.unwrap_or_else(new_id), thread_id, delivered, failed })
    }

    pub async fn inbox(&self, agent: &str, limit: Option<i64>) -> Result<Vec<Message>> {
        let max = self.config.max_unread as i64;
        let lim = limit.unwrap_or(max).clamp(1, max);
        let rows: Vec<Row> = self
            .all(
                &format!(
                    "SELECT {COLS} FROM messages WHERE to_agent = ? AND acked_at IS NULL AND suppressed = 0
                     AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid LIMIT ?"
                ),
                &[P::S(&normalize_name(agent)), P::I(now_ms()), P::I(lim)],
            )
            .await?;
        Ok(rows.into_iter().map(Row::into_message).collect())
    }

    pub async fn ack(&self, agent: &str, ids: &[String]) -> Result<AckResult> {
        if ids.len() > MAX_ACK_IDS {
            return Err(Error::invalid(format!("Cannot ack more than {MAX_ACK_IDS} ids at once."), "Split the ids into several calls."));
        }
        let me = normalize_name(agent);
        let now = now_ms();
        let mut acked = vec![];
        let mut failed = vec![];
        let mut stmts = vec![];
        let mut seen = std::collections::HashSet::new();
        #[derive(Deserialize)]
        struct R {
            acked_at: Option<f64>,
        }
        for id in ids.iter().filter(|i| seen.insert(i.as_str())) {
            let row = self
                .first::<R>(
                    "SELECT acked_at FROM messages WHERE id = ? AND to_agent = ? AND suppressed = 0 AND (expires_at IS NULL OR expires_at > ?)",
                    &[P::S(id), P::S(&me), P::I(now)],
                )
                .await?;
            let Some(row) = row else {
                failed.push(AckFailed { id: id.clone(), code: ErrorCode::NotFound });
                continue;
            };
            acked.push(id.clone());
            if row.acked_at.is_some() {
                continue; // already acked: idempotent
            }
            // A tombstone keeps the message's own expiry; under MESSAGE_TTL_DAYS=0 (NULL expiry) it gets
            // TOMBSTONE_TTL_MS so metadata is not kept forever.
            stmts.push(if self.config.delete_on_ack {
                self.stmt(
                    "UPDATE messages SET subject = NULL, body = NULL, data = NULL, acked_at = ?, expires_at = COALESCE(expires_at, ?)
                     WHERE id = ? AND to_agent = ? AND acked_at IS NULL",
                    &[P::I(now), P::I(now + TOMBSTONE_TTL_MS), P::S(id), P::S(&me)],
                )?
            } else {
                self.stmt("UPDATE messages SET acked_at = ? WHERE id = ? AND to_agent = ? AND acked_at IS NULL", &[P::I(now), P::S(id), P::S(&me)])?
            });
        }
        let joined = acked.join(",");
        stmts.push(self.audit_stmt("ack", &me, (!acked.is_empty()).then_some(joined.as_str()), None, None)?);
        self.db.batch(stmts).await?;
        Ok(AckResult { acked, failed })
    }

    pub async fn thread(&self, agent: &str, thread_id: &str) -> Result<Vec<Message>> {
        let me = normalize_name(agent);
        let rows: Vec<Row> = self
            .all(
                &format!(
                    "SELECT {COLS} FROM messages WHERE thread_id = ? AND (from_agent = ? OR (to_agent = ? AND suppressed = 0))
                     AND body IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid"
                ),
                &[P::S(thread_id), P::S(&me), P::S(&me), P::I(now_ms())],
            )
            .await?;
        Ok(rows.into_iter().map(Row::into_message).collect())
    }

    // ---- blocks ----

    pub async fn block(&self, agent: &str, sender: &str) -> Result<()> {
        let me = normalize_name(agent);
        let s = valid_name(sender)?;
        self.run(
            "INSERT OR IGNORE INTO blocks (agent_name, blocked_sender, created_at) VALUES (?, ?, ?)",
            &[P::S(&me), P::S(&s), P::I(now_ms())],
        )
        .await?;
        self.audit("block", &me, Some(&s), None).await
    }

    pub async fn unblock(&self, agent: &str, sender: &str) -> Result<()> {
        let me = normalize_name(agent);
        let s = normalize_name(sender);
        self.run("DELETE FROM blocks WHERE agent_name = ? AND blocked_sender = ?", &[P::S(&me), P::S(&s)]).await?;
        self.audit("unblock", &me, Some(&s), None).await
    }

    pub async fn list_blocked(&self, agent: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct R {
            blocked_sender: String,
        }
        Ok(self
            .all::<R>("SELECT blocked_sender FROM blocks WHERE agent_name = ? ORDER BY blocked_sender", &[P::S(&normalize_name(agent))])
            .await?
            .into_iter()
            .map(|r| r.blocked_sender)
            .collect())
    }

    // ---- MCP sessions ----

    /// Records which principal created a session. An existing binding is never overwritten.
    pub async fn bind_session(&self, id: &str, principal: &str) -> Result<()> {
        let now = now_ms();
        self.run(
            "INSERT OR IGNORE INTO mcp_sessions (id, principal, created_at, expires_at) VALUES (?, ?, ?, ?)",
            &[P::S(id), P::S(principal), P::I(now), P::I(now + SESSION_TTL_MS)],
        )
        .await?;
        Ok(())
    }

    pub async fn session_principal(&self, id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct R {
            principal: String,
        }
        Ok(self
            .first::<R>("SELECT principal FROM mcp_sessions WHERE id = ? AND expires_at > ?", &[P::S(id), P::I(now_ms())])
            .await?
            .map(|r| r.principal))
    }

    pub async fn delete_session(&self, id: &str) -> Result<()> {
        self.run("DELETE FROM mcp_sessions WHERE id = ?", &[P::S(id)]).await?;
        Ok(())
    }

    // ---- binding codes ----

    /// Mints a one-time code that binds an OAuth connector to `name`. With `create`, a missing agent is created
    /// when the code is redeemed (not now, so an unused code leaves no agent behind). Returns (code, agent, expires_at).
    pub async fn create_binding_code(&self, name: &str, create: bool, ttl_ms: i64) -> Result<(String, String, i64)> {
        let n = valid_name(name)?;
        match self.agent_state(&n).await? {
            Some(AgentState::Disabled) => {
                return Err(Error::invalid(format!("Agent \"{n}\" is disabled."), "Re-enable it with admin_enable_agent first."));
            }
            None if !create => {
                return Err(Error::new(
                    ErrorCode::NotFound,
                    format!("Agent \"{n}\" not found."),
                    "Pass create: true to create it when the code is used.",
                ));
            }
            _ => {}
        }
        let code = generate_binding_code();
        let now = now_ms();
        let expires_at = now + ttl_ms;
        self.run(
            "INSERT INTO binding_codes (code_hash, agent_name, create_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            &[P::S(&sha256_hex(&code)), P::S(&n), P::I(create as i64), P::I(now), P::I(expires_at)],
        )
        .await?;
        self.audit("binding_code_created", "admin", Some(&n), None).await?;
        Ok((code, n, expires_at))
    }

    /// Consumes a binding code: the row is deleted whether or not it is still valid, so a code works at most once
    /// even under concurrent use. Returns (agent, create) for an unexpired code, None otherwise.
    pub async fn redeem_binding_code(&self, code: &str) -> Result<Option<(String, bool)>> {
        if !code.starts_with("amb_") {
            return Ok(None);
        }
        #[derive(Deserialize)]
        struct R {
            agent_name: String,
            create_agent: f64,
            expires_at: f64,
        }
        let row = self
            .first::<R>(
                "DELETE FROM binding_codes WHERE code_hash = ? RETURNING agent_name, create_agent, expires_at",
                &[P::S(&sha256_hex(code))],
            )
            .await?;
        Ok(row.filter(|r| (r.expires_at as i64) > now_ms()).map(|r| (r.agent_name, r.create_agent != 0.0)))
    }

    // ---- cleanup ----

    /// Deletes rows whose expires_at has passed (at most `batch` per table). NULL expiry is never deleted.
    /// Each table is cleaned independently: a failure is logged and reported but does not skip the others.
    pub async fn cleanup(&self, batch: i64) -> CleanupResult {
        let now = now_ms();
        let mut failed = vec![];
        let mut counts = [0usize; 4];
        for (i, table) in ["messages", "audit_log", "mcp_sessions", "binding_codes"].iter().enumerate() {
            let sql = format!(
                "DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?)"
            );
            match self.run(&sql, &[P::I(now), P::I(batch)]).await {
                Ok(n) => counts[i] = n,
                Err(e) => {
                    worker::console_error!("cleanup: {table} failed: {e}");
                    failed.push(table.to_string());
                }
            }
        }
        CleanupResult { messages: counts[0], audit: counts[1], sessions: counts[2], binding_codes: counts[3], failed }
    }
}

/// Checks subject/body/data sizes; returns the serialized data.
pub fn validate_send(input: &SendInput) -> Result<Option<String>> {
    if input.subject.chars().count() > MAX_SUBJECT_CHARS {
        return Err(Error::invalid(format!("subject must be a string of at most {MAX_SUBJECT_CHARS} characters."), "Shorten the subject."));
    }
    if input.body.len() > MAX_BODY_BYTES {
        return Err(Error::new(
            ErrorCode::TooLarge,
            format!("body exceeds {MAX_BODY_BYTES} bytes (UTF-8)."),
            "Shorten the body or split it into several messages.",
        ));
    }
    let Some(data) = &input.data else { return Ok(None) };
    let json = serde_json::to_string(data)?;
    if json.len() > MAX_DATA_BYTES {
        return Err(Error::new(ErrorCode::TooLarge, format!("data exceeds {MAX_DATA_BYTES} bytes once serialized."), "Send less structured data."));
    }
    Ok(Some(json))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(subject: &str, body: &str, data: Option<Json>) -> SendInput {
        SendInput { to: "x".into(), subject: subject.into(), body: body.into(), data, reply_to: None }
    }

    #[test]
    fn names() {
        assert!(is_valid_name("a"));
        assert!(is_valid_name("agent-7"));
        assert!(is_valid_name(&"a".repeat(32)));
        assert!(!is_valid_name(&"a".repeat(33)));
        assert!(!is_valid_name("-lead"));
        assert!(!is_valid_name("Upper"));
        assert!(!is_valid_name("bad name"));
        assert!(!is_valid_name(""));
        assert_eq!(valid_name("  Mixed-Case ").unwrap(), "mixed-case");
    }

    #[test]
    fn size_limits() {
        assert!(validate_send(&input(&"é".repeat(200), "", None)).is_ok());
        assert_eq!(validate_send(&input(&"é".repeat(201), "", None)).unwrap_err().code(), ErrorCode::InvalidInput);
        assert!(validate_send(&input("", &"a".repeat(MAX_BODY_BYTES), None)).is_ok());
        assert_eq!(validate_send(&input("", &"é".repeat(MAX_BODY_BYTES / 2 + 1), None)).unwrap_err().code(), ErrorCode::TooLarge);
        let big = Json::String("a".repeat(MAX_DATA_BYTES));
        assert_eq!(validate_send(&input("", "", Some(big))).unwrap_err().code(), ErrorCode::TooLarge);
        assert_eq!(validate_send(&input("", "", Some(serde_json::json!({"n":1})))).unwrap(), Some("{\"n\":1}".into()));
    }
}
