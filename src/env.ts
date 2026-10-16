import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  AUTH_LIMITER: RateLimit;
  SEND_LIMITER: RateLimit;
  ADMIN_KEY: string;
  /** Injected by OAuthProvider on requests it dispatches. */
  OAUTH_PROVIDER: OAuthHelpers;

  DELETE_ON_ACK: string;
  MESSAGE_TTL_DAYS: string;
  MAX_UNREAD: string;
  AUDIT_LOG_BODIES: string;
  BLOCKED_SENDER_FEEDBACK: string;
  OAUTH_REDIRECT_ALLOWLIST: string;
}
