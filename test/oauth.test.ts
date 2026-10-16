import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeStore, resetDb } from "./helpers";
import { Client } from "./mcp-client";

async function clearKv(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list(cursor ? { cursor } : {});
    await Promise.all(page.keys.map((k) => env.OAUTH_KV.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

beforeEach(async () => {
  await resetDb();
  await clearKv();
});

const ORIGIN = "https://x";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `198.51.100.${ipCounter}`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(redirectUri: string): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: "claude" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

interface Flow {
  clientId: string;
  redirectUri: string;
  verifier: string;
  url: string;
  ip: string;
}

async function startFlow(redirectUri = CALLBACK): Promise<Flow> {
  const clientId = await registerClient(redirectUri);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
  });
  return { clientId, redirectUri, verifier, url: `${ORIGIN}/authorize?${q}`, ip: freshIp() };
}

async function getForm(flow: Flow): Promise<{ res: Response; html: string; cookie: string; csrf: string }> {
  const res = await SELF.fetch(flow.url, { headers: { "CF-Connecting-IP": flow.ip } });
  const html = await res.text();
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const cookie = /__Host-csrf=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, cookie, csrf };
}

async function postForm(flow: Flow, cookie: string, fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(flow.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `__Host-csrf=${cookie}`,
      "CF-Connecting-IP": flow.ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function authorize(flow: Flow, agentFields: Record<string, string>): Promise<string> {
  const { cookie, csrf } = await getForm(flow);
  const res = await postForm(flow, cookie, { csrf, admin_key: "test-admin-key", ...agentFields });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  return loc.searchParams.get("code")!;
}

async function exchange(flow: Flow, code: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await SELF.fetch(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

async function tokenFor(agent: string): Promise<string> {
  const flow = await startFlow();
  const code = await authorize(flow, { agent });
  return (await exchange(flow, code)).access_token;
}

function expectFrameHeaders(res: Response) {
  expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
}

describe("/authorize", () => {
  it("GET with an allowlisted redirect URI renders the form with a CSRF cookie and anti-framing headers", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    await store.createAgent("gone", "");
    await store.setDisabled("gone", true);
    const flow = await startFlow();
    const { res, html, cookie, csrf } = await getForm(flow);
    expect(res.status).toBe(200);
    expectFrameHeaders(res);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__Host-csrf=");
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(cookie).not.toBe("");
    expect(csrf).toBe(cookie);
    expect(html).toMatch(/<form[^>]*method="post"/i);
    expect(html).toContain('name="admin_key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="new_agent"');
    expect(html).toContain('<option value="alpha"');
    expect(html).not.toContain('<option value="gone"');
  });

  it("GET with a redirect URI outside the allowlist -> 400", async () => {
    const flow = await startFlow("https://evil.example/cb");
    const { res } = await getForm(flow);
    expect(res.status).toBe(400);
    expectFrameHeaders(res);
  });

  it("POST with a mismatched CSRF token -> 403", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const flow = await startFlow();
    const { cookie } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf: "not-the-token", admin_key: "test-admin-key", agent: "alpha" });
    expect(res.status).toBe(403);
    expectFrameHeaders(res);
    const noCookie = await postForm(flow, "", { csrf: "", admin_key: "test-admin-key", agent: "alpha" });
    expect(noCookie.status).toBe(403);
  });

  it("POST with a wrong admin key -> 401 and an auth_failed audit row", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: "wrong", agent: "alpha" });
    expect(res.status).toBe(401);
    expectFrameHeaders(res);
    expect(await res.text()).toContain('name="admin_key"');
    const row = await env.DB.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first<{ actor: string }>();
    expect(row?.actor).toBe(flow.ip);
  });

  it("11th wrong admin key from the same IP -> 429", async () => {
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await postForm(flow, cookie, { csrf, admin_key: "wrong", agent: "alpha" });
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it("POST with the right admin key -> 302 to the redirect URI with a code, audited as oauth_granted", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: "test-admin-key", agent: "alpha" });
    expect(res.status).toBe(302);
    expectFrameHeaders(res);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith(CALLBACK)).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get("code")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe("st4te");
    const row = await env.DB.prepare("SELECT actor, target FROM audit_log WHERE event = 'oauth_granted'").first<{ actor: string; target: string }>();
    expect(row).toMatchObject({ actor: "admin", target: "alpha" });
  });

  it("a new agent name creates the agent without revealing a key", async () => {
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: "test-admin-key", agent: "", new_agent: "Fresh-One" });
    expect(res.status).toBe(302);
    const text = await res.text();
    expect(text).not.toContain("amk_");
    expect(res.headers.get("Location")).not.toContain("amk_");
    expect(await env.DB.prepare("SELECT 1 FROM agents WHERE name = 'fresh-one'").first()).not.toBeNull();
  });

  it("an unknown or disabled agent -> 400, no grant", async () => {
    const { store } = makeStore();
    await store.createAgent("gone", "");
    await store.setDisabled("gone", true);
    for (const agent of ["nobody", "gone"]) {
      const flow = await startFlow();
      const { cookie, csrf } = await getForm(flow);
      const res = await postForm(flow, cookie, { csrf, admin_key: "test-admin-key", agent });
      expect(res.status).toBe(400);
      await res.text();
    }
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_granted'").first()).toBeNull();
  });
});

