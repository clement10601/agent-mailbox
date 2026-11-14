import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, Client, admin, createAgent, startWorker, type Worker } from "./harness";

let w: Worker;
beforeAll(async () => {
  w = await startWorker();
});
beforeEach(() => w.reset());

async function disable(name: string): Promise<void> {
  await (await admin(w)).ok("admin_disable_agent", { agent: name });
}

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
  const res = await w.fetch(`/register`, {
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
  return { clientId, redirectUri, verifier, url: `/authorize?${q}`, ip: freshIp() };
}

async function getForm(flow: Flow): Promise<{ res: Response; html: string; cookie: string; csrf: string }> {
  const res = await w.fetch(flow.url, { headers: { "CF-Connecting-IP": flow.ip } });
  const html = await res.text();
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const cookie = /__Host-csrf=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, cookie, csrf };
}

async function postForm(flow: Flow, cookie: string, fields: Record<string, string>): Promise<Response> {
  return w.fetch(flow.url, {
    method: "POST",
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
  const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, ...agentFields });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  return loc.searchParams.get("code")!;
}

async function exchange(flow: Flow, code: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await w.fetch(`/token`, {
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
    await createAgent(w, "alpha");
    await createAgent(w, "gone");
    await disable("gone");
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
    expect(html).toMatch(/<input(?=[^>]*name="agent")(?=[^>]*type="text")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*name="create")[^>]*>/);
    // Nothing about existing agents is shown before the admin key is checked.
    expect(html).not.toContain("<select");
    expect(html).not.toContain("alpha");
    expect(html).not.toContain("gone");
  });

  it("GET with a redirect URI outside the allowlist -> 400", async () => {
    const flow = await startFlow("https://evil.example/cb");
    const { res } = await getForm(flow);
    expect(res.status).toBe(400);
    expectFrameHeaders(res);
  });

  it("POST with a mismatched CSRF token -> 403", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const { cookie } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf: "not-the-token", admin_key: ADMIN_KEY, agent: "alpha" });
    expect(res.status).toBe(403);
    expectFrameHeaders(res);
    const noCookie = await postForm(flow, "", { csrf: "", admin_key: ADMIN_KEY, agent: "alpha" });
    expect(noCookie.status).toBe(403);
  });

  it("POST with a wrong admin key -> 401 and an auth_failed audit row", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: "wrong", agent: "alpha" });
    expect(res.status).toBe(401);
    expectFrameHeaders(res);
    expect(await res.text()).toContain('name="admin_key"');
    const row = await w.db.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first();
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

  it("after 10 wrong keys the correct key from the same IP is also 429 and gets no code", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    for (let i = 0; i < 10; i++) {
      const res = await postForm(flow, cookie, { csrf, admin_key: "wrong", agent: "alpha" });
      expect(res.status).toBe(401);
      await res.text();
    }
    const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "alpha" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Location")).toBeNull();
    await res.text();
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_granted'").first()).toBeNull();
    expect(await w.kv.list({ prefix: "grant:" })).toMatchObject({ keys: [] });
  });

  it("POST with the right admin key -> 302 to the redirect URI with a code, audited as oauth_granted", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "alpha" });
    expect(res.status).toBe(302);
    expectFrameHeaders(res);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith(CALLBACK)).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get("code")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe("st4te");
    const row = await w.db.prepare("SELECT actor, target FROM audit_log WHERE event = 'oauth_granted'").first();
    expect(row).toMatchObject({ actor: "admin", target: "alpha" });
  });

  it("a missing agent with the create checkbox is created and granted without revealing a key", async () => {
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "Fresh-One", create: "1" });
    expect(res.status).toBe(302);
    const text = await res.text();
    expect(text).not.toContain("amk_");
    expect(res.headers.get("Location")).not.toContain("amk_");
    expect(await w.db.prepare("SELECT 1 FROM agents WHERE name = 'fresh-one'").first()).not.toBeNull();
    const row = await w.db.prepare("SELECT target FROM audit_log WHERE event = 'oauth_granted'").first();
    expect(row?.target).toBe("fresh-one");
  });

  it("a missing agent without the create checkbox -> 400 'not found', nothing created or granted", async () => {
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "nobody" });
    expect(res.status).toBe(400);
    expectFrameHeaders(res);
    const html = await res.text();
    expect(html).toContain("not found");
    expect(html).toContain('name="admin_key"');
    expect(await w.db.prepare("SELECT 1 FROM agents WHERE name = 'nobody'").first()).toBeNull();
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_granted'").first()).toBeNull();
  });

  it("the create checkbox on an existing active agent just grants it", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "alpha", create: "1" });
    expect(res.status).toBe(302);
    const n = await w.db.prepare("SELECT COUNT(*) AS n FROM keys WHERE agent_name = 'alpha'").first();
    expect(n!.n).toBe(1);
  });

  it("an invalid agent name -> 400", async () => {
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "Bad Name!", create: "1" });
    expect(res.status).toBe(400);
    await res.text();
    expect(await w.db.prepare("SELECT COUNT(*) AS n FROM agents").first()).toEqual({ n: 0 });
  });

  it("a disabled agent -> 400, no grant, with or without the create checkbox", async () => {
    await createAgent(w, "gone");
    await disable("gone");
    for (const extra of [{}, { create: "1" }] as Record<string, string>[]) {
      const flow = await startFlow();
      const { cookie, csrf } = await getForm(flow);
      const res = await postForm(flow, cookie, { csrf, admin_key: ADMIN_KEY, agent: "gone", ...extra });
      expect(res.status).toBe(400);
      await res.text();
    }
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_granted'").first()).toBeNull();
    expect(await w.db.prepare("SELECT disabled FROM agents WHERE name = 'gone'").first()).toEqual({ disabled: 1 });
  });
});

