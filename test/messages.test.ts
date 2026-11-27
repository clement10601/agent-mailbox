// Messaging behaviour, driven through the agent tools over MCP.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, admin, createAgent, startWorker, type Worker } from "./harness";

let w: Worker;
beforeAll(async () => {
  w = await startWorker();
});
beforeEach(() => w.reset());

type Agents = Record<string, Client>;

/** Agents a, b, c with initialized clients. */
async function setup(worker: Worker = w, names = ["a", "b", "c"]): Promise<Agents> {
  const out: Agents = {};
  for (const n of names) {
    const k = await createAgent(worker, n, `agent ${n}`);
    out[n] = await new Client(worker, k.key).init();
  }
  return out;
}

const msg = (to: string | string[], extra = {}) => ({ to, subject: "hi", body: "x", ...extra });

async function send(c: Client, to: string | string[], extra = {}) {
  return c.ok("send_message", msg(to, extra));
}

async function inbox(c: Client, limit?: number): Promise<any[]> {
  return (await c.ok("check_inbox", limit === undefined ? {} : { limit })).messages;
}

async function thread(c: Client, id: string): Promise<any[]> {
  return (await c.ok("read_thread", { thread_id: id })).messages;
}

async function code(c: Client, tool: string, args: unknown): Promise<string> {
  const r = await c.call(tool, args);
  expect(r.isError, JSON.stringify(r.value)).toBe(true);
  return r.value.code;
}

const outcome = (r: any) => (r.delivered.length ? "delivered" : r.failed.map((f: any) => f.code).join(","));

