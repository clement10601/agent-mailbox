// Agent and key management through the admin tools, plus the audit log.
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, admin, freshIp, startWorker, type Worker } from "./harness";

let w: Worker;
let adm: Client;
beforeAll(async () => {
  w = await startWorker();
});
beforeEach(async () => {
  await w.reset();
  adm = await admin(w);
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function code(c: Client, tool: string, args: unknown): Promise<{ code: string; hint: string }> {
  const r = await c.call(tool, args);
  expect(r.isError, JSON.stringify(r.value)).toBe(true);
  return r.value;
}

/** True when `key` currently authenticates on /mcp. */
async function works(key: string): Promise<boolean> {
  const res = await new Client(w, key, freshIp()).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await res.text();
  return res.status === 200;
}

describe("admin tools", () => {
  it("exposes exactly the admin_ tools", async () => {
    expect((await adm.toolNames()).sort()).toEqual(
      [
        "admin_create_agent",
        "admin_create_binding_code",
        "admin_issue_key",
        "admin_revoke_key",
        "admin_disable_agent",
        "admin_enable_agent",
        "admin_list_agents",
        "admin_audit_log",
        "admin_set_block",
        "admin_revoke_oauth",
      ].sort()
    );
  });

  it("agents see exactly the spec tool names", async () => {
    const k = await adm.ok("admin_create_agent", { name: "a" });
    const c = await new Client(w, k.key).init();
    expect((await c.toolNames()).sort()).toEqual(
      ["whoami", "list_agents", "send_message", "check_inbox", "ack", "read_thread", "block_sender", "unblock_sender", "list_blocked", "update_profile"].sort()
    );
  });

  it("create normalizes the name, returns an amk_ key and stores only its hash", async () => {
    const r = await adm.ok("admin_create_agent", { name: "Strata ", description: "llm" });
    expect(r.name).toBe("strata");
    expect(r.key.startsWith("amk_")).toBe(true);
    expect(r.key_id).toMatch(/^[0-9a-f]{16}$/);
    const row = await w.db.prepare("SELECT key_hash FROM keys WHERE id = ?").bind(r.key_id).first();
    expect(row.key_hash).not.toBe(r.key);
    expect(row.key_hash).toBe(sha256(r.key));
    expect(await works(r.key)).toBe(true);
  });

  it("rejects invalid names and duplicates", async () => {
    expect((await code(adm, "admin_create_agent", { name: "bad name!" })).code).toBe("invalid_input");
    expect((await code(adm, "admin_create_agent", { name: "-x" })).code).toBe("invalid_input");
    expect((await code(adm, "admin_create_agent", { name: "a".repeat(33) })).code).toBe("invalid_input");
    await adm.ok("admin_create_agent", { name: "strata" });
    const e = await code(adm, "admin_create_agent", { name: "STRATA" });
    expect(e.code).toBe("invalid_input");
    expect(e.hint).toContain("admin_issue_key");
  });

  it("issues, revokes, and respects disabled", async () => {
    const first = await adm.ok("admin_create_agent", { name: "strata" });
    const second = await adm.ok("admin_issue_key", { agent: "Strata" });
    expect(await works(second.key)).toBe(true);
    expect(await adm.ok("admin_revoke_key", { key_id: first.key_id })).toEqual({ ok: true });
    expect(await works(first.key)).toBe(false);
    expect(await works(second.key)).toBe(true);
    await adm.ok("admin_disable_agent", { agent: "strata" });
    expect(await works(second.key)).toBe(false);
    await adm.ok("admin_enable_agent", { agent: "strata" });
    expect(await works(second.key)).toBe(true);
  });

  it("unknown ids and agents -> not_found", async () => {
    expect((await code(adm, "admin_revoke_key", { key_id: "nope" })).code).toBe("not_found");
    expect((await code(adm, "admin_issue_key", { agent: "ghost" })).code).toBe("not_found");
    expect((await code(adm, "admin_disable_agent", { agent: "ghost" })).code).toBe("not_found");
    expect((await code(adm, "admin_set_block", { agent: "ghost", sender: "a", blocked: true })).code).toBe("not_found");
    expect((await code(adm, "admin_revoke_oauth", { agent: "ghost", grant_id: "g" })).code).toBe("not_found");
  });

  it("admin_list_agents includes disabled agents with unread, key and grant counts", async () => {
    await adm.ok("admin_create_agent", { name: "beta", description: "b" });
    await adm.ok("admin_create_agent", { name: "alpha", description: "a" });
    const g = await adm.ok("admin_create_agent", { name: "gamma", description: "g" });
    await adm.ok("admin_issue_key", { agent: "gamma" });
    await adm.ok("admin_revoke_key", { key_id: g.key_id });
    await adm.ok("admin_disable_agent", { agent: "gamma" });
    const now = Date.now();
    const insert = "INSERT INTO messages (id,thread_id,from_agent,to_agent,created_at,expires_at,acked_at) VALUES (?,?,?,?,?,?,?)";
    await w.db.prepare(insert).bind("m1", "t", "beta", "alpha", now, null, null).run();
    await w.db.prepare(insert).bind("m2", "t", "beta", "alpha", now, now - 1, null).run();
    await w.db.prepare(insert).bind("m3", "t", "beta", "alpha", now, null, now).run();
    const list = (await adm.ok("admin_list_agents")).agents;
    expect(list.map((a: any) => a.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(list[0]).toMatchObject({ description: "a", disabled: false, unread: 1, last_seen_at: null, active_keys: 1, oauth_grants: 0, oauth_grant_ids: [] });
    expect(list[2]).toMatchObject({ disabled: true, active_keys: 1 });
  });

  it("last_seen_at is written at most once per minute", async () => {
    const k = await adm.ok("admin_create_agent", { name: "strata" });
    const seen = async () => (await w.db.prepare("SELECT last_seen_at v FROM agents WHERE name='strata'").first()).v;
    expect(await seen()).toBeNull();
    const c = await new Client(w, k.key).init();
    const t0 = await seen();
    expect(t0).not.toBeNull();
    await c.toolNames();
    expect(await seen()).toBe(t0);
    await w.db.prepare("UPDATE agents SET last_seen_at = last_seen_at - 61000").run();
    await c.toolNames();
    expect(await seen()).toBeGreaterThan(t0 - 61000);
    const listed = (await adm.ok("admin_list_agents")).agents[0];
    expect(new Date(listed.last_seen_at).getTime()).toBe(await seen());
  });

  it("admin_set_block blocks a for b so a's mail does not reach b", async () => {
    const a = await adm.ok("admin_create_agent", { name: "a" });
    const b = await adm.ok("admin_create_agent", { name: "b" });
    expect(await adm.ok("admin_set_block", { agent: "b", sender: "a", blocked: true })).toEqual({ ok: true });
    const ca = await new Client(w, a.key).init();
    const cb = await new Client(w, b.key).init();
    await ca.ok("send_message", { to: "b", subject: "s", body: "x" });
    expect((await cb.ok("check_inbox")).messages).toHaveLength(0);
    await adm.ok("admin_set_block", { agent: "b", sender: "a", blocked: false });
    expect(await cb.ok("list_blocked")).toEqual({ blocked: [] });
  });
});

describe("audit log", () => {
  it("records agent and key events without bodies, with a TTL", async () => {
    const before = Date.now();
    await adm.ok("admin_create_agent", { name: "strata" });
    const k2 = await adm.ok("admin_issue_key", { agent: "strata" });
    await adm.ok("admin_revoke_key", { key_id: k2.key_id });
    await adm.ok("admin_disable_agent", { agent: "strata" });
    const rows = (await w.db.prepare("SELECT * FROM audit_log ORDER BY id").all()).results as any[];
    expect(rows.map((x) => x.event)).toEqual(["agent_created", "key_issued", "key_revoked", "agent_disabled"]);
    expect(rows[0]).toMatchObject({ actor: "admin", target: "strata" });
    expect(rows[1].subject).toBe(k2.key_id);
    expect(rows.every((x) => x.body === null)).toBe(true);
    expect(rows[0].ts).toBeGreaterThanOrEqual(before);
    expect(rows[0].expires_at).toBe(rows[0].ts + 7 * 86_400_000);
  });

  it("filters by actor or target with exact names, newest first", async () => {
    const ins = "INSERT INTO audit_log (ts, event, actor, target) VALUES (?, ?, ?, ?)";
    const t0 = Date.now();
    const rows: [string, string, string][] = [
      ["e1", "b", "a"],
      ["e2", "a", "b"],
      ["e3", "a", "c,b,d"],
      ["e4", "bb", "a"],
      ["e5", "a", "bb,c"],
      ["e6", "a", "b_"],
    ];
    for (const [i, r] of rows.entries()) await w.db.prepare(ins).bind(t0 + i * 10, ...r).run();
    const out = (await adm.ok("admin_audit_log", { agent: " B " })).entries;
    expect(out.map((r: any) => r.event)).toEqual(["e3", "e2", "e1"]);
    expect(new Date(out[0].ts).toISOString()).toBe(out[0].ts);
  });

  it("supports since and limit (clamped), newest first", async () => {
    await w.db.prepare("DELETE FROM audit_log").run();
    const ins = "INSERT INTO audit_log (ts, event, actor, target) VALUES (?, ?, 'a', 'b')";
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) await w.db.prepare(ins).bind(t0 + i * 1000, `e${i}`).run();
    const ev = async (args: unknown) => (await adm.ok("admin_audit_log", args)).entries.map((r: any) => r.event);
    expect(await ev({ limit: 2 })).toEqual(["e4", "e3"]);
    expect(await ev({ limit: 0 })).toEqual(["e4"]);
    expect(await ev({ since: "2026-01-01T00:00:02Z" })).toEqual(["e4", "e3", "e2"]);
    expect(await ev({})).toHaveLength(5);
    expect(await ev({ since: "2999-01-01T00:00:00Z" })).toEqual([]);
    expect((await code(adm, "admin_audit_log", { since: "not a date" })).code).toBe("invalid_input");
  });
});
