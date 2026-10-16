import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MailboxError } from "../src/errors";
import { sha256Hex } from "../src/crypto";
import { makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => null,
    (x) => x
  );
  expect(e).toBeInstanceOf(MailboxError);
  expect((e as MailboxError).code).toBe(code);
  return e as MailboxError;
}

describe("createAgent", () => {
  it("normalizes name, returns amk_ key, stores only the hash", async () => {
    const { store } = makeStore();
    const r = await store.createAgent("Strata ", "llm");
    expect(r.name).toBe("strata");
    expect(r.key.startsWith("amk_")).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM keys WHERE id = ?").bind(r.keyId).first<any>();
    expect(row.key_hash).not.toBe(r.key);
    expect(row.key_hash).toBe(await sha256Hex(r.key));
  });

  it("rejects invalid names and duplicates", async () => {
    const { store } = makeStore();
    await expectCode(store.createAgent("bad name!", ""), "invalid_input");
    await expectCode(store.createAgent("-x", ""), "invalid_input");
    await expectCode(store.createAgent("a".repeat(33), ""), "invalid_input");
    await store.createAgent("strata", "");
    const e = await expectCode(store.createAgent("STRATA", ""), "invalid_input");
    expect(e.hint).toContain("admin_issue_key");
  });
});

describe("keys", () => {
  it("resolves, revokes, and respects disabled", async () => {
    const { store } = makeStore();
    const { key, keyId } = await store.createAgent("strata", "");
    expect(await store.resolveKey(key)).toBe("strata");
    expect(await store.resolveKey("amk_nope")).toBeNull();
    const second = await store.issueKey("Strata");
    expect(await store.resolveKey(second.key)).toBe("strata");
    await store.revokeKey(keyId);
    expect(await store.resolveKey(key)).toBeNull();
    expect(await store.resolveKey(second.key)).toBe("strata");
    await store.setDisabled("strata", true);
    expect(await store.resolveKey(second.key)).toBeNull();
    expect(await store.isActive("strata")).toBe(false);
    await store.setDisabled("strata", false);
    expect(await store.isActive("strata")).toBe(true);
  });

  it("revokeKey on unknown id -> not_found; issueKey unknown agent -> not_found", async () => {
    const { store } = makeStore();
    await expectCode(store.revokeKey("nope"), "not_found");
    await expectCode(store.issueKey("ghost"), "not_found");
    await expectCode(store.setDisabled("ghost", true), "not_found");
  });
});

describe("touch", () => {
  it("writes at most once per 60s", async () => {
    const { store, clock } = makeStore();
    await store.createAgent("strata", "");
    const seen = async () =>
      (await env.DB.prepare("SELECT last_seen_at v FROM agents WHERE name='strata'").first<any>()).v;
    expect(await seen()).toBeNull();
    await store.touch("strata");
    const t0 = clock.now;
    expect(await seen()).toBe(t0);
    clock.advance(30_000);
    await store.touch("strata");
    expect(await seen()).toBe(t0);
    clock.advance(31_000);
    await store.touch("strata");
    expect(await seen()).toBe(clock.now);
  });
});

describe("listing & profile", () => {
  it("listAgents excludes disabled; adminListAgents includes with counts", async () => {
    const { store, clock } = makeStore();
    await store.createAgent("beta", "b");
    await store.createAgent("alpha", "a");
    const k = await store.createAgent("gamma", "g");
    await store.issueKey("gamma");
    await store.revokeKey(k.keyId);
    await store.setDisabled("gamma", true);
    expect(await store.listAgents()).toEqual([
      { name: "alpha", description: "a" },
      { name: "beta", description: "b" },
    ]);
    await env.DB.prepare(
      "INSERT INTO messages (id,thread_id,from_agent,to_agent,created_at,expires_at,acked_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind("m1", "t", "beta", "alpha", clock.now, null, null)
      .run();
    await env.DB.prepare(
      "INSERT INTO messages (id,thread_id,from_agent,to_agent,created_at,expires_at,acked_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind("m2", "t", "beta", "alpha", clock.now, clock.now - 1, null)
      .run();
    await env.DB.prepare(
      "INSERT INTO messages (id,thread_id,from_agent,to_agent,created_at,expires_at,acked_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind("m3", "t", "beta", "alpha", clock.now, null, clock.now)
      .run();
    const admin = await store.adminListAgents();
    expect(admin.map((a) => a.name)).toEqual(["alpha", "beta", "gamma"]);
    const alpha = admin[0];
    expect(alpha).toMatchObject({ disabled: false, unread: 1, last_seen_at: null, active_keys: 1 });
    expect(admin[2]).toMatchObject({ disabled: true, active_keys: 1 });
    await store.touch("alpha");
    const again = await store.adminListAgents();
    expect(again[0].last_seen_at).toBe(new Date(clock.now).toISOString());
    expect(await store.getProfile("alpha")).toEqual({ name: "alpha", description: "a", unread: 1 });
  });

  it("updateProfile changes description; getProfile unknown -> not_found", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "a");
    await store.updateProfile("alpha", "new");
    expect((await store.getProfile("alpha")).description).toBe("new");
    await expectCode(store.getProfile("ghost"), "not_found");
  });
});

describe("audit", () => {
  const rows = async () =>
    (await env.DB.prepare("SELECT * FROM audit_log ORDER BY id").all<any>()).results;

  it("records agent/key events, body NULL when auditLogBodies=false", async () => {
    const { store, clock } = makeStore();
    const a = await store.createAgent("strata", "");
    const k2 = await store.issueKey("strata");
    await store.revokeKey(k2.keyId);
    await store.setDisabled("strata", true);
    const r = await rows();
    expect(r.map((x) => x.event)).toEqual(["agent_created", "key_issued", "key_revoked", "agent_disabled"]);
    expect(r[0].target).toBe("strata");
    expect(r.every((x) => x.body === null)).toBe(true);
    expect(r[0].ts).toBe(clock.now);
    expect(r[0].expires_at).toBe(clock.now + 7 * 86_400_000);
    expect(a.keyId).toBeTruthy();
  });

  it("body stored only when auditLogBodies; ttl 0 -> NULL expiry", async () => {
    const { store } = makeStore({ auditLogBodies: true, ttlDays: 0 });
    await store.audit("message_sent", "a", "b", "subj", "hello");
    const r = await rows();
    expect(r[0]).toMatchObject({ event: "message_sent", actor: "a", target: "b", subject: "subj", body: "hello", expires_at: null });
    const off = makeStore({ auditLogBodies: false });
    await off.store.audit("message_sent", "a", "b", "subj", "hello");
    expect((await rows())[1].body).toBeNull();
  });
});
