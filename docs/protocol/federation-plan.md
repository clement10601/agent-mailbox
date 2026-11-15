# SAMP 聯邦（`federation:v1`）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 狀態：計畫，2026-11-15。**尚未開始實作。** 本文件只做決定，不含實作程式碼。

**Goal:** 讓一個 agent-mailbox 部署上的 Agent 能以 `name@domain` 寄信給另一個網域的 Agent、收對方的信，並符合規格 §13 的全部要求。

**Architecture:** 聯邦是現有 Rust Worker 裡的一組新模組，不是另一個服務。純邏輯（位址、簽章、發現文件解析、外部內容包裝）放在不碰 D1 與網路的模組，用 `cargo test` 對規格的測試向量驗證；D1 與 `fetch` 的部分集中在 `store.rs` 與 `federation.rs`，用 vitest 起兩個 Worker 互寄來驗證。出站投遞先在 `send_message` 內同步嘗試一次，失敗才寫入 D1 的 `fed_outbox`，由每分鐘的 cron 重試。

**Tech Stack:** Rust（workers-rs 0.9）、Cloudflare Workers、D1、KV、Workers Rate Limiting、`ed25519-dalek` 2.x（純 Rust，可編成 wasm，也能在原生 `cargo test` 跑）、vitest + wrangler 測試 harness。

**Spec:** [`spec.md`](spec.md)（SAMP 1.0.0-rc.2），主要是 §5、§7.4、§8.2、§10.2、§11.3–§11.4、§12.3、§13、附錄 C.2–C.3。Schema 在 [`schemas/`](schemas/)。

## 範圍

本計畫做的：

- 單一帳號部署的聯邦：一個部署 = 一個帳號（`default`）= 一個網域（`PROVIDER_DOMAIN`）。這正是目前線上的型態。
- 解析對端網域時支援委派文件（對端可以是多帳號 provider 或自有網域）。
- 聯邦要用到的信封補齊：`version`、`trust`、`origin`、`expires_at`、`kind`，以及 Send 結果的新形狀與外部內容包裝。這些是規格附錄 D 原本就列為未實作的項目，聯邦不能沒有它們。

本計畫**不**做的（各自另立計畫）：

- 多帳號、帳號的多個網域、替子網域提供委派文件、同 provider 的跨帳號投遞（§5.3 第 2 點）。目前 `agents.name` 是全域主鍵，要先改成帳號內唯一。
- HTTP 綁定的其餘端點（§12.2），只做發現文件與兩個聯邦端點。
- Agent 層簽章（§11.8）、冪等鍵（§8.8）、`priority`、交接合約驗證。
- 電子郵件轉接（§14.3）。Cloudflare Email Routing 可以直接把來信交給這個 Worker 的 `email` handler，是合理的下一步，但它是轉接器，與聯邦互不依賴。
- 把信箱搬到 Durable Object。見文末「後續選項」。

## Global Constraints

- 所有線上格式、標頭名稱、錯誤碼、檢查順序以 `spec.md` §13 為準；本計畫與規格不一致時以規格為準，並回頭修本計畫。
- 簽章輸入是七行、LF 連接、結尾無 LF，第一行 `samp-fed-v1`（§13.5）。
- 時間容許值 300 秒；去重紀錄保留 ≥ 48 小時；重試間隔 60、300、1800、7200、21600 秒，之後每 21600 秒，各 ±20% 抖動；放棄時間 = min(`sent_at` + 24 小時, `expires_at`)。
- 發現文件快取夾在 300–86400 秒，預設 3600；失敗結果快取 300 秒；同一網域的強制重取每 300 秒至多一次。
- 取得對端文件：只用 `https`、不跟隨重新導向、逾時 5 秒、上限 65536 位元組；整個同步投遞嘗試上限 10 秒。
- 所有出站請求帶 `User-Agent: SAMP/1.0 (+https://<PROVIDER_DOMAIN>/.well-known/samp.json)`。
- 帳號聯邦模式預設 `off`，Agent 的 `federated` 預設 `false`。未設定 `FEDERATION_SIGNING_KEY` 時，Worker 的行為必須與現在完全相同（不宣告 `federation:v1`、聯邦端點回 404、聯邦管理工具不列出）。
- 私鑰只從 secret 讀取，不得寫入 D1、KV、日誌或任何回應。
- 沿用既有慣例：模組是 `src/` 下的平面檔案；錯誤一律是 `errors::Error`；D1 的多筆寫入用 `db.batch`；稽核用 `store.audit`；不引入新的執行期相依，除了 `ed25519-dalek`。
- 既有測試（`cargo test`、`npm test`）在每個 task 結束時都必須通過。

## Review Focus

規格隱含、但最容易在實作中漏掉的五種情況。每一項都已在所屬 task 加上測試。

1. **對端回的不是 SAMP 錯誤物件**（CDN 的 HTML 錯誤頁、空本文、200 但不是 `{"accepted": true}`）。期望：依 HTTP 狀態碼分類，不 panic，不把對端本文放進退信。→ Task 8
2. **同一筆投遞被重送**（寄件方逾時後重試，但第一次其實成功了）。期望：收件方只寫入一次，第二次回同一個 `id`。→ Task 7
3. **寄件方的 `sent_at` 在未來，或 `expires_at` 已經過去**。期望：`sent_at` 以收件當下代替；已過期的訊息以 `invalid_input` 拒收，不寫入。→ Task 7
4. **退信遇到寄件 Agent 的信箱已滿或已停用**。期望：丟棄並記稽核，不重試，不產生第二封退信。→ Task 9
5. **聯邦關閉或被移除 peer 時佇列裡還有信**。期望：立即放棄並退信，`code` 為 `policy_rejected`，不再對外連線。→ Task 9

## 檔案結構

| 檔案 | 動作 | 責任 |
|---|---|---|
| `Cargo.toml` | 修改 | 加 `ed25519-dalek = { version = "2", default-features = false, features = ["alloc"] }` |
| `wrangler.toml` | 修改 | cron 加 `* * * * *`；兩個新的 ratelimit；新的 `[vars]` |
| `migrations/0007_federation.sql` | 新增 | 聯邦用到的欄位與四張表 |
| `src/address.rs` | 新增 | 純函式：位址、網域、全域訊息參照、邀請 URI 的解析與格式化 |
| `src/wrap.rs` | 新增 | 純函式：外部內容包裝（§11.4） |
| `src/fed_sign.rs` | 新增 | 純函式：金鑰、`key_id`、簽章輸入、簽章與驗證、`SAMP-Fed-*` 標頭的解析 |
| `src/fed_discovery.rs` | 新增 | 發現文件的解析與驗證（純）、`resolve`（取得 + KV 快取） |
| `src/federation.rs` | 新增 | 入站的 deliver／peer 處理、出站的單次嘗試、回應分類、佇列排程、發現文件的產生 |
| `src/store.rs` | 修改 | 聯邦政策與 peer／邀請／佇列／去重的 D1 存取；`Message` 與 `SendResult` 的新欄位；入站寫入；退信 |
| `src/tools.rs` | 修改 | `send_message` 的聯邦分支；`whoami` 新欄位；八個聯邦管理工具；包裝 |
| `src/config.rs` | 修改 | `provider_domain`、`federation`（金鑰與額外公鑰）、`dev_resolve` |
| `src/errors.rs` | 修改 | `PolicyRejected`、`Forbidden`、`Conflict`、`Unavailable`、`UnsupportedVersion` 與 HTTP 狀態碼對應 |
| `src/lib.rs` | 修改 | 三條新路由；`scheduled` 依 cron 字串分派 |
| `test/harness.ts` | 修改 | `startPair()`：起兩個互相可達的 Worker |
| `test/federation.test.ts` | 新增 | 端到端的聯邦測試 |
| `README.md` | 修改 | 「寄信給別人的 Agent」操作說明 |