describe("send / inbox", () => {
  it("delivers and lists", async () => {
    const { a, b } = await setup();
    const r = await send(a, "b");
    expect(r.delivered).toEqual(["b"]);
    expect(r.failed).toEqual([]);
    const m = await inbox(b);
    expect(m).toHaveLength(1);
    expect(m[0].from).toBe("a");
    expect(m[0].id).toBe(r.id);
    expect(new Date(m[0].sent_at).toISOString()).toBe(m[0].sent_at);
    expect(m[0].data).toBeNull();
  });

  it("normalizes recipient", async () => {
    const { a } = await setup();
    expect((await send(a, " B ")).delivered).toEqual(["b"]);
  });

  it("round-trips data", async () => {
    const { a, b } = await setup();
    await send(a, "b", { data: { k: [1, 2] } });
    expect((await inbox(b))[0].data).toEqual({ k: [1, 2] });
  });

  it("unknown or disabled recipient", async () => {
    const { a } = await setup();
    await (await admin(w)).ok("admin_disable_agent", { agent: "c" });
    expect((await send(a, "zzz")).failed).toEqual([{ agent: "zzz", code: "unknown_recipient" }]);
    expect((await send(a, "c")).failed).toEqual([{ agent: "c", code: "unknown_recipient" }]);
  });

  it("an invalid recipient name is invalid_input", async () => {
    const { a } = await setup();
    expect(await code(a, "send_message", msg("bad name!"))).toBe("invalid_input");
  });

  it("blocked: silent delivers invisibly", async () => {
    const { a, b } = await setup();
    await b.ok("block_sender", { agent: "a" });
    const r = await send(a, "b");
    expect(r.delivered).toEqual(["b"]);
    expect(await inbox(b)).toEqual([]);
  });

  it("blocked: reject reports blocked", async () => {
    const rej = await startWorker({ BLOCKED_SENDER_FEEDBACK: "reject" });
    const { a, b } = await setup(rej);
    await b.ok("block_sender", { agent: "a" });
    expect((await send(a, "b")).failed).toEqual([{ agent: "b", code: "blocked" }]);
  });

  it("inbox_full looks the same to a silently blocked sender as to an unblocked one", async () => {
    const run = async (blocked: boolean) => {
      await w.reset();
      const { a, b } = await setup();
      if (blocked) await b.ok("block_sender", { agent: "a" });
      const seq: string[] = [];
      for (let i = 0; i < 11; i++) seq.push(outcome(await send(a, "b")));
      const rows = await w.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = 'b'").first();
      return { seq, rows: rows.n };
    };
    const open = await run(false);
    const blocked = await run(true);
    expect(open.seq).toEqual([...Array(10).fill("delivered"), "inbox_full"]);
    expect(blocked).toEqual(open);
  });

  it("a blocked sender's fullness counts the recipient's visible unread plus its own suppressed rows", async () => {
    const { a, b, c } = await setup();
    for (let i = 0; i < 6; i++) await send(c, "b");
    await b.ok("block_sender", { agent: "a" });
    const seq: string[] = [];
    for (let i = 0; i < 5; i++) seq.push(outcome(await send(a, "b")));
    expect(seq).toEqual(["delivered", "delivered", "delivered", "delivered", "inbox_full"]);
    // The recipient acks its visible mail: the blocked sender sees space again, as an unblocked one would.
    await b.ok("ack", { ids: (await inbox(b)).map((m) => m.id) });
    expect((await send(a, "b")).delivered).toEqual(["b"]);
  });

  it("broadcast excludes sender, shares thread, reports full inboxes", async () => {
    const { a } = await setup();
    for (let i = 0; i < 10; i++) await send(a, "c");
    const r = await send(a, "all");
    expect(r.delivered).toEqual(["b"]);
    expect(r.failed).toEqual([{ agent: "c", code: "inbox_full" }]);
    const rows = await w.db.prepare("SELECT thread_id FROM messages WHERE thread_id = ?").bind(r.thread_id).all();
    expect(rows.results).toHaveLength(1);
    expect((await send(a, "ALL")).delivered).toEqual(["b"]);
  });

  it("broadcast rows share a thread_id", async () => {
    const { a } = await setup();
    const r = await send(a, "all");
    expect(r.delivered).toEqual(["b", "c"]);
    const rows = await w.db.prepare("SELECT thread_id FROM messages WHERE thread_id = ?").bind(r.thread_id).all();
    expect(rows.results).toHaveLength(2);
  });

  it("broadcast with only sender", async () => {
    const { a } = await setup(w, ["a"]);
    const r = await send(a, "all");
    expect(r.delivered).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("size limits", async () => {
    const { a } = await setup();
    await send(a, "b", { body: "中".repeat(10922) });
    expect(await code(a, "send_message", msg("b", { body: "中".repeat(10923) }))).toBe("too_large");
    expect(await code(a, "send_message", msg("b", { data: { s: "x".repeat(65536) } }))).toBe("too_large");
    expect(await code(a, "send_message", msg("b", { subject: "s".repeat(201) }))).toBe("invalid_input");
    await send(a, "b", { subject: "é".repeat(200) });
  });

  it("self send", async () => {
    const { a } = await setup();
    expect((await send(a, "a")).delivered).toEqual(["a"]);
  });

  it("ttl expiry", async () => {
    const { a, b } = await setup();
    const r = await send(a, "b");
    const row = await w.db.prepare("SELECT created_at, expires_at FROM messages WHERE id = ?").bind(r.id).first();
    expect(row.expires_at - row.created_at).toBe(7 * 86_400_000);
    await w.db.prepare("UPDATE messages SET expires_at = ?").bind(Date.now() + 60_000).run();
    expect(await inbox(b)).toHaveLength(1);
    await w.db.prepare("UPDATE messages SET expires_at = ?").bind(Date.now() - 1).run();
    expect(await inbox(b)).toHaveLength(0);
  });

  it("ttl 0 keeps messages without expiry", async () => {
    const forever = await startWorker({ MESSAGE_TTL_DAYS: "0" });
    const { a } = await setup(forever);
    const r = await send(a, "b");
    const row = await forever.db.prepare("SELECT expires_at FROM messages WHERE id = ?").bind(r.id).first();
    expect(row.expires_at).toBeNull();
  });

  it("inbox limit clamps", async () => {
    const { a, b } = await setup();
    for (let i = 0; i < 10; i++) await send(a, "b", { subject: `m${i}` });
    expect(await inbox(b, 0)).toHaveLength(1);
    expect(await inbox(b, -5)).toHaveLength(1);
    expect(await inbox(b, 99)).toHaveLength(10);
    expect((await inbox(b))[0].subject).toBe("m0");
  });

  it("writes an audit record without the body by default", async () => {
    const { a } = await setup();
    await send(a, "b");
    const row = await w.db.prepare("SELECT * FROM audit_log WHERE event = 'send'").first();
    expect(row.actor).toBe("a");
    expect(row.target).toBe("b");
    expect(row.subject).toBe("hi");
    expect(row.body).toBeNull();
  });

  it("AUDIT_LOG_BODIES=true keeps bodies; ttl 0 -> NULL audit expiry", async () => {
    const loud = await startWorker({ AUDIT_LOG_BODIES: "true", MESSAGE_TTL_DAYS: "0" });
    const { a } = await setup(loud);
    await send(a, "b", { body: "hello" });
    const row = await loud.db.prepare("SELECT * FROM audit_log WHERE event = 'send'").first();
    expect(row).toMatchObject({ actor: "a", target: "b", subject: "hi", body: "hello", expires_at: null });
  });

  it("send_message is rate limited at 30 per minute with retry_after 60", async () => {
    const { a, b } = await setup();
    for (let i = 0; i < 30; i++) {
      const r = await a.call("send_message", msg(i % 2 ? "c" : "a"));
      expect(r.isError).toBe(false);
    }
    const r = await a.call("send_message", msg("b"));
    expect(r.isError).toBe(true);
    expect(r.value).toMatchObject({ code: "rate_limited", retry_after: 60 });
    expect(await inbox(b)).toHaveLength(0);
  });
});

describe("reply_to / threads", () => {
  it("reply joins thread; unrelated agent rejected", async () => {
    const { a, b, c } = await setup();
    const first = await send(a, "b");
    const reply = await send(b, "a", { reply_to: first.id });
    expect(reply.thread_id).toBe(first.thread_id);
    expect(await code(c, "send_message", msg("a", { reply_to: first.id }))).toBe("invalid_reply_to");
    expect(await code(b, "send_message", msg("a", { reply_to: "nope" }))).toBe("invalid_reply_to");
    expect((await inbox(a))[0].reply_to).toBe(first.id);
  });

  it("reply to an acked tombstone works", async () => {
    const { a, b } = await setup();
    const first = await send(a, "b", { data: { x: 1 } });
    await b.ok("ack", { ids: [first.id] });
    const row = await w.db.prepare("SELECT * FROM messages WHERE id = ?").bind(first.id).first();
    expect(row.body).toBeNull();
    expect(row.subject).toBeNull();
    expect(row.data).toBeNull();
    expect(row.acked_at).not.toBeNull();
    const reply = await send(b, "a", { reply_to: first.id });
    expect(reply.thread_id).toBe(first.thread_id);
    expect((await thread(b, first.thread_id)).map((m) => m.id)).toEqual([reply.id]);
  });

  it("expired reply_to rejected", async () => {
    const { a, b } = await setup();
    const first = await send(a, "b");
    await w.db.prepare("UPDATE messages SET expires_at = ?").bind(Date.now() - 1).run();
    expect(await code(b, "send_message", msg("a", { reply_to: first.id }))).toBe("invalid_reply_to");
  });

  it("thread only shows own messages", async () => {
    const { a, b, c } = await setup();
    const bc = await send(b, "c");
    expect(await thread(a, bc.thread_id)).toEqual([]);
    expect(await thread(c, bc.thread_id)).toHaveLength(1);
  });
});

describe("ack", () => {
  it("others' ids -> not_found and untouched", async () => {
    const { a, b, c } = await setup();
    const r = await send(a, "b");
    expect(await c.ok("ack", { ids: [r.id] })).toEqual({ acked: [], failed: [{ id: r.id, code: "not_found" }] });
    expect(await inbox(b)).toHaveLength(1);
  });

  it("acks, is idempotent, and removes from inbox", async () => {
    const { a, b } = await setup();
    const r = await send(a, "b");
    expect(await b.ok("ack", { ids: [r.id, r.id] })).toEqual({ acked: [r.id], failed: [] });
    expect(await b.ok("ack", { ids: [r.id] })).toEqual({ acked: [r.id], failed: [] });
    expect(await inbox(b)).toEqual([]);
  });

  it("DELETE_ON_ACK=false keeps content", async () => {
    const keep = await startWorker({ DELETE_ON_ACK: "false" });
    const { a, b } = await setup(keep);
    const r = await send(a, "b");
    expect((await b.ok("ack", { ids: [r.id] })).acked).toEqual([r.id]);
    expect(await inbox(b)).toEqual([]);
    expect((await thread(b, r.thread_id))[0].body).toBe("x");
  });

  it("writes an audit record", async () => {
    const { a, b } = await setup();
    const r = await send(a, "b");
    await b.ok("ack", { ids: [r.id] });
    const row = await w.db.prepare("SELECT actor, target FROM audit_log WHERE event = 'ack'").first();
    expect(row).toMatchObject({ actor: "b", target: r.id });
  });
});

describe("blocks and profile tools", () => {
  it("block / unblock / list", async () => {
    const { b } = await setup();
    await b.ok("block_sender", { agent: " A " });
    await b.ok("block_sender", { agent: "c" });
    expect(await b.ok("block_sender", { agent: "a" })).toEqual({ ok: true });
    expect(await b.ok("list_blocked")).toEqual({ blocked: ["a", "c"] });
    expect(await b.ok("unblock_sender", { agent: "a" })).toEqual({ ok: true });
    expect(await b.ok("list_blocked")).toEqual({ blocked: ["c"] });
    expect(await code(b, "block_sender", { agent: "bad name!" })).toBe("invalid_input");
  });

  it("whoami returns own unread; list_agents has no unread and hides disabled agents", async () => {
    const { a, b } = await setup();
    await send(a, "b");
    expect(await b.ok("whoami")).toEqual({ name: "b", description: "agent b", unread: 1 });
    await (await admin(w)).ok("admin_disable_agent", { agent: "c" });
    const list = (await b.ok("list_agents")).agents;
    expect(list).toEqual([
      { name: "a", description: "agent a" },
      { name: "b", description: "agent b" },
    ]);
  });

  it("update_profile changes the description", async () => {
    const { a } = await setup();
    expect(await a.ok("update_profile", { description: "new" })).toEqual({ ok: true });
    expect((await a.ok("whoami")).description).toBe("new");
  });
});

describe("silent block does not leak", () => {
  async function scenario(blocked: boolean) {
    await w.reset();
    const { a, b } = await setup();
    if (blocked) await b.ok("block_sender", { agent: "a" });
    const first = await send(a, "b");
    const t = await thread(a, first.thread_id);
    const r = await a.call("send_message", msg("b", { reply_to: first.id }));
    const reply = r.isError ? { ok: false, code: r.value.code } : { ok: true, same: r.value.thread_id === first.thread_id };
    return { delivered: first.delivered, n: t.length, to: t.map((m) => m.to), reply };
  }

  it("sender's read_thread and reply_to behave identically", async () => {
    const plain = await scenario(false);
    const blocked = await scenario(true);
    expect(blocked).toEqual(plain);
    expect(blocked.n).toBe(1);
    expect(blocked.reply).toEqual({ ok: true, same: true });
  });

  it("recipient never sees a suppressed message", async () => {
    const { a, b } = await setup();
    await b.ok("block_sender", { agent: "a" });
    const r = await send(a, "b");
    expect(await inbox(b)).toEqual([]);
    expect((await b.ok("whoami")).unread).toBe(0);
    const listed = (await (await admin(w)).ok("admin_list_agents")).agents;
    expect(listed.find((x: any) => x.name === "b").unread).toBe(0);
    expect(await thread(b, r.thread_id)).toEqual([]);
    expect(await b.ok("ack", { ids: [r.id] })).toEqual({ acked: [], failed: [{ id: r.id, code: "not_found" }] });
    expect(await code(b, "send_message", msg("a", { reply_to: r.id }))).toBe("invalid_reply_to");
  });

  it("broadcast with a silent blocker", async () => {
    const { a, b, c } = await setup();
    await c.ok("block_sender", { agent: "a" });
    const r = await send(a, "all");
    expect(r.delivered).toEqual(["b", "c"]);
    expect((await thread(a, r.thread_id)).map((m) => m.to).sort()).toEqual(["b", "c"]);
    expect(await inbox(c)).toEqual([]);
    expect(await thread(c, r.thread_id)).toEqual([]);
    expect(await inbox(b)).toHaveLength(1);
  });

  it("silent block + full inbox reports inbox_full like an unblocked sender and writes no row", async () => {
    const { a, b, c } = await setup();
    for (let i = 0; i < 10; i++) await send(c, "b");
    await b.ok("block_sender", { agent: "a" });
    expect((await send(a, "b")).failed).toEqual([{ agent: "b", code: "inbox_full" }]);
    const n = await w.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent = 'a'").first();
    expect(n.n).toBe(0);
    expect(await inbox(b)).toHaveLength(10);
  });
});

describe("topic and inbox filtering", () => {
  it("stores trimmed topic, returns it in inbox and read_thread, and treats blank as null", async () => {
    const { a, b } = await setup();
    const r1 = await send(a, "b", { topic: "  deploy/prod  ", subject: "s1" });
    const r2 = await send(a, "b", { topic: "   ", subject: "s2" });
    const r3 = await send(a, "b", { subject: "s3" });

    const msgs = await inbox(b);
    expect(msgs.map((m) => ({ id: m.id, topic: m.topic }))).toEqual([
      { id: r1.id, topic: "deploy/prod" },
      { id: r2.id, topic: null },
      { id: r3.id, topic: null },
    ]);

    const t = await thread(b, r1.thread_id);
    expect(t).toHaveLength(1);
    expect(t[0].topic).toBe("deploy/prod");
  });

  it("rejects overly long or control-character topics", async () => {
    const { a } = await setup();
    await send(a, "b", { topic: "é".repeat(64) });
    expect(await code(a, "send_message", msg("b", { topic: "é".repeat(65) }))).toBe("invalid_input");
    expect(await code(a, "send_message", msg("b", { topic: "line1\nline2" }))).toBe("invalid_input");
  });

  it("filters check_inbox by topic, from (case-insensitive), and both with limit", async () => {
    const { a, b, c } = await setup();
    await send(a, "b", { topic: "alerts", subject: "a-alerts-1" });
    await send(c, "b", { topic: "alerts", subject: "c-alerts-1" });
    await send(a, "b", { topic: "digest", subject: "a-digest-1" });
    await send(a, "b", { topic: "alerts", subject: "a-alerts-2" });
    await send(c, "b", { subject: "c-none" });

    const byTopic = (await b.ok("check_inbox", { topic: " alerts " })).messages;
    expect(byTopic.map((m: any) => m.subject)).toEqual(["a-alerts-1", "c-alerts-1", "a-alerts-2"]);

    const byFrom = (await b.ok("check_inbox", { from: " A " })).messages;
    expect(byFrom.map((m: any) => m.subject)).toEqual(["a-alerts-1", "a-digest-1", "a-alerts-2"]);

    const combined = (await b.ok("check_inbox", { topic: "alerts", from: "A", limit: 1 })).messages;
    expect(combined.map((m: any) => m.subject)).toEqual(["a-alerts-1"]);

    // Blank filter strings behave like no filter (backwards compatible).
    const all = (await b.ok("check_inbox", { topic: "  ", from: "" })).messages;
    expect(all).toHaveLength(5);
  });
});

describe("multi-recipient send_message", () => {
  it("delivers to multiple recipients sharing one thread_id and deduplicates case-insensitively", async () => {
    const { a, b, c } = await setup();
    const r = await send(a, [" B ", "c", "b"], { topic: "team-sync", subject: "standup" });
    expect(r.delivered).toEqual(["b", "c"]);
    expect(r.failed).toEqual([]);

    const ib = await inbox(b);
    const ic = await inbox(c);
    expect(ib).toHaveLength(1);
    expect(ic).toHaveLength(1);
    expect(ib[0].id).toBe(r.id);
    expect(ic[0].id).not.toBe(ib[0].id);
    expect(ib[0].thread_id).toBe(r.thread_id);
    expect(ic[0].thread_id).toBe(r.thread_id);
    expect(ib[0].topic).toBe("team-sync");
    expect(ic[0].topic).toBe("team-sync");

    // Audit log records comma-joined targets and is searchable per recipient.
    const adm = await admin(w);
    const bLog = (await adm.ok("admin_audit_log", { agent: "b" })).entries;
    expect(bLog[0]).toMatchObject({ event: "send", actor: "a", target: "b,c", subject: "standup" });
  });

  it("joins an existing thread when reply_to is set", async () => {
    const { a, b, c } = await setup();
    const first = await send(a, "b", { subject: "kickoff" });
    const reply = await send(b, ["a", "c"], { reply_to: first.id, subject: "looping in c" });
    expect(reply.thread_id).toBe(first.thread_id);
    expect(reply.delivered).toEqual(["a", "c"]);
    expect((await inbox(a))[0].thread_id).toBe(first.thread_id);
    expect((await inbox(c))[0].thread_id).toBe(first.thread_id);
  });

  it("handles partial failures: unknown, disabled, inbox_full, and reject block", async () => {
    const rej = await startWorker({ BLOCKED_SENDER_FEEDBACK: "reject" });
    const { a, b, c } = await setup(rej, ["a", "b", "c", "d", "e"]);
    await (await admin(rej)).ok("admin_disable_agent", { agent: "d" });
    for (let i = 0; i < 10; i++) await send(a, "c");
    await b.ok("block_sender", { agent: "a" });

    const r = await send(a, ["e", "b", "c", "d", "ghost"]);
    expect(r.delivered).toEqual(["e"]);
    expect(r.failed).toEqual([
      { agent: "b", code: "blocked" },
      { agent: "c", code: "inbox_full" },
      { agent: "d", code: "unknown_recipient" },
      { agent: "ghost", code: "unknown_recipient" },
    ]);
  });

  it("respects silent block without leaking in multi-recipient send", async () => {
    const { a, b, c } = await setup();
    await c.ok("block_sender", { agent: "a" });
    const r = await send(a, ["b", "c"]);
    expect(r.delivered).toEqual(["b", "c"]);
    expect(r.failed).toEqual([]);
    expect(await inbox(b)).toHaveLength(1);
    expect(await inbox(c)).toEqual([]);
  });

  it("validates empty array, 'all' in array, invalid names, and >50 recipients", async () => {
    const { a } = await setup();
    expect(await code(a, "send_message", msg([]))).toBe("invalid_input");
    expect(await code(a, "send_message", msg(["b", "all"]))).toBe("invalid_input");
    expect(await code(a, "send_message", msg(["b", "ALL"]))).toBe("invalid_input");
    expect(await code(a, "send_message", msg(["b", "bad name!"]))).toBe("invalid_input");
    const tooMany = Array.from({ length: 51 }, (_, i) => `a${i}`);
    expect(await code(a, "send_message", msg(tooMany))).toBe("invalid_input");
    const n = await w.db.prepare("SELECT COUNT(*) AS n FROM messages").first();
    expect(n.n).toBe(0);
  });
});