describe("OAuth tokens on /mcp", () => {
  it("unauthenticated /mcp advertises the protected resource metadata", async () => {
    const res = await w.fetch(`/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    await res.text();
    const meta = await w.fetch(`/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    // The harness serves over plain http, so the scheme follows the request.
    const body = (await meta.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toMatch(/^https?:\/\/x\/mcp$/);
    const as = await w.fetch(`/.well-known/oauth-authorization-server`);
    const asMeta = (await as.json()) as Record<string, unknown>;
    expect(asMeta.issuer).toBe(body.authorization_servers[0]);
    expect(asMeta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asMeta.registration_endpoint).toMatch(/\/register$/);
  });

  it("issues a 1h access token and a refresh token", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const tok = await exchange(flow, await authorize(flow, { agent: "alpha" }));
    expect(tok.expires_in).toBe(3600);
    expect(tok.refresh_token).toBeTruthy();
  });

  it("the token acts as the chosen agent, bound to its session like a key", async () => {
    await createAgent(w, "alpha");
    const c = new Client(w, await tokenFor("alpha"));
    await c.init();
    const names = await c.toolNames();
    expect(names).toContain("send_message");
    expect(names.some((n) => n.startsWith("admin_"))).toBe(false);
    const me = await c.call("whoami", {});
    expect(me.value.name).toBe("alpha");
    const row = await w.db.prepare("SELECT principal FROM mcp_sessions WHERE id = ?").bind(c.sessionId).first();
    expect(row?.principal).toBe("agent:alpha");
    const seen = await w.db.prepare("SELECT last_seen_at FROM agents WHERE name = 'alpha'").first();
    expect(seen?.last_seen_at).not.toBeNull();
  });

  it("another agent's token cannot use the session", async () => {
    await createAgent(w, "alpha");
    await createAgent(w, "beta");
    const ca = new Client(w, await tokenFor("alpha"));
    await ca.init();
    const spoof = new Client(w, await tokenFor("beta"));
    spoof.sessionId = ca.sessionId;
    const res = await spoof.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("disabling the agent invalidates the token on the next request", async () => {
    await createAgent(w, "alpha");
    const c = new Client(w, await tokenFor("alpha"));
    await c.init();
    await disable("alpha");
    const res = await c.post({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("invalid OAuth-format tokens -> 401 every time, never counted, so the IP is not locked out", async () => {
    const a = await createAgent(w, "alpha");
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await new Client(w, "alpha:grant:secret", ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(15).fill(401));
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'auth_failed'").first()).toBeNull();
    // A static key from the same (shared egress) IP still works.
    const good = new Client(w, a.key, ip);
    await good.init();
    expect(await good.toolNames()).toContain("send_message");
  });

  it("a disabled agent's valid OAuth token -> 401 every time, never counted", async () => {
    await createAgent(w, "alpha");
    const token = await tokenFor("alpha");
    await disable("alpha");
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await new Client(w, token, ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(15).fill(401));
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'auth_failed'").first()).toBeNull();
  });

  it("admin over Bearer sees grant counts and admin_revoke_oauth kills the token", async () => {
    await createAgent(w, "alpha");
    const token = await tokenFor("alpha");
    const grantId = token.split(":")[1];

    const admin = new Client(w, ADMIN_KEY);
    await admin.init();
    const list = await admin.call("admin_list_agents", {});
    const alpha = list.value.agents.find((a: { name: string }) => a.name === "alpha");
    expect(alpha.oauth_grants).toBe(1);
    expect(alpha.oauth_grant_ids).toEqual([grantId]);

    const r = await admin.call("admin_revoke_oauth", { agent: "alpha", grant_id: grantId });
    expect(r.isError).toBe(false);
    const row = await w.db.prepare("SELECT actor, target, subject FROM audit_log WHERE event = 'oauth_revoked'").first();
    expect(row).toMatchObject({ actor: "admin", target: "alpha", subject: grantId });

    const res = await new Client(w, token).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    await res.text();
    const after = await admin.call("admin_list_agents", {});
    expect(after.value.agents.find((a: { name: string }) => a.name === "alpha").oauth_grants).toBe(0);
  });
});

describe("token endpoint", () => {
  it("rejects a reused code, a wrong verifier and an unknown client", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const code = await authorize(flow, { agent: "alpha" });
    const bad = await w.fetch(`/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: "wrong" }).toString(),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");
    await exchange(flow, code);
    const reused = await w.fetch(`/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: flow.verifier }).toString(),
    });
    expect(reused.status).toBe(400);
    await reused.text();
    const unknown = await w.fetch(`/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: "nope", code_verifier: flow.verifier }).toString(),
    });
    expect(unknown.status).toBe(401);
    await unknown.text();
  });

  it("refresh rotates the refresh token and issues a working access token", async () => {
    await createAgent(w, "alpha");
    const flow = await startFlow();
    const first = await exchange(flow, await authorize(flow, { agent: "alpha" }));
    const refresh = async (token: string) =>
      w.fetch(`/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: flow.clientId }).toString(),
      });
    const r = await refresh(first.refresh_token!);
    expect(r.status).toBe(200);
    const second = (await r.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const old = await refresh(first.refresh_token!);
    expect(old.status).toBe(400);
    await old.text();
    const c = await new Client(w, second.access_token).init();
    expect((await c.ok("whoami")).name).toBe("alpha");
  });

  it("registration rejects non-https redirect URIs", async () => {
    const res = await w.fetch(`/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(400);
    await res.text();
  });

  it("authorize requires PKCE S256", async () => {
    const clientId = await registerClient(CALLBACK);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "s" });
    const res = await w.fetch(`/authorize?${q}`);
    expect(res.status).toBe(400);
    await res.text();
  });
});

describe("binding codes", () => {
  async function mint(args: Record<string, unknown>): Promise<{ code: string; agent: string; create: boolean; expires_at: string }> {
    return (await admin(w)).ok("admin_create_binding_code", args);
  }

  it("the form offers a binding code field", async () => {
    const { html } = await getForm(await startFlow());
    expect(html).toMatch(/<input(?=[^>]*name="binding_code")(?=[^>]*type="password")[^>]*>/);
  });

  it("a code binds the connector to its agent, works once, and the token acts as that agent", async () => {
    await createAgent(w, "alpha");
    const minted = await mint({ agent: "Alpha" });
    expect(minted.code).toMatch(/^amb_/);
    expect(minted.agent).toBe("alpha");
    expect(Date.parse(minted.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    const stored = await w.db.prepare("SELECT code_hash FROM binding_codes").first();
    expect(stored?.code_hash).not.toBe(minted.code);

    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    // The admin fields are ignored when a code is given: the code decides the agent.
    const res = await postForm(flow, cookie, { csrf, binding_code: ` ${minted.code} `, agent: "someone-else" });
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("Location")!).searchParams.get("code")!;
    const tok = (await exchange(flow, code)).access_token;
    const c = await new Client(w, tok).init();
    expect((await c.ok("whoami")).name).toBe("alpha");
    const row = await w.db.prepare("SELECT actor, target FROM audit_log WHERE event = 'oauth_granted'").first();
    expect(row).toMatchObject({ actor: "binding_code", target: "alpha" });
    expect(await w.db.prepare("SELECT 1 FROM binding_codes").first()).toBeNull();

    const again = await startFlow();
    const f2 = await getForm(again);
    const reuse = await postForm(again, f2.cookie, { csrf: f2.csrf, binding_code: minted.code });
    expect(reuse.status).toBe(401);
    expect(await reuse.text()).toContain("already used");
    const failed = await w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'auth_failed'").first();
    expect(failed?.n).toBe(1);
  });

  it("create: true creates the agent only when the code is used", async () => {
    const minted = await mint({ agent: "new-bot", create: true });
    expect(await w.db.prepare("SELECT 1 FROM agents WHERE name = 'new-bot'").first()).toBeNull();
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, binding_code: minted.code });
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain("amk_");
    expect(await w.db.prepare("SELECT 1 FROM agents WHERE name = 'new-bot'").first()).not.toBeNull();
  });

  it("minting refuses a missing agent without create, a disabled agent, and an out-of-range ttl", async () => {
    const a = await admin(w);
    expect((await a.call("admin_create_binding_code", { agent: "nobody" })).value.code).toBe("not_found");
    await createAgent(w, "gone");
    await disable("gone");
    expect((await a.call("admin_create_binding_code", { agent: "gone", create: true })).isError).toBe(true);
    await createAgent(w, "alpha");
    expect((await a.call("admin_create_binding_code", { agent: "alpha", ttl_minutes: 0 })).isError).toBe(true);
    expect((await a.call("admin_create_binding_code", { agent: "alpha", ttl_minutes: 61 })).isError).toBe(true);
    expect(await w.db.prepare("SELECT 1 FROM binding_codes").first()).toBeNull();
  });

  it("an agent cannot mint codes", async () => {
    const { key } = await createAgent(w, "alpha");
    const c = await new Client(w, key).init();
    expect((await c.call("admin_create_binding_code", { agent: "alpha" })).isError).toBe(true);
  });

  it("an expired code is refused and consumed", async () => {
    await createAgent(w, "alpha");
    const minted = await mint({ agent: "alpha", ttl_minutes: 1 });
    await w.db.prepare("UPDATE binding_codes SET expires_at = 1").run();
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, binding_code: minted.code });
    expect(res.status).toBe(401);
    await res.text();
    expect(await w.db.prepare("SELECT 1 FROM binding_codes").first()).toBeNull();
  });

  it("a code whose agent was disabled after minting -> 400, no grant", async () => {
    await createAgent(w, "alpha");
    const minted = await mint({ agent: "alpha" });
    await disable("alpha");
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf, binding_code: minted.code });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("disabled");
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_granted'").first()).toBeNull();
  });

  it("an empty form -> 400 without counting a failure", async () => {
    const flow = await startFlow();
    const { cookie, csrf } = await getForm(flow);
    const res = await postForm(flow, cookie, { csrf });
    expect(res.status).toBe(400);
    await res.text();
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'auth_failed'").first()).toBeNull();
  });

  it("cron deletes expired codes", async () => {
    await createAgent(w, "alpha");
    await mint({ agent: "alpha" });
    await w.db.prepare("UPDATE binding_codes SET expires_at = 1").run();
    await w.scheduled();
    expect(await w.db.prepare("SELECT 1 FROM binding_codes").first()).toBeNull();
  });
});
