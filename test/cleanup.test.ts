// The hourly cron: expired messages, tombstones, audit rows and session bindings are deleted.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, createAgent, startWorker, type Worker } from "./harness";

const DAY = 86_400_000;
const msg = (to: string) => ({ to, subject: "hi", body: "x" });

let w: Worker;
beforeAll(async () => {
  w = await startWorker();
});
beforeEach(() => w.reset());

async function setup(worker: Worker = w): Promise<{ a: Client; b: Client }> {
  const a = await createAgent(worker, "a");
  const b = await createAgent(worker, "b");
  return { a: await new Client(worker, a.key).init(), b: await new Client(worker, b.key).init() };
}

async function count(worker: Worker, table: string): Promise<number> {
  return (await worker.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
}

/** Moves every expiry in `table` by `ms` (negative = into the past). */
async function age(worker: Worker, table: string, ms: number): Promise<void> {
  await worker.db.prepare(`UPDATE ${table} SET expires_at = expires_at + ? WHERE expires_at IS NOT NULL`).bind(ms).run();
}

describe("cleanup", () => {
  it("deletes expired messages and logs the counts", async () => {
    const { a } = await setup();
    for (let i = 0; i < 3; i++) await a.ok("send_message", msg("b"));
    await w.scheduled();
    expect(await count(w, "messages")).toBe(3);
    await age(w, "messages", -8 * DAY);
    await w.scheduled();
    expect(await count(w, "messages")).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(w.logs().some((l) => /cleanup: deleted 3 messages, \d+ audit rows, \d+ sessions/.test(l))).toBe(true);
  });

  it("never deletes by time when MESSAGE_TTL_DAYS=0", async () => {
    const forever = await startWorker({ MESSAGE_TTL_DAYS: "0" });
    const { a } = await setup(forever);
    await a.ok("send_message", msg("b"));
    expect((await forever.db.prepare("SELECT expires_at FROM messages").first()).expires_at).toBeNull();
    await forever.scheduled();
    expect(await count(forever, "messages")).toBe(1);
  });

  it("keeps tombstones until expiry", async () => {
    const { a, b } = await setup();
    const { id } = await a.ok("send_message", msg("b"));
    await b.ok("ack", { ids: [id] });
    expect(await w.db.prepare("SELECT subject, body FROM messages WHERE id = ?").bind(id).first()).toEqual({ subject: null, body: null });
    await age(w, "messages", -DAY);
    await w.scheduled();
    expect(await count(w, "messages")).toBe(1);
    await age(w, "messages", -7 * DAY);
    await w.scheduled();
    expect(await count(w, "messages")).toBe(0);
  });

  it("with MESSAGE_TTL_DAYS=0, tombstones expire 7 days after ack while unacked messages stay", async () => {
    const forever = await startWorker({ MESSAGE_TTL_DAYS: "0" });
    const { a, b } = await setup(forever);
    const acked = await a.ok("send_message", msg("b"));
    const kept = await a.ok("send_message", msg("b"));
    const before = Date.now();
    await b.ok("ack", { ids: [acked.id] });
    const row = await forever.db.prepare("SELECT acked_at, expires_at FROM messages WHERE id = ?").bind(acked.id).first();
    expect(row.acked_at).toBeGreaterThanOrEqual(before);
    expect(row.expires_at).toBe(row.acked_at + 7 * DAY);
    await forever.scheduled();
    expect(await count(forever, "messages")).toBe(2);
    await age(forever, "messages", -7 * DAY);
    await forever.scheduled();
    const left = (await forever.db.prepare("SELECT id, expires_at FROM messages").all()).results;
    expect(left).toEqual([{ id: kept.id, expires_at: null }]);
  });

  it("with a TTL, ack keeps the message's own expiry for its tombstone", async () => {
    const short = await startWorker({ MESSAGE_TTL_DAYS: "3" });
    const { a, b } = await setup(short);
    const { id } = await a.ok("send_message", msg("b"));
    const sent = await short.db.prepare("SELECT created_at, expires_at FROM messages WHERE id = ?").bind(id).first();
    expect(sent.expires_at).toBe(sent.created_at + 3 * DAY);
    await b.ok("ack", { ids: [id] });
    const after = await short.db.prepare("SELECT expires_at FROM messages WHERE id = ?").bind(id).first();
    expect(after.expires_at).toBe(sent.expires_at);
  });

  it("with MESSAGE_TTL_DAYS=0, suppressed rows keep a NULL expiry like normal messages", async () => {
    const forever = await startWorker({ MESSAGE_TTL_DAYS: "0" });
    const { a, b } = await setup(forever);
    await b.ok("block_sender", { agent: "a" });
    await a.ok("send_message", msg("b"));
    expect(await forever.db.prepare("SELECT suppressed, expires_at FROM messages WHERE from_agent = 'a'").first()).toEqual({ suppressed: 1, expires_at: null });
  });

  it("deletes expired audit rows and session bindings", async () => {
    await setup();
    expect(await count(w, "audit_log")).toBeGreaterThan(0);
    expect(await count(w, "mcp_sessions")).toBeGreaterThan(0);
    await age(w, "audit_log", -8 * DAY);
    await age(w, "mcp_sessions", -31 * DAY);
    await w.scheduled();
    expect(await count(w, "audit_log")).toBe(0);
    expect(await count(w, "mcp_sessions")).toBe(0);
  });

  it("a failing table does not stop the others and is reported", async () => {
    await setup();
    await age(w, "audit_log", -8 * DAY);
    await w.db.prepare("ALTER TABLE messages RENAME TO messages_gone").run();
    await w.scheduled();
    expect(await count(w, "audit_log")).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(w.logs().some((l) => /cleanup: .*failed: messages/.test(l))).toBe(true);
  });
});
