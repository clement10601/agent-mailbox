import type { Env } from "./env";
import type { Store } from "./store";
import { timingSafeEqual } from "./crypto";
import type { RateLimiter } from "./ratelimit";

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

export const AUTH_RETRY_AFTER_SECONDS = 60;
/** Failed authentications per IP within AUTH_FAILURE_WINDOW_MS after which every attempt from it gets 429. */
export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 60_000;

/**
 * Lockout check that must run BEFORE any credential is evaluated: an IP with AUTH_FAILURE_LIMIT or more
 * `auth_failed` rows in the last minute is refused even with a correct key, so guessing cannot continue
 * behind the 429. Only failures are counted, so legitimate traffic never consumes the budget.
 * (AUTH_LIMITER is per-location and approximate; the D1 audit rows are the authoritative count.)
 */
export async function isLockedOut(request: Request, store: Store): Promise<boolean> {
  return (await store.recentAuthFailures(clientIp(request), AUTH_FAILURE_WINDOW_MS)) >= AUTH_FAILURE_LIMIT;
}

/** Outcome per request, so a failure seen by two layers (e.g. provider and /mcp wrapper) is counted once. */
const failureOutcome = new WeakMap<Request, boolean>();

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Counts a failed authentication against AUTH_LIMITER (per client IP) and writes an `auth_failed` audit row.
 * Returns false when the IP is over its limit: the caller must answer 429 (nothing is audited then).
 */
export async function recordAuthFailure(request: Request, limiter: RateLimiter, store: Store): Promise<boolean> {
  const prior = failureOutcome.get(request);
  if (prior !== undefined) return prior;
  const ip = clientIp(request);
  const allowed = await limiter.limit(ip);
  failureOutcome.set(request, allowed);
  if (allowed) await store.audit("auth_failed", ip, null);
  return allowed;
}
