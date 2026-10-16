import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MailboxError } from "../src/errors";
import { makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => null,
    (x) => x
  );
  expect(e).toBeInstanceOf(MailboxError);
  expect((e as MailboxError).code).toBe(code);
}

async function setup(overrides = {}) {
  const r = makeStore(overrides);
  for (const n of ["a", "b", "c"]) await r.store.createAgent(n, "");
  return r;
}
const msg = (to: string, extra = {}) => ({ to, subject: "hi", body: "x", ...extra });

describe("send / inbox", () => {
  it("delivers and lists", async () => {
    const { store } = await setup();
    const r = await store.send("a", msg("b"));
    expect(r.delivered).toEqual(["b"]);
    expect(r.failed).toEqual([]);
    const inbox = await store.inbox("b");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe("a");
    expect(inbox[0].id).toBe(r.id);
    expect(new Date(inbox[0].sent_at).toISOString()).toBe(inbox[0].sent_at);
    expect(inbox[0].data).toBeNull();
  });

  it("normalizes recipient", async () => {
    const { store } = await setup();
    expect((await store.send("a", msg(" B "))).delivered).toEqual(["b"]);
  });

  it("round-trips data", async () => {
    const { store } = await setup();
    await store.send("a", msg("b", { data: { k: [1, 2] } }));
    expect((await store.inbox("b"))[0].data).toEqual({ k: [1, 2] });
  });

  it("unknown or disabled recipient", async () => {
    const { store } = await setup();
    await store.setDisabled("c", true);
    expect((await store.send("a", msg("zzz"))).failed).toEqual([{ agent: "zzz", code: "unknown_recipient" }]);
    expect((await store.send("a", msg("c"))).failed).toEqual([{ agent: "c", code: "unknown_recipient" }]);
  });

  it("blocked: silent vs reject", async () => {
    const s = await setup();
    await s.store.block("b", "a");
    const r = await s.store.send("a", msg("b"));
    expect(r.delivered).toEqual(["b"]);
    expect(await s.store.inbox("b")).toEqual([]);
    await resetDb();
    const rej = await setup({ blockedSenderFeedback: "reject" });
    await rej.store.block("b", "a");
    expect((await rej.store.send("a", msg("b"))).failed).toEqual([{ agent: "b", code: "blocked" }]);
  });

  it("inbox_full, but silent block wins", async () => {
    const { store } = await setup();
    for (let i = 0; i < 10; i++) await store.send("a", msg("b"));
    expect((await store.send("a", msg("b"))).failed).toEqual([{ agent: "b", code: "inbox_full" }]);
    await store.block("b", "a");
    expect((await store.send("a", msg("b"))).delivered).toEqual(["b"]);
  });

  it("broadcast excludes sender, shares thread, reports full inboxes", async () => {
    const { store } = await setup();
    for (let i = 0; i < 10; i++) await store.send("a", msg("c"));
    const r = await store.send("a", msg("all"));
    expect(r.delivered).toEqual(["b"]);
    expect(r.failed).toEqual([{ agent: "c", code: "inbox_full" }]);
    const rows = await env.DB.prepare("SELECT thread_id FROM messages WHERE thread_id = ?").bind(r.thread_id).all();
    expect(rows.results).toHaveLength(1);
    const r2 = await store.send("a", msg("all"));
    expect(r2.delivered).toEqual(["b"]);
  });

  it("broadcast rows share a thread_id", async () => {
    const { store } = await setup();
    const r = await store.send("a", msg("all"));
    expect(r.delivered).toEqual(["b", "c"]);
    const rows = await env.DB.prepare("SELECT thread_id FROM messages WHERE thread_id = ?").bind(r.thread_id).all();
    expect(rows.results).toHaveLength(2);
  });

  it("broadcast with only sender", async () => {
    const { store } = makeStore();
    await store.createAgent("a", "");
    const r = await store.send("a", msg("all"));
    expect(r.delivered).toEqual([]);
    expect(r.failed).toEqual([]);
  });

  it("size limits", async () => {
    const { store } = await setup();
    await store.send("a", msg("b", { body: "中".repeat(10922) }));
    await expectCode(store.send("a", msg("b", { body: "中".repeat(10923) })), "too_large");
    await expectCode(store.send("a", msg("b", { data: { s: "x".repeat(65536) } })), "too_large");
    await expectCode(store.send("a", msg("b", { subject: "s".repeat(201) })), "invalid_input");
    await store.send("a", msg("b", { subject: "s".repeat(200) }));
  });

  it("self send", async () => {
    const { store } = await setup();
    expect((await store.send("a", msg("a"))).delivered).toEqual(["a"]);
  });

  it("ttl expiry", async () => {
    const { store, clock } = await setup();
    await store.send("a", msg("b"));
    clock.advance(7 * 86_400_000 - 1);
    expect(await store.inbox("b")).toHaveLength(1);
    clock.advance(2);
    expect(await store.inbox("b")).toHaveLength(0);
  });

  it("inbox limit clamps", async () => {
    const { store, clock } = await setup();
    for (let i = 0; i < 10; i++) {
      await store.send("a", msg("b", { subject: `m${i}` }));
      clock.advance(1);
    }
    expect(await store.inbox("b", 0)).toHaveLength(1);
    expect(await store.inbox("b", -5)).toHaveLength(1);
    expect(await store.inbox("b", 99)).toHaveLength(10);
    expect((await store.inbox("b"))[0].subject).toBe("m0");
  });

  it("writes an audit record", async () => {
    const { store } = await setup();
    await store.send("a", msg("b"));
    const row = await env.DB.prepare("SELECT * FROM audit_log WHERE event = 'send'").first<any>();
    expect(row.actor).toBe("a");
    expect(row.target).toBe("b");
    expect(row.body).toBeNull();
  });
});

