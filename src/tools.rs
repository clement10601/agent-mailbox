//! MCP tools. Each tool has a JSON Schema (advertised in tools/list and enforced before the handler runs)
//! and a handler. Agents get the agent tools; the admin key gets only the admin_ tools.

use serde_json::{json, Map, Value as Json};
use worker::RateLimiter;

use crate::auth::Identity;
use crate::errors::{Error, ErrorCode, Result};
use crate::oauth::Provider;
use crate::store::{parse_iso, SendInput, Store, MAX_ACK_IDS};

pub const AUDIT_DEFAULT_LIMIT: i64 = 100;
pub const AUDIT_MAX_LIMIT: i64 = 1000;
const SEND_RETRY_AFTER_SECONDS: u32 = 60;

pub struct ToolDef {
    pub name: &'static str,
    pub description: String,
    pub schema: Json,
}

fn obj(props: Json, required: &[&str]) -> Json {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

fn s(desc: &str) -> Json {
    json!({ "type": "string", "description": desc })
}

const AGENT_NAME: &str = "Agent name (case-insensitive).";

pub fn agent_tools() -> Vec<ToolDef> {
    let t = |name, description: &str, schema| ToolDef { name, description: description.to_string(), schema };
    vec![
        t("whoami", "Your agent name, description and number of unread messages.", obj(json!({}), &[])),
        t("list_agents", "Active agents you can message: name and description.", obj(json!({}), &[])),
        t(
            "send_message",
            "Send a message to an agent, or to \"all\" (every other active agent). Returns id, thread_id, delivered[] and failed[] ({agent, code}).",
            obj(
                json!({
                    "to": s("Recipient agent name, or \"all\" to broadcast."),
                    "subject": s("Subject, at most 200 characters."),
                    "body": s("Message text, at most 32 KiB (UTF-8)."),
                    "data": { "description": "Optional structured JSON payload, at most 64 KiB serialized." },
                    "reply_to": s("Id of a message you sent or received; the new message joins its thread."),
                }),
                &["to", "subject", "body"],
            ),
        ),
        t(
            "check_inbox",
            "Unread messages, oldest first. Does not mark them read; call ack when done.",
            obj(json!({ "limit": { "type": "integer", "description": "Maximum number of messages; defaults to and is capped at MAX_UNREAD." } }), &[]),
        ),
        ToolDef {
            name: "ack",
            description: format!("Mark messages as handled (at most {MAX_ACK_IDS} ids). Returns acked[] and failed[] ({{id, code}})."),
            schema: obj(
                json!({ "ids": { "type": "array", "items": { "type": "string" }, "maxItems": MAX_ACK_IDS, "description": "Message ids from check_inbox." } }),
                &["ids"],
            ),
        },
        t(
            "read_thread",
            "Messages in a thread that you sent or received and that still exist, in time order.",
            obj(json!({ "thread_id": s("Thread id from a message.") }), &["thread_id"]),
        ),
        t("block_sender", "Stop receiving messages from an agent.", obj(json!({ "agent": s(AGENT_NAME) }), &["agent"])),
        t("unblock_sender", "Receive messages from a previously blocked agent again.", obj(json!({ "agent": s(AGENT_NAME) }), &["agent"])),
        t("list_blocked", "Agents you have blocked.", obj(json!({}), &[])),
        t(
            "update_profile",
            "Update your description, shown to other agents in list_agents.",
            obj(json!({ "description": s("New description.") }), &["description"]),
        ),
    ]
}

pub fn admin_tools() -> Vec<ToolDef> {
    let t = |name, description: &str, schema| ToolDef { name, description: description.to_string(), schema };
    vec![
        t(
            "admin_create_agent",
            "Create an agent and return its first key. The key is shown only once.",
            obj(json!({ "name": s("1-32 chars: lowercase letters, digits, hyphen."), "description": s("What the agent does.") }), &["name"]),
        ),
        t("admin_issue_key", "Issue an additional key for an agent. The key is shown only once.", obj(json!({ "agent": s(AGENT_NAME) }), &["agent"])),
        t(
            "admin_revoke_key",
            "Revoke a key by its id.",
            obj(json!({ "key_id": s("Key id from admin_create_agent or admin_issue_key.") }), &["key_id"]),
        ),
        t(
            "admin_disable_agent",
            "Disable an agent: its keys and OAuth tokens stop working and it cannot receive mail.",
            obj(json!({ "agent": s(AGENT_NAME) }), &["agent"]),
        ),
        t("admin_enable_agent", "Re-enable a disabled agent.", obj(json!({ "agent": s(AGENT_NAME) }), &["agent"])),
        t(
            "admin_list_agents",
            "All agents with unread count, last_seen_at, active key count, OAuth grant count and grant ids (for admin_revoke_oauth).",
            obj(json!({}), &[]),
        ),
        ToolDef {
            name: "admin_audit_log",
            description: format!("Audit log, newest first. Defaults to {AUDIT_DEFAULT_LIMIT} entries (max {AUDIT_MAX_LIMIT})."),
            schema: obj(
                json!({
                    "since": s("Only entries at or after this ISO 8601 time."),
                    "agent": s("Only entries where this agent is actor or target."),
                    "limit": { "type": "integer", "description": format!("Maximum entries (1-{AUDIT_MAX_LIMIT}).") },
                }),
                &[],
            ),
        },
        t(
            "admin_set_block",
            "Set or clear a block on behalf of any agent: `agent` stops (or resumes) receiving mail from `sender`.",
            obj(
                json!({
                    "agent": s("The agent whose blocklist changes."),
                    "sender": s("The sender to block or unblock."),
                    "blocked": { "type": "boolean", "description": "true to block, false to unblock." },
                }),
                &["agent", "sender", "blocked"],
            ),
        ),
        t(
            "admin_revoke_oauth",
            "Revoke one OAuth grant of an agent; its access and refresh tokens stop working. Grant ids come from admin_list_agents.",
            obj(json!({ "agent": s(AGENT_NAME), "grant_id": s("OAuth grant id.") }), &["agent", "grant_id"]),
        ),
    ]
}

pub fn tools_for(identity: &Identity) -> Vec<ToolDef> {
    match identity {
        Identity::Admin => admin_tools(),
        Identity::Agent(_) => agent_tools(),
    }
}

fn type_ok(v: &Json, ty: &str) -> bool {
    match ty {
        "string" => v.is_string(),
        "boolean" => v.is_boolean(),
        "integer" => v.as_f64().map(|n| n.fract() == 0.0).unwrap_or(false),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => true,
    }
}

/// Validates `args` against the subset of JSON Schema the tool schemas use.
pub fn validate(schema: &Json, args: &Map<String, Json>) -> Result<()> {
    let fail = |m: String| Err(Error::invalid(format!("Input validation error: {m}"), "Check the tool's input schema."));
    let props = schema["properties"].as_object().cloned().unwrap_or_default();
    for r in schema["required"].as_array().into_iter().flatten().filter_map(Json::as_str) {
        if args.get(r).map(Json::is_null).unwrap_or(true) {
            return fail(format!("\"{r}\" is required"));
        }
    }
    for (k, v) in args {
        let Some(p) = props.get(k) else { return fail(format!("unknown argument \"{k}\"")) };
        if v.is_null() && !schema["required"].as_array().into_iter().flatten().any(|r| r == k) {
            continue;
        }
        if let Some(ty) = p["type"].as_str() {
            if !type_ok(v, ty) {
                return fail(format!("\"{k}\" must be of type {ty}"));
            }
        }
        if let (Some(items), Some(arr)) = (p["items"]["type"].as_str(), v.as_array()) {
            if !arr.iter().all(|x| type_ok(x, items)) {
                return fail(format!("every item of \"{k}\" must be of type {items}"));
            }
        }
        if let (Some(max), Some(arr)) = (p["maxItems"].as_u64(), v.as_array()) {
            if arr.len() as u64 > max {
                return fail(format!("\"{k}\" must contain at most {max} items"));
            }
        }
    }
    Ok(())
}

fn str_arg<'a>(a: &'a Map<String, Json>, k: &str) -> &'a str {
    a.get(k).and_then(Json::as_str).unwrap_or("")
}

