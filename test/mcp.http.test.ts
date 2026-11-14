import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, Client, admin, agentClient, createAgent, freshIp, startWorker, type Worker } from "./harness";

let w: Worker;
beforeAll(async () => {
  w = await startWorker();
});
beforeEach(() => w.reset());

const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

describe("/mcp over HTTP", () => {
  it("agent key lists agent tools only", async () => {
    const c = await agentClient(w, "alpha");
    const names = await c.toolNames();
    expect(names).toContain("send_message");
    expect(names.some((n) => n.startsWith("admin_"))).toBe(false);
  });

  it("admin key lists only admin_ tools", async () => {
    const names = await (await admin(w)).toolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith("admin_"))).toBe(true);
  });

  it("initialize negotiates the protocol version and names the server", async () => {
    const c = new Client(w, ADMIN_KEY);
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } });
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("agent-mailbox");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("requests other than initialize need a session", async () => {
    const res = await new Client(w, ADMIN_KEY).post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(400);
    await res.text();
  });

  it("wrong key -> 401 unauthorized, audited by IP", async () => {
    const ip = freshIp();
    const res = await new Client(w, "amk_wrong", ip).post(initBody);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("unauthorized");
    const row = await w.db.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first();
    expect(row?.actor).toBe(ip);
  });

  it("11th failure from the same IP -> 429", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await new Client(w, "wrong-key", ip).post(initBody);
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it("after 10 bad keys a valid key from the same IP is 429 until the window passes", async () => {
    const a = await createAgent(w, "alpha");
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await new Client(w, "amk_wrong", ip).post(initBody);
      expect(res.status).toBe(401);
      await res.text();
    }
    const good = new Client(w, a.key, ip);
    const locked = await good.post(initBody);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBe("60");
    await locked.text();
    // The admin key is locked out too.
    const adm = await new Client(w, ADMIN_KEY, ip).post(initBody);
    expect(adm.status).toBe(429);
    await adm.text();
    // Age the failures past the 60 s window: the valid key works again.
    await w.db.prepare("UPDATE audit_log SET ts = ts - 61000 WHERE event = 'auth_failed'").run();
    await good.init();
    expect(await good.toolNames()).toContain("send_message");
  });

  it("a disabled agent's valid key is 401 every time but never counts toward the lockout", async () => {
    const a = await createAgent(w, "alpha");
    const b = await createAgent(w, "beta");
    await (await admin(w)).ok("admin_disable_agent", { agent: "alpha" });
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await new Client(w, a.key, ip).post(initBody);
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array(15).fill(401));
    expect(await w.db.prepare("SELECT 1 FROM audit_log WHERE event = 'auth_failed'").first()).toBeNull();
    const good = await new Client(w, b.key, ip).init();
    expect(await good.toolNames()).toContain("send_message");
  });

  it("a revoked key still counts as a failed attempt", async () => {
    const a = await createAgent(w, "alpha");
    await (await admin(w)).ok("admin_revoke_key", { key_id: a.key_id });
    const ip = freshIp();
    const res = await new Client(w, a.key, ip).post(initBody);
    expect(res.status).toBe(401);
    await res.text();
    const row = await w.db.prepare("SELECT actor FROM audit_log WHERE event = 'auth_failed'").first();
    expect(row?.actor).toBe(ip);
  });

  it("a valid key used many times from one IP is never rate limited", async () => {
    const c = await agentClient(w, "alpha");
    for (let i = 0; i < 15; i++) expect(await c.toolNames()).toContain("send_message");
  });

  it("revoked key is rejected on an existing session", async () => {
    const a = await createAgent(w, "alpha");
    const c = await new Client(w, a.key).init();
    await (await admin(w)).ok("admin_revoke_key", { key_id: a.key_id });
    const res = await c.post({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("send_message then check_inbox end to end, and touches last_seen_at", async () => {
    const ca = await agentClient(w, "alpha");
    const cb = await agentClient(w, "beta");
    const sent = await ca.ok("send_message", { to: "beta", subject: "hello", body: "world", data: { n: 1 } });
    expect(sent.delivered).toEqual(["beta"]);
    const inbox = await cb.ok("check_inbox");
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ from: "alpha", to: "beta", subject: "hello", body: "world", data: { n: 1 }, reply_to: null });
    expect(inbox.messages[0].sent_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const row = await w.db.prepare("SELECT last_seen_at FROM agents WHERE name = 'alpha'").first();
    expect(row?.last_seen_at).not.toBeNull();
  });

  it("tool errors use the {code,message,hint} shape, including schema validation", async () => {
    const c = await agentClient(w, "alpha");
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
    const r4 = await c.call("send_message", { to: "alpha" });
    expect(r4.isError).toBe(true);
    expect(r4.value.code).toBe("invalid_input");
    const r5 = await c.call("no_such_tool", {});
    expect(r5.isError).toBe(true);
    expect(r5.value.code).toBe("invalid_input");
  });

  it("an agent cannot call admin tools by name", async () => {
    const c = await agentClient(w, "alpha");
    const r = await c.call("admin_create_agent", { name: "evil" });
    expect(r.isError).toBe(true);
    expect(await w.db.prepare("SELECT 1 FROM agents WHERE name = 'evil'").first()).toBeNull();
  });

  it("notifications get 202, GET is 405, DELETE ends the session", async () => {
    const c = await agentClient(w, "alpha");
    const n = await c.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    await n.text();
    const g = await w.fetch("/mcp", { method: "GET", headers: { Authorization: `Bearer ${ADMIN_KEY}`, "CF-Connecting-IP": freshIp() } });
    expect(g.status).toBe(405);
    await g.text();
    const d = await w.fetch("/mcp", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${(c as any).key}`, "mcp-session-id": c.sessionId!, "CF-Connecting-IP": freshIp() },
    });
    expect(d.status).toBe(200);
    await d.text();
    const after = await c.post({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    expect(after.status).toBe(404);
    await after.text();
  });
});

describe("session binding", () => {
  it("agent B's key on agent A's session is rejected and cannot act as A", async () => {
    const a = await createAgent(w, "alpha");
    const b = await createAgent(w, "beta");
    const ca = await new Client(w, a.key).init();
    const cb = await new Client(w, b.key).init();
    await cb.ok("send_message", { to: "alpha", subject: "for alpha", body: "x" });
    const [pending] = (await ca.ok("check_inbox")).messages;

    const spoof = new Client(w, b.key);
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

    expect((await cb.ok("check_inbox")).messages).toHaveLength(0);
    const sentAsAlpha = await w.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent = 'alpha'").first();
    expect(sentAsAlpha?.n).toBe(0);
    // The legitimate owner keeps working in its session; the message was not acked.
    const inbox = await ca.ok("check_inbox");
    expect(inbox.messages.map((m: { id: string }) => m.id)).toEqual([pending.id]);
  });

  it("an agent key on an admin session is rejected", async () => {
    const a = await createAgent(w, "alpha");
    const adm = await admin(w);
    const spoof = new Client(w, a.key);
    spoof.sessionId = adm.sessionId;
    const res = await spoof.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("admin_");
    const r2 = await spoof.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "admin_create_agent", arguments: { name: "evil" } } });
    expect(r2.status).toBe(404);
    await r2.text();
    expect(await w.db.prepare("SELECT 1 FROM agents WHERE name = 'evil'").first()).toBeNull();
    expect(await adm.toolNames()).toContain("admin_create_agent");
  });

  it("the admin key on an agent session is rejected", async () => {
    const ca = await agentClient(w, "alpha");
    const spoof = new Client(w, ADMIN_KEY);
    spoof.sessionId = ca.sessionId;
    const res = await spoof.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("a session id we never bound is rejected even with a valid key", async () => {
    const a = await createAgent(w, "alpha");
    const c = new Client(w, a.key);
    c.sessionId = "0".repeat(64);
    const res = await c.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("the binding is stored in D1, keyed by the session id, and expires", async () => {
    const c = await agentClient(w, "alpha");
    const row = await w.db.prepare("SELECT principal FROM mcp_sessions WHERE id = ?").bind(c.sessionId).first();
    expect(row?.principal).toBe("agent:alpha");
    await w.db.prepare("UPDATE mcp_sessions SET expires_at = 1").run();
    const res = await c.post({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("ADMIN_KEY strength", () => {
  it("/mcp answers 500 and logs the reason when ADMIN_KEY is too short", async () => {
    const weak = await startWorker({}, "short-key");
    const res = await new Client(weak, "short-key").post(initBody);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    await new Promise((r) => setTimeout(r, 200));
    expect(weak.logs().join("\n")).toContain("shorter than 32");
  });

  it("/mcp answers 500 when ADMIN_KEY is unset, for any bearer", async () => {
    const none = await startWorker({}, null);
    const res = await new Client(none, "amk_anything").post(initBody);
    expect(res.status).toBe(500);
    await res.text();
  });
});
