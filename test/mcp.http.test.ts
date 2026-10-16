import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeStore, resetDb } from "./helpers";
import { Client, freshIp } from "./mcp-client";

beforeEach(resetDb);

describe("/mcp over HTTP", () => {
  it("agent key lists agent tools only", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const c = new Client(a.key);
    await c.init();
    const names = await c.toolNames();
    expect(names).toContain("send_message");
    expect(names.some((n) => n.startsWith("admin_"))).toBe(false);
  });

  it("admin key lists only admin_ tools", async () => {
    const c = new Client("test-admin-key");
    await c.init();
    const names = await c.toolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith("admin_"))).toBe(true);
  });

  it("wrong key -> 401 unauthorized, audited by IP", async () => {
    const ip = freshIp();
    const res = await new Client("amk_wrong", ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("unauthorized");
    const row = await env.DB.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first<{ actor: string }>();
    expect(row?.actor).toBe(ip);
  });

  it("11th failure from the same IP -> 429", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await new Client("wrong-key", ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it("after 10 bad keys a valid key from the same IP is 429 until the window passes", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await new Client("amk_wrong", ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(res.status).toBe(401);
      await res.text();
    }
    const good = new Client(a.key, ip);
    const locked = await good.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(locked.status).toBe(429);
    await locked.text();
    // The admin key is locked out too.
    const admin = await new Client("test-admin-key", ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(admin.status).toBe(429);
    await admin.text();
    // Age the failures past the 60 s window: the valid key works again.
    await env.DB.prepare("UPDATE audit_log SET ts = ts - 61000 WHERE event = 'auth_failed'").run();
    await good.init();
    expect(await good.toolNames()).toContain("send_message");
  });

  it("a disabled agent's valid key is 401 every time but never counts toward the lockout", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const b = await store.createAgent("beta", "");
    await store.setDisabled("alpha", true);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await new Client(a.key, ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(15).fill(401));
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE event = 'auth_failed'").first()).toBeNull();
    const good = new Client(b.key, ip);
    await good.init();
    expect(await good.toolNames()).toContain("send_message");
  });

  it("a revoked key still counts as a failed attempt", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    await store.revokeKey(a.keyId);
    const ip = freshIp();
    const res = await new Client(a.key, ip).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    await res.text();
    const row = await env.DB.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first<{ actor: string }>();
    expect(row?.actor).toBe(ip);
  });

  it("a valid key used many times from one IP is never rate limited", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const c = new Client(a.key);
    await c.init();
    for (let i = 0; i < 15; i++) expect(await c.toolNames()).toContain("send_message");
  });

  it("revoked key is rejected on an existing session", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const c = new Client(a.key);
    await c.init();
    await store.revokeKey(a.keyId);
    const res = await c.post({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
  });

  it("send_message then check_inbox end to end, and touches last_seen_at", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const b = await store.createAgent("beta", "");
    const ca = new Client(a.key);
    const cb = new Client(b.key);
    await ca.init();
    await cb.init();
    const sent = await ca.call("send_message", { to: "beta", subject: "hello", body: "world", data: { n: 1 } });
    expect(sent.isError).toBe(false);
    expect(sent.value.delivered).toEqual(["beta"]);
    const inbox = await cb.call("check_inbox", {});
    expect(inbox.isError).toBe(false);
    expect(inbox.value.messages).toHaveLength(1);
    expect(inbox.value.messages[0]).toMatchObject({ from: "alpha", subject: "hello", body: "world", data: { n: 1 } });
    const row = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE name = 'alpha'").first<{ last_seen_at: number | null }>();
    expect(row?.last_seen_at).not.toBeNull();
  });

  it("tool errors use the {code,message,hint} shape, including schema validation", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const c = new Client(a.key);
    await c.init();
    const r1 = await c.call("send_message", { to: "nobody", subject: "s", body: "b" });
    expect(r1.isError).toBe(false);
    expect(r1.value.failed).toEqual([{ agent: "nobody", code: "unknown_recipient" }]);
    const r2 = await c.call("send_message", { to: "alpha", subject: "s", body: "b", reply_to: "nope" });
    expect(r2.isError).toBe(true);
    expect(r2.value.code).toBe("invalid_reply_to");
    const r3 = await c.call("ack", { ids: Array.from({ length: 51 }, (_, i) => `id${i}`) });
    expect(r3.isError).toBe(true);
    expect(r3.value.code).toBe("invalid_input");
    expect(typeof r3.value.hint).toBe("string");
  });
});

describe("session binding", () => {
  async function twoAgents() {
    // Real clock: messages written here are read back by the worker, which uses Date.now().
    const { store } = makeStore({}, Date.now());
    const a = await store.createAgent("alpha", "");
    const b = await store.createAgent("beta", "");
    return { store, a, b };
  }

  it("agent B's key on agent A's session is rejected and cannot act as A", async () => {
    const { store, a, b } = await twoAgents();
    const ca = new Client(a.key);
    await ca.init();
    await store.send("beta", { to: "alpha", subject: "for alpha", body: "x" });
    const [pending] = await store.inbox("alpha");

    const spoof = new Client(b.key);
    spoof.sessionId = ca.sessionId;
    const r1 = await spoof.post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_message", arguments: { to: "beta", subject: "spoof", body: "x" } },
    });
    expect(r1.status).toBe(404);
    await r1.text();
    const r2 = await spoof.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ack", arguments: { ids: [pending.id] } } });
    expect(r2.status).toBe(404);
    await r2.text();

    expect(await store.inbox("beta")).toHaveLength(0);
    const sentAsAlpha = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent = 'alpha'").first<{ n: number }>();
    expect(sentAsAlpha?.n).toBe(0);

    // The legitimate owner keeps working in its session; the message was not acked.
    const inbox = await ca.call("check_inbox", {});
    expect(inbox.isError).toBe(false);
    expect(inbox.value.messages.map((m: { id: string }) => m.id)).toEqual([pending.id]);
  });

  it("an agent key on an admin session is rejected", async () => {
    const { a } = await twoAgents();
    const admin = new Client("test-admin-key");
    await admin.init();
    const spoof = new Client(a.key);
    spoof.sessionId = admin.sessionId;
    const res = await spoof.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("admin_");
    const r2 = await spoof.post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "admin_create_agent", arguments: { name: "evil" } },
    });
    expect(r2.status).toBe(404);
    await r2.text();
    expect(await env.DB.prepare("SELECT 1 FROM agents WHERE name = 'evil'").first()).toBeNull();
    // Admin continues to work.
    expect(await admin.toolNames()).toContain("admin_create_agent");
  });

  it("the admin key on an agent session is rejected", async () => {
    const { a } = await twoAgents();
    const ca = new Client(a.key);
    await ca.init();
    const spoof = new Client("test-admin-key");
    spoof.sessionId = ca.sessionId;
    const res = await spoof.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("a session id we never bound is rejected even with a valid key", async () => {
    const { a } = await twoAgents();
    const c = new Client(a.key);
    c.sessionId = "0".repeat(64);
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("the binding is stored outside the session object, keyed by the session id", async () => {
    const { a } = await twoAgents();
    const c = new Client(a.key);
    await c.init();
    const row = await env.DB.prepare("SELECT principal FROM mcp_sessions WHERE id = ?").bind(c.sessionId).first<{ principal: string }>();
    expect(row?.principal).toBe("agent:alpha");
  });
});

describe("routing", () => {
  it("unknown paths 404", async () => {
    const res = await SELF.fetch("https://x/elsewhere");
    expect(res.status).toBe(404);
  });
});