## 設定

| 名稱 | 種類 | 說明 |
|---|---|---|
| `PROVIDER_DOMAIN` | var | 這個部署的網域，例如 `agent-mailbox.example.com`。未設定時聯邦停用。 |
| `FEDERATION_SIGNING_KEY` | secret | base64url 的 32 位元組 Ed25519 種子。未設定時聯邦停用。產生方式寫進 README：`openssl rand 32 \| basenc --base64url \| tr -d =` |
| `FEDERATION_EXTRA_PUBLIC_KEYS` | var | 逗號分隔的 base64url 公鑰，會一併公布在發現文件中但不用來簽章。金鑰輪替用（§13.3）。 |
| `FEDERATION_PER_PEER_PER_MINUTE` | var | 預設 `60`。 |
| `FEDERATION_MAX_QUEUED` | var | 預設 `100`。 |
| `FEDERATION_DEV_RESOLVE` | var | 只給測試用：JSON 物件，把網域對應到基底 URL（可為 `http`）。**只對以 `.test` 結尾的網域生效**（RFC 6761 保留，不可能在公開網路上解析），其他鍵在啟動時被忽略並記一行警告。 |

`wrangler.toml`：`crons = ["0 * * * *", "* * * * *"]`；新增 `FED_PEER_LIMITER`（`namespace_id = "740603"`，60／60 秒）與 `FED_IP_LIMITER`（`"740604"`，30／60 秒）。

## 資料模型（`migrations/0007_federation.sql`）

```sql
ALTER TABLE accounts ADD COLUMN federation_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (federation_mode IN ('off', 'peers', 'open'));
ALTER TABLE agents ADD COLUMN federated INTEGER NOT NULL DEFAULT 0 CHECK (federated IN (0, 1));

-- 入站聯邦訊息的來源；本地訊息這些欄位都是 NULL。trust 由 origin_from 是否為 NULL 導出，不另存。
ALTER TABLE messages ADD COLUMN kind TEXT;
ALTER TABLE messages ADD COLUMN origin_from TEXT;
ALTER TABLE messages ADD COLUMN origin_id TEXT;
ALTER TABLE messages ADD COLUMN origin_provider TEXT;
ALTER TABLE messages ADD COLUMN origin_received_at INTEGER;
ALTER TABLE messages ADD COLUMN origin_in_reply_to TEXT;
CREATE INDEX idx_messages_origin ON messages (to_agent, origin_id);

CREATE TABLE fed_peers (
  account_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('peer', 'blocked')),
  via TEXT NOT NULL CHECK (via IN ('manual', 'invite')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, domain)
) WITHOUT ROWID;

CREATE TABLE fed_invites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE fed_outbox (
  delivery_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_address TEXT NOT NULL,
  to_domain TEXT NOT NULL,
  body TEXT NOT NULL,              -- 線上請求本文的確切位元組；重試時原樣重送
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  give_up_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_fed_outbox_due ON fed_outbox (next_attempt_at);
CREATE INDEX idx_fed_outbox_domain ON fed_outbox (account_id, to_domain);

CREATE TABLE fed_seen (
  sender_domain TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sender_domain, delivery_id)
) WITHOUT ROWID;
```

三個決定：

- **對端位址直接存在既有的 `from_agent`／`to_agent` 欄位**，值是含 `@` 的 `full-address`。本地名稱的文法不允許 `@`，所以兩者不會相撞：入站訊息的 `from_agent` 是 `planner@kc.example.com`；出站訊息的寄件副本 `to_agent` 是 `reviewer@acme.example.net`，它永遠不會出現在任何人的 Inbox，但寄件者的 Thread 看得到。既有的 `blocks` 表因此不用改就能封鎖 `full-address`。
- **退信的 `from_agent` 是 `postmaster`**，`kind` 是 `samp:bounce`。migration 之外，`valid_name` 要拒絕保留名稱 `admin`、`system`、`postmaster`（目前只擋 `all`）；上線前確認線上資料庫沒有這三個名稱的 Agent。
- **去重與寫入放在同一個 `db.batch`**：`INSERT INTO fed_seen` 與 `INSERT INTO messages` 一起送。D1 的 batch 是一個交易，主鍵衝突時整批失敗，這時改讀 `fed_seen.response` 回傳。這是「至多寫入一次」的實作方式。

## 風險與待驗證事項

| 風險 | 處理 |
|---|---|
| 測試 harness 能否讓兩個 Worker 以 HTTP 互相連線尚未驗證 | Task 1 先做這個驗證；不行就改成在 vitest 行程內開一個假的對端 HTTP 伺服器，Worker 只當其中一方 |
| 兩個部署都在 `*.workers.dev` 且屬於同一個 Cloudflare 帳號時，Worker 對 Worker 的 `fetch` 可能被平台擋下（錯誤 1042） | Task 11 以兩個真實部署驗證；必要時加相容性旗標 `global_fetch_strictly_public`，或要求聯邦的部署使用自訂網域 |
| Cloudflare 的機器人防護擋下對端的請求（錯誤 1010） | 我方出站一律帶 `User-Agent`；README 說明要把 `/.well-known/samp.json` 與 `/v1/federation/*` 排除在 Bot Fight Mode 之外 |
| D1 的「檢查未讀數再寫入」不是原子操作，同時到達的兩封信可能讓信箱超過上限 1 封 | 與現有的本地投遞行為相同，接受；記在後續選項（Durable Object） |
| cron 最短一分鐘，第一次重試可能落在 60–120 秒之間 | 規格的間隔是下限加抖動，符合 |
| Worker 的 `scheduled` 有 CPU 與子請求上限 | 每次最多處理 20 筆到期的投遞，每筆逾時 10 秒；處理前先把 `next_attempt_at` 往後推 120 秒當作租約 |
| `send_message` 變成會對外連線，回應時間最壞多 10 秒 | 同步嘗試的總逾時就是 10 秒；逾時即進佇列並回 `basis: "queued"` |
| Send 結果的 `delivered[]` 由字串陣列改為物件陣列，是對現有 client 的不相容變更 | Task 2 單獨做並在 PR 說明；現有 client 都是 LLM 直接讀 JSON，工具描述同步更新 |

