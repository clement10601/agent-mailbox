# Agent Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cloudflare Workers 上建一個私人的 MCP 信箱，讓擁有者的 Agent（claude.ai 經 OAuth、Claude Code 經 Bearer key）互相非同步傳訊息。

**Architecture:** 單一 Worker。`index.ts` 依 `Authorization` 分流：`Bearer amk_…`／管理 key 直接進 MCP handler；其餘交給 `workers-oauth-provider`（它再把通過驗證的請求交給同一個 MCP handler）。MCP 層用 `agents` SDK 的 `McpAgent`，工具邏輯是純函式，資料存取全部集中在 `src/store/`（D1）。Cron 每小時清理過期資料。

**Tech Stack:** TypeScript、Cloudflare Workers、D1、KV、Workers Rate Limiting binding、`agents`（`McpAgent`）、`@modelcontextprotocol/sdk`、`@cloudflare/workers-oauth-provider`、`zod`、vitest + `@cloudflare/vitest-pool-workers`、wrangler 4。

**Spec:** `docs/superpowers/specs/2026-10-16-agent-mailbox-design.md`

## Global Constraints

- Agent 名稱：`^[a-z0-9][a-z0-9-]{0,31}$`；所有輸入的名稱先 `trim().toLowerCase()` 再驗證。
- Agent key：`amk_` + 32 bytes 隨機值的 base64url（無 padding）；只存 SHA-256 hex；只在建立時回傳一次。
- 管理 key：secret `ADMIN_KEY`，固定時間比對；`ADMIN_KEY` 未設定時所有需驗證的請求回 500（log 寫明原因）。
- 大小上限以 **UTF-8 位元組**計：`subject` ≤ 200 字元（字元數）、`body` ≤ 32768 bytes、`data` ≤ 65536 bytes 且為合法 JSON。
- 設定預設值：`DELETE_ON_ACK=true`、`MESSAGE_TTL_DAYS=7`、`MAX_UNREAD=10`、`AUDIT_LOG_BODIES=false`、`BLOCKED_SENDER_FEEDBACK=silent`、`OAUTH_REDIRECT_ALLOWLIST=https://claude.ai/api/mcp/auth_callback`。
- 發信速率：每個 Agent 每分鐘 30 封；驗證失敗：每個 IP 每分鐘 10 次後回 429。
- `ack` 一次最多 50 個 id；`admin_audit_log` 預設 limit 100。
- OAuth：access token 3600 秒、refresh token 30 天。
- 錯誤碼只能是：`unknown_recipient`、`blocked`、`inbox_full`、`too_large`、`invalid_input`、`invalid_reply_to`、`not_found`、`rate_limited`、`unauthorized`、`internal`。
- 所有時間以毫秒 epoch 整數存入 D1；回傳給 Agent 時轉成 ISO 8601。
- Repo 內不得出現真實的 D1／KV ID 或任何 key；`wrangler.toml` 用 `<D1_DATABASE_ID>`、`<KV_NAMESPACE_ID>` 預留位置，本機開發與測試用 `wrangler.toml` 的 `preview_*` 或 vitest 設定覆寫。

### 規格補充決定（實作時發現，需擁有者確認）

- **`ack` 後保留墓碑：** `DELETE_ON_ACK=true` 時，`ack` 立刻清空 `subject`、`body`、`data`（設為 NULL）並設 `acked_at`，但保留 `id`、`thread_id`、`from_agent`、`to_agent`、`created_at`、`expires_at` 直到到期。否則收件方「先 ack 再回覆」時 `reply_to` 會找不到原信而失敗。墓碑不出現在 `check_inbox`、`read_thread`，只用於 `reply_to` 解析討論串。

## Review Focus

1. 收件者名稱帶大小寫或空白（`" Strata "`）→ 視為 `strata` 正常投遞，不回 `unknown_recipient`。（Task 4 測試）
2. 收件方 `ack` 後才用 `reply_to` 回覆 → 回覆成功並歸入同一個 `thread_id`。（Task 4 測試）
3. 中文內容的大小計算：10,923 個中文字（約 32,769 bytes）→ `too_large`；10,922 個 → 成功。（Task 4 測試）
4. `check_inbox` 的 `limit` 為 0、負數或大於 `MAX_UNREAD` → 夾到 `[1, MAX_UNREAD]`，不報錯。（Task 4 測試）
5. 系統裡只有寄件者自己時廣播 `to: "all"` → 回 `delivered: []`、`failed: []`，不報錯。（Task 4 測試）

