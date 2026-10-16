import { beforeEach, describe, expect, it } from "vitest";
import { agentTools } from "../src/tools/agent";
import { adminTools } from "../src/tools/admin";
import type { RateLimiter } from "../src/ratelimit";
import { MailboxError } from "../src/errors";
import { makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

const allow: RateLimiter = { limit: async () => true };
const deny: RateLimiter = { limit: async () => false };

async function caught(p: Promise<unknown>): Promise<MailboxError> {
  const e = await p.then(
    () => null,
    (x) => x
  );
  expect(e).toBeInstanceOf(MailboxError);
  return e as MailboxError;
}

async function setup() {
  const r = makeStore();
  for (const n of ["a", "b"]) await r.store.createAgent(n, `agent ${n}`);
  return r;
}

describe("agent tools", () => {
  it("exposes exactly the spec tool names", async () => {
    const { store } = await setup();
    expect(Object.keys(agentTools(store, "a", allow)).sort()).toEqual(
      [
        "whoami",
        "list_agents",
        "send_message",
        "check_inbox",
        "ack",
        "read_thread",
        "block_sender",
        "unblock_sender",
        "list_blocked",
        "update_profile",
      ].sort()
    );
  });

  it("whoami returns own unread; list_agents has no unread", async () => {
    const { store } = await setup();
    await store.send("a", { to: "b", subject: "s", body: "x" });
    const tb = agentTools(store, "b", allow);
    expect(await tb.whoami.handler({})).toEqual({ name: "b", description: "agent b", unread: 1 });
    const list = (await tb.list_agents.handler({})) as { agents: Record<string, unknown>[] };
    expect(list.agents.map((x) => x.name)).toEqual(["a", "b"]);
    for (const x of list.agents) expect(x).not.toHaveProperty("unread");
  });

  it("send_message is rate limited with retry_after 60", async () => {
    const { store } = await setup();
    let seen = "";
    const spy: RateLimiter = {
      limit: async (k) => {
        seen = k;
        return false;
      },
    };
    const e = await caught(agentTools(store, "a", spy).send_message.handler({ to: "b", subject: "s", body: "x" }));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfter).toBe(60);
    expect(seen).toBe("a");
    expect(await store.inbox("b")).toHaveLength(0);
  });

  it("check_inbox, ack, check_inbox is empty", async () => {
    const { store } = await setup();
    const ta = agentTools(store, "a", allow);
    const tb = agentTools(store, "b", allow);
    const sent = (await ta.send_message.handler({ to: "b", subject: "s", body: "x" })) as { id: string; delivered: string[] };
    expect(sent.delivered).toEqual(["b"]);
    const inbox = (await tb.check_inbox.handler({})) as { messages: { id: string }[] };
    expect(inbox.messages.map((m) => m.id)).toEqual([sent.id]);
    expect(await tb.ack.handler({ ids: [sent.id] })).toEqual({ acked: [sent.id], failed: [] });
    expect(await tb.check_inbox.handler({})).toEqual({ messages: [] });
  });

  it("block / unblock / list_blocked / update_profile / read_thread", async () => {
    const { store } = await setup();
    const ta = agentTools(store, "a", allow);
    const tb = agentTools(store, "b", allow);
    expect(await tb.block_sender.handler({ agent: "a" })).toEqual({ ok: true });
    expect(await tb.list_blocked.handler({})).toEqual({ blocked: ["a"] });
    expect(await tb.unblock_sender.handler({ agent: "a" })).toEqual({ ok: true });
    expect(await tb.list_blocked.handler({})).toEqual({ blocked: [] });
    expect(await ta.update_profile.handler({ description: "new" })).toEqual({ ok: true });
    expect(((await ta.whoami.handler({})) as { description: string }).description).toBe("new");
    const sent = (await ta.send_message.handler({ to: "b", subject: "s", body: "x" })) as { thread_id: string };
    const th = (await tb.read_thread.handler({ thread_id: sent.thread_id })) as { messages: unknown[] };
    expect(th.messages).toHaveLength(1);
  });
});

describe("admin tools", () => {
  it("exposes only admin_ tools", async () => {
    const { store } = makeStore();
    const names = Object.keys(adminTools(store, null));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.startsWith("admin_")).toBe(true);
    expect(names.sort()).toEqual(
      [
        "admin_create_agent",
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

  it("admin_create_agent returns a key that resolves", async () => {
    const { store } = makeStore();
    const t = adminTools(store, null);
    const r = (await t.admin_create_agent.handler({ name: "Zed", description: "z" })) as { name: string; key: string; key_id: string };
    expect(r.name).toBe("zed");
    expect(await store.resolveKey(r.key)).toBe("zed");
    const k2 = (await t.admin_issue_key.handler({ agent: "zed" })) as { key: string; key_id: string };
    expect(await store.resolveKey(k2.key)).toBe("zed");
    expect(await t.admin_revoke_key.handler({ key_id: k2.key_id })).toEqual({ ok: true });
    expect(await store.resolveKey(k2.key)).toBeNull();
  });

  it("admin_set_block blocks a for b so a's mail does not reach b", async () => {
    const { store } = await setup();
    const t = adminTools(store, null);
    expect(await t.admin_set_block.handler({ agent: "b", sender: "a", blocked: true })).toEqual({ ok: true });
    await agentTools(store, "a", allow).send_message.handler({ to: "b", subject: "s", body: "x" });
    expect(await store.inbox("b")).toHaveLength(0);
    await t.admin_set_block.handler({ agent: "b", sender: "a", blocked: false });
    expect(await store.listBlocked("b")).toEqual([]);
    expect((await caught(t.admin_set_block.handler({ agent: "ghost", sender: "a", blocked: true }))).code).toBe("not_found");
  });

  it("disable/enable, list_agents with oauth null, audit_log clamp, revoke_oauth without provider", async () => {
    const { store } = await setup();
    const t = adminTools(store, null);
    expect(await t.admin_disable_agent.handler({ agent: "a" })).toEqual({ ok: true });
    let list = (await t.admin_list_agents.handler({})) as { agents: { name: string; disabled: boolean; oauth_grants: number; active_keys: number }[] };
    expect(list.agents.find((x) => x.name === "a")).toMatchObject({ disabled: true, oauth_grants: 0, active_keys: 1 });
    expect(await t.admin_enable_agent.handler({ agent: "a" })).toEqual({ ok: true });
    list = (await t.admin_list_agents.handler({})) as typeof list;
    expect(list.agents.find((x) => x.name === "a")?.disabled).toBe(false);

    const log = (await t.admin_audit_log.handler({ limit: 0 })) as { entries: unknown[] };
    expect(log.entries).toHaveLength(1);
    const all = (await t.admin_audit_log.handler({ agent: "a" })) as { entries: { ts: string }[] };
    expect(all.entries.length).toBeGreaterThan(1);
    expect(new Date(all.entries[0].ts).toISOString()).toBe(all.entries[0].ts);
    const since = (await t.admin_audit_log.handler({ since: "2999-01-01T00:00:00Z" })) as { entries: unknown[] };
    expect(since.entries).toEqual([]);
    expect((await caught(t.admin_audit_log.handler({ since: "not a date" }))).code).toBe("invalid_input");

    expect((await caught(t.admin_revoke_oauth.handler({ agent: "a", grant_id: "g" }))).code).toBe("internal");
  });
});