describe("OAuth tokens on /mcp", () => {
  it("unauthenticated /mcp advertises the protected resource metadata", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    await res.text();
    const meta = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
  });

  it("issues a 1h access token and a refresh token", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const flow = await startFlow();
    const tok = await exchange(flow, await authorize(flow, { agent: "alpha" }));
    expect(tok.expires_in).toBe(3600);
    expect(tok.refresh_token).toBeTruthy();
  });

  it("the token acts as the chosen agent, bound to its session like a key", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const c = new Client(await tokenFor("alpha"));
    await c.init();
    const names = await c.toolNames();
    expect(names).toContain("send_message");
    expect(names.some((n) => n.startsWith("admin_"))).toBe(false);
    const me = await c.call("whoami", {});
    expect(me.value.name).toBe("alpha");
    const row = await env.DB.prepare("SELECT principal FROM mcp_sessions WHERE id = ?").bind(c.sessionId).first<{ principal: string }>();
    expect(row?.principal).toBe("agent:alpha");
    const seen = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE name = 'alpha'").first<{ last_seen_at: number | null }>();
    expect(seen?.last_seen_at).not.toBeNull();
  });

  it("another agent's token cannot use the session", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    await store.createAgent("beta", "");
    const ca = new Client(await tokenFor("alpha"));
    await ca.init();
    const spoof = new Client(await tokenFor("beta"));
    spoof.sessionId = ca.sessionId;
    const res = await spoof.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("disabling the agent invalidates the token on the next request", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const c = new Client(await tokenFor("alpha"));
    await c.init();
    await store.setDisabled("alpha", true);
    const res = await c.post({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("a bogus OAuth-format token -> 401 and is audited as auth_failed", async () => {
    const ip = freshIp();
    const res = await new Client("alpha:grant:secret", ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    await res.text();
    const row = await env.DB.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first<{ actor: string }>();
    expect(row?.actor).toBe(ip);
  });

  it("admin over Bearer sees grant counts and admin_revoke_oauth kills the token", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    const token = await tokenFor("alpha");
    const grantId = token.split(":")[1];

    const admin = new Client("test-admin-key");
    await admin.init();
    const list = await admin.call("admin_list_agents", {});
    const alpha = list.value.agents.find((a: { name: string }) => a.name === "alpha");
    expect(alpha.oauth_grants).toBe(1);
    expect(alpha.oauth_grant_ids).toEqual([grantId]);

    const r = await admin.call("admin_revoke_oauth", { agent: "alpha", grant_id: grantId });
    expect(r.isError).toBe(false);
    const row = await env.DB.prepare("SELECT actor, target, subject FROM audit_log WHERE event = 'oauth_revoked'").first();
    expect(row).toMatchObject({ actor: "admin", target: "alpha", subject: grantId });

    const res = await new Client(token).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    await res.text();
    const after = await admin.call("admin_list_agents", {});
    expect(after.value.agents.find((a: { name: string }) => a.name === "alpha").oauth_grants).toBe(0);
  });
});