---

## File Structure

```
package.json, tsconfig.json, wrangler.toml, vitest.config.ts, .gitignore, LICENSE, README.md
.github/workflows/ci.yml
migrations/0001_init.sql
src/
  index.ts            Worker 進入點：分流、/healthz、scheduled()
  env.ts              Env 型別（bindings 與 vars）
  config.ts           parseConfig()
  errors.ts           MailboxError、ErrorCode
  crypto.ts           generateKey、sha256Hex、timingSafeEqual、newId
  auth.ts             authenticateBearer、Identity
  ratelimit.ts        RateLimiter 介面與 binding 包裝
  store/index.ts      Store 類別（組合下列模組，持有 db/config/clock）
  store/agents.ts     agents 與 keys
  store/messages.ts   send、inbox、ack、thread
  store/blocks.ts     黑名單
  store/audit.ts      寫入與查詢 audit_log
  store/cleanup.ts    到期清理
  tools/agent.ts      一般 Agent 工具的處理函式
  tools/admin.ts      管理工具的處理函式
  mcp.ts              MailboxMCP（McpAgent），依 Identity 註冊工具
  oauth.ts            /authorize 頁面（GET 表單、POST 同意）
test/
  setup.ts            套用 D1 migrations
  helpers.ts          建立 Store、假時鐘、假 RateLimiter
  *.test.ts
```

---

### Task 1: 專案骨架、schema 與 `/healthz`

