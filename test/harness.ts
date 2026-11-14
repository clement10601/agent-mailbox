// Runs the built Rust worker with wrangler's test harness, using wrangler.toml's bindings, and drives it over
// HTTP like a real client would. test/global-setup.ts builds it once into .wrangler/test-build.
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "wrangler";
import { afterAll, expect } from "vitest";

export const ADMIN_KEY = "test-admin-key-0123456789abcdef0123456789";
export const ORIGIN = "https://x";

const ROOT = join(__dirname, "..");
export const BUILD_DIR = join(ROOT, ".wrangler/test-build");

export interface D1 {
  prepare(sql: string): any;
  batch(stmts: any[]): Promise<any>;
}
export interface KV {
  list(opts?: { prefix?: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Worker {
  db: D1;
  kv: KV;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  scheduled(): Promise<void>;
  reset(): Promise<void>;
  logs(): string[];
}

const started: TestHarness[] = [];
afterAll(async () => {
  await Promise.all(started.splice(0).map((h) => h.close()));
});

/** Starts the worker with `vars` overriding wrangler.toml. `adminKey: null` leaves ADMIN_KEY unset. */
export async function startWorker(vars: Record<string, string> = {}, adminKey: string | null = ADMIN_KEY): Promise<Worker> {
  const secrets: Record<string, string> = adminKey === null ? {} : { ADMIN_KEY: adminKey };
  const h = createTestHarness({
    root: ROOT,
    workers: [{ configPath: "./wrangler.toml", prebuiltWorkerDir: BUILD_DIR, vars, secrets }],
  });
  started.push(h);
  await h.listen();
  let handle = h.getWorker();
  let env = (await handle.getEnv()) as { DB: D1; OAUTH_KV: KV };
  await handle.applyD1Migrations("DB");
  const w: Worker = {
    db: env.DB,
    kv: env.OAUTH_KV,
    async fetch(path, init) {
      return (await h.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...(init as object) } as never)) as unknown as Response;
    },
    async scheduled() {
      await handle.scheduled({ cron: "0 * * * *", scheduledTime: new Date() } as never);
    },
    /** Fresh storage and runtime (rate limiters included). */
    async reset() {
      await h.reset();
      await h.listen();
      handle = h.getWorker();
      env = (await handle.getEnv()) as { DB: D1; OAUTH_KV: KV };
      await handle.applyD1Migrations("DB");
      w.db = env.DB;
      w.kv = env.OAUTH_KV;
      h.clearLogs();
    },
    logs() {
      return h.getLogs().map((l: any) => (Array.isArray(l.message) ? l.message.join(" ") : String(l.message ?? JSON.stringify(l))));
    },
  };
  return w;
}

let ipCounter = 0;
export function freshIp(): string {
  ipCounter++;
  return `203.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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
  constructor(
    private w: Worker,
    private key: string,
    private ip = freshIp(),
  ) {}

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
    return this.w.fetch("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
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

  async init(): Promise<this> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    this.sessionId = res.headers.get("mcp-session-id");
    expect(this.sessionId).toBeTruthy();
    await rpcMessages(res);
    const n = await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await n.text();
    return this;
  }

  async toolNames(): Promise<string[]> {
    const r = await this.rpc("tools/list");
    return r.result.tools.map((t: { name: string }) => t.name);
  }

  async call(
    name: string,
    args: unknown = {},
  ): Promise<{ isError: boolean; value: any }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    return {
      isError: !!r.result.isError,
      value: JSON.parse(r.result.content[0].text),
    };
  }

  /** Calls a tool and fails the test if it returns a tool error. */
  async ok(name: string, args: unknown = {}): Promise<any> {
    const r = await this.call(name, args);
    expect(r.isError, JSON.stringify(r.value)).toBe(false);
    return r.value;
  }
}

/** An initialized admin client plus helpers for seeding state through the admin tools. */
export async function admin(w: Worker): Promise<Client> {
  return new Client(w, ADMIN_KEY).init();
}

export async function createAgent(
  w: Worker,
  name: string,
  description = "",
): Promise<{ name: string; key: string; key_id: string }> {
  return (await admin(w)).ok("admin_create_agent", { name, description });
}

export async function agentClient(w: Worker, name: string): Promise<Client> {
  const a = await createAgent(w, name);
  return new Client(w, a.key).init();
}
