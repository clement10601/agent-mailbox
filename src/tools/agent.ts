import { z } from "zod";
import { MailboxError } from "../errors";
import type { RateLimiter } from "../ratelimit";
import type { Store } from "../store";
import type { ToolSet } from "./types";

export const MAX_ACK_IDS = 50;
const SEND_RETRY_AFTER_SECONDS = 60;

const agentName = z.string().describe("Agent name (case-insensitive).");

/** Tools for an authenticated agent `me`. Identity comes from the key; no tool takes "who am I". */
export function agentTools(store: Store, me: string, sendLimiter: RateLimiter): ToolSet {
  return {
    whoami: {
      description: "Your agent name, description and number of unread messages.",
      schema: {},
      handler: async () => store.getProfile(me),
    },
    list_agents: {
      description: "Active agents you can message: name and description.",
      schema: {},
      handler: async () => ({ agents: await store.listAgents() }),
    },
    send_message: {
      description:
        'Send a message to an agent, or to "all" (every other active agent). Returns id, thread_id, delivered[] and failed[] ({agent, code}).',
      schema: {
        to: z.string().describe('Recipient agent name, or "all" to broadcast.'),
        subject: z.string().describe("Subject, at most 200 characters."),
        body: z.string().describe("Message text, at most 32 KiB (UTF-8)."),
        data: z.unknown().optional().describe("Optional structured JSON payload, at most 64 KiB serialized."),
        reply_to: z
          .string()
          .optional()
          .describe("Id of a message you sent or received; the new message joins its thread."),
      },
      handler: async (args: { to: string; subject: string; body: string; data?: unknown; reply_to?: string }) => {
        if (!(await sendLimiter.limit(me))) {
          throw new MailboxError(
            "rate_limited",
            "Too many messages sent; the limit is 30 per minute.",
            "Wait before sending again.",
            SEND_RETRY_AFTER_SECONDS
          );
        }
        return store.send(me, args);
      },
    },
    check_inbox: {
      description: "Unread messages, oldest first. Does not mark them read; call ack when done.",
      schema: {
        limit: z.number().int().optional().describe("Maximum number of messages; defaults to and is capped at MAX_UNREAD."),
      },
      handler: async (args: { limit?: number }) => ({ messages: await store.inbox(me, args.limit) }),
    },
    ack: {
      description: `Mark messages as handled (at most ${MAX_ACK_IDS} ids). Returns acked[] and failed[] ({id, code}).`,
      schema: {
        ids: z.array(z.string()).max(MAX_ACK_IDS).describe("Message ids from check_inbox."),
      },
      handler: async (args: { ids: string[] }) => store.ack(me, args.ids),
    },
    read_thread: {
      description: "Messages in a thread that you sent or received and that still exist, in time order.",
      schema: { thread_id: z.string().describe("Thread id from a message.") },
      handler: async (args: { thread_id: string }) => ({ messages: await store.thread(me, args.thread_id) }),
    },
    block_sender: {
      description: "Stop receiving messages from an agent.",
      schema: { agent: agentName },
      handler: async (args: { agent: string }) => {
        await store.block(me, args.agent);
        return { ok: true };
      },
    },
    unblock_sender: {
      description: "Receive messages from a previously blocked agent again.",
      schema: { agent: agentName },
      handler: async (args: { agent: string }) => {
        await store.unblock(me, args.agent);
        return { ok: true };
      },
    },
    list_blocked: {
      description: "Agents you have blocked.",
      schema: {},
      handler: async () => ({ blocked: await store.listBlocked(me) }),
    },
    update_profile: {
      description: "Update your description, shown to other agents in list_agents.",
      schema: { description: z.string().describe("New description.") },
      handler: async (args: { description: string }) => {
        await store.updateProfile(me, args.description);
        return { ok: true };
      },
    },
  };
}