fn opt_str(a: &Map<String, Json>, k: &str) -> Option<String> {
    a.get(k).and_then(Json::as_str).map(String::from)
}

fn opt_int(a: &Map<String, Json>, k: &str) -> Option<i64> {
    a.get(k).and_then(Json::as_f64).map(|n| n as i64)
}

fn ok() -> Json {
    json!({ "ok": true })
}

pub struct Ctx<'a> {
    pub store: &'a Store,
    pub oauth: &'a Provider,
    pub send_limiter: &'a RateLimiter,
}

/// Runs a tool that has already passed `validate`.
pub async fn call(identity: &Identity, name: &str, a: &Map<String, Json>, cx: &Ctx<'_>) -> Result<Json> {
    let store = cx.store;
    match identity {
        Identity::Agent(me) => match name {
            "whoami" => Ok(serde_json::to_value(store.get_profile(me).await?)?),
            "list_agents" => Ok(json!({ "agents": store.list_agents().await? })),
            "send_message" => {
                if !cx.send_limiter.limit(me.clone()).await?.success {
                    return Err(Error::with_retry(
                        ErrorCode::RateLimited,
                        "Too many messages sent; the limit is 30 per minute.",
                        "Wait before sending again.",
                        SEND_RETRY_AFTER_SECONDS,
                    ));
                }
                let input = SendInput {
                    to: str_arg(a, "to").into(),
                    subject: str_arg(a, "subject").into(),
                    body: str_arg(a, "body").into(),
                    data: a.get("data").cloned(),
                    reply_to: opt_str(a, "reply_to"),
                };
                Ok(serde_json::to_value(store.send(me, input).await?)?)
            }
            "check_inbox" => Ok(json!({ "messages": store.inbox(me, opt_int(a, "limit")).await? })),
            "ack" => {
                let ids: Vec<String> = a["ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
                Ok(serde_json::to_value(store.ack(me, &ids).await?)?)
            }
            "read_thread" => Ok(json!({ "messages": store.thread(me, str_arg(a, "thread_id")).await? })),
            "block_sender" => store.block(me, str_arg(a, "agent")).await.map(|_| ok()),
            "unblock_sender" => store.unblock(me, str_arg(a, "agent")).await.map(|_| ok()),
            "list_blocked" => Ok(json!({ "blocked": store.list_blocked(me).await? })),
            "update_profile" => store.update_profile(me, str_arg(a, "description")).await.map(|_| ok()),
            _ => Err(unknown_tool(name)),
        },
        Identity::Admin => match name {
            "admin_create_agent" => {
                let (n, key, key_id) = store.create_agent(str_arg(a, "name"), str_arg(a, "description")).await?;
                Ok(json!({ "name": n, "key": key, "key_id": key_id }))
            }
            "admin_issue_key" => {
                let (key, key_id) = store.issue_key(str_arg(a, "agent")).await?;
                Ok(json!({ "key": key, "key_id": key_id }))
            }
            "admin_revoke_key" => store.revoke_key(str_arg(a, "key_id")).await.map(|_| ok()),
            "admin_disable_agent" => store.set_disabled(str_arg(a, "agent"), true).await.map(|_| ok()),
            "admin_enable_agent" => store.set_disabled(str_arg(a, "agent"), false).await.map(|_| ok()),
            "admin_list_agents" => {
                let mut out = vec![];
                for ag in store.admin_list_agents().await? {
                    let ids = cx.oauth.grant_ids(&ag.name).await?;
                    let mut v = serde_json::to_value(&ag)?;
                    v["oauth_grants"] = json!(ids.len());
                    v["oauth_grant_ids"] = json!(ids);
                    out.push(v);
                }
                Ok(json!({ "agents": out }))
            }
            "admin_audit_log" => {
                let limit = opt_int(a, "limit").unwrap_or(AUDIT_DEFAULT_LIMIT).clamp(1, AUDIT_MAX_LIMIT);
                let since = match opt_str(a, "since") {
                    None => None,
                    Some(s) => Some(parse_iso(&s).ok_or_else(|| {
                        Error::invalid(format!("since is not a valid ISO 8601 time: \"{s}\"."), "Use e.g. \"2026-10-16T00:00:00Z\".")
                    })?),
                };
                let agent = opt_str(a, "agent").map(|s| s.trim().to_lowercase());
                Ok(json!({ "entries": store.audit_log(since, agent.as_deref(), limit).await? }))
            }
            "admin_set_block" => {
                let name = store.get_profile(str_arg(a, "agent")).await?.name; // not_found if missing
                if a["blocked"].as_bool() == Some(true) {
                    store.block(&name, str_arg(a, "sender")).await?;
                } else {
                    store.unblock(&name, str_arg(a, "sender")).await?;
                }
                Ok(ok())
            }
            "admin_revoke_oauth" => {
                let agent = str_arg(a, "agent").trim().to_lowercase();
                let grant = str_arg(a, "grant_id");
                if !cx.oauth.grant_ids(&agent).await?.iter().any(|g| g == grant) {
                    return Err(Error::new(
                        ErrorCode::NotFound,
                        format!("Agent \"{agent}\" has no OAuth grant \"{grant}\"."),
                        "List grant ids with admin_list_agents.",
                    ));
                }
                cx.oauth.revoke_grant(&agent, grant).await?;
                store.audit("oauth_revoked", "admin", Some(&agent), Some(grant)).await?;
                Ok(ok())
            }
            _ => Err(unknown_tool(name)),
        },
    }
}

pub fn unknown_tool(name: &str) -> Error {
    Error::invalid(format!("Tool {name} not found."), "List the available tools with tools/list.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: Vec<ToolDef>) -> Vec<&'static str> {
        v.into_iter().map(|t| t.name).collect()
    }

    #[test]
    fn agent_tool_names() {
        assert_eq!(
            names(agent_tools()),
            vec!["whoami", "list_agents", "send_message", "check_inbox", "ack", "read_thread", "block_sender", "unblock_sender", "list_blocked", "update_profile"]
        );
    }

    #[test]
    fn admin_tools_are_prefixed() {
        assert!(names(admin_tools()).iter().all(|n| n.starts_with("admin_")));
    }

    fn args(v: Json) -> Map<String, Json> {
        v.as_object().unwrap().clone()
    }

    fn schema(name: &str) -> Json {
        agent_tools().into_iter().chain(admin_tools()).find(|t| t.name == name).unwrap().schema
    }

    #[test]
    fn validation() {
        let send = schema("send_message");
        assert!(validate(&send, &args(json!({"to":"a","subject":"s","body":"b","data":{"x":[1]}}))).is_ok());
        assert!(validate(&send, &args(json!({"to":"a","subject":"s"}))).is_err());
        assert!(validate(&send, &args(json!({"to":1,"subject":"s","body":"b"}))).is_err());
        assert!(validate(&send, &args(json!({"to":"a","subject":"s","body":"b","extra":1}))).is_err());
        let ack = schema("ack");
        let many: Vec<String> = (0..51).map(|i| format!("id{i}")).collect();
        let e = validate(&ack, &args(json!({ "ids": many }))).unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidInput);
        assert!(validate(&ack, &args(json!({"ids":[1]}))).is_err());
        let inbox = schema("check_inbox");
        assert!(validate(&inbox, &args(json!({"limit":2.5}))).is_err());
        assert!(validate(&inbox, &args(json!({"limit":3}))).is_ok());
        assert!(validate(&schema("admin_set_block"), &args(json!({"agent":"a","sender":"b","blocked":"yes"}))).is_err());
    }
}
