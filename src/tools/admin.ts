import { z } from "zod";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MailboxError } from "../errors";
import type { Store } from "../store";
import type { ToolSet } from "./types";

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 1000;

const agentName = z.string().describe("Agent name (case-insensitive).");

async function countGrants(oauth: OAuthHelpers | null, agent: string): Promise<number> {
  if (!oauth) return 0;
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(agent, cursor ? { cursor } : undefined);
    n += page.items.length;
    cursor = page.cursor;
  } while (cursor);
  return n;
}

function parseSince(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) {
    throw new MailboxError("invalid_input", `since is not a valid ISO 8601 time: "${since}".`, 'Use e.g. "2026-10-16T00:00:00Z".');
  }
  return ms;
}

/** Tools for the admin identity. `oauth` is null when the OAuth provider is not available on this request. */
export function adminTools(store: Store, oauth: OAuthHelpers | null): ToolSet {
  return {
    admin_create_agent: {
      description: "Create an agent and return its first key. The key is shown only once.",
      schema: {
        name: z.string().describe("1-32 chars: lowercase letters, digits, hyphen."),
        description: z.string().optional().describe("What the agent does."),
      },
      handler: async (args: { name: string; description?: string }) => {
        const r = await store.createAgent(args.name, args.description ?? "");
        return { name: r.name, key: r.key, key_id: r.keyId };
      },
    },
    admin_issue_key: {
      description: "Issue an additional key for an agent. The key is shown only once.",
      schema: { agent: agentName },
      handler: async (args: { agent: string }) => {
        const r = await store.issueKey(args.agent);
        return { key: r.key, key_id: r.keyId };
      },
    },
    admin_revoke_key: {
      description: "Revoke a key by its id.",
      schema: { key_id: z.string().describe("Key id from admin_create_agent or admin_issue_key.") },
      handler: async (args: { key_id: string }) => {
        await store.revokeKey(args.key_id);
        return { ok: true };
      },
    },
    admin_disable_agent: {
      description: "Disable an agent: its keys and OAuth tokens stop working and it cannot receive mail.",
      schema: { agent: agentName },
      handler: async (args: { agent: string }) => {
        await store.setDisabled(args.agent, true);
        return { ok: true };
      },
    },
    admin_enable_agent: {
      description: "Re-enable a disabled agent.",
      schema: { agent: agentName },
      handler: async (args: { agent: string }) => {
        await store.setDisabled(args.agent, false);
        return { ok: true };
      },
    },
    admin_list_agents: {
      description: "All agents with unread count, last_seen_at, active key count and OAuth grant count.",
      schema: {},
      handler: async () => {
        const agents = await store.adminListAgents();
        const out = [];
        for (const a of agents) out.push({ ...a, oauth_grants: await countGrants(oauth, a.name) });
        return { agents: out };
      },
    },
    admin_audit_log: {
      description: `Audit log, newest first. Defaults to ${AUDIT_DEFAULT_LIMIT} entries (max ${AUDIT_MAX_LIMIT}).`,
      schema: {
        since: z.string().optional().describe("Only entries at or after this ISO 8601 time."),
        agent: z.string().optional().describe("Only entries where this agent is actor or target."),
        limit: z.number().int().optional().describe(`Maximum entries (1-${AUDIT_MAX_LIMIT}).`),
      },
      handler: async (args: { since?: string; agent?: string; limit?: number }) => {
        const limit = Math.min(Math.max(Math.floor(args.limit ?? AUDIT_DEFAULT_LIMIT), 1), AUDIT_MAX_LIMIT);
        const agent = args.agent === undefined ? undefined : args.agent.trim().toLowerCase();
        return { entries: await store.auditLog({ since: parseSince(args.since), agent, limit }) };
      },
    },
    admin_set_block: {
      description: "Set or clear a block on behalf of any agent: `agent` stops (or resumes) receiving mail from `sender`.",
      schema: {
        agent: z.string().describe("The agent whose blocklist changes."),
        sender: z.string().describe("The sender to block or unblock."),
        blocked: z.boolean().describe("true to block, false to unblock."),
      },
      handler: async (args: { agent: string; sender: string; blocked: boolean }) => {
        const { name } = await store.getProfile(args.agent); // not_found if missing
        if (args.blocked) await store.block(name, args.sender);
        else await store.unblock(name, args.sender);
        return { ok: true };
      },
    },
    admin_revoke_oauth: {
      description: "Revoke one OAuth grant of an agent (grant ids are listed by the OAuth provider).",
      schema: {
        agent: agentName,
        grant_id: z.string().describe("OAuth grant id."),
      },
      handler: async (args: { agent: string; grant_id: string }) => {
        if (!oauth) {
          throw new MailboxError("internal", "OAuth is not available.", "Retry later; if it persists, contact the operator.");
        }
        await oauth.revokeGrant(args.grant_id, args.agent.trim().toLowerCase());
        return { ok: true };
      },
    },
  };
}
