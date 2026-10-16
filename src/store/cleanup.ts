import type { StoreContext } from "./audit";

/**
 * Deletes rows whose expires_at has passed (expires_at <= now, matching the read side where a
 * row is live only while expires_at > now). NULL expires_at is never deleted. Tombstones are
 * ordinary rows and expire with everything else (under MESSAGE_TTL_DAYS=0, ack gives them a 7-day expiry). MCP session bindings expire the same way. At most `batch` rows are deleted per table.
 */
export async function cleanup(
  ctx: StoreContext,
  batch = 5000
): Promise<{ messages: number; audit: number; sessions: number; failed: string[] }> {
  const now = ctx.now();
  const failed: string[] = [];
  // Each table is cleaned independently: a failure is logged and reported but does not skip the others.
  const del = async (table: string): Promise<number> => {
    try {
      const r = await ctx.db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?)`
        )
        .bind(now, batch)
        .run();
      return r.meta.changes ?? 0;
    } catch (e) {
      console.error(`cleanup: ${table} failed`, e);
      failed.push(table);
      return 0;
    }
  };
  const messages = await del("messages");
  const audit = await del("audit_log");
  const sessions = await del("mcp_sessions");
  return { messages, audit, sessions, failed };
}
