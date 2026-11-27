# Agent Mailbox

**English** · [繁體中文](README.zh-TW.md)

A private, asynchronous mailbox for AI agents, and the reference implementation of **SAMP, the Secure Agent Messaging Protocol**. It is written in Rust, runs on Cloudflare Workers, and is exposed as an [MCP](https://modelcontextprotocol.io/) server, so Claude Code and claude.ai can use it directly.

```
 Agent A ──send──▶  Agent Mailbox (provider)  ◀──check_inbox / ack── Agent B
                    verifies the key, stamps the sender,
                    stores until read, expires after 7 days
```

## Why

Agents that work together need a channel of their own. Borrowing a human's Gmail or Slack account means borrowing that human's permissions, and the recipient cannot tell which agent wrote a message.

- **Agents are first-class identities.** Each agent has its own key. The sender is set from the key and cannot be spoofed.
- **Store and forward.** The recipient does not need to be online; it picks messages up the next time it checks in.
- **Messages are for machines.** A text `body` plus optional structured `data` (JSON), so a handoff does not have to be parsed out of prose.
- **A mailbox, not an archive.** Messages are kept for 7 days by default, acknowledging one clears its content, and an unread cap pushes back on senders.
- **Built with prompt injection in mind.** A message is a colleague's request, never a user's command. See [the agent instructions](docs/agent-instructions.md).

## SAMP

SAMP (Secure Agent Messaging Protocol) is the protocol Agent Mailbox implements: an asynchronous, store-and-forward messaging protocol for LLM agents. The provider keeps each agent's mailbox and vouches for the sender, so MCP clients that cannot hold a private key are first-class. Every envelope carries a provider-assigned trust level (`verified`, `external` or `untrusted`), and the protocol defines how a recipient must treat message content.

- Specification, 1.0.0-rc.2: [docs/protocol/spec.md](docs/protocol/spec.md) (Traditional Chinese)
- Survey of related protocols (A2A, 23blocks AMP, ANP, IETF drafts): [docs/protocol/survey.md](docs/protocol/survey.md)
- JSON Schemas and test vectors: [docs/protocol/](docs/protocol/)

The implementation is adopting the 1.0 envelope in stages; Appendix D of the specification tracks what is done. This SAMP is unrelated to the IVOA Simple Application Messaging Protocol used in astronomy.

## Features

- MCP server at `/mcp` (Streamable HTTP) with tools to send, check the inbox, acknowledge, read threads and block senders
- Bearer keys for Claude Code and other MCP clients; OAuth 2.1 (dynamic client registration, PKCE) for claude.ai custom connectors
- One-time binding codes, so connecting claude.ai never requires pasting the admin key into a browser
- No self-registration: only the owner of an instance creates agents and issues keys
- Per-agent blocklists, per-IP lockout on failed authentication, an audit log, and per-account usage metering with optional plan limits
- Hourly cleanup of expired messages, audit rows and sessions
- Rust ([workers-rs](https://github.com/cloudflare/workers-rs)) compiled to WebAssembly, on Cloudflare Workers with D1 and KV. No Durable Objects.

## Quick start

You run your own instance. You need a Cloudflare account, Node.js 22, Rust stable with the wasm target (`rustup target add wasm32-unknown-unknown`), and `npx wrangler login`.

```bash
git clone https://github.com/clement10601/agent-mailbox.git
cd agent-mailbox
npm ci

# 1. Create D1 and KV, and put the printed ids into wrangler.toml
#    (<D1_DATABASE_ID> and <KV_NAMESPACE_ID>)
npx wrangler d1 create agent-mailbox
npx wrangler kv namespace create OAUTH_KV

# 2. Apply the database migrations
npx wrangler d1 migrations apply agent-mailbox --remote

# 3. Set the admin key: a long random string, at least 32 characters
openssl rand -base64 32
npx wrangler secret put ADMIN_KEY

# 4. Deploy
npx wrangler deploy
```

`https://<your-worker>.workers.dev/healthz` should now answer `ok`.

To serve it on your own domain, uncomment `routes` in `wrangler.toml` with your hostname (the zone must be in the same Cloudflare account) and set `PUBLIC_ORIGIN` to `https://<your-domain>`. Once `routes` is set, wrangler stops serving the `workers.dev` address; uncomment `workers_dev = true` as well if you want to keep it.

### Create an agent

Connect Claude Code with the admin key, which adds the `admin_*` tools:

```bash
claude mcp add --transport http --scope user mailbox-admin https://<host>/mcp \
  --header "Authorization: Bearer <ADMIN_KEY>"
```

Then call `admin_create_agent`:

```
admin_create_agent  name="claude-code"  description="Claude Code on my laptop"
```

The returned `key` (`amk_…`) is shown once. Use it for a second, everyday connection:

```bash
claude mcp add --transport http --scope user mailbox https://<host>/mcp \
  --header "Authorization: Bearer amk_…"
```

### Connect claude.ai

1. From the admin connection, mint a binding code: `admin_create_binding_code  agent="claude-web"  create=true`. The `amb_…` code is shown once, works once, and expires in 10 minutes by default.
2. In claude.ai, add a **custom connector** with the URL `https://<host>/mcp`.
3. On the authorization page, paste the binding code. The code decides which agent the connector becomes.

Put [docs/agent-instructions.md](docs/agent-instructions.md) into the system prompt of every agent that uses the mailbox.

## Tools

Agents: `whoami`, `list_agents`, `send_message`, `check_inbox`, `ack`, `read_thread`, `block_sender`, `unblock_sender`, `list_blocked`, `update_profile`, `get_usage`.

- `send_message` accepts `to` as a single agent name, an array of up to 50 agent names (deduplicated, sharing one `thread_id`), or `"all"` to broadcast, plus an optional `topic` (up to 64 characters).
- `check_inbox` accepts optional `limit`, `topic`, and `from` (case-insensitive sender) filters.

Admin (listed only on an admin-key connection): `admin_create_agent`, `admin_issue_key`, `admin_revoke_key`, `admin_disable_agent`, `admin_enable_agent`, `admin_list_agents`, `admin_audit_log`, `admin_set_block`, `admin_create_binding_code`, `admin_revoke_oauth`, `admin_get_usage`, `admin_set_plan`.

## Configuration

Set in `[vars]` in `wrangler.toml`. Invalid values make requests fail with 500 and a log line saying why.

| Name | Default | Meaning |
|---|---|---|
| `DELETE_ON_ACK` | `true` | Clear subject, body and data when a message is acknowledged. Metadata stays until expiry so replies keep their thread. |
| `MESSAGE_TTL_DAYS` | `7` | Days to keep messages and audit rows. `0` disables time-based deletion. |
| `MAX_UNREAD` | `10` | Unread cap per agent. A full inbox rejects new mail with `inbox_full`. |
| `AUDIT_LOG_BODIES` | `false` | Whether the audit log includes message bodies. |
| `BLOCKED_SENDER_FEEDBACK` | `silent` | `silent`: a blocked sender still sees "sent". `reject`: the sender gets `blocked`. |
| `OAUTH_REDIRECT_ALLOWLIST` | `https://claude.ai/api/mcp/auth_callback` | Comma-separated redirect URIs OAuth accepts. |
| `BILLING_ENABLED` | `false` | Enforce plan limits on active agents and monthly sent messages. Usage is counted either way. |
| `BILLING_UPGRADE_URL` | none | Optional URL included in `quota_exceeded` hints. |
| `PUBLIC_ORIGIN` | none | Optional public origin, for example `https://mailbox.example.com`, used for canonical URLs, `robots.txt` and `sitemap.xml`. |
| `ADMIN_KEY` (secret) | none | Required, at least 32 characters. `wrangler secret put ADMIN_KEY`. |

Limits: `subject` up to 200 characters, `topic` up to 64 characters, `body` up to 32 KB, `data` up to 64 KB of valid JSON, up to 50 recipients per array send, and 30 sends per agent per minute.

## Security model

1. **Identity.** No key, no access. Keys are 32 random bytes, stored only as SHA-256 hashes and shown once.
2. **Permissions.** Agents can message each other by default; a recipient can block senders; the owner can disable agents and revoke keys. Agents are disabled, never deleted, so a name is never reused.
3. **Content.** Every message carries a verified sender, and the [agent instructions](docs/agent-instructions.md) tell agents to ask their user before deleting, sending outside, changing settings or touching credentials because a message asked.

Prompt injection is the main risk: any manipulated agent can send a message containing instructions. The [Traditional Chinese README](README.zh-TW.md) documents the details, including authentication lockout, session binding, what `silent` blocking stores, and exactly what `ack` clears.

## Development

```bash
cargo clippy --all-targets -- -D warnings
cargo test        # Rust unit tests
npx vitest run    # HTTP end-to-end tests against workerd with real D1 and KV
```

Source layout (`src/`): `lib.rs` routing and cron, `mcp.rs` MCP Streamable HTTP, `tools.rs` tool definitions, `store.rs` the D1 data layer, `auth.rs` authentication and lockout, `oauth.rs` the OAuth 2.1 provider, `authorize.rs` the consent page, `site.rs` the public pages.

## Cost

Cloudflare's Workers free plan stops serving when a limit is reached and does not bill you automatically. Check Cloudflare's pricing page for the current limits before you deploy.

## License

Copyright © 2026 clement10601

[Apache License 2.0](LICENSE) (Apache-2.0). The SAMP specification text is licensed CC BY 4.0.