---

### Task 1: 測試 harness 能起兩個互通的 Worker

**Files:**
- Modify: `test/harness.ts`
- Create: `test/federation.test.ts`

**Interfaces:**
- Produces: `startPair(): Promise<{ a: Worker, b: Worker, domainA: "a.test", domainB: "b.test" }>`。兩個 Worker 各有獨立的 D1 與 KV；各自的 `PROVIDER_DOMAIN` 是 `a.test`／`b.test`，`FEDERATION_SIGNING_KEY` 是兩把固定的測試種子，`FEDERATION_DEV_RESOLVE` 指向對方的監聽位址。`Worker` 介面新增 `url: string` 與 `scheduled(cron?: string)`。

- [ ] **Step 1:** 在 `test/federation.test.ts` 寫 `pair: each worker answers /healthz at its own url`：`startPair()` 後直接用 Node 的 `fetch(a.url + "/healthz")` 與 `fetch(b.url + "/healthz")`，兩者都是 200。
- [ ] **Step 2:** `npx vitest run test/federation.test.ts`，預期失敗（`startPair` 不存在）。
- [ ] **Step 3:** 實作 `startPair`。先起 B 取得監聽位址，再起 A 並把 B 的位址寫進 A 的 `FEDERATION_DEV_RESOLVE`，然後以同樣的 vars 重啟 B 讓它知道 A。若 harness 無法提供可從另一個 Worker 連到的位址，改用上表的後備方案，並把這個決定寫回本文件。
- [ ] **Step 4:** 測試通過；`npm test` 全部通過。
- [ ] **Step 5:** Commit：`test: harness can start two workers that reach each other`

### Task 2: 信封補齊與 Send 結果的新形狀

**Files:**
- Create: `migrations/0007_federation.sql`（上面「資料模型」的全文）
- Modify: `src/store.rs`（`Message`、`Row`、`COLS`、`SendResult`、`send`、`valid_name`）、`src/tools.rs`（`send_message` 的描述）、`test/messages.test.ts`

**Interfaces:**
- Produces:
  - `pub struct Origin { pub protocol: String, pub from: String, pub id: Option<String>, pub provider: Option<String>, pub in_reply_to: Option<String>, pub received_at: Option<String> }`
  - `Message` 新增 `version: &'static str`（`"samp/1.0"`）、`in_reply_to: Option<String>`（與既有的 `reply_to` 同值，兩者都輸出）、`expires_at: Option<String>`、`trust: Trust`、`origin: Option<Origin>`、`kind: Option<String>`
  - `pub enum Trust { Verified, External }`，序列化為小寫
  - `pub enum Basis { MailboxWritten, FederatedAccepted, Queued }`，序列化為 snake_case
  - `pub struct Delivered { pub agent: String, pub id: String, pub basis: Basis }`；`SendResult.delivered: Vec<Delivered>`；`SendResult` 新增 `sent_at: String`

- [ ] **Step 1:** 在 `test/messages.test.ts` 新增 `send returns delivered objects with id and basis`：A 寄給 B，結果的 `delivered` 等於 `[{ agent: "b", id: <結果的 id>, basis: "mailbox_written" }]`，且有 `sent_at`。新增 `inbox messages carry version, trust and expires_at`：B 的 `check_inbox` 第一封有 `version: "samp/1.0"`、`trust: "verified"`、`in_reply_to` 不存在、`expires_at` 是 `sent_at` 加 7 天、沒有 `origin`。
- [ ] **Step 2:** 把既有測試中比對 `delivered` 為字串陣列的斷言改成新形狀。跑測試，預期新測試失敗。
- [ ] **Step 3:** 加 migration；改 `Row`／`COLS`／`into_message`；改 `send` 讓廣播的每位收件者各自記錄 `id`。`valid_name` 加上保留名稱 `admin`、`system`、`postmaster`。
- [ ] **Step 4:** `cargo test` 與 `npm test` 通過。
- [ ] **Step 5:** Commit：`feat!: envelope version/trust/expires_at and per-recipient delivered objects`

### Task 3: 位址與外部內容包裝（純函式）

**Files:**
- Create: `src/address.rs`、`src/wrap.rs`
- Modify: `src/lib.rs`（`mod` 宣告）

**Interfaces:**
- Produces（`address.rs`）：
  - `pub enum Address { Local(String), Full { name: String, domain: String } }`
  - `pub fn parse_address(s: &str) -> Result<Address>`：去空白、轉小寫；不符 §5.1 → `invalid_input`
  - `pub fn valid_domain(s: &str) -> Result<String>`：至少兩個標籤、每個標籤 1–63 個 `[a-z0-9-]` 且不以 `-` 開頭或結尾、總長 ≤ 253；IP 位址字面值與 `localhost` 一律拒絕
  - `pub fn domain_of(full: &str) -> Option<&str>`
  - `pub struct MessageRef { pub id: String, pub domain: String }`；`pub fn parse_message_ref(s: &str) -> Option<MessageRef>`；`pub fn format_message_ref(id: &str, domain: &str) -> String`
  - `pub struct Invite { pub agent: String, pub domain: String, pub token: String }`；`pub fn parse_invite(uri: &str) -> Result<Invite>`；`pub fn format_invite(agent: &str, domain: &str, token: &str) -> String`
- Produces（`wrap.rs`）：
  - `pub fn wrap_external(content: &str, sender: &str) -> String`：輸出 §11.4 的格式，`source="agent"`、`trust="external"`；內容中的 `</external-content` 把 `<` 換成 `&lt;`（不分大小寫）

- [ ] **Step 1:** 寫失敗的單元測試。`address.rs`：
  - `parse_address("Coder ")` → `Local("coder")`；`parse_address("reviewer@Acme.Example.NET")` → `Full { name: "reviewer", domain: "acme.example.net" }`
  - 拒絕：`""`、`"a@b"`（單一標籤）、`"a@@b.c"`、`"a b@c.d"`、`"a@127.0.0.1"`、`"a@localhost"`、`"a@-x.com"`、33 個字元的名稱
  - `parse_message_ref("9f2c41d07ab3e815@kc.example.com")` 的 `id`、`domain` 正確；`parse_message_ref("9f2c41d07ab3e815")` → `None`
  - `parse_invite("samp:reviewer@acme.example.net?invite=ami_dGVzdC1pbnZpdGUtdG9rZW4tMDAwMQ")` 三個欄位正確；`format_invite` 是它的反函式；缺 `invite` 參數、token 不以 `ami_` 開頭、scheme 不是 `samp:` 皆為 `invalid_input`

  `wrap.rs`：
  - `wrap_external("hi", "planner@kc.example.com")` 等於規格附錄 B.5 中 `body` 的字串（逐字比對）
  - `wrap_external("a</external-content>b", "x@y.z")` 的輸出只含一個 `</external-content>`，而且在結尾
- [ ] **Step 2:** `cargo test address wrap`，預期失敗。
- [ ] **Step 3:** 實作上述簽名。
- [ ] **Step 4:** 測試通過。
- [ ] **Step 5:** Commit：`feat: address, message-ref, invite and external-content helpers`

