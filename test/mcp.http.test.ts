import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `203.0.113.${ipCounter}`;
}

/** Parses a JSON or SSE response body into the JSON-RPC messages it carries. */
async function rpcMessages(res: Response): Promise<any[]> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
  }
  return text ? [JSON.parse(text)] : [];
}

class Client {
  sessionId: string | null = null;
  nextId = 1;
  constructor(private key: string, private ip = freshIp()) {}

  async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "CF-Connecting-IP": this.ip,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
      headers["mcp-protocol-version"] = "2025-06-18";
    }
    return SELF.fetch("https://x/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  }

  async rpc(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    expect(res.status).toBe(200);
    const msgs = await rpcMessages(res);
    const m = msgs.find((x) => x.id === id);
    expect(m, JSON.stringify(msgs)).toBeDefined();
    return m;
  }

  async init(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(res.status).toBe(200);
    this.sessionId = res.headers.get("mcp-session-id");
    expect(this.sessionId).toBeTruthy();
    await rpcMessages(res);
    const n = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await n.text();
  }

  async toolNames(): Promise<string[]> {
    const r = await this.rpc("tools/list");
    return r.result.tools.map((t: { name: string }) => t.name);
  }

  async call(name: string, args: unknown): Promise<{ isError: boolean; value: any }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    return { isError: !!r.result.isError, value: JSON.parse(r.result.content[0].text) };
  }
}

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

describe("routing", () => {
  it("unknown paths 404", async () => {
    const res = await SELF.fetch("https://x/elsewhere");
    expect(res.status).toBe(404);
  });
});
