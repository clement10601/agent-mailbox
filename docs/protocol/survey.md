# Agent 訊息協定調查（2026-11）

> 狀態：草稿，2026-11-14。目的：在把 agent-mailbox 整理成一份協定規格之前，先看清楚已經有哪些協定、名稱是否衝突、我們的定位在哪裡。規格見 [spec.md](spec.md)。
>
> **命名**：原本暫定的「Agentic Messaging Protocol（AMP）」與既有的 23blocks「Agent Messaging Protocol（AMP）」幾乎同名（見 §2.1），因此改名為 **SAMP（Secure Agent Messaging Protocol）**。另外留意：天文學界的 IVOA 有一個同縮寫的「Simple Application Messaging Protocol（SAMP）」，用於桌面天文軟體互通，領域不同、不易混淆，但對外介紹時建議寫全名。

## 1. 結論

1. **「AMP」已被占用。** 23blocks 的 Agent Messaging Protocol 名稱、縮寫、甚至題材（「給 Agent 的 email」）都跟我們重疊，而且仍在活躍開發。沿用 AMP 會在搜尋、社群與規格引用上互相混淆，建議改名。
2. **沒有現成協定剛好符合我們的定位。** 我們的核心是「MCP 原生、身分由伺服器託管、存了再轉、讀完即清」的私人信箱。A2A 是同步／任務導向的 RPC；ANP 與 23blocks AMP 要求客戶端自己持有金鑰；IETF 的 store-and-forward 草案還停在個人草案、面向 runtime 而不是 LLM 工具呼叫。
3. **應該對齊而不是重造的部分：** 信封欄位命名與投遞「依據」（`basis`）語彙對齊 23blocks AMP；Agent 對外描述與任務互動對齊 A2A 的 Agent Card；離線可達性的錯誤語意參考 `draft-chapman-a2a-offline-delivery`。這樣日後要做雙向轉接（bridge）時成本最低。
4. **我們獨有、值得寫進規格的設計：** 伺服器背書寄件者（server-attested sender）、帳號→Agent→憑證三層身分與一次性綁定碼、`ack` 即清除內容、未讀上限造成的明確背壓（`inbox_full`）、靜默封鎖、交接合約（handoff contract）資料格式、以及「信件是同事的請求，不是使用者的命令」這條內容權限規則。

## 2. 逐一比較

### 2.1 23blocks — Agent Messaging Protocol（AMP）

- 來源：<https://github.com/agentmessaging/protocol>、<https://agentmessaging.org/>。Apache-2.0，規格 v0.1.2-draft，2026-01 首版，2026-11-01 仍有合併（第 13 節 person principals）。維護者 23blocks，參考實作 AI Maestro（TypeScript），另有 Claude Code 外掛（Bash 腳本 + skill）。
- 位址：`agent-name@scope.provider`，例如 `backend-architect@acme.crabmail.ai`，scope 可多層。
- 信封：`envelope { version, id, from, to, subject, priority, timestamp, expires_at, signature, in_reply_to, thread_id }` + `payload { type, message, context, attachments }`。
- 身分：Agent 自己產生 Ed25519 金鑰，向 provider 註冊公鑰換 API key；每封信以 `from|to|subject|priority|in_reply_to|SHA256(payload)` 簽章。
- 投遞：WebSocket → webhook → relay queue（預設 7 天 TTL）→ 區網 mesh，依序嘗試；跨 provider 走聯邦（DNS／registry）。第 12 節 `notify:v1` 定義投遞依據 `basis`（`mailbox_written`、`socket_written`、`webhook_2xx`、`queued`）與便宜的「有沒有新信」計數 API。
- 安全：信任標註（外部來源標記以防提示詞注入）、ACL、隔離與風險分數、金鑰撤銷、48 項部署檢查清單、附錄列出注入樣式。
- 與我們的差異：
  - **金鑰在客戶端。** claude.ai 自訂連接器、Claude Desktop 等 MCP 客戶端沒有地方放私鑰、也不會幫工具呼叫簽章，所以 23blocks AMP 在純 MCP 環境下得由伺服器代簽，失去它設計的意義。我們反過來以伺服器背書為基礎，端到端簽章做成選配擴充。
  - **本機優先 vs 中繼站。** 它主張信存在 Agent 自己機器上；我們是有 TTL 的託管中繼，`ack` 後清除內容。
  - **MCP 不在它的範圍內。** 它的介面是 REST + WebSocket + CLI；我們的主要綁定就是 MCP 工具。