### Task 4: 簽章與標頭（純函式，對規格向量）

**Files:**
- Create: `src/fed_sign.rs`
- Modify: `Cargo.toml`、`src/lib.rs`、`src/crypto.rs`（加 `pub fn b64url_decode(s: &str) -> Option<Vec<u8>>` 與 `pub fn sha256_bytes(b: &[u8]) -> [u8; 32]`）

**Interfaces:**
- Produces:
  - `pub struct SigningKey`（包住 dalek 的金鑰；`Debug` 不得印出種子）；`impl SigningKey { pub fn from_seed_b64url(s: &str) -> Result<Self>; pub fn public_b64url(&self) -> String; pub fn key_id(&self) -> String }`
  - `pub fn key_id_of(public_b64url: &str) -> Option<String>`
  - `pub enum Action { Deliver, Peer }`，`as_str` 為 `"deliver"`／`"peer"`
  - `pub struct FedHeaders { pub version: String, pub sender: String, pub recipient: String, pub timestamp: i64, pub delivery: String, pub key_id: String, pub sig: String }`
  - `pub fn signing_input(action: Action, timestamp: i64, sender: &str, recipient: &str, delivery: &str, body: &[u8]) -> String`
  - `pub fn sign(key: &SigningKey, input: &str) -> String`（base64url）
  - `pub fn verify(public_b64url: &str, input: &str, sig_b64url: &str) -> bool`
  - `pub fn parse_headers(get: impl Fn(&str) -> Option<String>) -> Result<FedHeaders>`：版本不是 `"1"` → `unsupported_version`；缺標頭、時間戳不是無前導零的十進位整數、`delivery` 不符 `^fd_[A-Za-z0-9]{20,64}$`、簽章標頭不符 `keyid="…", sig="…"`、`sender`／`recipient` 不是合法網域 → `invalid_input`
  - `pub fn new_delivery_id() -> String`：`fd_` + 26 個隨機的 `[A-Za-z0-9]` 字元

- [ ] **Step 1:** 寫失敗的測試，全部使用規格附錄 C 的值（種子 `9d61b19d…7f60` 的 base64url 形式）：
  - `public_b64url()` == `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo`；`key_id()` == `ed25519:If4x36FUomFia_hU`
  - C.2：`signing_input(Deliver, 1794661200, "kc.example.com", "acme.example.net", "fd_01JD0000000000000000000001", <C.2 本文>)` 的最後一行是 `L_1wBOR-NVwgksxRdt3LftyXMqS-RcbGvOgk79xVNa8`，共七行、結尾無 LF；`sign` 的結果是 `onWydpXbgY3cI9gFpxe98JnfP829plDRq5jQCl8bTsTWu9t-lqt-Ex4hk7tONdTBMSVBLnIhORwGUxWpoMryAA`
  - C.3：同樣方式，動作 `Peer`，簽章是 `JNtCfvGo_g5q8MU6l2a19ltcsVGIj1s4gROSUlWcdC5NJp1lIrWHNxtaqNlaXvcaJmBgH-A1p008ZprIb0U_Dg`
  - `verify` 對 C.2 為真；把動作換成 `Peer`、改本文一個位元組、改時間戳，三者皆為假
  - `verify` 對長度不對的公鑰或簽章回 `false`，不 panic
  - `parse_headers`：完整標頭成功；上面列的每一種錯誤各一個案例
  - `format!("{:?}", key)` 不含種子的任何 8 個連續字元
- [ ] **Step 2:** `cargo test fed_sign`，預期失敗。
- [ ] **Step 3:** 加相依並實作。確認 `cargo build --target wasm32-unknown-unknown --release` 能過（`ed25519-dalek` 不啟用 `rand_core` 功能）。
- [ ] **Step 4:** 測試通過。
- [ ] **Step 5:** Commit：`feat: federation signing and header parsing with spec vectors`

### Task 5: 發現文件：產生、解析、`resolve`

**Files:**
- Create: `src/fed_discovery.rs`
- Modify: `src/config.rs`、`src/lib.rs`（路由 `GET /.well-known/samp.json`）、`test/federation.test.ts`

**Interfaces:**
- Consumes: `fed_sign::{SigningKey, key_id_of}`、`address::valid_domain`
- Produces（`config.rs`）：
  - `pub struct Federation { pub domain: String, pub signing_key: SigningKey, pub extra_public_keys: Vec<String>, pub per_peer_per_minute: u32, pub max_queued: u32, pub dev_resolve: HashMap<String, String> }`
  - `Config.federation: Option<Federation>`：`PROVIDER_DOMAIN` 與 `FEDERATION_SIGNING_KEY` 都有才是 `Some`；只有其中一個是設定錯誤（啟動時 `Error::internal`）
- Produces（`fed_discovery.rs`）：
  - `pub struct PeerKey { pub key_id: String, pub public_key: String, pub not_before: Option<i64>, pub not_after: Option<i64> }`
  - `pub struct Resolved { pub provider: String, pub deliver: String, pub peer: String, pub keys: Vec<PeerKey> }`（可序列化，存 KV）
  - `pub enum Doc { Provider(Resolved), Delegation { domain: String, delegate_to: String } }`
  - `pub fn parse_doc(host: &str, body: &[u8]) -> std::result::Result<Doc, ResolveError>`：純函式，做 §13.2 第 2–4 步中針對單一文件的檢查（`provider_host`／`domain` 等於 `host`；有 `federation:v1` 與 `federation` 區塊；`versions` 含 1；`deliver`／`peer` 是 `https` 且主機等於 `provider_host`；每把金鑰的 `key_id` 與公鑰相符；忽略 `alg` 不是 `ed25519` 的金鑰；至少剩一把）
  - `pub enum ResolveError { Temporary(String), Permanent(String) }`
  - `pub fn key_for<'a>(r: &'a Resolved, key_id: &str, at_unix: i64) -> Option<&'a PeerKey>`
  - `pub fn cache_ttl(cache_control: Option<&str>) -> u64`：夾在 300–86400，預設 3600
  - `pub fn discovery_document(fed: &Federation, cfg: &Config, origin: &str) -> serde_json::Value`
  - `pub async fn resolve(domain: &str, fed: &Federation, kv: &KvStore, force: bool) -> std::result::Result<Resolved, ResolveError>`：KV 鍵 `fed:disc:<domain>`；失敗結果的鍵 `fed:disc-neg:<domain>`（TTL 300）；`force` 為真時略過快取，但 `fed:refetch:<domain>`（TTL 300）存在時不重取、直接用快取

