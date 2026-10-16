import { MailboxError, type ErrorCode } from "../errors";
import { newId } from "../crypto";
import { normalizeName, validName } from "./agents";
import { auditStatement, type StoreContext } from "./audit";

const DAY_MS = 86_400_000;
const MAX_SUBJECT_CHARS = 200;
const MAX_BODY_BYTES = 32_768;
const MAX_DATA_BYTES = 65_536;
const MAX_ACK_IDS = 50;
/** Lifetime of a DELETE_ON_ACK tombstone that has no expiry of its own (MESSAGE_TTL_DAYS=0). */
const TOMBSTONE_TTL_MS = 7 * DAY_MS;
const enc = new TextEncoder();

export interface SendInput {
  to: string;
  subject: string;
  body: string;
  data?: unknown;
  reply_to?: string;
}

export interface Message {
  id: string;
  thread_id: string;
  reply_to: string | null;
  from: string;
  to: string;
  subject: string;
  body: string;
  data: unknown | null;
  sent_at: string;
}

interface Row {
  id: string;
  thread_id: string;
  reply_to: string | null;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  data: string | null;
  created_at: number;
}

const COLS = "id, thread_id, reply_to, from_agent, to_agent, subject, body, data, created_at";

function toMessage(r: Row): Message {
  return {
    id: r.id,
    thread_id: r.thread_id,
    reply_to: r.reply_to,
    from: r.from_agent,
    to: r.to_agent,
    subject: r.subject,
    body: r.body,
    data: r.data === null ? null : JSON.parse(r.data),
    sent_at: new Date(r.created_at).toISOString(),
  };
}

function validate(input: SendInput): string | null {
  if (typeof input.subject !== "string" || [...input.subject].length > MAX_SUBJECT_CHARS) {
    throw new MailboxError("invalid_input", `subject must be a string of at most ${MAX_SUBJECT_CHARS} characters.`, "Shorten the subject.");
  }
  if (typeof input.body !== "string") {
    throw new MailboxError("invalid_input", "body must be a string.", "Pass the message text as a string.");
  }
  if (enc.encode(input.body).length > MAX_BODY_BYTES) {
    throw new MailboxError("too_large", `body exceeds ${MAX_BODY_BYTES} bytes (UTF-8).`, "Shorten the body or split it into several messages.");
  }
  if (input.data === undefined) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(input.data);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new MailboxError("invalid_input", "data must be valid JSON.", "Pass a JSON-serializable value.");
  }
  if (enc.encode(json).length > MAX_DATA_BYTES) {
    throw new MailboxError("too_large", `data exceeds ${MAX_DATA_BYTES} bytes once serialized.`, "Send less structured data.");
  }
  return json;
}

export async function send(
  ctx: StoreContext,
  fromRaw: string,
  input: SendInput
): Promise<{ id: string; thread_id: string; delivered: string[]; failed: { agent: string; code: ErrorCode }[] }> {
  const from = normalizeName(fromRaw);
  const dataJson = validate(input);
  const toNorm = normalizeName(input.to);
  const broadcast = toNorm === "all";
  if (!broadcast) validName(toNorm);

  const now = ctx.now();
  let threadId = newId();
  let replyTo: string | null = null;
  if (input.reply_to !== undefined && input.reply_to !== null && input.reply_to !== "") {
    const ref = await ctx.db
      .prepare(
        `SELECT thread_id FROM messages WHERE id = ? AND (from_agent = ? OR (to_agent = ? AND suppressed = 0))
         AND (expires_at IS NULL OR expires_at > ?)`
      )
      .bind(String(input.reply_to), from, from, now)
      .first<{ thread_id: string }>();
    if (!ref) {
      throw new MailboxError(
        "invalid_reply_to",
        "reply_to does not refer to a message you sent or received that still exists.",
        "Use the id of a message from check_inbox or read_thread."
      );
    }
    threadId = ref.thread_id;
    replyTo = String(input.reply_to);
  }

  let recipients: string[];
  if (broadcast) {
    const { results } = await ctx.db
      .prepare("SELECT name FROM agents WHERE disabled = 0 AND name != ? ORDER BY name")
      .bind(from)
      .all<{ name: string }>();
    recipients = results.map((r) => r.name);
  } else {
    recipients = [toNorm];
  }

  const expiresAt = ctx.config.ttlDays > 0 ? now + ctx.config.ttlDays * DAY_MS : null;
  const delivered: string[] = [];
  const failed: { agent: string; code: ErrorCode }[] = [];
  const stmts: D1PreparedStatement[] = [];
  let firstId: string | null = null;

  for (const r of recipients) {
    const active = await ctx.db.prepare("SELECT 1 FROM agents WHERE name = ? AND disabled = 0").bind(r).first();
    if (!active) {
      failed.push({ agent: r, code: "unknown_recipient" });
      continue;
    }
    let suppressed = 0;
    const blocked = await ctx.db
      .prepare("SELECT 1 FROM blocks WHERE agent_name = ? AND blocked_sender = ?")
      .bind(r, from)
      .first();
    if (blocked) {
      if (ctx.config.blockedSenderFeedback === "reject") {
        failed.push({ agent: r, code: "blocked" });
        continue;
      }
      suppressed = 1; // silent: real row, invisible to the recipient
    }
    // Fullness is the recipient's visible unread. A silently blocked sender also counts its own live
    // suppressed rows to this recipient, so it hits inbox_full exactly when it would if its mail were visible
    // (otherwise "never inbox_full" would reveal the block).
    const unread = await ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND acked_at IS NULL
         AND (suppressed = 0 OR (? = 1 AND from_agent = ?)) AND (expires_at IS NULL OR expires_at > ?)`
      )
      .bind(r, suppressed, from, now)
      .first<{ n: number }>();
    if ((unread?.n ?? 0) >= ctx.config.maxUnread) {
      failed.push({ agent: r, code: "inbox_full" });
      continue;
    }
    const id = newId();
    firstId ??= id;
    stmts.push(
      ctx.db
        .prepare(
          `INSERT INTO messages (id, thread_id, reply_to, from_agent, to_agent, subject, body, data, created_at, expires_at, suppressed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, threadId, replyTo, from, r, input.subject, input.body, dataJson, now, expiresAt, suppressed)
    );
    delivered.push(r);
  }

  stmts.push(
    auditStatement(ctx, "send", from, delivered.length ? delivered.join(",") : null, input.subject, input.body)
  );
  await ctx.db.batch(stmts);
  return { id: firstId ?? newId(), thread_id: threadId, delivered, failed };
}

