import { audit, type StoreContext } from "./audit";
import { normalizeName, validName } from "./agents";

export async function block(ctx: StoreContext, agent: string, sender: string): Promise<void> {
  const me = normalizeName(agent);
  const s = validName(sender);
  await ctx.db
    .prepare("INSERT OR IGNORE INTO blocks (agent_name, blocked_sender, created_at) VALUES (?, ?, ?)")
    .bind(me, s, ctx.now())
    .run();
  await audit(ctx, "block", me, s);
}

export async function unblock(ctx: StoreContext, agent: string, sender: string): Promise<void> {
  const me = normalizeName(agent);
  const s = normalizeName(sender);
  await ctx.db.prepare("DELETE FROM blocks WHERE agent_name = ? AND blocked_sender = ?").bind(me, s).run();
  await audit(ctx, "unblock", me, s);
}

export async function listBlocked(ctx: StoreContext, agent: string): Promise<string[]> {
  const { results } = await ctx.db
    .prepare("SELECT blocked_sender FROM blocks WHERE agent_name = ? ORDER BY blocked_sender")
    .bind(normalizeName(agent))
    .all<{ blocked_sender: string }>();
  return results.map((r) => r.blocked_sender);
}