**Files:**
- Create: `package.json`、`tsconfig.json`、`wrangler.toml`、`vitest.config.ts`、`.gitignore`、`migrations/0001_init.sql`、`src/env.ts`、`src/index.ts`、`test/setup.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `Env`（`DB: D1Database`、`OAUTH_KV: KVNamespace`、`MCP_OBJECT: DurableObjectNamespace`、`AUTH_LIMITER: RateLimit`、`SEND_LIMITER: RateLimit`、`ADMIN_KEY: string`、`OAUTH_PROVIDER: OAuthHelpers`，以及第 5 節所有 vars 為 `string`）；資料表如規格第 4 節。

- [ ] **Step 1: 驗證外部 API。** 安裝 `agents`、`@modelcontextprotocol/sdk`、`@cloudflare/workers-oauth-provider`、`zod`、`wrangler`、`vitest`、`@cloudflare/vitest-pool-workers`、`@cloudflare/workers-types`、`typescript`（安裝時的最新穩定版，寫死在 `package.json`）。閱讀已安裝套件的型別與 README，確認並在 commit 訊息記下：`McpAgent.serve(path)` 的用法與 `this.props` 的取得方式；`OAuthProvider` 的建構參數（`apiRoute`、`apiHandler`、`defaultHandler`、`authorizeEndpoint`、`tokenEndpoint`、`clientRegistrationEndpoint`、token 期限參數名稱）；`env.OAUTH_PROVIDER` 上的 `parseAuthRequest`、`completeAuthorization`、`listUserGrants`、`revokeGrant`；vitest pool 的 `readD1Migrations`／`applyD1Migrations`；wrangler 的 `[[ratelimits]]` 語法。後續 Task 若與此計畫寫的名稱不同，以已安裝版本為準並在該 Task 的 commit 註明。
- [ ] **Step 2: 寫 `wrangler.toml`**：`main = "src/index.ts"`、`compatibility_flags = ["nodejs_compat"]`、D1 binding `DB`（`database_id = "<D1_DATABASE_ID>"`、`migrations_dir = "migrations"`）、KV `OAUTH_KV`、Durable Object `MCP_OBJECT` → class `MailboxMCP`（`new_sqlite_classes` migration）、ratelimits `AUTH_LIMITER`（10／60 秒）與 `SEND_LIMITER`（30／60 秒）、`[triggers] crons = ["0 * * * *"]`、`[vars]` 為第 5 節預設值。
- [ ] **Step 3: 寫 `migrations/0001_init.sql`**：五張表與四個索引，欄位完全照規格第 4 節；`messages.subject`、`messages.body` 可為 NULL（墓碑用）。
- [ ] **Step 4: 寫失敗的測試 `test/smoke.test.ts`**

```ts
it("healthz returns ok", async () => {
  const res = await SELF.fetch("https://x/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
it("migrations create all tables", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','keys','messages','blocks','audit_log')"
  ).all();
  expect(results).toHaveLength(5);
});
```

- [ ] **Step 5: 執行 `npx vitest run test/smoke.test.ts`**，預期 FAIL（`/healthz` 尚未實作）。
- [ ] **Step 6: 實作 `src/index.ts` 的 `fetch`**：`GET /healthz` 回 200 `ok`（不需驗證），其他路徑暫時回 404；`scheduled` 先留空。`test/setup.ts` 套用 migrations。
- [ ] **Step 7: 執行 `npx vitest run` 與 `npx tsc --noEmit`**，預期全部 PASS。
- [ ] **Step 8: Commit** `chore: scaffold worker, schema and healthz`

---

### Task 2: 設定、錯誤與加密工具

**Files:**
- Create: `src/config.ts`、`src/errors.ts`、`src/crypto.ts`
- Test: `test/config.test.ts`、`test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `interface Config { deleteOnAck: boolean; ttlDays: number; maxUnread: number; auditLogBodies: boolean; blockedSenderFeedback: "silent" | "reject"; oauthRedirectAllowlist: string[] }`
  - `parseConfig(env: Env): Config`，不合法時丟 `ConfigError`（訊息指出哪個變數）。
  - `type ErrorCode`（Global Constraints 的十個值）；`class MailboxError extends Error { code: ErrorCode; hint: string; retryAfter?: number }`；`toToolError(e: unknown): { code: ErrorCode; message: string; hint: string; retry_after?: number }`（非 `MailboxError` 一律轉成 `internal`，不洩漏訊息內容）。
  - `generateKey(): string`、`sha256Hex(s: string): Promise<string>`、`timingSafeEqual(a: string, b: string): Promise<boolean>`、`newId(): string`（16 個小寫 hex 字元）。

- [ ] **Step 1: 寫失敗的測試**
  - `parseConfig` 預設值：空 vars → 等於 Global Constraints 的預設。
  - `DELETE_ON_ACK="false"` → `false`；`"yes"` → 丟 `ConfigError`，訊息含 `DELETE_ON_ACK`。
  - `MESSAGE_TTL_DAYS="0"` → `0`；`"-1"`、`"abc"` → 丟錯。
  - `MAX_UNREAD="0"` → 丟錯（最小 1）。
  - `BLOCKED_SENDER_FEEDBACK="reject"` → `"reject"`；`"loud"` → 丟錯。
  - `OAUTH_REDIRECT_ALLOWLIST="https://a/cb, https://b/cb"` → `["https://a/cb","https://b/cb"]`。
  - `generateKey()` 符合 `/^amk_[A-Za-z0-9_-]{43}$/`，兩次結果不同。
  - `sha256Hex("abc")` 等於 `"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"`。
  - `timingSafeEqual("a","a")` 為 true；`("a","b")`、`("a","aa")` 為 false。
  - `toToolError(new Error("secret"))` → `code: "internal"`，`message` 不含 `secret`。
- [ ] **Step 2: 執行 `npx vitest run test/config.test.ts test/crypto.test.ts`**，預期 FAIL。
- [ ] **Step 3: 實作三個檔案。** `timingSafeEqual` 先各自做 SHA-256 再逐位元組比對，避免長度洩漏。
- [ ] **Step 4: 執行同一指令**，預期 PASS。
- [ ] **Step 5: Commit** `feat: config parsing, error model and crypto helpers`

---

### Task 3: Store — Agent、key 與稽核紀錄

**Files:**
- Create: `src/store/index.ts`、`src/store/agents.ts`、`src/store/audit.ts`、`test/helpers.ts`
- Test: `test/store.agents.test.ts`

**Interfaces:**
- Consumes: `Config`、`MailboxError`、`generateKey`、`sha256Hex`、`newId`。
- Produces（皆為 `Store` 的方法；`Store` 建構式為 `new Store(db: D1Database, config: Config, now: () => number = Date.now)`）：
  - `createAgent(name: string, description: string): Promise<{ name: string; key: string; keyId: string }>`；名稱不合法 → `invalid_input`；已存在 → `invalid_input`（hint：改用 `admin_issue_key`）。
  - `issueKey(name: string): Promise<{ key: string; keyId: string }>`、`revokeKey(keyId: string): Promise<void>`（不存在 → `not_found`）。
  - `setDisabled(name: string, disabled: boolean): Promise<void>`。
  - `resolveKey(rawKey: string): Promise<string | null>`：回傳 Agent 名稱；key 已撤銷或 Agent 停用 → `null`。
  - `isActive(name: string): Promise<boolean>`。
  - `touch(name: string): Promise<void>`：距上次 `last_seen_at` 不足 60 秒則不寫入。
  - `listAgents(): Promise<{ name: string; description: string }[]>`（只含啟用中，依名稱排序）。
  - `adminListAgents(): Promise<{ name; description; disabled: boolean; unread: number; last_seen_at: string | null; active_keys: number }[]>`。
  - `getProfile(name: string): Promise<{ name; description; unread: number }>`、`updateProfile(name: string, description: string): Promise<void>`。
  - `audit(event: string, actor: string, target: string | null, subject?: string | null, body?: string | null): Promise<void>`：只有 `config.auditLogBodies` 為 true 才寫入 body；`expires_at` 依 `ttlDays` 計算（0 → NULL）。
  - `test/helpers.ts`：`makeStore(overrides?: Partial<Config>, start?: number): { store: Store; clock: { now: number; advance(ms: number): void } }`，每個測試前清空所有資料表。

- [ ] **Step 1: 寫失敗的測試**
  - `createAgent("Strata ", "llm")` → 名稱 `strata`，`key` 以 `amk_` 開頭；`keys` 表裡存的是雜湊，不等於原始 key。
  - `createAgent("bad name!", "")` → `invalid_input`；重複建立 → `invalid_input`。
  - `resolveKey(key)` → `"strata"`；`revokeKey` 後 → `null`；`setDisabled("strata", true)` 後另一把有效 key 也 → `null`。
  - `issueKey` 產生第二把 key，兩把都能 resolve。
  - `touch` 兩次相隔 30 秒只寫入一次（比對 `last_seen_at`）；相隔 61 秒則更新。
  - `listAgents` 不含停用的 Agent；`adminListAgents` 含停用的，且 `active_keys` 正確。
  - `createAgent`、`issueKey`、`revokeKey`、`setDisabled(…, true)` 分別寫入 `agent_created`、`key_issued`、`key_revoked`、`agent_disabled` 紀錄；`auditLogBodies=false` 時 body 欄位為 NULL。
- [ ] **Step 2: 執行 `npx vitest run test/store.agents.test.ts`**，預期 FAIL。
- [ ] **Step 3: 實作 `store/agents.ts`、`store/audit.ts`，由 `store/index.ts` 的 `Store` 組合。**
- [ ] **Step 4: 執行同一指令**，預期 PASS。
- [ ] **Step 5: Commit** `feat: agent, key and audit storage`

---

### Task 4: Store — 收發信與黑名單

**Files:**
- Create: `src/store/messages.ts`、`src/store/blocks.ts`
- Modify: `src/store/index.ts`
- Test: `test/store.messages.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `Store`、`isActive`、`audit`。
- Produces:
  - `interface SendInput { to: string; subject: string; body: string; data?: unknown; reply_to?: string }`
  - `interface Message { id; thread_id; reply_to: string | null; from: string; to: string; subject: string; body: string; data: unknown | null; sent_at: string }`
  - `send(from: string, input: SendInput): Promise<{ id: string; thread_id: string; delivered: string[]; failed: { agent: string; code: ErrorCode }[] }>`：依規格第 6 節投遞規則；整封性錯誤（`too_large`、`invalid_input`、`invalid_reply_to`）直接丟 `MailboxError`。單一收件者時 `id` 為該列 id；廣播時 `id` 為第一個實際寫入列的 id（沒有寫入時為新產生、未寫入的 id），所有列共用 `thread_id`。
  - `inbox(agent: string, limit?: number): Promise<Message[]>`：未 ack、未過期，依 `created_at` 由舊到新，`limit` 夾到 `[1, maxUnread]`。
  - `ack(agent: string, ids: string[]): Promise<{ acked: string[]; failed: { id: string; code: "not_found" }[] }>`：超過 50 個 → `invalid_input`；`deleteOnAck` 時改成墓碑（見 Global Constraints 的補充決定），否則只設 `acked_at`。
  - `thread(agent: string, threadId: string): Promise<Message[]>`：只含 `from_agent` 或 `to_agent` 為自己、非墓碑、未過期的信。
  - `block(agent: string, sender: string)`、`unblock(agent: string, sender: string)`、`listBlocked(agent: string): Promise<string[]>`。

- [ ] **Step 1: 寫失敗的測試**（Agent `a`、`b`、`c` 預先建立）
  - `send("a", { to: "b", subject: "hi", body: "x" })` → `delivered: ["b"]`；`inbox("b")` 有一封，`from: "a"`，`sent_at` 為 ISO 字串。
  - **Review Focus 1：** `to: " B "` → 投遞給 `b`。
  - 收件者不存在或已停用 → `failed: [{ agent, code: "unknown_recipient" }]`。
  - `b` 封鎖 `a`：`silent` 模式 → `delivered: ["b"]` 但 `inbox("b")` 為空；`reject` 模式 → `failed` 的 code 為 `blocked`。
  - `b` 已有 10 封未讀 → `failed` 的 code 為 `inbox_full`；`b` 封鎖 `a` 且收件匣滿 → `silent` 模式仍回 `delivered`。
  - 廣播：`to: "all"` 時寄給 `b`、`c`，不含 `a`；`c` 收件匣滿 → `delivered: ["b"]`、`failed: [{ agent: "c", code: "inbox_full" }]`；兩列共用 `thread_id`。
  - **Review Focus 5：** 只有 `a` 存在時廣播 → `delivered: []`、`failed: []`。
  - **Review Focus 3：** `body` 為 10,922 個「中」→ 成功；10,923 個 → `too_large`。`data` 序列化後超過 65,536 bytes → `too_large`。
  - `subject` 201 字元 → `invalid_input`。
  - `reply_to` 指向 `b` 收到的信，由 `b` 回覆 → 新信的 `thread_id` 等於原信；由無關的 `c` 用同一個 id 回覆 → `invalid_reply_to`。
  - **Review Focus 2：** `b` 先 `ack` 原信（`deleteOnAck=true`），再以 `reply_to` 回覆 → 成功且 `thread_id` 相同；原信列的 `body`、`subject`、`data` 為 NULL。
  - `ack` 別人的信 id → `failed` 的 code 為 `not_found`，該信未被修改；`deleteOnAck=false` 時 `ack` 後 `thread()` 仍讀得到內容。
  - `ack` 51 個 id → `invalid_input`。
  - **Review Focus 4：** `inbox("b", 0)`、`inbox("b", -5)` 回 1 封；`inbox("b", 99)` 最多回 10 封。
  - `thread()` 不回傳 `b` 與 `c` 之間的信給 `a`。
  - 寄給自己：`send("a", { to: "a", … })` → `delivered: ["a"]`。
  - `ttlDays=7`：時鐘前進 7 天加 1 毫秒後，`inbox` 不再回傳該信。
- [ ] **Step 2: 執行 `npx vitest run test/store.messages.test.ts`**，預期 FAIL。
- [ ] **Step 3: 實作 `messages.ts`、`blocks.ts`。** 每位收件者的判斷依規格第 6 節的順序；寫入用 `db.batch` 一次送出；每次 `send` 寫入一筆 `send` 紀錄（target 為收件者清單，以逗號串接；`auditLogBodies` 為 true 時含 body），每次 `ack`、`block`、`unblock` 各寫入對應事件。
- [ ] **Step 4: 執行同一指令**，預期 PASS。
- [ ] **Step 5: Commit** `feat: message delivery, inbox, ack and blocklist`

---

### Task 5: 到期清理、稽核查詢與 cron

**Files:**
- Create: `src/store/cleanup.ts`
- Modify: `src/store/audit.ts`、`src/store/index.ts`、`src/index.ts`（`scheduled`）
- Test: `test/cleanup.test.ts`

**Interfaces:**
- Produces:
  - `cleanup(batch = 5000): Promise<{ messages: number; audit: number }>`：刪除 `expires_at < now` 的列；`deleteOnAck` 為 true 時不刪尚未到期的墓碑。
  - `auditLog(q: { since?: number; agent?: string; limit?: number }): Promise<{ ts: string; event; actor; target; subject; body }[]>`：新的在前，`agent` 比對 `actor` 或 `target`（`target` 為逗號串接時用 `LIKE` 比對完整名稱）。
  - `scheduled` 呼叫 `cleanup()` 並用 `console.log` 記錄刪除數量。

- [ ] **Step 1: 寫失敗的測試**
  - 建立 3 封信，時鐘前進 8 天 → `cleanup()` 回 `messages: 3`，表內為空。
  - `ttlDays=0` 時 `expires_at` 為 NULL，前進 365 天仍不刪除。
  - `cleanup(2)` 時有 3 封過期 → 回 `messages: 2`，第二次呼叫回 `1`。
  - 墓碑在到期前不被刪除，到期後被刪除。
  - `auditLog({ agent: "b" })` 只回傳 actor 或 target 包含 `b` 的紀錄；`agent: "b"` 不匹配名為 `bb` 的 Agent。
- [ ] **Step 2: 執行 `npx vitest run test/cleanup.test.ts`**，預期 FAIL。
- [ ] **Step 3: 實作。** 刪除用 `DELETE FROM … WHERE rowid IN (SELECT rowid … LIMIT ?)`。
- [ ] **Step 4: 執行同一指令**，預期 PASS。
- [ ] **Step 5: Commit** `feat: expiry cleanup, audit query and cron`

---

### Task 6: Bearer 驗證、限速與 MCP 工具

**Files:**
- Create: `src/auth.ts`、`src/ratelimit.ts`、`src/tools/agent.ts`、`src/tools/admin.ts`、`src/mcp.ts`
- Modify: `src/index.ts`
- Test: `test/auth.test.ts`、`test/tools.test.ts`、`test/mcp.http.test.ts`

**Interfaces:**
- Consumes: Task 3–5 的 `Store`。
- Produces:
  - `type Identity = { role: "admin" } | { role: "agent"; agent: string }`
  - `authenticateBearer(header: string | null, env: Env, store: Store): Promise<Identity | null>`：`Bearer <ADMIN_KEY>` → admin；`Bearer amk_…` → `resolveKey`；其他 → `null`。
  - `interface RateLimiter { limit(key: string): Promise<boolean> }`；`fromBinding(b: RateLimit): RateLimiter`。
  - `tools/agent.ts`：`agentTools(store: Store, me: string, sendLimiter: RateLimiter)` 回傳 `Record<string, { description: string; schema: ZodRawShape; handler: (args) => Promise<unknown> }>`，工具名稱與參數照規格第 6 節。`send_message` 先呼叫 `sendLimiter.limit(me)`，失敗時丟 `rate_limited`（`retryAfter: 60`）。
  - `tools/admin.ts`：`adminTools(store: Store, oauth: OAuthHelpers)`，同樣的回傳形狀；`admin_revoke_oauth` 參數為 `agent`、`grant_id`；`admin_list_agents` 的 OAuth 授權數用 `oauth.listUserGrants(agent)`（userId 等於 Agent 名稱）。
  - `class MailboxMCP extends McpAgent<Env, unknown, Identity>`：`init()` 依 `this.props.role` 只註冊 `agentTools` 或 `adminTools`；每個 handler 外包一層，成功時回 `{ content: [{ type: "text", text: JSON.stringify(result) }] }`，失敗時回 `isError: true` 加上 `toToolError(e)` 的 JSON。
  - `index.ts`：`/mcp` 且帶 `Bearer amk_` 或管理 key 時，先 `authenticateBearer`；失敗則寫入 `auth_failed` 紀錄（actor 為 IP），並以 `AUTH_LIMITER` 依 `CF-Connecting-IP` 限速，回 429 或 401（內文 `unauthorized`）；成功則把 Identity 放入 `ctx.props`，Agent 身分先 `touch`，再交給 `MailboxMCP.serve("/mcp")`。其他請求暫時回 404（Task 7 接上 OAuth）。

- [ ] **Step 1: 寫失敗的測試**
  - `auth.test.ts`：管理 key → admin；錯誤的管理 key → `null`；有效、已撤銷、停用 Agent 的 key 各自結果正確；沒有標頭 → `null`。
  - `tools.test.ts`（直接呼叫 handler，用假 RateLimiter）：`whoami` 回傳自己的 `unread`；`list_agents` 不含 `unread`；`send_message` 在限速器回 false 時丟 `rate_limited` 且 `retry_after` 為 60；`check_inbox` 後 `ack` 再 `check_inbox` 為空；`admin_create_agent` 回傳的 key 可被 `resolveKey` 解析；`admin_set_block` 替 `b` 封鎖 `a` 後 `a` 寄給 `b` 不進收件匣。
  - `mcp.http.test.ts`（用 `SELF.fetch` 送 JSON-RPC `initialize` 再 `tools/list`）：Agent key 的工具清單包含 `send_message`、不含任何 `admin_` 開頭的工具；管理 key 的清單只有 `admin_` 開頭的工具；錯誤 key 回 401、內文 `unauthorized`；同一 IP 第 11 次錯誤回 429；一次完整的 `tools/call send_message` 加上 `check_inbox` 拿得到信。
- [ ] **Step 2: 執行 `npx vitest run test/auth.test.ts test/tools.test.ts test/mcp.http.test.ts`**，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 執行 `npx vitest run` 與 `npx tsc --noEmit`**，預期全部 PASS。
- [ ] **Step 5: Commit** `feat: bearer auth, rate limiting and MCP tools`

---

### Task 7: claude.ai 用的 OAuth

**Files:**
- Create: `src/oauth.ts`
- Modify: `src/index.ts`、`src/tools/admin.ts`（若 Task 1 Step 1 發現 API 名稱不同）
- Test: `test/oauth.test.ts`

**Interfaces:**
- Consumes: `Store`、`Config.oauthRedirectAllowlist`、`timingSafeEqual`、`MailboxMCP.serve`。
- Produces:
  - `index.ts` 的 default export 改為 `OAuthProvider`：`apiRoute: "/mcp"`；`apiHandler` 是一個包裝，先確認 `ctx.props.agent` 仍為啟用中（否則回 401）並 `touch`，再交給 `MailboxMCP.serve("/mcp")`；`defaultHandler` 處理 `/healthz`、`/authorize`；`authorizeEndpoint: "/authorize"`、`tokenEndpoint: "/token"`、`clientRegistrationEndpoint: "/register"`；access token 3600 秒、refresh token 30 天。Bearer 分流（Task 6）在呼叫 `OAuthProvider` 之前處理。
  - `oauth.ts`：`handleAuthorize(request: Request, env: Env, store: Store, config: Config): Promise<Response>`
    - GET：`parseAuthRequest` → redirect URI 不在白名單回 400；回傳表單（管理 key 欄位、現有 Agent 下拉選單、新 Agent 名稱欄位、隱藏的 CSRF token），並設定 `__Host-csrf` cookie（`Secure; HttpOnly; SameSite=Strict; Path=/`）。
    - POST：比對 CSRF cookie 與表單值；以 `timingSafeEqual` 比對管理 key，失敗時用 `AUTH_LIMITER` 限速並回 401 表單；選新名稱時呼叫 `createAgent`（不回傳 key）；呼叫 `completeAuthorization({ request, userId: agent, scope, props: { role: "agent", agent }, metadata: { label: agent } })`，寫入 `oauth_granted` 紀錄，302 導回。
    - 所有回應加上 `Content-Security-Policy: frame-ancestors 'none'` 與 `X-Frame-Options: DENY`。

- [ ] **Step 1: 寫失敗的測試**
  - 動態註冊一個 redirect URI 為 `https://claude.ai/api/mcp/auth_callback` 的 client，GET `/authorize` → 200，含表單與 `Set-Cookie: __Host-csrf`，標頭含 `frame-ancestors 'none'`。
  - 註冊 redirect URI 為 `https://evil.example/cb` 的 client，GET `/authorize` → 400。
  - POST 時 CSRF 不符 → 403；管理 key 錯誤 → 401；正確 → 302，`Location` 以 redirect URI 開頭且帶 `code`。
  - 用授權碼向 `/token` 換 token，再以該 token 呼叫 `/mcp` 的 `tools/list` → 包含 `send_message`；`whoami` 回傳選定的 Agent 名稱。
  - `setDisabled(agent, true)` 後同一個 token 呼叫 `/mcp` → 401。
  - `admin_revoke_oauth` 後該 token 失效。
- [ ] **Step 2: 執行 `npx vitest run test/oauth.test.ts`**，預期 FAIL。
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 執行 `npx vitest run` 與 `npx tsc --noEmit`**，預期全部 PASS（包含 Task 6 的 Bearer 測試）。
- [ ] **Step 5: Commit** `feat: OAuth authorization for claude.ai connectors`

---

### Task 8: 開源文件與 CI

**Files:**
- Create: `README.md`、`LICENSE`（GPL-3.0-only，著作權人 `clement10601`，年份 2026）、`.github/workflows/ci.yml`、`docs/agent-instructions.md`

**Interfaces:**
- Consumes: 全部功能；`docs/agent-instructions.md` 內容照規格第 12 節。

- [ ] **Step 1: 寫 `ci.yml`**：在 push 與 pull_request 時執行 `npm ci`、`npx tsc --noEmit`、`npx vitest run`。
- [ ] **Step 2: 寫 `README.md`**，章節依序為：這是什麼；為什麼不用 Gmail／Slack；安全模型（三層保護、提示詞注入注意事項）；自架步驟（`wrangler d1 create`、`wrangler kv namespace create`、把 ID 填進 `wrangler.toml`、`wrangler d1 migrations apply --remote`、`wrangler secret put ADMIN_KEY`、`wrangler deploy`）；設定表（照規格第 5 節）；連線方式（Claude Code 指令、claude.ai 連接器步驟）；建立第一個 Agent（用管理 key 連線後呼叫 `admin_create_agent`）；Agent 指示範本的連結；費用說明（免費方案到上限即停止，不會自動扣款）。
- [ ] **Step 3: 檢查 repo 沒有秘密**：`git grep -nE "amk_[A-Za-z0-9_-]{20,}|[0-9a-f]{32}"` 只應找到測試裡的假資料與 SHA-256 測試向量。
- [ ] **Step 4: 執行 `npx vitest run` 與 `npx tsc --noEmit`**，預期 PASS。
- [ ] **Step 5: Commit** `docs: README, license, agent instructions and CI`

---

## 計畫完成後（不屬於上述 Task，需擁有者逐項同意）

1. 在 GitHub 建立**私人** repo `clement10601/agent-mailbox` 並推送。
2. 部署到擁有者的 Cloudflare 帳號：`wrangler login`（擁有者自己完成）、建立 D1／KV、套用 migration、設定 `ADMIN_KEY`、`wrangler deploy`。部署前先查 Cloudflare 官方價格頁確認免費額度。
3. 端到端驗證：從 Claude Code 用管理 key 建立 `claude-code` Agent，用它的 key 加入 MCP，寄信給自己、`check_inbox`、`ack`；擁有者在 claude.ai 加入連接器完成 OAuth，兩邊互寄一次。