- 結論：名稱衝突，題材重疊，但身分模型根本不同。建議改名，信封欄位盡量同名，並提供雙向轉接（規格 §14.2）。

### 2.2 A2A（Agent2Agent Protocol）

- 來源：<https://a2a-protocol.org/>。Google 2025-04 發表，2025-06 移交 Linux Foundation；2026 年發布 1.0 穩定版，超過 150 個組織支持（LF 新聞稿，2026-04-09）；據報導 2026-08 與 MCP 一起納入 Agentic AI Foundation。
- 模型：客戶端 Agent 對遠端 Agent 送 `Message`，遠端產生 `Task`（有狀態生命週期：submitted → working → input-required → completed／failed／canceled…），結果以 `Artifact` 回傳。內容由 `Part`（文字、檔案、結構化資料）組成。
- 傳輸：JSON-RPC 2.0 over HTTP、SSE 串流、gRPC、HTTP+JSON；長任務可設定 push notification（webhook）。
- 發現：Agent Card（`/.well-known/agent-card.json`）描述技能、端點與驗證方式。
- 與我們的差異：A2A 假設對方有可連線的 HTTP 端點、而且「現在」在線；它是**委派任務的 RPC**，不是信箱。對方不在線、或對方根本只是一個在 claude.ai 對話中偶爾被叫起來的 Agent 時，A2A 沒有存了再轉的語意（這正是 `draft-chapman-a2a-offline-delivery` 想補的洞）。
- 結論：互補。SAMP 可以在 Agent Card 上宣告一個「mailbox」技能，讓 A2A 客戶端把訊息投進信箱（規格 §14.1）；反過來，信箱中的 `task` 型訊息也可以轉成 A2A 的 Task。

### 2.3 ACP（IBM / BeeAI Agent Communication Protocol）

- 來源：<https://research.ibm.com/projects/agent-communication-protocol>、LF AI & Data 部落格（2025-08-29）。REST 優先、支援非同步與串流的 Agent 互通協定。
- 現況：**2025 年 8 月已併入 A2A**，BeeAI 改用 A2A。新設計不應以 ACP 為目標。
- 另外注意：Cisco AGNTCY 也有一個縮寫同為 ACP 的「Agent Connect Protocol」，以及其 IETF 草案 SLIM（Secure Low-Latency Interactive Messaging，`draft-mpsb-agntcy-slim`）。SLIM 是低延遲的即時訊息層（pub/sub、群組、MLS 加密），定位是傳輸基礎設施，不是信箱。

### 2.4 ANP（Agent Network Protocol）

- 來源：<https://agent-network-protocol.com/>、<https://github.com/agent-network-protocol/AgentNetworkProtocol>。Apache-2.0，社群主導，目前規格 1.2；W3C 有社群組在討論，IETF 有以它為基礎的框架草案（`draft-zyyhl-agent-networks-framework`）。
- 模型：三層——身分層（W3C DID，`did:wba`，端到端加密）、元協定層（Agent 協商要用什麼協定）、應用層（Agent 描述、發現）。1.2 版有完整的即時訊息 profile（直接訊息、群組、裝置綁定 E2EE、附件、聯邦）。
- 與我們的差異：目標是「開放、跨網域的 Agent 網際網路」，身分去中心化、金鑰在 Agent 端。對單一擁有者的私人信箱來說過重，而且同樣不適合無法持有金鑰的 MCP 客戶端。
- 結論：不採用，但身分層若日後要做跨網域聯邦，`did:web` 類的方式是可以借鏡的方向；SAMP 1.0 的聯邦改採「網域 + provider 簽章」（規格 §13）。

### 2.5 MCP（Model Context Protocol）

- 來源：<https://modelcontextprotocol.io/>。Anthropic 2024-11 發表，現屬 Agentic AI Foundation。
- 角色：MCP 是「模型 ↔ 工具／資料」的協定，不是 Agent 之間的協定。但它是目前 Agent 最普遍能用的介面：Claude Code、claude.ai、各家 IDE 都能直接接 MCP 伺服器。
- 與我們的關係：**MCP 是 SAMP 的主要傳輸綁定**。agent-mailbox 現在就是一個 MCP 伺服器（Streamable HTTP、Bearer key 或 OAuth 2.1），工具就是協定操作。這是我們跟上面所有協定最大的不同：別人把 MCP 當成「另外一層」，我們把協定直接做成 LLM 會呼叫的工具，所以任何能接 MCP 的 Agent 不用裝 SDK 就能收發信。

### 2.6 IETF 個人草案（store-and-forward 相關）

這些都是**個人草案，沒有 IETF 背書**，但它們證明「Agent 需要非同步信箱」已是被提出的需求：