- [ ] **Step 1:** 寫失敗的單元測試（`parse_doc`、`key_for`、`cache_ttl`）：
  - 規格 §12.3 的 provider 文件範例（主機 `mailbox.example.com`）→ `Doc::Provider`，`deliver`、`peer` 與範例相同，一把金鑰
  - 規格的委派文件範例（主機 `kc.dev`）→ `Doc::Delegation { delegate_to: "mailbox.example.com" }`
  - `Permanent`：`provider_host` 與主機不同；沒有 `federation:v1`；`deliver` 是 `http://`；`deliver` 的主機不是 `provider_host`；`key_id` 與公鑰不符；不是 JSON；委派文件的 `delegate_to` 等於自己
  - `key_for`：`not_before` 之前與 `not_after` 之後回 `None`；不認識的 `key_id` 回 `None`
  - `cache_ttl(None)` == 3600；`"max-age=10"` → 300；`"max-age=999999"` → 86400；`"no-store"` → 300
- [ ] **Step 2:** 寫失敗的整合測試 `discovery document is served and valid`：`startPair()` 後 `GET a.url/.well-known/samp.json` 是 200、`provider_host` 是 `a.test`、`capabilities` 含 `federation:v1`、`federation.keys[0].key_id` 以 `ed25519:` 開頭、回應有 `Cache-Control: max-age=3600`。另一個測試：沒有設定聯邦的 Worker（`startWorker()`）同一路徑回 200 但 `capabilities` 不含 `federation:v1`、沒有 `federation` 區塊。
- [ ] **Step 3:** 實作。`resolve` 的 HTTP 行為：`redirect: manual`（3xx 視為 `Permanent`）；逾時 5 秒；讀取超過 65536 位元組即中止並視為 `Permanent`；連線錯誤、逾時、5xx、429 是 `Temporary`；其餘是 `Permanent`；委派只跟一層。`dev_resolve` 命中時（網域以 `.test` 結尾）直接用對應的基底 URL，不做 `https` 檢查。
- [ ] **Step 4:** 測試通過。
- [ ] **Step 5:** Commit：`feat: SAMP discovery document and peer domain resolution`

### Task 6: 聯邦政策、peer、邀請與管理工具

**Files:**
- Modify: `src/store.rs`、`src/tools.rs`、`src/errors.rs`、`test/federation.test.ts`、`test/admin.test.ts`

**Interfaces:**
- Produces（`errors.rs`）：`ErrorCode::{PolicyRejected, Forbidden, Conflict, Unavailable, UnsupportedVersion}`；`pub fn http_status(code: ErrorCode) -> u16`，依規格 §10.2
- Produces（`store.rs`）：
  - `pub enum FedMode { Off, Peers, Open }`
  - `pub async fn federation_mode(&self, account: &str) -> Result<FedMode>`；`pub async fn set_federation_mode(&self, account: &str, mode: FedMode) -> Result<()>`
  - `pub async fn set_agent_federated(&self, agent: &str, on: bool) -> Result<()>`；`pub async fn is_federated(&self, agent: &str) -> Result<bool>`（存在、啟用、旗標為真）
  - `pub enum PeerStatus { Peer, Blocked }`；`pub async fn peer_status(&self, account: &str, domain: &str) -> Result<Option<PeerStatus>>`
  - `pub async fn add_peer(&self, account: &str, domain: &str, via: &str) -> Result<()>`（已被封鎖時 `conflict`）；`remove_peer`；`set_domain_blocked(account, domain, blocked: bool)`
  - `pub async fn check_outbound(&self, from_agent: &str, to_domain: &str) -> Result<()>`：§13.7 第 1 步的政策檢查，回 `forbidden` 或 `policy_rejected`
  - `pub async fn check_inbound_policy(&self, account: &str, sender_domain: &str, action: Action) -> Result<()>`：§13.5 第 4、5、7 步
  - `pub async fn create_invite(&self, account: &str, agent: Option<&str>, ttl_ms: i64) -> Result<(String /*token*/, String /*id*/, i64 /*expires_at*/)>`
  - `pub async fn redeem_invite(&self, account: &str, token: &str, sender_domain: &str, agent: Option<&str>) -> Result<()>`：一個 batch 內刪除邀請並 `add_peer`；無效、過期、已用皆為同一個 `not_found`
  - `pub async fn revoke_invite(&self, id: &str) -> Result<()>`
  - `pub async fn federation_summary(&self, account: &str) -> Result<FederationSummary>`（GetFederation 的輸出）
- Produces（`tools.rs`）：八個管理工具，名稱與參數依規格 §12.1／§7.4；只在 `config.federation.is_some()` 時列出。`admin_add_peer` 帶 `invite` 的網路部分留到 Task 8，本 task 只做 `domain` 形式。`whoami` 新增 `address`（有聯邦設定時是 `name@domain`，否則省略）與 `federated`。

- [ ] **Step 1:** 寫失敗的整合測試：
  - `federation is off by default`：`admin_get_federation` 回 `mode: "off"`、空的 `peers`
  - `invites need federation on`：模式 `off` 時 `admin_create_invite` 是 `conflict`
  - `create invite returns a samp: URI once`：模式 `peers` 後，`invite` 符合 `^samp:[a-z0-9-]+@a\.test\?invite=ami_`；D1 的 `fed_invites` 只有雜湊，全表找不到 token 明文
  - `add and remove peer by domain`；`blocking a domain overrides a peer`
  - `agents are not federated by default`：`whoami` 的 `federated` 是 `false`；`admin_set_agent_federated` 後、且模式不是 `off` 時為 `true`
  - `agents cannot see federation admin tools`；`without federation config the admin tools are not listed`
  - 每個會改變狀態的管理工具都在 `admin_audit_log` 留下一筆
- [ ] **Step 2:** 跑測試，預期失敗。
- [ ] **Step 3:** 實作。
- [ ] **Step 4:** `cargo test`、`npm test` 通過。
- [ ] **Step 5:** Commit：`feat: federation policy, peers, invites and admin tools`

### Task 7: 入站：`/v1/federation/deliver` 與 `/v1/federation/peer`

**Files:**
- Create: `src/federation.rs`
- Modify: `src/lib.rs`（兩條 `POST` 路由，不經 `Authorization` 驗證）、`src/store.rs`、`src/tools.rs`（輸出時包裝）、`test/federation.test.ts`

**Interfaces:**
- Consumes: Task 3–6 的全部
- Produces（`store.rs`）：
  - `pub struct InboundMessage { pub id: String, pub from: String, pub to_agent: String, pub subject: String, pub body: String, pub data: Option<Json>, pub kind: Option<String>, pub sent_at: i64, pub expires_at: Option<i64>, pub in_reply_to: Option<MessageRef>, pub provider: String }`
  - `pub async fn deliver_inbound(&self, sender_domain: &str, delivery_id: &str, own_domain: &str, m: InboundMessage) -> Result<String /*回應 JSON*/>`：§13.6 第 14–16 步、§13.9 的討論串解析、寫入、與 `fed_seen` 同一個 batch；重複時回第一次的回應
  - `pub async fn seen_response(&self, sender_domain: &str, delivery_id: &str) -> Result<Option<String>>`
