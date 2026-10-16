import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import type { Config } from "./config";
import type { Store } from "./store";
import { AUTH_RETRY_AFTER_SECONDS, isLockedOut, recordAuthFailure } from "./auth";
import { randomToken, timingSafeEqual } from "./crypto";
import { MailboxError } from "./errors";
import { fromBinding } from "./ratelimit";

const CSRF_COOKIE = "__Host-csrf";

/** Sent on every /authorize response. The page loads nothing external and must never be framed. */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function respond(status: number, body: string | null, headers: Record<string, string> = {}): Response {
  const h: Record<string, string> = { ...SECURITY_HEADERS, ...headers };
  if (body !== null) h["Content-Type"] = "text/html; charset=utf-8";
  return new Response(body, { status, headers: h });
}

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
label{display:block;margin-top:1rem;font-weight:600}input,select{width:100%;padding:.4rem;box-sizing:border-box}
button{margin-top:1.5rem;padding:.5rem 1rem}.error{color:#b00020}.muted{color:#555}
</style></head><body>${inner}</body></html>`;
}

function errorPage(status: number, message: string, headers: Record<string, string> = {}): Response {
  return respond(status, shell("Authorization error", `<h1>Authorization error</h1><p class="error">${escapeHtml(message)}</p>`), headers);
}

interface FormView {
  action: string;
  csrf: string;
  clientName: string;
  agents: string[];
  error?: string;
}

function formPage(v: FormView): string {
  const options = v.agents
    .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
    .join("");
  return shell(
    "Authorize Agent Mailbox",
    `<h1>Connect to Agent Mailbox</h1>
<p class="muted"><strong>${escapeHtml(v.clientName)}</strong> asks to act as one of your agents.</p>
${v.error ? `<p class="error">${escapeHtml(v.error)}</p>` : ""}
<form method="post" action="${escapeHtml(v.action)}">
<input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
<label for="admin_key">Admin key</label>
<input id="admin_key" name="admin_key" type="password" autocomplete="current-password" required>
<label for="agent">Existing agent</label>
<select id="agent" name="agent"><option value="">(create a new agent)</option>${options}</select>
<label for="new_agent">…or new agent name</label>
<input id="new_agent" name="new_agent" type="text" pattern="[a-z0-9][a-z0-9-]{0,31}" placeholder="lowercase letters, digits, hyphen">
<button type="submit">Authorize</button>
</form>`
  );
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function parseAllowed(request: Request, env: Env, config: Config): Promise<AuthRequest | Response> {
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    // Never follow the library's error redirect: the client's redirect URI may be outside the allowlist.
    const msg = e instanceof Error && "description" in e ? String((e as { description: unknown }).description) : "Invalid authorization request.";
    return errorPage(400, msg);
  }
  if (!config.oauthRedirectAllowlist.includes(authReq.redirectUri)) {
    return errorPage(400, "This redirect URI is not allowed. Add it to OAUTH_REDIRECT_ALLOWLIST to permit it.");
  }
  return authReq;
}

async function clientName(env: Env, clientId: string): Promise<string> {
  const c = await env.OAUTH_PROVIDER.lookupClient(clientId);
  return c?.clientName || clientId;
}

/**
 * The consent page for claude.ai connectors. GET renders a form; POST (admin key + agent choice) completes the
 * authorization and redirects back to the client with a code. Only allowlisted redirect URIs are served.
 */
export async function handleAuthorize(request: Request, env: Env, store: Store, config: Config): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return respond(405, null, { Allow: "GET, POST" });
  }
  const parsed = await parseAllowed(request, env, config);
  if (parsed instanceof Response) return parsed;
  const authReq = parsed;
  const url = new URL(request.url);
  const action = url.pathname + url.search;
  const view = async (csrf: string, error?: string): Promise<string> =>
    formPage({ action, csrf, clientName: await clientName(env, authReq.clientId), agents: (await store.listAgents()).map((a) => a.name), error });

  if (request.method === "GET") {
    const csrf = randomToken();
    return respond(200, await view(csrf), {
      "Set-Cookie": `${CSRF_COOKIE}=${csrf}; Secure; HttpOnly; SameSite=Strict; Path=/`,
    });
  }

  const tooMany = () =>
    errorPage(429, "Too many failed attempts. Wait a minute and try again.", {
      "Retry-After": String(AUTH_RETRY_AFTER_SECONDS),
    });
  // Before the admin key is even looked at: a locked-out IP learns nothing, right key or wrong.
  if (await isLockedOut(request, store)) return tooMany();

  const form = new URLSearchParams(await request.text());
  const cookieToken = readCookie(request, CSRF_COOKIE) ?? "";
  const formToken = form.get("csrf") ?? "";
  if (cookieToken === "" || formToken === "" || !(await timingSafeEqual(cookieToken, formToken))) {
    return errorPage(403, "The form expired or was not submitted from this page. Reload and try again.");
  }

  const adminKey = typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY : "";
  if (adminKey === "") {
    console.error("authorize: ADMIN_KEY secret is not set; answering 500");
    return errorPage(500, "The server is not configured.");
  }
  if (!(await timingSafeEqual(form.get("admin_key") ?? "", adminKey))) {
    if (!(await recordAuthFailure(request, fromBinding(env.AUTH_LIMITER), store))) return tooMany();
    return respond(401, await view(cookieToken, "Wrong admin key."));
  }

  let agent: string;
  const newName = (form.get("new_agent") ?? "").trim();
  try {
    if (newName !== "") {
      // The key createAgent returns is deliberately dropped: this agent authenticates through OAuth.
      agent = (await store.createAgent(newName, "")).name;
    } else {
      agent = (form.get("agent") ?? "").trim().toLowerCase();
      if (agent === "" || !(await store.isActive(agent))) {
        return respond(400, await view(cookieToken, "Choose an existing active agent or enter a new name."));
      }
    }
  } catch (e) {
    if (e instanceof MailboxError && e.code === "invalid_input") {
      return respond(400, await view(cookieToken, e.message));
    }
    throw e;
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: agent,
    scope: authReq.scope,
    props: { role: "agent", agent },
    metadata: { label: agent },
  });
  await store.audit("oauth_granted", "admin", agent, authReq.clientId);
  return respond(302, null, {
    Location: redirectTo,
    "Set-Cookie": `${CSRF_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  });
}