| 草案 | 重點 | 與我們的關聯 |
|---|---|---|
| `draft-sharif-agent-transport-protocol`（Agent Transport Protocol, ATP） | 仿 SMTP 的 store-and-forward；每跳驗證身分、信任分數、能力協商、防竄改信封；明言要跟 A2A、MCP、FIPA ACL 互通 | 模型最接近，但它的 payload 是「Agent 本身（狀態、上下文）」，面向 runtime 遷移，比我們重 |
| `draft-chapman-a2a-offline-delivery` | 為 A2A 補離線投遞：可達性模式、「睡著」拒絕訊號、佇列上限與佇列滿錯誤、取出時驗證、「持久化」與「通知」分開 | 我們的 `inbox_full`、TTL、`ack` 語意正好對應；錯誤語意值得對齊 |
| `draft-mpsb-agntcy-slim` | Cisco 低延遲即時訊息、MLS 群組加密 | 不同層次（即時傳輸） |
| 其他（ATP/AGTP/IACP/AIP 等） | 各種「Agent 版 HTTP／傳輸層」提案，見 <https://internet-of-agents.net/> 的整理 | 數量多、尚未收斂，暫不跟隨 |

### 2.7 其他相關產品（非協定）

- **AgentMail、Shipmail、Dead Simple Email**：給 Agent 真正的 email 信箱（SMTP／IMAP + REST + MCP）。好處是能跟人類收發；代價是沿用 email 的寄件者偽造、垃圾信問題，而且身分仍是「一個信箱」而非「一個 Agent」。我們刻意不走 SMTP。
- **各種 file-based agent mailbox skill**（本機 JSON 檔、同一台機器上的 Agent 互傳）：說明需求普遍，但都沒有跨機器與身分。
- **FIPA ACL／KQML**（1990–2000 年代）：古典多 Agent 系統的訊息語言，提供 performative（request、inform、propose…）的概念。我們的 `kind` 欄位（規格 §6.5）取其精神但只保留少數幾種。

## 3. SAMP 的定位

一句話：**給 LLM Agent 的私人、非同步、由伺服器背書身分的信箱協定，以 MCP 工具為主要介面。**

| 面向 | A2A | 23blocks AMP | ANP | **SAMP** |
|---|---|---|---|---|
| 互動模式 | 同步 RPC／任務 | 非同步訊息 | 訊息 + 協商 | 非同步信箱（存了再轉） |
| 收件方需在線 | 是（或靠 push） | 否 | 視 profile | 否 |
| 身分 | 依 Agent Card 宣告的驗證方式 | 客戶端 Ed25519 | DID + E2EE | 伺服器背書（帳號→Agent→憑證），簽章選配 |
| 主要介面 | JSON-RPC／gRPC／REST | REST + WebSocket + CLI | HTTP + JSON-LD | **MCP 工具**，REST 為輔 |
| 訊息保存 | 不適用 | 本機優先，中繼 7 天 | 視實作 | 中繼 TTL，`ack` 即清內容 |
| 背壓 | 無明確定義 | 佇列 TTL | 視 profile | 未讀上限 → `inbox_full` |
| 注入防護 | 不在範圍 | 信任標註、隔離 | 不在範圍 | 伺服器標記來源 + 收件端隔離閱讀 + 內容權限規則 |
| 跨 provider | 是 | 是（聯邦） | 是 | 選配（`federation:v1`，provider 簽章） |

### 刻意不做的事（非目標）

- 不做任務生命週期（交給 A2A；我們只定義交接合約的資料格式）。
- 不做即時串流與群組加密（交給 SLIM 之類）。
- 聯邦不是核心：以選配的 `federation:v1` profile 提供，預設關閉。
- 不做工具或技能的描述格式（交給 MCP／Agent Skills）。

## 4. 參考資料

- 23blocks AMP 規格：<https://github.com/agentmessaging/protocol/tree/main/spec>（本調查讀了 01、02、04、05、06、07、12 節）
- A2A：<https://a2a-protocol.org/latest/>；LF 一週年新聞稿 <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>
- ACP 併入 A2A：<https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/>
- ANP：<https://agent-network-protocol.com/specs/1.2/white-paper>
- IETF 草案：<https://datatracker.ietf.org/doc/draft-sharif-agent-transport-protocol/>、<https://datatracker.ietf.org/doc/draft-chapman-a2a-offline-delivery/>、<https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/>
- 草案彙整：<https://internet-of-agents.net/>
- MCP：<https://modelcontextprotocol.io/>
