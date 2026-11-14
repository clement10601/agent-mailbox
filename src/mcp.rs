//! MCP over Streamable HTTP, answered with plain JSON (no SSE streams: the mailbox has no server-initiated
//! messages). Sessions are only ids bound to the identity that created them in D1 (`mcp_sessions`), so no
//! Durable Object is needed and every request is handled statelessly.

use serde_json::{json, Map, Value as Json};
use worker::{Request, Response};

use crate::auth::Identity;
use crate::crypto::{hex, random_token, sha256};
use crate::errors::Result;
use crate::store::Store;
use crate::tools::{self, Ctx};

pub const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn json_response(status: u16, body: &Json) -> Result<Response> {
    Ok(Response::from_json(body)?.with_status(status))
}

fn rpc_error(id: Json, code: i64, message: &str) -> Json {
    json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": id })
}

pub fn session_not_found() -> Result<Response> {
    json_response(404, &rpc_error(Json::Null, -32001, "Session not found"))
}

fn tool_result(value: &Json, is_error: bool) -> Json {
    let mut r = json!({ "content": [{ "type": "text", "text": value.to_string() }] });
    if is_error {
        r["isError"] = json!(true);
    }
    r
}

/// Handles one authenticated /mcp request. The caller has already checked that any `mcp-session-id` header
/// names a session bound to `identity`.
pub async fn handle(mut req: Request, identity: &Identity, session: Option<String>, cx: &Ctx<'_>) -> Result<Response> {
    match req.method() {
        worker::Method::Post => {}
        worker::Method::Delete => {
            if let Some(s) = session {
                cx.store.delete_session(&s).await?;
            }
            return Ok(Response::empty()?.with_status(200));
        }
        _ => {
            let mut r = json_response(405, &rpc_error(Json::Null, -32000, "Method not allowed."))?;
            r.headers_mut().set("Allow", "POST, DELETE")?;
            return Ok(r);
        }
    }
    let body: Json = match req.text().await.ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(b) => b,
        None => return json_response(400, &rpc_error(Json::Null, -32700, "Parse error")),
    };
    let Some(msg) = body.as_object() else {
        return json_response(400, &rpc_error(Json::Null, -32600, "Invalid Request: batches are not supported"));
    };
    let method = msg.get("method").and_then(Json::as_str).unwrap_or("");
    let id = msg.get("id").cloned();
    let params = msg.get("params").and_then(Json::as_object).cloned().unwrap_or_default();

    // Notifications and responses from the client need no answer.
    let Some(id) = id else {
        return Ok(Response::empty()?.with_status(202));
    };
    if method.is_empty() {
        return Ok(Response::empty()?.with_status(202));
    }

    if method == "initialize" {
        let requested = params.get("protocolVersion").and_then(Json::as_str).unwrap_or("");
        let version = if SUPPORTED_VERSIONS.contains(&requested) { requested } else { SUPPORTED_VERSIONS[0] };
        let sid = hex(&sha256(&random_token()));
        cx.store.bind_session(&sid, &identity.principal()).await?;
        let mut r = json_response(
            200,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "agent-mailbox", "version": SERVER_VERSION },
                },
            }),
        )?;
        r.headers_mut().set("mcp-session-id", &sid)?;
        return Ok(r);
    }

    if session.is_none() {
        return json_response(400, &rpc_error(id, -32000, "Bad Request: Mcp-Session-Id header is required"));
    }

    let result = match method {
        "ping" => json!({}),
        "tools/list" => {
            let list: Vec<Json> = tools::tools_for(identity)
                .into_iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.schema }))
                .collect();
            json!({ "tools": list })
        }
        "tools/call" => call_tool(identity, &params, cx).await,
        _ => return json_response(200, &rpc_error(id, -32601, &format!("Method not found: {method}"))),
    };
    json_response(200, &json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

async fn call_tool(identity: &Identity, params: &Map<String, Json>, cx: &Ctx<'_>) -> Json {
    let name = params.get("name").and_then(Json::as_str).unwrap_or("");
    let args = params.get("arguments").and_then(Json::as_object).cloned().unwrap_or_default();
    let Some(def) = tools::tools_for(identity).into_iter().find(|t| t.name == name) else {
        return tool_result(&json!(tools::unknown_tool(name).to_tool_error()), true);
    };
    if let Err(e) = tools::validate(&def.schema, &args) {
        return tool_result(&json!(e.to_tool_error()), true);
    }
    match tools::call(identity, name, &args, cx).await {
        Ok(v) => tool_result(&v, false),
        Err(e) => {
            if let crate::errors::Error::Internal(m) = &e {
                worker::console_error!("tool {name} failed: {m}");
            }
            tool_result(&json!(e.to_tool_error()), true)
        }
    }
}

/// True when `session` is bound to `identity` and has not expired.
pub async fn session_matches(store: &Store, session: &str, identity: &Identity) -> Result<bool> {
    Ok(store.session_principal(session).await?.as_deref() == Some(identity.principal().as_str()))
}
