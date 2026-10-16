import type { Config } from "../config";

const DAY_MS = 86_400_000;

export interface StoreContext {
  db: D1Database;
  config: Config;
  now: () => number;
}

export function auditStatement(
  ctx: StoreContext,
  event: string,
  actor: string,
  target: string | null,
  subject: string | null = null,
  body: string | null = null
): D1PreparedStatement {
  const ts = ctx.now();
  const expiresAt = ctx.config.ttlDays > 0 ? ts + ctx.config.ttlDays * DAY_MS : null;
  const storedBody = ctx.config.auditLogBodies ? body : null;
  return ctx.db
    .prepare(
      "INSERT INTO audit_log (ts, event, actor, target, subject, body, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(ts, event, actor, target, subject, storedBody, expiresAt);
}

export async function audit(
  ctx: StoreContext,
  event: string,
  actor: string,
  target: string | null,
  subject: string | null = null,
  body: string | null = null
): Promise<void> {
  await auditStatement(ctx, event, actor, target, subject, body).run();
}
