import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeStore, resetDb } from "./helpers";

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

  it("deletes expired audit rows", async () => {
    const { store, clock } = await setup();
    await store.audit("x", "a", "b");
    clock.advance(8 * DAY);
    const r = await store.cleanup();
    expect(r.audit).toBeGreaterThanOrEqual(1);
    expect(await count("audit_log")).toBe(0);
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
