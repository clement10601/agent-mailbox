import type { StoreContext } from "./audit";

/**
 * Deletes rows whose expires_at has passed (expires_at <= now, matching the read side where a
 * row is live only while expires_at > now). NULL expires_at is never deleted. Tombstones are
 * ordinary rows and expire with everything else. MCP session bindings expire the same way. At most `batch` rows are deleted per table.
 */
export async function cleanup(
  ctx: StoreContext,
  batch = 5000
): Promise<{ messages: number; audit: number; sessions: number }> {
  const now = ctx.now();
  const del = async (table: string): Promise<number> => {
    const r = await ctx.db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?)`
      )
      .bind(now, batch)
      .run();
    return r.meta.changes ?? 0;
  };
  return { messages: await del("messages"), audit: await del("audit_log"), sessions: await del("mcp_sessions") };
}
