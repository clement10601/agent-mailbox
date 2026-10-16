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

export interface AuditEntry {
  ts: string;
  event: string;
  actor: string | null;
  target: string | null;
  subject: string | null;
  body: string | null;
}

export async function auditLog(
  ctx: StoreContext,
  q: { since?: number; agent?: string; limit?: number }
): Promise<AuditEntry[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.since !== undefined) {
    where.push("ts >= ?");
    args.push(q.since);
  }
  if (q.agent !== undefined) {
    // target may be a comma-joined list of recipients; match whole names only.
    where.push("(actor = ? OR target = ? OR ',' || target || ',' LIKE ? ESCAPE '\\')");
    const esc = q.agent.replace(/[\\%_]/g, "\\$&");
    args.push(q.agent, q.agent, `%,${esc},%`);
  }
  const limit = q.limit ?? 100;
  const sql =
    "SELECT ts, event, actor, target, subject, body FROM audit_log" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY ts DESC, id DESC LIMIT ?";
  const { results } = await ctx.db
    .prepare(sql)
    .bind(...args, limit)
    .all<{ ts: number; event: string; actor: string | null; target: string | null; subject: string | null; body: string | null }>();
  return results.map((r) => ({ ...r, ts: new Date(r.ts).toISOString() }));
}