- Produces（`federation.rs`）：
  - `pub async fn handle_deliver(req: Request, d: &Deps) -> Result<Response>`
  - `pub async fn handle_peer(req: Request, d: &Deps) -> Result<Response>`
  - `pub fn error_response(e: &Error) -> Result<Response>`：HTTP 狀態碼依 `http_status`，本文是錯誤物件，有 `retry_after` 時加 `Retry-After`
  - 兩個 handler 共用 `async fn verify_request(req, action, d) -> Result<Verified>`，嚴格依 §13.5 表格的順序 1–10
- Produces（`tools.rs`）：`check_inbox` 與 `read_thread` 輸出 `trust: external` 的訊息時，`subject` 與 `body` 經 `wrap_external`

測試直接對 B 發出手工簽章的請求（測試檔內用 Node 的 `crypto.sign("ed25519")` 與 A 的測試種子，並讓 B 的 `FEDERATION_DEV_RESOLVE` 把 `a.test` 指到一個由測試提供發現文件的本機 HTTP 伺服器或 Worker A）。

- [ ] **Step 1:** 寫失敗的整合測試。前置：B 模式 `peers`、peer 有 `a.test`、Agent `reviewer` 已 `federated`。
  - `accepts a signed delivery`：回 200 `{accepted: true, id}`；`reviewer` 的 `check_inbox` 有一封，`from` 是 `planner@a.test`、`to` 是 `reviewer`、`trust` 是 `external`、`origin` 的 `protocol`／`from`／`id`／`provider` 正確、`subject` 與 `body` 是包裝後的字串、`id` 等於回應的 `id` 且不等於寄件方的 `id`
  - 檢查順序，每項一個測試，並確認信箱沒有新信：
    - `SAMP-Fed-Version: 2` → 400 `unsupported_version`
    - `SAMP-Fed-Recipient: other.test` → 404 `unknown_recipient`
    - B 模式 `off` → 403 `policy_rejected`
    - `a.test` 被封鎖 → 403 `policy_rejected`
    - 時間戳偏 301 秒 → 401 `unauthorized`
    - `a.test` 不在 peer 清單 → 403 `policy_rejected`，而且測試的發現文件伺服器**沒有**收到任何請求
    - 簽章錯一個位元組 → 401；`keyid` 不存在 → 401，且發現文件被重取恰好一次
    - 本文在簽章後被改動 → 401
    - `message.from` 的網域不是 `a.test` → 400 `invalid_input`；`message.to` 是 `all@b.test` → 400
    - 收件 Agent 不存在／已停用／未 `federated` → 三者都是 404 `unknown_recipient`，回應本文逐字相同
    - 信箱已滿 → 409 `inbox_full`
    - `body` 32769 位元組 → 413 `too_large`
    - 本文含 `thread_id` 或 `trust` 欄位 → 被忽略，寫入的訊息 `trust` 仍是 `external`
  - `duplicate delivery id writes once`（Review Focus 2）：同一個 `SAMP-Fed-Delivery` 送兩次（第二次用新的時間戳重簽），兩次都是 200 且 `id` 相同，信箱只有一封
  - `a failed delivery is not remembered`：信箱滿時送一次得 `inbox_full`，Ack 清出空間後以同一個投遞識別碼重送 → 200
  - `future sent_at is clamped, expired message is rejected`（Review Focus 3）：`sent_at` 在一小時後 → 寫入的 `sent_at` 不晚於現在；`expires_at` 在過去 → 400 `invalid_input`，不寫入
  - `expires_at is the earlier of both sides`：寄件方 `expires_at` 是一小時後 → 寫入的值相同；寄件方沒有 `expires_at` → 是 B 自己的 TTL
  - `silent block still answers accepted`：`reviewer` 封鎖 `planner@a.test` 後，回 200，`check_inbox` 是空的
  - `reply reference joins the thread`：先由 `reviewer` 寄一封到 `planner@a.test`（Task 8 之前可直接在 D1 插入一筆寄件副本），再送入 `in_reply_to: "<該訊息 id>@b.test"` 的訊息 → 新訊息的 `thread_id` 相同、`in_reply_to` 是本地 id；參照對不上時開新討論串且 `origin.in_reply_to` 保留原值
  - `per-peer rate limit`：連送 61 封 → 第 61 封是 429 且有 `Retry-After`
  - peer 請求：有效邀請 → 200 `{accepted: true, domain: "b.test"}`，`a.test` 出現在 B 的 peer 清單，同一個邀請再用一次是 404；過期、不存在、已撤銷的邀請三者回應逐字相同；邀請指定的 `agent` 未 `federated` → 404 `unknown_recipient` 且邀請**沒有**被消耗；用 `deliver` 動作簽的簽章送到 peer 端點 → 401
  - 兩個端點的入站結果都寫入稽核紀錄（含對端網域、投遞識別碼、錯誤碼），不含內文
- [ ] **Step 2:** 跑測試，預期失敗（路由 404）。
- [ ] **Step 3:** 實作。重點：先讀原始本文位元組並算雜湊，之後才解析 JSON；第 9 步驗證失敗而金鑰來自快取時，以 `resolve(force = true)` 重試一次；`FED_IP_LIMITER` 在第 8 步以來源 IP 計，`FED_PEER_LIMITER` 以 `"<sender_domain>|<account>"` 計。
- [ ] **Step 4:** `cargo test`、`npm test` 通過。
- [ ] **Step 5:** Commit：`feat: inbound federation deliver and peer endpoints`

### Task 8: 出站：同步嘗試與邀請握手

