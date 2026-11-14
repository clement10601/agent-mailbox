// Accounts, usage counting and plan limits (BILLING_ENABLED).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, admin, createAgent, startWorker, type Worker } from "./harness";

let w: Worker; // limits not enforced (the default)
let b: Worker; // BILLING_ENABLED=true
beforeAll(async () => {
  w = await startWorker();
  b = await startWorker({ BILLING_ENABLED: "true", BILLING_UPGRADE_URL: "https://example.com/upgrade", MAX_UNREAD: "50" });
});
beforeEach(async () => {
  await w.reset();
  await b.reset();
});

const PERIOD = new Date().toISOString().slice(0, 7);

async function agents(worker: Worker, names: string[]): Promise<Record<string, Client>> {
  const out: Record<string, Client> = {};
  for (const n of names) {
    const k = await createAgent(worker, n);
    out[n] = await new Client(worker, k.key).init();
  }
  return out;
}

const msg = (to: string) => ({ to, subject: "hi", body: "x" });

async function setSent(worker: Worker, n: number) {
  await worker.db
    .prepare(
      "INSERT INTO usage_counters (account_id, period, messages_sent) VALUES ('default', ?, ?) ON CONFLICT (account_id, period) DO UPDATE SET messages_sent = excluded.messages_sent",
    )
    .bind(PERIOD, n)
    .run();
}

async function messageRows(worker: Worker): Promise<number> {
  return (await worker.db.prepare("SELECT COUNT(*) AS n FROM messages").first()).n;
}

describe("usage counting", () => {
  it("counts accepted messages per account and period, also when limits are not enforced", async () => {
    const { a } = await agents(w, ["a", "b", "c"]);
    await a.ok("send_message", msg("b"));
    await a.ok("send_message", msg("all")); // b and c
    const u = await a.ok("get_usage");
    expect(u).toMatchObject({
      account: "default",
      plan: "free",
      enforced: false,
      period: PERIOD,
      messages_sent: 3,
      messages_limit: null,
      agents: 3,
      agents_limit: null,
    });
    expect(new Date(u.resets_at).getTime()).toBeGreaterThan(Date.now());
    expect(u.resets_at.endsWith("-01T00:00:00.000Z")).toBe(true);
  });

  it("does not count messages that were not accepted", async () => {
    const { a } = await agents(w, ["a", "b"]);
    const r = await a.ok("send_message", msg("nobody"));
    expect(r.failed).toEqual([{ agent: "nobody", code: "unknown_recipient" }]);
    expect((await a.ok("get_usage")).messages_sent).toBe(0);
  });

  it("counts a silently blocked message like a delivered one", async () => {
    const { a, b: bb } = await agents(w, ["a", "b"]);
    await bb.ok("block_sender", { agent: "a" });
    expect((await a.ok("send_message", msg("b"))).delivered).toEqual(["b"]);
    expect((await a.ok("get_usage")).messages_sent).toBe(1);
  });

  it("does not enforce limits unless BILLING_ENABLED is true", async () => {
    const { a } = await agents(w, ["a", "b", "c", "d"]); // more than the free plan's 3 agents
    await setSent(w, 5000);
    expect((await a.ok("send_message", msg("b"))).delivered).toEqual(["b"]);
  });

  it("admin can read usage and change the plan", async () => {
    const adm = await admin(w);
    expect(await adm.ok("admin_get_usage")).toMatchObject({ account: "default", plan: "free", messages_sent: 0, agents: 0 });
    await adm.ok("admin_set_plan", { plan: "Pro" });
    expect((await adm.ok("admin_get_usage", { account: "default" })).plan).toBe("pro");
    const log = (await adm.ok("admin_audit_log")).entries;
    expect(log[0]).toMatchObject({ event: "plan_changed", actor: "admin", target: "default", subject: "pro" });

    const bad = await adm.call("admin_set_plan", { plan: "enterprise" });
    expect(bad.isError).toBe(true);
    expect(bad.value.code).toBe("invalid_input");
    const missing = await adm.call("admin_get_usage", { account: "nope" });
    expect(missing.value.code).toBe("not_found");
  });
});

describe("plan limits", () => {
  it("reports limits in get_usage", async () => {
    const { a } = await agents(b, ["a"]);
    expect(await a.ok("get_usage")).toMatchObject({ enforced: true, messages_limit: 1000, agents_limit: 3, agents: 1 });
  });

  it("rejects sending once the monthly messages are used up, and writes nothing", async () => {
    const { a } = await agents(b, ["a", "b"]);
    await setSent(b, 999);
    expect((await a.ok("send_message", msg("b"))).delivered).toEqual(["b"]);
    const r = await a.call("send_message", msg("b"));
    expect(r.isError).toBe(true);
    expect(r.value.code).toBe("quota_exceeded");
    expect(r.value.hint).toContain("https://example.com/upgrade");
    expect(r.value.hint).toContain("-01T00:00:00.000Z");
    expect(await messageRows(b)).toBe(1);
    expect((await a.ok("get_usage")).messages_sent).toBe(1000);
  });

  it("a broadcast delivers only as many copies as the quota has left", async () => {
    const { a } = await agents(b, ["a", "b", "c"]);
    await setSent(b, 999);
    const r = await a.ok("send_message", msg("all"));
    expect(r.delivered).toEqual(["b"]);
    expect(r.failed).toEqual([{ agent: "c", code: "quota_exceeded" }]);
    expect((await a.ok("get_usage")).messages_sent).toBe(1000);
  });

  it("a higher plan raises the limit", async () => {
    const { a } = await agents(b, ["a", "b"]);
    await setSent(b, 1000);
    expect((await a.call("send_message", msg("b"))).value.code).toBe("quota_exceeded");
    await (await admin(b)).ok("admin_set_plan", { plan: "pro" });
    expect((await a.ok("send_message", msg("b"))).delivered).toEqual(["b"]);
    expect(await a.ok("get_usage")).toMatchObject({ plan: "pro", messages_limit: 50000, agents_limit: 20 });
  });

  it("usage from an earlier period does not count", async () => {
    const { a } = await agents(b, ["a", "b"]);
    await b.db.prepare("INSERT INTO usage_counters (account_id, period, messages_sent) VALUES ('default', '2020-01', 100000)").run();
    expect((await a.ok("send_message", msg("b"))).delivered).toEqual(["b"]);
    expect((await a.ok("get_usage")).messages_sent).toBe(1);
  });

  it("limits active agents; disabling one frees a slot and re-enabling needs one", async () => {
    const adm = await admin(b);
    for (const n of ["a", "b", "c"]) await adm.ok("admin_create_agent", { name: n });
    const full = await adm.call("admin_create_agent", { name: "d" });
    expect(full.isError).toBe(true);
    expect(full.value.code).toBe("quota_exceeded");

    await adm.ok("admin_disable_agent", { agent: "a" });
    await adm.ok("admin_create_agent", { name: "d" });
    const back = await adm.call("admin_enable_agent", { agent: "a" });
    expect(back.value.code).toBe("quota_exceeded");
    // Enabling an agent that is already enabled is not a new slot.
    await adm.ok("admin_enable_agent", { agent: "b" });
  });
});
