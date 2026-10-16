import type { Env } from "./env";

export interface Config {
  deleteOnAck: boolean;
  ttlDays: number;
  maxUnread: number;
  auditLogBodies: boolean;
  blockedSenderFeedback: "silent" | "reject";
  oauthRedirectAllowlist: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function raw(v: string | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  return t === "" ? undefined : t;
}

function bool(name: string, v: string | undefined, def: boolean): boolean {
  const s = raw(v);
  if (s === undefined) return def;
  if (s === "true") return true;
  if (s === "false") return false;
  throw new ConfigError(`${name} must be "true" or "false", got "${s}"`);
}

function int(name: string, v: string | undefined, def: number, min: number): number {
  const s = raw(v);
  if (s === undefined) return def;
  if (!/^\d+$/.test(s) || Number(s) < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}, got "${s}"`);
  }
  return Number(s);
}

export function parseConfig(env: Env): Config {
  const feedback = raw(env.BLOCKED_SENDER_FEEDBACK) ?? "silent";
  if (feedback !== "silent" && feedback !== "reject") {
    throw new ConfigError(`BLOCKED_SENDER_FEEDBACK must be "silent" or "reject", got "${feedback}"`);
  }
  const allow = (raw(env.OAUTH_REDIRECT_ALLOWLIST) ?? "https://claude.ai/api/mcp/auth_callback")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    deleteOnAck: bool("DELETE_ON_ACK", env.DELETE_ON_ACK, true),
    ttlDays: int("MESSAGE_TTL_DAYS", env.MESSAGE_TTL_DAYS, 7, 0),
    maxUnread: int("MAX_UNREAD", env.MAX_UNREAD, 10, 1),
    auditLogBodies: bool("AUDIT_LOG_BODIES", env.AUDIT_LOG_BODIES, false),
    blockedSenderFeedback: feedback,
    oauthRedirectAllowlist: allow,
  };
}