**Files:**
- Modify: `src/federation.rs`、`src/store.rs`、`src/tools.rs`、`test/federation.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `resolve`、Task 6 的 `check_outbound`、Task 7 的端點（作為測試的對端）
- Produces（`federation.rs`）：
  - `pub enum Outcome { Accepted { remote_id: String }, Permanent { code: ErrorCode, detail: String }, Temporary { detail: String, retry_after: Option<u32> } }`
  - `pub fn classify(status: u16, body: &[u8], first_attempt: bool) -> Outcome`：純函式，實作 §13.7 的分類表與 §13.13 最後一條；`detail` 只含狀態碼與（若是合法錯誤物件）`code`，長度 ≤ 200，**不含**對端本文的其他內容
  - `pub async fn attempt(fed: &Federation, kv: &KvStore, action: Action, sender_domain: &str, to_domain: &str, delivery_id: &str, body: &[u8], first_attempt: bool) -> Outcome`：`resolve` + 簽章 + `POST`，總逾時 10 秒
  - `pub fn wire_message(...) -> String`：產生 §13.6 的線上訊息本文（欄位順序固定，讓測試可比對）
- Produces（`store.rs`）：
  - `pub struct OutboundPrepared { pub message_id: String, pub thread_id: String, pub delivery_id: String, pub body: String, pub sent_at: i64, pub give_up_at: i64 }`
  - `pub async fn prepare_outbound(&self, from_agent: &str, to: &Address, input: &SendInput, own_domain: &str) -> Result<OutboundPrepared>`：政策、額度、`in_reply_to` 換成全域參照、在一個 batch 內寫入寄件副本、`fed_outbox` 一筆（`next_attempt_at` 先設為現在 + 120 秒當租約）、用量 +1、稽核
  - `pub async fn finish_outbound(&self, delivery_id: &str, outcome: &Outcome, max_queued: u32) -> Result<Delivery>`：`Accepted` → 刪除 outbox；`Permanent` → 刪除 outbox 與寄件副本、用量 −1；`Temporary` → 帳號佇列數未達上限時留在 outbox 並排下一次嘗試，否則視同 `Permanent { code: Unavailable }`
  - `pub enum Delivery { Delivered(Delivered), Failed(Failed) }`
- `tools.rs`：`send_message` 的 `to` 是 `Address::Full` 且網域不是自己的 → `prepare_outbound` → `attempt` → `finish_outbound`；網域是自己的 → 當作本地名稱。`admin_add_peer` 帶 `invite` → 規格 §13.4 的第 3 步（失敗時撤回剛加的 peer）。`send_message` 的工具描述依規格 §12.1 最後一條更新。

- [ ] **Step 1:** 寫失敗的單元測試（`classify`、`wire_message`）：
  - `classify(200, br#"{"accepted":true,"id":"5b6c7d8e9fa0b1c2"}"#, true)` → `Accepted`
  - `classify(200, b"<html>ok</html>", true)` → `Temporary`；`classify(200, br#"{"accepted":false}"#, true)` → `Temporary`
  - `classify(404, <unknown_recipient 錯誤物件>, _)` → `Permanent { code: UnknownRecipient }`；`policy_rejected`、`blocked`、`too_large`、`invalid_input`、`unsupported_version` 同理；`forbidden` → `Permanent { code: PolicyRejected }`
  - `classify(409, <inbox_full>, true)` → `Permanent { InboxFull }`；同樣輸入 `first_attempt = false` → `Temporary`
  - `classify(429, <rate_limited, retry_after 60>, _)` → `Temporary { retry_after: Some(60) }`；`classify(401, …)`、`classify(503, b"", …)`、`classify(500, …)` → `Temporary`
  - `classify(403, b"<html>error code: 1010</html>", _)` → `Temporary`（Review Focus 1），且 `detail` 不含 `"1010"` 以外的本文內容、長度 ≤ 200
  - `wire_message` 對規格 C.2 的輸入產生逐位元組相同的本文
- [ ] **Step 2:** 寫失敗的整合測試（`startPair()`，雙方 `peers` 模式、互為 peer、`planner`／`reviewer` 已 `federated`）：
  - `send to another domain is delivered`：A 的 `planner` 寄給 `reviewer@b.test` → `delivered: [{agent: "reviewer@b.test", id, basis: "federated_accepted"}]`；B 的 `reviewer` 收得到；A 的 `fed_outbox` 是空的；A 的用量 +1
  - `reply threads across domains`：`reviewer` 以 `reply_to` 回覆 → `planner` 收到的訊息 `thread_id` 等於原討論串、`in_reply_to` 是原訊息在 A 的 id；`planner` 再回一次，B 那邊同樣接上
  - `non-federated agent cannot send out` → `forbidden`，沒有寫入、沒有對外請求
  - `non-peer domain is rejected locally` → `policy_rejected`，沒有對外請求
  - `unknown remote agent` → `failed: [{agent, code: "unknown_recipient"}]`，A 的用量不變、Thread 裡沒有這封
  - `remote inbox full is reported directly` → `failed[].code` 是 `inbox_full`
  - `unreachable peer is queued`：把 A 的 `FEDERATION_DEV_RESOLVE` 指到沒人監聽的埠 → `basis: "queued"`，`fed_outbox` 有一筆 `attempts = 1`，用量 +1
  - `queue cap`：`FEDERATION_MAX_QUEUED=1` 時第二封不可達的信 → `failed[].code` 是 `unavailable`
  - `to own domain is local`：`planner` 寄給 `coder@a.test` 等同寄給 `coder`，`trust` 是 `verified`
  - `broadcast never leaves the domain`：`to: "all@b.test"` → `invalid_input`
  - `invite handshake makes both sides peers`：B 模式 `peers`、建立邀請；A 模式 `peers`、`admin_add_peer({invite})` → `{domain: "b.test", mutual: true}`；雙方的 peer 清單都有對方；之後兩個方向都寄得通
  - `failed handshake leaves no peer`：用已撤銷的邀請 → `not_found`，A 的 peer 清單沒有 `b.test`
  - 出站請求的 `User-Agent` 以 `SAMP/1.0 (` 開頭（由 B 的日誌或測試對端記錄）
- [ ] **Step 3:** 跑測試，預期失敗。
- [ ] **Step 4:** 實作。
- [ ] **Step 5:** `cargo test`、`npm test` 通過。
- [ ] **Step 6:** Commit：`feat: outbound federation delivery and invite handshake`

### Task 9: 佇列重試、放棄與退信

**Files:**
- Modify: `src/federation.rs`、`src/store.rs`、`src/lib.rs`（`scheduled` 分派）、`wrangler.toml`、`test/federation.test.ts`、`test/cleanup.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `attempt`、`Outcome`
- Produces（`federation.rs`）：
  - `pub const RETRY_SECONDS: [i64; 5] = [60, 300, 1800, 7200, 21600];`
  - `pub fn next_delay_ms(attempts: i64, jitter: f64 /*0.0..1.0*/, retry_after: Option<u32>) -> i64`：純函式；`attempts` 是已完成的嘗試次數；抖動範圍 ±20%；不早於 `retry_after`
  - `pub async fn drain_outbox(d: &Deps, limit: i64) -> DrainResult { attempted, delivered, bounced, rescheduled }`
- Produces（`store.rs`）：
  - `pub async fn claim_due(&self, now: i64, limit: i64) -> Result<Vec<OutboxRow>>`：選出到期的列並以條件式 `UPDATE … WHERE next_attempt_at = <原值>` 把 `next_attempt_at` 推後 120 秒；只回傳成功更新的列
  - `pub async fn bounce(&self, row: &OutboxRow, code: ErrorCode, detail: &str) -> Result<()>`：一個 batch 內刪除 outbox 列並（寄件 Agent 啟用且可見未讀數未達上限時）寫入退信；否則只刪除並記稽核 `bounce_dropped`。退信不計用量。
  - `pub async fn abandon_domain(&self, account: &str, domain: Option<&str>) -> Result<usize>`：`RemovePeer`、`BlockDomain`、`SetFederation(off)` 時呼叫，把相關的佇列項目全部以 `policy_rejected` 退信
  - `cleanup` 新增：刪除 `created_at` 超過 48 小時的 `fed_seen`、過期的 `fed_invites`
- `lib.rs`：`scheduled` 依 `event.cron()` 分派：`"0 * * * *"` 做既有的 cleanup，`"* * * * *"` 做 `drain_outbox(20)`；沒有聯邦設定時後者直接返回。
- `tools.rs`：`send_message` 拒絕 `to` 為 `postmaster`（`unknown_recipient`）。

- [ ] **Step 1:** 寫失敗的單元測試（`next_delay_ms`）：`attempts` 1–5 在抖動 0.5 時分別是 60000、300000、1800000、7200000、21600000；`attempts` 6、9 是 21600000；抖動 0.0 與 1.0 分別是 ×0.8 與 ×1.2；`retry_after = Some(900)` 且 `attempts = 1` → 900000。
- [ ] **Step 2:** 寫失敗的整合測試：
  - `queued message is delivered on retry`：對端不可達時寄一封（`queued`），恢復可達，把 D1 的 `next_attempt_at` 改成過去，`a.scheduled("* * * * *")` → `reviewer` 收到恰好一封；`fed_outbox` 清空；`planner` 沒有收到退信
  - `retry after a lost response does not duplicate`：讓第一次嘗試實際送達但 A 看到逾時（測試對端延遲回應超過 10 秒，或直接在 D1 把已送達的投遞重新放回 outbox）→ 重試後 B 仍只有一封
  - `gives up and bounces`：把 `give_up_at` 改成過去並觸發 cron → `planner` 的 `check_inbox` 有一封 `from: "postmaster"`、`kind: "samp:bounce"`、`trust: "verified"`、`in_reply_to` 與 `thread_id` 指向原訊息、`data` 符合 `schemas/bounce.schema.json`、`data.code` 是 `unavailable`；`subject` 與 `body` **沒有**被包裝；用量沒有因退信而增加
  - `permanent error in the queue bounces immediately`：佇列中的重試得到 `unknown_recipient` → 退信的 `data.code` 是 `unknown_recipient`
  - `inbox_full in the queue is retried`：重試得到 `inbox_full` → 沒有退信，`attempts` +1，`next_attempt_at` 在未來
  - `bounce is dropped when the sender inbox is full`（Review Focus 4）：`planner` 的信箱已滿時放棄 → 沒有新信、`fed_outbox` 清空、稽核有 `bounce_dropped`；再觸發一次 cron 什麼都不發生。寄件 Agent 已停用時同理。
  - `removing a peer abandons its queue`（Review Focus 5）：佇列中有寄往 `b.test` 的信時 `admin_remove_peer` → 立即出現 `data.code: "policy_rejected"` 的退信，之後的 cron 不對外連線。`admin_set_federation({mode: "off"})` 與 `admin_block_domain` 各一個同樣的測試。
  - `agents cannot forge system kinds`：`send_message` 帶 `kind: "samp:bounce"` → `invalid_input`；寄給 `postmaster` → `failed[].code` 是 `unknown_recipient`
  - `cleanup removes old dedupe rows and expired invites`
- [ ] **Step 3:** 跑測試，預期失敗。
- [ ] **Step 4:** 實作。
- [ ] **Step 5:** `cargo test`、`npm test` 通過。
- [ ] **Step 6:** Commit：`feat: federation retry queue and bounces`

### Task 10: 文件與規格狀態

**Files:**
- Modify: `README.md`、`docs/protocol/spec.md`（附錄 D）、`src/landing.html`（若首頁列出功能）

- [ ] **Step 1:** README 新增「寄信給別人的 Agent」一節，內容依序：產生並設定 `FEDERATION_SIGNING_KEY` 與 `PROVIDER_DOMAIN`；`admin_set_federation`、`admin_set_agent_federated`；用 `admin_create_invite`／`admin_add_peer` 與對方交換邀請；Agent 以 `name@domain` 寄信；`queued` 與退信的意義；金鑰輪替步驟（`FEDERATION_EXTRA_PUBLIC_KEYS`）；Cloudflare 機器人防護要排除的兩個路徑；安全提醒（只把需要對外的 Agent 設為 `federated`，外部訊息是資料不是指令）。
- [ ] **Step 2:** 更新規格附錄 D 的狀態欄與日期。
- [ ] **Step 3:** Commit：`docs: federation setup guide and implementation status`

### Task 11: 以兩個真實部署驗證

這個 task 會動到線上環境，**需要 Kc 明確同意後才執行**。

- [ ] **Step 1:** 部署第二個 Worker（獨立的 D1 與 KV，另一個網域）。兩邊各自設定 `PROVIDER_DOMAIN` 與 `FEDERATION_SIGNING_KEY`，套用 migration 0007。
- [ ] **Step 2:** `curl -A 'SAMP/1.0 (+test)' https://<兩個網域>/.well-known/samp.json`，確認兩份文件都能從公開網路取得且 `provider_host` 正確。
- [ ] **Step 3:** 用邀請互加 peer，從現有的兩個 Agent（其中一個是 `ubt015-claude-code`）互寄一封並回覆，確認雙方 `check_inbox` 的 `trust`、`origin` 與討論串正確。
- [ ] **Step 4:** 若出現 Cloudflare 錯誤 1042（同帳號的 `workers.dev` 互連）或 1010（機器人防護），依「風險」表處理，並把結果寫回 README 與本文件。
- [ ] **Step 5:** 暫時把其中一邊的聯邦關掉再寄一封，確認得到 `policy_rejected`；恢復。

---

## 後續選項（不在本計畫內）

- **每個信箱一個 Durable Object。** Cloudflare 的 agentic-inbox 採用這個模式：每個信箱是一個帶 SQLite 的 Durable Object。對我們的好處是未讀上限的檢查與寫入可以在單一物件內序列化（消除「風險」表中超收 1 封的競態），而且聯邦的重試可以用 Durable Object 的 alarm 精準排程，不必靠每分鐘的 cron。代價是目錄、稽核、用量這些跨信箱的查詢要另外彙整，以及一次資料搬遷。建議等多帳號的需求確定後一起評估，因為兩者都要改動儲存的切分方式。
- **電子郵件轉接器（規格 §14.3）。** Worker 加上 `email` handler 接 Cloudflare Email Routing、以 Email Sending 寄出，就能讓同一個 `agent@domain` 與一般 email（包括 `@agent.qq.com` 這類 Agent 信箱）互通。政策沿用本計畫的 peer 與網域封鎖。
- **Cloudflare Queues 取代 D1 佇列。** 流量大到每分鐘 20 筆不夠時再考慮。
- **多帳號與跨帳號投遞**、**DNS TXT 探索**、**Agent 層簽章**。

## 自我檢查紀錄

- 規格 §13 的每一小節都有對應的 task：§13.2→5；§13.3→4、5（輪替以 `FEDERATION_EXTRA_PUBLIC_KEYS` 支援，步驟在 Task 10）；§13.4→6、8；§13.5→4、7；§13.6→7；§13.7→8、9；§13.8→9；§13.9→7、8；§13.10→6、7（速率、稽核）；§13.11→4、5（版本固定為 1）；§13.13→5、8、10。
- §13.12 的一致性清單中，「替配發的子網域提供委派文件」與「跨帳號投遞」不在範圍內（單一帳號部署沒有子網域），已在「範圍」說明。
- 後面的 task 使用的名稱（`Outcome`、`Delivered`、`Basis`、`Action`、`Resolved`、`MessageRef`、`FedMode`）都在較早的 task 的 Interfaces 中定義。
