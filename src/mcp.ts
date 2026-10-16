import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env";
import type { Identity } from "./auth";
import { parseConfig } from "./config";
import { toToolError, type ToolError } from "./errors";
import { fromBinding } from "./ratelimit";
import { Store } from "./store";
import { agentTools } from "./tools/agent";
import { adminTools } from "./tools/admin";
import type { ToolSet } from "./tools/types";

function errorResult(err: ToolError) {
  return { content: [{ type: "text" as const, text: JSON.stringify(err) }], isError: true };
}

/**
 * The SDK reports schema-validation failures (and its own protocol errors) as a plain-text tool error.
 * Re-shape those into our `{ code, message, hint }` contract so agents only ever see documented codes.
 * `createToolError` is private in the SDK typings, hence the cast; it is a plain prototype method at runtime.
 */
function reshapeSdkToolErrors(server: McpServer): void {
  const s = server as unknown as { createToolError: (msg: string) => unknown };
  s.createToolError = (msg: string) => {
    if (/validation error|Invalid arguments/i.test(msg)) {
      return errorResult({ code: "invalid_input", message: msg, hint: "Check the tool's input schema." });
    }
    console.error("mcp tool error:", msg);
    return errorResult(toToolError(new Error(msg)));
  };
}

export class MailboxMCP extends McpAgent<Env, unknown, Identity> {
  server = new McpServer({ name: "agent-mailbox", version: "0.1.0" });

  async init(): Promise<void> {
    reshapeSdkToolErrors(this.server);
    const identity = this.props;
    if (!identity) return;
    const store = new Store(this.env.DB, parseConfig(this.env));
    const tools: ToolSet =
      identity.role === "admin"
        ? adminTools(store, this.env.OAUTH_PROVIDER ?? null)
        : agentTools(store, identity.agent, fromBinding(this.env.SEND_LIMITER));
    for (const [name, def] of Object.entries(tools)) {
      this.server.registerTool(name, { description: def.description, inputSchema: def.schema }, (async (args: unknown) => {
        try {
          const result = await def.handler(args ?? {});
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (e) {
          const err = toToolError(e);
          if (err.code === "internal") console.error(`tool ${name} failed:`, e);
          return errorResult(err);
        }
      }) as never);
    }
  }
}
