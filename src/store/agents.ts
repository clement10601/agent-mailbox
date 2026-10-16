import { MailboxError } from "../errors";
import { generateKey, newId, sha256Hex } from "../crypto";
import { audit, type StoreContext } from "./audit";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOUCH_INTERVAL_MS = 60_000;

export function normalizeName(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

export function validName(name: string): string {
  const n = normalizeName(name);
  if (!NAME_RE.test(n)) {
    throw new MailboxError(
      "invalid_input",
      `Invalid agent name "${n}".`,
      "Use 1-32 chars: lowercase letters, digits, hyphen; must start with a letter or digit."
    );
  }
  return n;
}

async function requireAgent(ctx: StoreContext, name: string): Promise<string> {
  const n = normalizeName(name);
  const row = await ctx.db.prepare("SELECT name FROM agents WHERE name = ?").bind(n).first();
  if (!row) throw new MailboxError("not_found", `Agent "${n}" does not exist.`, "Check the name with admin_list_agents.");
  return n;
}

export async function createAgent(
  ctx: StoreContext,
  name: string,
  description: string
): Promise<{ name: string; key: string; keyId: string }> {
  const n = validName(name);
  const exists = await ctx.db.prepare("SELECT 1 FROM agents WHERE name = ?").bind(n).first();
  const dup = () =>
    new MailboxError("invalid_input", `Agent "${n}" already exists.`, "Use admin_issue_key to issue another key for it.");
  if (exists) throw dup();
  const key = generateKey();
  const keyId = newId();
  const now = ctx.now();
  try {
    await ctx.db.batch([
      ctx.db
        .prepare("INSERT INTO agents (name, description, created_at) VALUES (?, ?, ?)")
        .bind(n, description ?? "", now),
      ctx.db
        .prepare("INSERT INTO keys (id, agent_name, key_hash, created_at) VALUES (?, ?, ?, ?)")
        .bind(keyId, n, await sha256Hex(key), now),
    ]);
  } catch (e) {
    // Lost a creation race on the primary key.
    if (String(e).includes("UNIQUE") || String(e).includes("constraint")) throw dup();
    throw e;
  }
  await audit(ctx, "agent_created", "admin", n);
  return { name: n, key, keyId };
}

export async function issueKey(ctx: StoreContext, name: string): Promise<{ key: string; keyId: string }> {
  const n = await requireAgent(ctx, name);
  const key = generateKey();
  const keyId = newId();
  await ctx.db
    .prepare("INSERT INTO keys (id, agent_name, key_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(keyId, n, await sha256Hex(key), ctx.now())
    .run();
  await audit(ctx, "key_issued", "admin", n, keyId);
  return { key, keyId };
}

export async function revokeKey(ctx: StoreContext, keyId: string): Promise<void> {
  const row = await ctx.db.prepare("SELECT agent_name FROM keys WHERE id = ?").bind(keyId).first<{ agent_name: string }>();
  if (!row) throw new MailboxError("not_found", `Key "${keyId}" does not exist.`, "List keys with admin_list_agents.");
  await ctx.db
    .prepare("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(ctx.now(), keyId)
    .run();
  await audit(ctx, "key_revoked", "admin", row.agent_name, keyId);
}

export async function setDisabled(ctx: StoreContext, name: string, disabled: boolean): Promise<void> {
  const n = await requireAgent(ctx, name);
  await ctx.db.prepare("UPDATE agents SET disabled = ? WHERE name = ?").bind(disabled ? 1 : 0, n).run();
  await audit(ctx, disabled ? "agent_disabled" : "agent_enabled", "admin", n);
}

export async function resolveKey(ctx: StoreContext, rawKey: string): Promise<string | null> {
  const row = await ctx.db
    .prepare(
      `SELECT k.agent_name AS name FROM keys k JOIN agents a ON a.name = k.agent_name
       WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.disabled = 0`
    )
    .bind(await sha256Hex(rawKey))
    .first<{ name: string }>();
  return row?.name ?? null;
}

export async function isActive(ctx: StoreContext, name: string): Promise<boolean> {
  const row = await ctx.db
    .prepare("SELECT 1 FROM agents WHERE name = ? AND disabled = 0")
    .bind(normalizeName(name))
    .first();
  return row !== null;
}

export async function touch(ctx: StoreContext, name: string): Promise<void> {
  const now = ctx.now();
  await ctx.db
    .prepare("UPDATE agents SET last_seen_at = ? WHERE name = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)")
    .bind(now, normalizeName(name), now - TOUCH_INTERVAL_MS)
    .run();
}

export async function listAgents(ctx: StoreContext): Promise<{ name: string; description: string }[]> {
  const { results } = await ctx.db
    .prepare("SELECT name, description FROM agents WHERE disabled = 0 ORDER BY name")
    .all<{ name: string; description: string }>();
  return results;
}

export async function adminListAgents(ctx: StoreContext): Promise<
  { name: string; description: string; disabled: boolean; unread: number; last_seen_at: string | null; active_keys: number }[]
> {
  const now = ctx.now();
  const { results } = await ctx.db
    .prepare(
      `SELECT a.name, a.description, a.disabled, a.last_seen_at,
        (SELECT COUNT(*) FROM messages m WHERE m.to_agent = a.name AND m.acked_at IS NULL AND m.suppressed = 0
           AND (m.expires_at IS NULL OR m.expires_at > ?)) AS unread,
        (SELECT COUNT(*) FROM keys k WHERE k.agent_name = a.name AND k.revoked_at IS NULL) AS active_keys
       FROM agents a ORDER BY a.name`
    )
    .bind(now)
    .all<{ name: string; description: string; disabled: number; last_seen_at: number | null; unread: number; active_keys: number }>();
  return results.map((r) => ({
    name: r.name,
    description: r.description,
    disabled: r.disabled === 1,
    unread: r.unread,
    last_seen_at: r.last_seen_at === null ? null : new Date(r.last_seen_at).toISOString(),
    active_keys: r.active_keys,
  }));
}

export async function getProfile(
  ctx: StoreContext,
  name: string
): Promise<{ name: string; description: string; unread: number }> {
  const n = normalizeName(name);
  const row = await ctx.db
    .prepare(
      `SELECT a.name, a.description,
        (SELECT COUNT(*) FROM messages m WHERE m.to_agent = a.name AND m.acked_at IS NULL AND m.suppressed = 0
           AND (m.expires_at IS NULL OR m.expires_at > ?)) AS unread
       FROM agents a WHERE a.name = ?`
    )
    .bind(ctx.now(), n)
    .first<{ name: string; description: string; unread: number }>();
  if (!row) throw new MailboxError("not_found", `Agent "${n}" does not exist.`, "Check the name with list_agents.");
  return row;
}

export async function updateProfile(ctx: StoreContext, name: string, description: string): Promise<void> {
  const n = await requireAgent(ctx, name);
  await ctx.db.prepare("UPDATE agents SET description = ? WHERE name = ?").bind(description ?? "", n).run();
}
