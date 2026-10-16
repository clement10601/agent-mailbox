import type { Env } from "./env";
import type { Store } from "./store";
import { timingSafeEqual } from "./crypto";

export type Identity = { role: "admin" } | { role: "agent"; agent: string };

/** Thrown when ADMIN_KEY is unset; callers must answer 500 and log the reason. */
export class AdminKeyMissingError extends Error {
  constructor() {
    super("ADMIN_KEY secret is not set; refusing to authenticate requests");
    this.name = "AdminKeyMissingError";
  }
}

const BEARER_RE = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/**
 * Resolves an `Authorization` header to an identity.
 * `Bearer <ADMIN_KEY>` -> admin; `Bearer amk_…` -> the key's (active, unrevoked) agent; anything else -> null.
 * Throws AdminKeyMissingError if ADMIN_KEY is not configured, whatever the header holds.
 */
export async function authenticateBearer(header: string | null, env: Env, store: Store): Promise<Identity | null> {
  const adminKey = typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY : "";
  if (adminKey === "") throw new AdminKeyMissingError();
  const m = header ? BEARER_RE.exec(header) : null;
  if (!m) return null;
  const token = m[1];
  if (await timingSafeEqual(token, adminKey)) return { role: "admin" };
  if (token.startsWith("amk_")) {
    const agent = await store.resolveKey(token);
    if (agent) return { role: "agent", agent };
  }
  return null;
}

/**
 * Per-request check for an already-resolved identity: an agent must still exist and be enabled;
 * records activity (`last_seen_at`, throttled by the store). Returns false if the identity is no longer valid.
 */
export async function activateIdentity(identity: Identity, store: Store): Promise<boolean> {
  if (identity.role === "admin") return true;
  if (!(await store.isActive(identity.agent))) return false;
  await store.touch(identity.agent);
  return true;
}

/** Stable string form of an identity, used to bind MCP sessions to the identity that created them. */
export function principalOf(identity: Identity): string {
  return identity.role === "admin" ? "admin" : `agent:${identity.agent}`;
}