export async function inbox(ctx: StoreContext, agent: string, limit?: number): Promise<Message[]> {
  const max = ctx.config.maxUnread;
  let lim = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : max;
  lim = Math.min(Math.max(lim, 1), max);
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLS} FROM messages WHERE to_agent = ? AND acked_at IS NULL AND suppressed = 0
       AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid LIMIT ?`
    )
    .bind(normalizeName(agent), ctx.now(), lim)
    .all<Row>();
  return results.map(toMessage);
}

export async function ack(
  ctx: StoreContext,
  agent: string,
  ids: string[]
): Promise<{ acked: string[]; failed: { id: string; code: "not_found" }[] }> {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) {
    throw new MailboxError("invalid_input", "ids must be an array of strings.", "Pass message ids from check_inbox.");
  }
  if (ids.length > MAX_ACK_IDS) {
    throw new MailboxError("invalid_input", `Cannot ack more than ${MAX_ACK_IDS} ids at once.`, "Split the ids into several calls.");
  }
  const me = normalizeName(agent);
  const now = ctx.now();
  const acked: string[] = [];
  const failed: { id: string; code: "not_found" }[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const id of [...new Set(ids)]) {
    const row = await ctx.db
      .prepare("SELECT acked_at FROM messages WHERE id = ? AND to_agent = ? AND suppressed = 0 AND (expires_at IS NULL OR expires_at > ?)")
      .bind(id, me, now)
      .first<{ acked_at: number | null }>();
    if (!row) {
      failed.push({ id, code: "not_found" });
      continue;
    }
    acked.push(id);
    if (row.acked_at !== null) continue; // already acked: idempotent
    // A tombstone keeps the message's own expiry; under MESSAGE_TTL_DAYS=0 (NULL expiry) it gets
    // TOMBSTONE_TTL_MS so metadata is not kept forever.
    stmts.push(
      ctx.config.deleteOnAck
        ? ctx.db
            .prepare(
              `UPDATE messages SET subject = NULL, body = NULL, data = NULL, acked_at = ?, expires_at = COALESCE(expires_at, ?)
               WHERE id = ? AND to_agent = ? AND acked_at IS NULL`
            )
            .bind(now, now + TOMBSTONE_TTL_MS, id, me)
        : ctx.db.prepare("UPDATE messages SET acked_at = ? WHERE id = ? AND to_agent = ? AND acked_at IS NULL").bind(now, id, me)
    );
  }
  stmts.push(auditStatement(ctx, "ack", me, acked.length ? acked.join(",") : null));
  await ctx.db.batch(stmts);
  return { acked, failed };
}

export async function thread(ctx: StoreContext, agent: string, threadId: string): Promise<Message[]> {
  const me = normalizeName(agent);
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLS} FROM messages WHERE thread_id = ? AND (from_agent = ? OR (to_agent = ? AND suppressed = 0))
       AND body IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, rowid`
    )
    .bind(String(threadId), me, me, ctx.now())
    .all<Row>();
  return results.map(toMessage);
}
