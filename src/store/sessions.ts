import type { StoreContext } from "./audit";

/** Bindings outlive any realistic MCP session; an expired binding makes the client re-initialize. */
export const SESSION_TTL_MS = 30 * 86_400_000;

/** Records which principal created a session. An existing binding is never overwritten. */
export async function bindSession(ctx: StoreContext, id: string, principal: string): Promise<void> {
  const now = ctx.now();
  await ctx.db
    .prepare("INSERT OR IGNORE INTO mcp_sessions (id, principal, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, principal, now, now + SESSION_TTL_MS)
    .run();
}

export async function sessionPrincipal(ctx: StoreContext, id: string): Promise<string | null> {
  const row = await ctx.db
    .prepare("SELECT principal FROM mcp_sessions WHERE id = ? AND expires_at > ?")
    .bind(id, ctx.now())
    .first<{ principal: string }>();
  return row?.principal ?? null;
}
