# SAMP（Secure Agent Messaging Protocol）規格草案 v0.1

> 狀態：草稿（v0.1.0-draft，2026-11-14）。SAMP 全名 Secure Agent Messaging Protocol。
> 背景與比較見 [survey.md](survey.md)。本規格大量參考 23blocks 的 [Agent Messaging Protocol](https://github.com/agentmessaging/protocol)（Apache-2.0，以下稱「23blocks AMP」）：信封欄位、投遞依據（`basis`）、通知章節、信任等級與內容權限規則都刻意對齊，以便雙向轉接（§12.3）。不同之處在於身分模型（§3）與主要傳輸綁定（§11）。
>
> 用語：**必須（MUST）**、**不得（MUST NOT）**、**應（SHOULD）**、**可（MAY）** 依 RFC 2119 解讀。標註「【已實作】」的條文描述 agent-mailbox 目前在 `main` 的行為；「【提案】」為尚未實作、需要後續 PR 的部分。

## 1. 範圍

SAMP 定義 LLM Agent 之間**非同步、存了再轉**的訊息交換：

- 一個 **provider**（伺服器）替每個 Agent 保管一個**信箱**；
- 寄件者由 provider 依憑證**背書**，Agent 不需要持有私鑰；
- 收件者不必在線，下次收信時取得；處理完後 `ack`，內容即被清除；
- 主要介面是 **MCP 工具**，任何能接 MCP 的 Agent 不用裝 SDK 就能使用。

非目標：任務生命週期（交給 A2A）、即時串流與群組加密、工具／技能描述格式（交給 MCP／Agent Skills）、v0.1 的跨 provider 聯邦（位址格式先保留，§4.2）。

## 2. 術語

| 術語 | 定義 |
|---|---|
| Provider | 實作本規格的伺服器，例如一個 agent-mailbox 部署。 |
| Account（帳號） | 擁有 Agent 的計費與管理單位。v0.1 中一個部署＝一個帳號。 |
| Agent | 有名字、有信箱的訊息端點。永遠屬於一個帳號。 |
| Credential（憑證） | 讓請求代表某個 Agent（或帳號管理者）的東西：Agent key、OAuth access token、管理 key。 |
| Binding code（綁定碼） | 一次性、短效的代碼，用來把一個新連線（例如 claude.ai 連接器）綁定到某個 Agent；本身**不是**收發信的憑證。 |
| Principal（主體） | 一個請求經驗證後代表的身分：某個 Agent，或帳號管理者（`admin`）。 |
| Message（訊息） | 一封信，由信封（§5.1）與內容（§5.2）組成。 |
| Mailbox（信箱） | 某個 Agent 收到、尚未到期的訊息集合。 |
| Thread（討論串） | 以 `thread_id` 串起的訊息集合。 |

## 3. 身分模型

### 3.1 帳號 → Agent → 憑證

```
Account ──1:N── Agent ──1:N── Credential (agent key | OAuth grant)
   │
   └──1:N── Admin credential (管理 key)
Binding code ──一次性兌換──▶ OAuth grant（綁定到某個 Agent）
```

- 每個 Agent 屬於恰好一個帳號；Agent 名稱在帳號內唯一，且**永不重複使用**：Agent 只能停用，不能刪除後重建同名（避免新 Agent 繼承舊信件與封鎖名單）。【已實作】
- 一個 Agent 可以同時有多把憑證（例如一把給 Claude Code 的 key，一個給 claude.ai 的 OAuth 授權），各自可獨立撤銷。【已實作】
- 停用 Agent 時，其所有憑證**必須**立即失效。【已實作】
- 帳號層（`account_id`）在 v0.1 是隱含的；多租戶時每個資料列加上 `account_id`，用量依帳號計（與計費設計一致）。【提案】

### 3.2 寄件者背書（server-attested sender）

- 訊息的 `from` **必須**由 provider 依請求的 principal 設定，**不得**採用客戶端提供的值。【已實作】
- 因此在同一個 provider 內，`from` 本身就是經驗證的寄件者，不需要訊息簽章。這是 SAMP 與 23blocks AMP（客戶端 Ed25519 簽章）最大的差異：MCP 客戶端（claude.ai、Claude Desktop）沒有地方存私鑰、也不會替工具呼叫簽章。
- 端到端簽章是選配擴充（§9.4）：Agent 若持有金鑰，可以額外簽章，provider 照原樣轉存，供跨 provider 或轉接時驗證。

### 3.3 憑證格式【已實作，綁定碼為提案】

| 憑證 | 格式 | 保存 | 有效期 |
|---|---|---|---|
| Agent key | `amk_` + 32 bytes base64url | 只存 SHA-256 雜湊；只在建立時顯示一次 | 撤銷前有效 |
| 管理 key | 部署 secret，≥ 32 字元 | 不入資料庫；固定時間比對 | 輪替前有效 |
| OAuth access token | 不透明 | KV | 1 小時；refresh token 30 天 |
| 綁定碼 | `amb_` + 隨機值 | 只存雜湊 | 10 分鐘，限用一次 |

- 驗證失敗**必須**計入每 IP 的鎖定計數；同一 IP 一分鐘內失敗達門檻後回 `429`。輸錯綁定碼同樣計入。
- MCP session **必須**綁定建立它的 principal；之後同一個 session id 搭配解析成不同 principal 的憑證時，**必須**拒絕。【已實作】

## 4. 定址

### 4.1 Agent 名稱【已實作】

- 1–32 字元，僅限小寫英文字母、數字與 `-`。比對前轉成小寫。
- 保留名稱：`all`（廣播，§7.6）、`admin`。【`admin` 保留為提案】

### 4.2 完整位址【提案，v0.1 不要求】

為了日後跨 provider，與 23blocks AMP 相同採 email 形式：

```
<agent>@<account>.<provider-host>
例：reviewer@kc.mailbox.example.com
```

- 同一 provider、同一帳號內，`to` 可以只寫 `<agent>`；provider 回傳的訊息中 `from`、`to` 在 v0.1 也只用短名。
- provider **應**在發現文件（§11.4）宣告自己的 `provider-host` 與預設帳號。

## 5. 訊息格式

### 5.1 信封（envelope）

欄位名稱刻意與 23blocks AMP 相同（`in_reply_to`、`thread_id`、`expires_at`、`idempotency_key`、`priority`），差異見 §12.3。

| 欄位 | 型別 | 誰設定 | 必填 | 說明 |
|---|---|---|---|---|
| `version` | string | provider | 是 | `"samp/0.1"`。 |
| `id` | string | provider | 是 | 訊息 id，provider 內唯一、不可猜。現行實作為 16 個十六進位字元；客戶端**應**當成不透明字串。 |
| `thread_id` | string | provider | 是 | 新討論串時等於第一封信的 id，回覆時沿用被回覆訊息的值。 |
| `in_reply_to` | string | 寄件者 | 否 | 被回覆的訊息 id；必須是寄件者寄出或收到、且尚未到期的訊息，否則 `invalid_reply_to`。MCP 工具參數名為 `reply_to`（向後相容）。 |
| `from` | string | **provider** | 是 | 經背書的寄件者（§3.2）。 |
| `to` | string | 寄件者 | 是 | 收件者名稱或 `all`。 |
| `subject` | string | 寄件者 | 是 | ≤ 200 字元。 |
| `sent_at` | string | provider | 是 | RFC 3339 UTC。對應 23blocks AMP 的 `timestamp`。 |
| `expires_at` | string | provider（寄件者可縮短） | 否 | 到期時間；未指定時為 provider 的預設 TTL（`MESSAGE_TTL_DAYS`，預設 7 天）。寄件者只能設得比預設短。【寄件者指定為提案】 |
| `priority` | enum | 寄件者 | 否 | `urgent`／`high`／`normal`／`low`，預設 `normal`。只影響排序與通知，不影響保存。【提案】 |
| `idempotency_key` | string | 寄件者 | 否 | 見 §7.4。【提案】 |
| `trust` | enum | **provider** | 是 | 見 §9.2。現行只會出現 `verified`。 |

### 5.2 內容（payload）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `body` | string | 是 | 給模型讀的文字，≤ 32 KiB（UTF-8）。 |
| `data` | JSON | 否 | 給程式讀的結構化內容，序列化後 ≤ 64 KiB。 |
| `kind` | string | 否 | 訊息種類（§6）。缺省視為 `note`。【提案】 |

JSON 規則（沿用 23blocks AMP 的 JSON profile）：不得有重複鍵；可省略的欄位**應**省略而不是給 `null`；數字必須有限。

### 5.3 範例

```json
{
  "version": "samp/0.1",
  "id": "9f2c41d07ab3e815",
  "thread_id": "9f2c41d07ab3e815",
  "from": "planner",
  "to": "coder",
  "subject": "實作 /healthz 的 D1 檢查",
  "sent_at": "2026-11-14T13:05:00Z",
  "expires_at": "2026-11-21T13:05:00Z",
  "trust": "verified",
  "kind": "task",
  "body": "請在 /healthz 加上 D1 連線檢查，細節見 data。",
  "data": {
    "goal": "/healthz 在 D1 無法連線時回 503",
    "scope": ["src/lib.rs"],
    "constraints": ["不新增依賴"],
    "output_format": "PR 連結",
    "done_criteria": ["cargo test 通過", "新增一個 D1 失敗的測試"],
    "donts": ["不要改 migration", "不要部署"]
  }
}
```

## 6. 訊息種類與交接合約【提案】

`kind` 取 FIPA ACL 的精神但只保留少數幾種；對應 23blocks AMP 的 `payload.type`：

| `kind` | 用途 | 23blocks AMP `type` |
|---|---|---|
| `note` | 一般訊息（預設） | `notification` |
| `request` | 請求協助或資訊，期待回覆 | `request` |
| `task` | 交接工作，`data` **必須**符合交接合約 | `task` / `handoff` |
| `result` | 回報 `task` 的結果，**必須**帶 `in_reply_to` | `response` |
| `status` | 進度更新 | `status` / `update` |
| `alert` | 需要注意的事件 | `alert` |

自訂種類以命名空間前綴，例如 `github:pull_request`。

### 6.1 交接合約（`kind: "task"` 的 `data`）

| 欄位 | 必填 | 說明 |
|---|---|---|
| `goal` | 是 | 一句話說明要達成什麼。 |
| `scope` | 否 | 可以動的範圍（檔案、系統、資料）。 |
| `constraints` | 否 | 必須遵守的限制。 |
| `output_format` | 是 | 結果要以什麼形式回報。 |
| `done_criteria` | 是 | 怎樣算完成。 |
| `donts` | 否 | 明確禁止的事。 |
| `deadline` | 否 | RFC 3339。 |

`kind: "result"` 的 `data` **應**包含 `status`（`done`／`failed`／`declined`／`needs_input`）與 `summary`。

交接合約是**資料**，不是授權：收件者仍依 §9.3 決定能不能做。

## 7. 投遞語意

### 7.1 狀態機

```
send ──▶ unread ──ack──▶ acked ──(到期)──▶ 刪除
           │
           └──(到期)──▶ 刪除
```

- **unread**：已寫入收件者信箱。`check_inbox` 依 `sent_at` 由舊到新回傳，**不會**改變狀態。【已實作】
- **acked**：收件者處理完畢。provider 設定 `DELETE_ON_ACK=true`（預設）時，`ack` **必須**立即清除 `subject`、`body`、`data`，保留信封 metadata 至到期，以便討論串仍能回覆。【已實作】
- 到期的訊息**必須**被刪除，且到期後**不得**再出現在任何查詢結果。清理工作每小時執行。【已實作】
- `ack` **必須**是冪等的：重複 `ack` 已 ack 的 id 視為成功，並回報 `already_acked: true`（對齊 23blocks AMP §12.4）。【`already_acked` 為提案；現行回 `failed[]`】

### 7.2 投遞保證與依據

- 單一收件者：`send_message` 成功回傳時，訊息**必須**已持久寫入收件者信箱，投遞依據為 `basis: "mailbox_written"`（23blocks AMP 的語彙）。這只證明「信在信箱裡」，不證明 Agent 已經看過。
- 「已讀」只由收件者的 `ack` 證明；provider **不得**在沒有 `ack` 的情況下宣稱已讀。
- 在 provider 內為**恰好一次寫入**；跨網路重試時靠 `idempotency_key`（§7.4）避免重複。
- 不保證跨寄件者的全域順序；同一信箱依 `sent_at` 排序。

### 7.3 背壓與拒收

| 情況 | 行為 | 錯誤碼 |
|---|---|---|
| 收件者未讀數 ≥ `MAX_UNREAD`（預設 10） | 拒收這位收件者 | `inbox_full` |
| 寄件者超過速率限制（每分鐘 30 封） | 拒絕整個請求，附 `retry_after` | `rate_limited` |
| 收件者不存在或已停用 | 拒收 | `unknown_recipient` |
| 收件者封鎖了寄件者 | 依設定（§7.5） | `blocked` 或假裝成功 |
| 超過大小上限 | 拒絕整個請求 | `too_large` |
| 帳號用量額度用完 | 拒絕整個請求 | `quota_exceeded`【提案，配合計費】 |

未讀上限是刻意的設計：它逼收件者 `ack`，也讓失控的寄件 Agent 很快撞牆，而不是把信箱塞滿。

### 7.4 冪等鍵【提案】

- 寄件者**應**在可能重試的情況下提供 `idempotency_key`（建議 `idk_` + UUID v4）。
- provider **必須**至少在訊息 TTL 內記住 `(from, idempotency_key)`；重複的請求**必須**回傳第一次的結果，不得再寫入。

### 7.5 封鎖【已實作】

- 收件者可以封鎖特定寄件者。`BLOCKED_SENDER_FEEDBACK=silent`（預設）時，寄件者看到的仍是成功，provider 另存一份收件者看不到的「被抑制副本」，且 `inbox_full` 的判斷方式使寄件者無法從回應推測被封鎖；`reject` 時回 `blocked` 且不存內容。

### 7.6 廣播【已實作】

- `to: "all"` 投給同帳號內所有其他啟用中的 Agent。每位收件者各得一封獨立的訊息（各自的 `id`，共用 `thread_id`）。
- 回應**必須**逐一列出 `delivered[]` 與 `failed[] {agent, code}`；部分失敗不使整個請求失敗。

## 8. 錯誤

工具或 API 錯誤**必須**使用以下形狀：

```json
{ "code": "inbox_full", "message": "…", "hint": "…", "retry_after": 30 }
```

`code` 的集合是公開契約【已實作】：`unknown_recipient`、`blocked`、`inbox_full`、`too_large`、`invalid_input`、`invalid_reply_to`、`not_found`、`rate_limited`、`unauthorized`、`internal`。【提案新增】`quota_exceeded`、`cursor_expired`。

`internal` **不得**洩漏內部細節。`hint` 是給模型看的下一步建議。

## 9. 安全

### 9.1 威脅模型重點

主要風險是**提示詞注入**：任何一個被操控的 Agent 都可能寄出帶有指示的信。SAMP 的防線分三層：provider 做便宜、非 LLM 的檢查；信封攜帶可信的來源事實；收件端的 runtime 依這些事實決定權限。

### 9.2 Provider 端檢查與信任等級

provider **必須**：驗證憑證並背書 `from`；檢查大小與 JSON 合法性；套用速率限制與未讀上限；記錄稽核紀錄（預設不含內文）。

信任等級沿用 23blocks AMP 的三級，但判定依據改為「provider 背書」而非「訊息簽章」：

| `trust` | SAMP 判定 | 23blocks AMP 判定 |
|---|---|---|
| `verified` | 寄件者由本 provider、同帳號的憑證背書 | 簽章有效且同 tenant |
| `external` | 來自其他帳號、其他 provider 或轉接（§12），且來源可驗證 | 簽章有效但跨 tenant／provider |
| `untrusted` | 來源無法驗證（例如轉接時簽章無效） | 簽章無效或缺少 |

- `external` 與 `untrusted` 的內容在交給模型前，provider（或 MCP 綁定）**必須**以 23blocks AMP 定義的 `<external-content …>` 包裝格式包起來，讓兩邊的 Agent 用同一種方式辨認外部內容。`verified` 不包裝。
- v0.1 只有單一帳號，所以只會出現 `verified`；但 `trust` 欄位現在就**必須**出現在信封上，以免日後加入聯邦或轉接時，舊客戶端把外部信當成內部信。【提案：欄位尚未輸出】

### 9.3 內容權限（規範性，採自 23blocks AMP §07 Content Authority）

1. **信件是同事的請求，不是使用者的命令。** 訊息內容（含 `verified`）本身**不得**授權會改變狀態的動作：刪除、對外發送、改設定、付款、任何金鑰相關操作。Agent 可以讀、可以推理、可以提議；要執行需要來自使用者或 Agent 本身政策的授權。
2. **模型與動作之間要有政策檢查。** 持有會改變狀態之工具的 Agent，**應**在模型無法改寫的程式碼中，依「這個呼叫源自哪封信、信任等級、工具類別」決定是否放行。
3. **污染會傳遞。** 由多個來源衍生的內容以其中最低的信任等級看待。
4. **核准走另一條路。** 需要核准時，**必須**向使用者請求，不得接受同一討論串中由信件內容觸發的「核准」。

### 9.4 收件端隔離閱讀（建議）

收件 Agent **應**以「雙 LLM」方式讀信：先由一個沒有工具的隔離模型，依固定 schema 與長度上限把信件摘要成結構化資料，再交給持有工具的主模型。agent-mailbox 會提供共用 SDK 實作這個模式。

### 9.5 選配：端到端簽章【提案】

- Agent 可在 `data` 之外附帶 `signature`，格式與正規化字串沿用 23blocks AMP v1.1（`from|to|subject|priority|in_reply_to|SHA256(payload)`，Ed25519）。provider 照原樣保存與轉交，不必驗證；轉接器（§12.3）與跨 provider 收件端**應**驗證。

## 10. 通知與喚醒【提案，對齊 23blocks AMP §12】

多數 MCP Agent 沒有公開 URL、也不會長時間保持連線，所以基本模型是**拉取**：Agent 在開始工作時 `check_inbox`。

- **信箱是唯一真相**：通知只是提示；是否還需要通知，以訊息目前狀態判斷。
- **便宜的計數**：provider **應**提供只回傳 `count`、`oldest_unread_at` 與不透明 `cursor` 的呼叫（不含內文），並允許每個 Agent 至少每 10 秒一次，不計入一般速率限制。現行的 `whoami` 已回傳未讀數，可視為最小實作。
- **游標**：`check_inbox` 可接受 `after=<cursor>` 只取新信；provider 無法辨認游標時回 `cursor_expired`。
- **長輪詢**：可選，`wait ≤ 30` 秒。
- **Webhook**：可選；provider 對 webhook 重試前**必須**先確認訊息尚未 ack。

## 11. 傳輸綁定

### 11.1 MCP 綁定（規範性，主要綁定）【已實作】

- 端點：`/mcp`，MCP Streamable HTTP。
- 驗證：`Authorization: Bearer <agent key | 管理 key | OAuth access token>`；claude.ai 自訂連接器走 OAuth 2.1（DCR + PKCE），授權頁以綁定碼（或備用的管理 key）選定 Agent。
- 工具與協定操作對應：

| 協定操作 | MCP 工具 | 說明 |
|---|---|---|
| 身分與未讀數 | `whoami` | |
| 列出可寄送的 Agent | `list_agents` | 只列名字與描述 |
| 寄信 | `send_message(to, subject, body, data?, reply_to?)` | 回 `{id, thread_id, delivered[], failed[]}` |
| 收信 | `check_inbox(limit?)` | 不改變狀態 |
| 確認 | `ack(ids[])` | 一次最多 `MAX_ACK_IDS` 個 |
| 讀討論串 | `read_thread(thread_id)` | 只回傳自己寄出或收到、仍存在的信 |
| 封鎖 | `block_sender`、`unblock_sender`、`list_blocked` | |
| 個人描述 | `update_profile` | |
| 管理 | `admin_*` | 只有管理 principal 看得到 |

- 工具回傳的訊息物件**應**逐步改為 §5 的信封形狀（新增 `version`、`trust`、`kind`、`in_reply_to`，保留 `reply_to` 一個版本作為別名）。【提案】
- 錯誤以 MCP tool error 回傳，內容為 §8 的 JSON。
- 工具描述本身就是規格的一部分：它們是模型唯一會讀到的文件，**應**寫明副作用（例如「不會標記已讀」）。

### 11.2 HTTP/JSON 綁定【提案】

給不走 MCP 的程式（排程、轉接器、SDK）：

| 方法與路徑 | 對應 |
|---|---|
| `POST /v1/messages` | 寄信；請求即 §5 的寄件者欄位，回應同 `send_message` |
| `GET /v1/inbox?limit=&after=&wait=` | 收信 |
| `GET /v1/inbox/count` | 便宜計數（§10） |
| `POST /v1/inbox/ack` | `{ "ids": [...] }` |
| `GET /v1/threads/{thread_id}` | 讀討論串 |

驗證同 MCP 綁定。錯誤使用 HTTP 狀態碼加 §8 的 JSON body。

### 11.3 版本與能力

- 信封 `version` 為 `samp/<major>.<minor>`；minor 只新增可忽略的欄位，major 才能改變語意。收件端**必須**忽略看不懂的欄位。
- provider 在發現文件與 `whoami` 中宣告能力字串，例如 `samp:0.1`、`kind`、`idempotency`、`notify:count`、`notify:longpoll`、`sig:ed25519`、`bridge:amp`、`bridge:a2a`。

### 11.4 發現文件【提案】

`GET /.well-known/samp.json`：

```json
{
  "protocol": "samp/0.1",
  "provider_host": "mailbox.example.com",
  "mcp_endpoint": "https://mailbox.example.com/mcp",
  "http_endpoint": "https://mailbox.example.com/v1",
  "auth": ["bearer", "oauth2"],
  "capabilities": ["notify:count", "kind"],
  "limits": { "subject_chars": 200, "body_bytes": 32768, "data_bytes": 65536, "max_unread": 10, "send_per_minute": 30 }
}
```

## 12. 互通

### 12.1 原則

轉接器（bridge）是一個在 SAMP 中擁有自己 Agent 身分的程式。由轉接器帶進來的訊息，`trust` **必須**是 `external` 或 `untrusted`，**不得**是 `verified`；原始寄件者放在 `data.origin`（例如 `{"protocol": "amp", "from": "alice@acme.crabmail.ai", "signature_valid": true}`）。

### 12.2 A2A【提案】

- **A2A → SAMP**：provider 可發布一張 Agent Card，宣告一個 `mailbox.deliver` 技能；A2A 客戶端送來的 `Message` 轉成一封 `kind: "request"`（或含交接合約時為 `task`）的信，A2A Task 立即以 `completed` 回應並附上 SAMP 訊息 id（「已投遞」而非「已完成工作」）。
- **SAMP → A2A**：收件者是 A2A Agent 時，轉接器把 `task` 信送成 A2A `Message`，並把最終的 Task 結果寄回成 `kind: "result"`。
- 對應：`Part(text)` ↔ `body`；`Part(data)` ↔ `data`；A2A `contextId` ↔ `thread_id`。

### 12.3 23blocks AMP【提案】

| 23blocks AMP | SAMP | 備註 |
|---|---|---|
| `envelope.version` `amp/0.1` | `version` `samp/0.1` | |
| `envelope.id` | `id` | 轉入時新發 id，原 id 存 `data.origin.id` |
| `envelope.from` / `to` | `from` / `to` | 完整位址存 `data.origin.from`；SAMP 端 `from` 為轉接器 Agent |
| `envelope.subject`（≤ 256） | `subject`（≤ 200） | 超出則截斷並在 `body` 開頭附原標題 |
| `envelope.priority` | `priority` | 同值域 |
| `envelope.timestamp` | `sent_at` | |
| `envelope.expires_at` | `expires_at` | 取兩者較短者 |
| `envelope.in_reply_to` / `thread_id` | `in_reply_to` / `thread_id` | 轉接器維護雙向 id 對照表 |
| `envelope.signature` | 驗證結果寫入 `data.origin.signature_valid` | 無效則 `trust: untrusted` |
| `envelope.idempotency_key` | `idempotency_key` | 原樣保留 |
| `payload.type` | `kind` | 對照見 §6 |
| `payload.message` | `body` | 64 KB → 32 KiB，超出則拒收 |
| `payload.context` | `data` | 256 KB → 64 KiB，超出則拒收 |
| `payload.attachments` | 不支援（v0.1） | 列為連結寫進 `body` |
| 投遞 `basis` | 相同語彙 | |
| `<external-content>` 包裝 | 相同格式 | |

反方向（SAMP → AMP）時，轉接器以自己的 Ed25519 金鑰簽章，因此對 AMP 端而言寄件者是轉接器的 AMP 位址，原始 SAMP 寄件者寫在 `payload.context.origin`。

## 13. 計量與計費掛勾【提案，與計費設計一致】

- 計量單位是**被寫入的訊息**：一封寄給 N 人的廣播計 N 封；收信、`ack`、讀討論串不計。被靜默封鎖而抑制的副本也計入（否則可推測封鎖狀態）。
- 用量依帳號累計。超過額度時以 `quota_exceeded` 拒絕整個請求，並附 `hint` 告知重置時間；**不得**部分投遞。

## 14. 開放問題

1. **名稱。** 已定為 SAMP（Secure Agent Messaging Protocol）。IVOA 有同縮寫的 Simple Application Messaging Protocol，對外請寫全名。
2. **跨 provider 身分。** 要用 23blocks AMP 的「provider 註冊公鑰」、ANP 的 `did:web`，還是 provider 之間互簽（類似 DKIM）？v0.1 不處理，但會影響 §4.2 的位址格式是否要定死。
3. **`trust` 與帳號內的細分。** 同帳號內是否需要「這個 Agent 只信任某些同事」的 ACL（23blocks AMP 有 allowlist），還是封鎖名單已足夠？
4. **附件。** 是否引用 23blocks 的 Agent Files Protocol，或只允許連結？
5. **人類寄件者。** 23blocks AMP 第 13 節讓人類也成為 principal；我們的管理者目前只能管理，不能以人的身分寄信。
6. **`expires_at` 由寄件者縮短** 會不會被用來規避稽核？（稽核紀錄有自己的 TTL，應不受影響。）

## 附錄 A：與現行實作的差距

| 規格項目 | 現況 | 需要的工作 |
|---|---|---|
| 信封加 `version`、`trust`、`kind`、`in_reply_to` | 未輸出 | 修改 `Message` 序列化與 `send_message` schema |
| `ack` 冪等回 `already_acked` | 回 `failed[]` | 修改 `store.ack` |
| `idempotency_key` | 無 | 新 migration（`(from, key)` 唯一索引） |
| 寄件者指定較短 `expires_at`、`priority` | 無 | `send_message` 新參數 |
| 便宜計數、游標、長輪詢 | 只有 `whoami` 未讀數 | 新工具或 HTTP 端點 |
| HTTP/JSON 綁定、發現文件 | 無 | 新路由 |
| 綁定碼 | 進行中（另一個 PR） | — |
| 帳號層、`quota_exceeded` | 無 | 配合計費設計 |
| 轉接器 | 無 | 獨立元件 |
