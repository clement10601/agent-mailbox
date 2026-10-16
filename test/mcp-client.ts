import { SELF } from "cloudflare:test";
import { expect } from "vitest";

let ipCounter = 0;
export function freshIp(): string {
  ipCounter++;
  return `203.0.113.${ipCounter}`;
}

/** Parses a JSON or SSE response body into the JSON-RPC messages it carries. */
export async function rpcMessages(res: Response): Promise<any[]> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
  }
  return text ? [JSON.parse(text)] : [];
}

export class Client {
  sessionId: string | null = null;
  nextId = 1;
  constructor(private key: string, private ip = freshIp()) {}

  async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "CF-Connecting-IP": this.ip,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
      headers["mcp-protocol-version"] = "2025-06-18";
    }
    return SELF.fetch("https://x/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  }

  async rpc(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    expect(res.status).toBe(200);
    const msgs = await rpcMessages(res);
    const m = msgs.find((x) => x.id === id);
    expect(m, JSON.stringify(msgs)).toBeDefined();
    return m;
  }

  async init(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(res.status).toBe(200);
    this.sessionId = res.headers.get("mcp-session-id");
    expect(this.sessionId).toBeTruthy();
    await rpcMessages(res);
    const n = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await n.text();
  }

  async toolNames(): Promise<string[]> {
    const r = await this.rpc("tools/list");
    return r.result.tools.map((t: { name: string }) => t.name);
  }

  async call(name: string, args: unknown): Promise<{ isError: boolean; value: any }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    return { isError: !!r.result.isError, value: JSON.parse(r.result.content[0].text) };
  }
}

