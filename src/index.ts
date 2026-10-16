import type { Env } from "./env";
import { parseConfig } from "./config";
import { Store } from "./store";
import { AdminKeyMissingError, activateIdentity, authenticateBearer, principalOf, type Identity } from "./auth";
import { fromBinding } from "./ratelimit";
import { MailboxMCP } from "./mcp";

// Wrangler's Durable Object binding needs the class exported from the main module.
export { MailboxMCP };

const AUTH_RETRY_AFTER_SECONDS = 60;
const mcpHandler = MailboxMCP.serve("/mcp");

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Bearer-authenticated /mcp: runs on every HTTP request before anything reaches the session Durable Object. */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const header = request.headers.get("Authorization");
  let identity: Identity | null;
  let store: Store;
  try {
    store = new Store(env.DB, parseConfig(env));
    identity = await authenticateBearer(header, env, store);
    if (identity && !(await activateIdentity(identity, store))) identity = null;
  } catch (e) {
    if (e instanceof AdminKeyMissingError) console.error("auth: ADMIN_KEY secret is not set; answering 500");
    else console.error("auth: internal error", e);
    return json(500, { error: "internal" });
  }

  if (!identity) {
    // No credentials at all is not counted as a failed attempt (clients probe /mcp before authenticating).
    if (header !== null) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await fromBinding(env.AUTH_LIMITER).limit(ip))) {
        return json(429, { error: "rate_limited", retry_after: AUTH_RETRY_AFTER_SECONDS }, {
          "Retry-After": String(AUTH_RETRY_AFTER_SECONDS),
        });
      }
      await store.audit("auth_failed", ip, null);
    }
    return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }

  // McpAgent only applies props when a session object first starts (and restores the stored ones after
  // eviction), so it cannot be trusted to follow the presenting key. Each session is therefore bound to its
  // creator in D1 and every request must present a key for that same identity. Mismatches and unknown
  // sessions both get the same 404 the MCP transport uses for unknown sessions, so nothing leaks.
  const principal = principalOf(identity);
  const sessionId = request.headers.get("mcp-session-id");
  try {
    if (sessionId !== null && (await store.sessionPrincipal(sessionId)) !== principal) {
      return json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    }
  } catch (e) {
    console.error("auth: session lookup failed", e);
    return json(500, { error: "internal" });
  }

  // McpAgent.serve reads the identity from ctx.props (OAuthProvider sets it the same way).
  (ctx as unknown as { props: Identity }).props = identity;
  const res = await mcpHandler.fetch(request, env, ctx);
  const created = res.headers.get("mcp-session-id");
  if (sessionId === null && created !== null && res.ok) {
    try {
      await store.bindSession(created, principal);
    } catch (e) {
      console.error("auth: could not bind new session", e);
      await res.body?.cancel();
      return json(500, { error: "internal" });
    }
  }
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return handleMcp(request, env, ctx);
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB, parseConfig(env));
    const r = await store.cleanup();
    console.log(`cleanup: deleted ${r.messages} messages, ${r.audit} audit rows`);
  },
} satisfies ExportedHandler<Env>;
