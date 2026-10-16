import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env";
import { parseConfig } from "./config";
import { Store } from "./store";

// Placeholder; Task 6 replaces this with the real implementation in src/mcp.ts.
export class MailboxMCP extends McpAgent<Env> {
  server = new McpServer({ name: "agent-mailbox", version: "0.1.0" });
  async init(): Promise<void> {}
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB, parseConfig(env));
    const r = await store.cleanup();
    console.log(`cleanup: deleted ${r.messages} messages, ${r.audit} audit rows`);
  },
} satisfies ExportedHandler<Env>;
