import { env } from "cloudflare:workers";
import { Store } from "../src/store";
import type { Config } from "../src/config";

export const defaultConfig: Config = {
  deleteOnAck: true,
  ttlDays: 7,
  maxUnread: 10,
  auditLogBodies: false,
  blockedSenderFeedback: "silent",
  oauthRedirectAllowlist: ["https://claude.ai/api/mcp/auth_callback"],
};

export interface Clock {
  now: number;
  advance(ms: number): void;
}

export async function clearAll(db: D1Database): Promise<void> {
  await db.batch(
    ["audit_log", "blocks", "messages", "keys", "agents"].map((t) => db.prepare(`DELETE FROM ${t}`))
  );
}

/** Builds a Store over the test D1. Call `await resetDb()` in beforeEach to clear tables. */
export function makeStore(
  overrides: Partial<Config> = {},
  start = 1_700_000_000_000
): { store: Store; clock: Clock } {
  const clock: Clock = {
    now: start,
    advance(ms) {
      this.now += ms;
    },
  };
  const store = new Store(env.DB, { ...defaultConfig, ...overrides }, () => clock.now);
  return { store, clock };
}

export async function resetDb(): Promise<void> {
  await clearAll(env.DB);
}
