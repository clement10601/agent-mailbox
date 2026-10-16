import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminKeyMissingError, activateIdentity, authenticateBearer } from "../src/auth";
import { makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

describe("authenticateBearer", () => {
  it("admin key -> admin", async () => {
    const { store } = makeStore();
    expect(await authenticateBearer("Bearer test-admin-key", env, store)).toEqual({ role: "admin" });
  });

  it("wrong admin key -> null", async () => {
    const { store } = makeStore();
    expect(await authenticateBearer("Bearer test-admin-kez", env, store)).toBeNull();
    expect(await authenticateBearer("Bearer ", env, store)).toBeNull();
    expect(await authenticateBearer("Basic test-admin-key", env, store)).toBeNull();
  });

  it("no header -> null", async () => {
    const { store } = makeStore();
    expect(await authenticateBearer(null, env, store)).toBeNull();
  });

  it("valid, revoked and disabled agent keys", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    expect(await authenticateBearer(`Bearer ${a.key}`, env, store)).toEqual({ role: "agent", agent: "alpha" });

    await store.revokeKey(a.keyId);
    expect(await authenticateBearer(`Bearer ${a.key}`, env, store)).toBeNull();

    const b = await store.createAgent("beta", "");
    await store.setDisabled("beta", true);
    expect(await authenticateBearer(`Bearer ${b.key}`, env, store)).toBeNull();
    expect(await authenticateBearer("Bearer amk_nope", env, store)).toBeNull();
  });

  it("throws when ADMIN_KEY is not set, for any bearer", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const noKey = { ...env, ADMIN_KEY: "" };
    await expect(authenticateBearer(`Bearer ${a.key}`, noKey, store)).rejects.toBeInstanceOf(AdminKeyMissingError);
    const undef = { ...env, ADMIN_KEY: undefined as unknown as string };
    await expect(authenticateBearer("Bearer x", undef, store)).rejects.toBeInstanceOf(AdminKeyMissingError);
  });
});

describe("activateIdentity", () => {
  it("rejects disabled agents and touches active ones", async () => {
    const { store } = makeStore();
    await store.createAgent("alpha", "");
    expect(await activateIdentity({ role: "admin" }, store)).toBe(true);
    expect(await activateIdentity({ role: "agent", agent: "alpha" }, store)).toBe(true);
    const row = await env.DB.prepare("SELECT last_seen_at FROM agents WHERE name = 'alpha'").first<{ last_seen_at: number | null }>();
    expect(row?.last_seen_at).not.toBeNull();
    await store.setDisabled("alpha", true);
    expect(await activateIdentity({ role: "agent", agent: "alpha" }, store)).toBe(false);
    expect(await activateIdentity({ role: "agent", agent: "ghost" }, store)).toBe(false);
  });
});
