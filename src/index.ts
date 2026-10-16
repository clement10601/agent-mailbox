import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { parseConfig } from "./config";
import { Store } from "./store";
import {
  AUTH_RETRY_AFTER_SECONDS,
  AdminKeyMissingError,
  activateIdentity,
  isLockedOut,
  authenticateBearer,
  principalOf,
  recordAuthFailure,
  type Identity,
} from "./auth";
import { timingSafeEqual } from "./crypto";
import { fromBinding } from "./ratelimit";
import { MailboxMCP } from "./mcp";
import { handleAuthorize } from "./oauth";
import { providerOptions } from "./oauth-provider";

// Wrangler's Durable Object binding needs the class exported from the main module.
export { MailboxMCP };

const mcpHandler = MailboxMCP.serve("/mcp");

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function rateLimited(): Response {
  return json(429, { error: "rate_limited", retry_after: AUTH_RETRY_AFTER_SECONDS }, {
    "Retry-After": String(AUTH_RETRY_AFTER_SECONDS),
  });
}

type ResolveIdentity = (header: string | null, env: Env, store: Store) => Promise<Identity | null>;

/**
 * Authenticated /mcp: runs on every HTTP request before anything reaches the session Durable Object.
 * `resolve` turns the request's credential into an identity: static Bearer keys by default, OAuth token
 * props when called from the OAuthProvider's API handler. Everything after that is shared, so both kinds
 * of credential get the same per-request disabled check, activity touch and session binding.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  resolve: ResolveIdentity = authenticateBearer
): Promise<Response> {
  const header = request.headers.get("Authorization");
  let identity: Identity | null;
  let store: Store;
  try {
    store = new Store(env.DB, parseConfig(env));
    identity = await resolve(header, env, store);
    if (identity && !(await activateIdentity(identity, store))) identity = null;
  } catch (e) {
    if (e instanceof AdminKeyMissingError) console.error("auth: ADMIN_KEY secret is not set; answering 500");
    else console.error("auth: internal error", e);
    return json(500, { error: "internal" });
  }

  if (!identity) {
    // No credentials at all is not counted as a failed attempt (clients probe /mcp before authenticating).
    if (header !== null && !(await recordAuthFailure(request, fromBinding(env.AUTH_LIMITER), store))) {
      return rateLimited();
    }
    return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }

  // McpAgent only applies props when a session object first starts (and restores the stored ones after
  // eviction), so it cannot be trusted to follow the presenting credential. Each session is therefore bound
  // to its creator in D1 and every request must present a credential for that same identity. Mismatches and
  // unknown sessions both get the same 404 the MCP transport uses for unknown sessions, so nothing leaks.
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

  // McpAgent.serve reads the identity from ctx.props.
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

/** OAuth grants only ever carry agent props (see handleAuthorize); anything else is rejected. */
function identityFromProps(props: unknown): Identity | null {
  const p = props as { role?: unknown; agent?: unknown } | null | undefined;
  if (p && p.role === "agent" && typeof p.agent === "string" && p.agent !== "") return { role: "agent", agent: p.agent };
  return null;
}

/** OAuthProvider's API handler: the token is already verified; ctx.props holds what the grant stored. */
const oauthApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props?: unknown }).props;
    return handleMcp(request, env, ctx, async () => identityFromProps(props));
  },
};

/** Everything that is not an OAuth endpoint or /mcp. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (url.pathname === "/authorize") {
      try {
        const config = parseConfig(env);
        return await handleAuthorize(request, env, new Store(env.DB, config), config);
      } catch (e) {
        console.error("authorize: internal error", e);
        return new Response("Internal error", {
          status: 500,
          headers: { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  },
};

// The protected resource is `<origin>/mcp`, and the origin is only known per request, so one provider is
// kept per origin (a deployment normally sees one or two: workers.dev and a custom domain).
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>(providerOptions(origin, oauthApiHandler, defaultHandler));
    providers.set(origin, p);
  }
  return p;
}

const BEARER_RE = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/**
 * Tokens the OAuthProvider issued look like `<agent>:<grantId>:<secret>`. Static credentials (`amk_…` keys,
 * the admin key) and malformed headers stay on the Bearer path so its 401/429 and audit behaviour is unchanged.
 */
async function isProviderToken(header: string | null, env: Env): Promise<boolean> {
  const m = header ? BEARER_RE.exec(header) : null;
  if (m === null || m[1].startsWith("amk_") || m[1].split(":").length !== 3) return false;
  // An admin key that happens to contain two colons must still take the Bearer path.
  return !(typeof env.ADMIN_KEY === "string" && env.ADMIN_KEY !== "" && (await timingSafeEqual(m[1], env.ADMIN_KEY)));
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const header = request.headers.get("Authorization");
    const mcp = isMcpPath(url.pathname);
    // Lockout comes before any credential (static key or OAuth token) is evaluated. Requests without
    // credentials evaluate nothing and are never counted, so they are not checked.
    if (mcp && header !== null) {
      try {
        if (await isLockedOut(request, new Store(env.DB, parseConfig(env)))) return rateLimited();
      } catch (e) {
        console.error("auth: lockout check failed", e);
        return json(500, { error: "internal" });
      }
    }
    // Bearer pre-routing: static keys never touch the provider. No header at all goes to the provider so the
    // 401 carries the protected-resource-metadata challenge that claude.ai uses to discover OAuth.
    if (mcp && header !== null && !(await isProviderToken(header, env))) {
      return handleMcp(request, env, ctx);
    }
    // The provider writes OAUTH_PROVIDER onto the env it is given; a per-request copy keeps helpers bound to
    // this request's origin instead of whichever origin happened to arrive first.
    const reqEnv: Env = { ...env, OAUTH_PROVIDER: undefined as unknown as Env["OAUTH_PROVIDER"] };
    const res = await providerFor(url.origin).fetch(request, reqEnv, ctx);
    if (mcp && header !== null && res.status === 401) {
      // The provider rejected the token itself (unknown, expired, revoked). Count it like any other failure;
      // recordAuthFailure is per-request idempotent, so failures already counted by handleMcp are not doubled.
      try {
        const store = new Store(env.DB, parseConfig(env));
        if (!(await recordAuthFailure(request, fromBinding(env.AUTH_LIMITER), store))) {
          await res.body?.cancel();
          return rateLimited();
        }
      } catch (e) {
        console.error("auth: could not record OAuth failure", e);
      }
    }
    return res;
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB, parseConfig(env));
    const r = await store.cleanup();
    console.log(`cleanup: deleted ${r.messages} messages, ${r.audit} audit rows`);
  },
} satisfies ExportedHandler<Env>;