describe("reply_to / threads", () => {
  it("reply joins thread; unrelated agent rejected", async () => {
    const { store } = await setup();
    const first = await store.send("a", msg("b"));
    const reply = await store.send("b", msg("a", { reply_to: first.id }));
    expect(reply.thread_id).toBe(first.thread_id);
    await expectCode(store.send("c", msg("a", { reply_to: first.id })), "invalid_reply_to");
    await expectCode(store.send("b", msg("a", { reply_to: "nope" })), "invalid_reply_to");
    expect((await store.inbox("a"))[0].reply_to).toBe(first.id);
  });

  it("reply to an acked tombstone works", async () => {
    const { store } = await setup();
    const first = await store.send("a", msg("b", { data: { x: 1 } }));
    await store.ack("b", [first.id]);
    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(first.id).first<any>();
    expect(row.body).toBeNull();
    expect(row.subject).toBeNull();
    expect(row.data).toBeNull();
    expect(row.acked_at).not.toBeNull();
    const reply = await store.send("b", msg("a", { reply_to: first.id }));
    expect(reply.thread_id).toBe(first.thread_id);
    const t = await store.thread("b", first.thread_id);
    expect(t.map((m) => m.id)).toEqual([reply.id]);
  });

  it("expired reply_to rejected", async () => {
    const { store, clock } = await setup();
    const first = await store.send("a", msg("b"));
    clock.advance(7 * 86_400_000 + 1);
    await expectCode(store.send("b", msg("a", { reply_to: first.id })), "invalid_reply_to");
  });

  it("thread only shows own messages", async () => {
    const { store } = await setup();
    const bc = await store.send("b", msg("c"));
    expect(await store.thread("a", bc.thread_id)).toEqual([]);
    expect(await store.thread("c", bc.thread_id)).toHaveLength(1);
  });
});

describe("ack", () => {
  it("others' ids -> not_found and untouched", async () => {
    const { store } = await setup();
    const r = await store.send("a", msg("b"));
    const out = await store.ack("c", [r.id]);
    expect(out).toEqual({ acked: [], failed: [{ id: r.id, code: "not_found" }] });
    expect(await store.inbox("b")).toHaveLength(1);
  });

  it("acks and removes from inbox; deleteOnAck=false keeps content", async () => {
    const { store } = await setup({ deleteOnAck: false });
    const r = await store.send("a", msg("b"));
    expect((await store.ack("b", [r.id])).acked).toEqual([r.id]);
    expect(await store.inbox("b")).toEqual([]);
    expect((await store.thread("b", r.thread_id))[0].body).toBe("x");
  });

  it("more than 50 ids rejected", async () => {
    const { store } = await setup();
    await expectCode(store.ack("b", Array.from({ length: 51 }, (_, i) => String(i))), "invalid_input");
  });

  it("writes an audit record", async () => {
    const { store } = await setup();
    const r = await store.send("a", msg("b"));
    await store.ack("b", [r.id]);
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE event = 'ack'").first()).not.toBeNull();
  });
});

describe("blocks", () => {
  it("block / unblock / list", async () => {
    const { store } = await setup();
    await store.block("b", " A ");
    await store.block("b", "c");
    await store.block("b", "a");
    expect(await store.listBlocked("b")).toEqual(["a", "c"]);
    await store.unblock("b", "a");
    expect(await store.listBlocked("b")).toEqual(["c"]);
    await expectCode(store.block("b", "bad name!"), "invalid_input");
  });
});
