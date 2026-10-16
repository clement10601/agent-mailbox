import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { Store } from "../src/store";
import { defaultConfig, makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

const DAY = 86_400_000;
const msg = (to: string) => ({ to, subject: "hi", body: "x" });

async function setup(overrides = {}) {
  const r = makeStore(overrides);
  for (const n of ["a", "b", "bb"]) await r.store.createAgent(n, "");
  return r;
}
async function count(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return r!.n;
}

describe("cleanup", () => {
  it("deletes expired messages", async () => {
    const { store, clock } = await setup();
    for (let i = 0; i < 3; i++) await store.send("a", msg("b"));
    clock.advance(8 * DAY);
    const r = await store.cleanup();
    expect(r.messages).toBe(3);
    expect(await count("messages")).toBe(0);
  });

  it("never deletes by time when ttlDays=0", async () => {
    const { store, clock } = await setup({ ttlDays: 0 });
    await store.send("a", msg("b"));
    const row = await env.DB.prepare("SELECT expires_at FROM messages").first<{ expires_at: number | null }>();
    expect(row!.expires_at).toBeNull();
    clock.advance(365 * DAY);
    expect((await store.cleanup()).messages).toBe(0);
    expect(await count("messages")).toBe(1);
  });

  it("respects the batch size", async () => {
    const { store, clock } = await setup();
    for (let i = 0; i < 3; i++) await store.send("a", msg("b"));
    clock.advance(8 * DAY);
    expect((await store.cleanup(2)).messages).toBe(2);
    expect((await store.cleanup(2)).messages).toBe(1);
  });

  it("keeps tombstones until expiry", async () => {
    const { store, clock } = await setup({ deleteOnAck: true });
    const { id } = await store.send("a", msg("b"));
    await store.ack("b", [id]);
    const row = await env.DB.prepare("SELECT subject, body FROM messages WHERE id = ?").bind(id).first();
    expect(row).toEqual({ subject: null, body: null });
    clock.advance(DAY);
    expect((await store.cleanup()).messages).toBe(0);
    expect(await count("messages")).toBe(1);
    clock.advance(7 * DAY);
    expect((await store.cleanup()).messages).toBe(1);
    expect(await count("messages")).toBe(0);
  });

  it("with ttlDays=0, tombstones expire 7 days after ack while unacked messages stay", async () => {
    const { store, clock } = await setup({ ttlDays: 0, deleteOnAck: true });
    const acked = await store.send("a", msg("b"));
    const kept = await store.send("a", msg("b"));
    const ackedAt = clock.now;
    await store.ack("b", [acked.id]);
    const row = await env.DB.prepare("SELECT expires_at FROM messages WHERE id = ?").bind(acked.id).first<{ expires_at: number | null }>();
    expect(row!.expires_at).toBe(ackedAt + 7 * DAY);
    clock.advance(7 * DAY - 1);
    expect((await store.cleanup()).messages).toBe(0);
    clock.advance(2); // 7 days + 1 ms after the ack
    expect((await store.cleanup()).messages).toBe(1);
    const left = await env.DB.prepare("SELECT id, expires_at FROM messages").all<{ id: string; expires_at: number | null }>();
    expect(left.results).toEqual([{ id: kept.id, expires_at: null }]);
  });

  it("with a TTL, ack keeps the message's own expiry for its tombstone", async () => {
    const { store, clock } = await setup({ ttlDays: 3, deleteOnAck: true });
    const sentAt = clock.now;
    const { id } = await store.send("a", msg("b"));
    clock.advance(DAY);
    await store.ack("b", [id]);
    const row = await env.DB.prepare("SELECT expires_at FROM messages WHERE id = ?").bind(id).first<{ expires_at: number }>();
    expect(row!.expires_at).toBe(sentAt + 3 * DAY);
  });

  it("with ttlDays=0, suppressed rows keep a NULL expiry like normal messages", async () => {
    const { store } = await setup({ ttlDays: 0 });
    await store.block("b", "a");
    await store.send("a", msg("b"));
    const row = await env.DB.prepare("SELECT suppressed, expires_at FROM messages").first();
    expect(row).toEqual({ suppressed: 1, expires_at: null });
  });

  it("deletes expired audit rows", async () => {
    const { store, clock } = await setup();
    await store.audit("x", "a", "b");
    clock.advance(8 * DAY);
    const r = await store.cleanup();
    expect(r.audit).toBeGreaterThanOrEqual(1);
    expect(await count("audit_log")).toBe(0);
  });
});

/** env.DB, except that statements whose SQL contains `failOn` throw when prepared. */
function failingDb(failOn: string): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(failOn)) throw new Error("D1 down");
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("cleanup failures", () => {
  it("a failing step does not skip the others and is reported", async () => {
    const { store, clock } = await setup();
    await store.send("a", msg("b"));
    await store.bindSession("s1", "agent:a");
    clock.advance(31 * DAY);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new Store(failingDb("DELETE FROM messages"), defaultConfig, () => clock.now);
    const r = await broken.cleanup();
    errors.mockRestore();
    expect(r.messages).toBe(0);
    expect(r.audit).toBeGreaterThanOrEqual(1);
    expect(r.sessions).toBe(1);
    expect(r.failed).toEqual(["messages"]);
    expect(await count("messages")).toBe(1);
    expect(await count("audit_log")).toBe(0);
  });

  it("the scheduled handler logs messages, audit and sessions counts", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();
    expect(logs.some((l) => /cleanup: .*messages.*audit.*sessions/.test(l))).toBe(true);
  });
});

describe("auditLog", () => {
  it("filters by actor or target with exact names", async () => {
    const { store, clock } = await setup();
    await env.DB.prepare("DELETE FROM audit_log").run();
    await store.audit("e1", "b", "a");
    clock.advance(10);
    await store.audit("e2", "a", "b");
    clock.advance(10);
    await store.audit("e3", "a", "c,b,d");
    clock.advance(10);
    await store.audit("e4", "bb", "a");
    clock.advance(10);
    await store.audit("e5", "a", "bb,c");
    const rows = await store.auditLog({ agent: "b" });
    expect(rows.map((r) => r.event)).toEqual(["e3", "e2", "e1"]);
    expect(new Date(rows[0].ts).toISOString()).toBe(rows[0].ts);
  });

  it("supports since and limit, newest first", async () => {
    const { store, clock } = await setup();
    await env.DB.prepare("DELETE FROM audit_log").run();
    const t0 = clock.now;
    for (let i = 0; i < 5; i++) {
      await store.audit(`e${i}`, "a", "b");
      clock.advance(10);
    }
    expect((await store.auditLog({ limit: 2 })).map((r) => r.event)).toEqual(["e4", "e3"]);
    expect((await store.auditLog({ since: t0 + 20 })).map((r) => r.event)).toEqual(["e4", "e3", "e2"]);
    expect(await store.auditLog({})).toHaveLength(5);
  });
});

describe("mcp session bindings", () => {
  it("binds, reads back, and expires after 30 days", async () => {
    const { store, clock } = makeStore();
    await store.bindSession("s1", "agent:a");
    expect(await store.sessionPrincipal("s1")).toBe("agent:a");
    expect(await store.sessionPrincipal("nope")).toBeNull();
    // A stored binding is never overwritten by a later identity.
    await store.bindSession("s1", "admin");
    expect(await store.sessionPrincipal("s1")).toBe("agent:a");
    clock.advance(31 * 86_400_000);
    expect(await store.sessionPrincipal("s1")).toBeNull();
    expect((await store.cleanup()).sessions).toBe(1);
  });
});
