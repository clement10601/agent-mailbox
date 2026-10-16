import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcp } from "../src/index";
import { AdminKeyMissingError, activateIdentity, authenticateBearer } from "../src/auth";
import { makeStore, resetDb } from "./helpers";

beforeEach(resetDb);

describe("authenticateBearer", () => {
  it("admin key -> admin", async () => {
    const { store } = makeStore();
    expect(await authenticateBearer("Bearer test-admin-key-0123456789abcdef0123456789", env, store)).toEqual({ role: "admin" });
  });

  it("wrong admin key -> null", async () => {
    const { store } = makeStore();
    expect(await authenticateBearer("Bearer test-admin-key-0123456789abcdef012345678X", env, store)).toBeNull();
    expect(await authenticateBearer("Bearer ", env, store)).toBeNull();
    expect(await authenticateBearer("Basic test-admin-key-0123456789abcdef0123456789", env, store)).toBeNull();
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

describe("ADMIN_KEY strength", () => {
  it("a key shorter than 32 characters is treated as unset", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const short = { ...env, ADMIN_KEY: "x".repeat(31) };
    await expect(authenticateBearer(`Bearer ${"x".repeat(31)}`, short, store)).rejects.toBeInstanceOf(AdminKeyMissingError);
    await expect(authenticateBearer(`Bearer ${a.key}`, short, store)).rejects.toBeInstanceOf(AdminKeyMissingError);
    const ok = { ...env, ADMIN_KEY: "x".repeat(32) };
    expect(await authenticateBearer(`Bearer ${"x".repeat(32)}`, ok, store)).toEqual({ role: "admin" });
  });

  it("/mcp answers 500 and logs the reason when ADMIN_KEY is too short", async () => {
    const { store } = makeStore();
    const a = await store.createAgent("alpha", "");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    const req = new Request("https://x/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.key}`, "CF-Connecting-IP": "192.0.2.77", "Content-Type": "application/json" },
      body: "{}",
    });
    const ctx = createExecutionContext();
    const res = await handleMcp(req, { ...env, ADMIN_KEY: "short-key" }, ctx);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(errors.some((e) => e.includes("ADMIN_KEY") && e.includes("32"))).toBe(true);
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
