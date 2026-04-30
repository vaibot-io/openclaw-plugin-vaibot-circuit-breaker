# @vaibot/circuit-breaker-openclaw-plugin

OpenClaw Gateway plugin that enforces VAIBot governance decisions on every tool call — with a local circuit breaker that keeps protection active even when the API is unreachable.

VAIBot classifies each tool call against your governance policy and returns an allow, deny, or approval-required decision before the tool executes. Every decision creates a tamper-evident receipt with on-chain provenance anchoring.

## Plugin vs. MCP server

VAIBot also ships an MCP server that exposes governance tools Claude can call voluntarily. The plugin and the MCP server are complementary — they serve different roles:

| | MCP server | This plugin |
|---|---|---|
| Agent queries policy / status | ✓ | ✗ |
| Agent approves actions in-session | ✓ | ✓ |
| Enforcement happens before execution | ✗ | ✓ |
| Agent can skip or bypass the check | ✓ | ✗ |
| Audit trail the agent can't forge | ✗ | ✓ |
| Circuit breaker when API is unreachable | ✗ | ✓ |

The MCP server gives the agent a way to query and interact with VAIBot. The plugin is what makes governance **mandatory** — the check happens at the gateway level before the tool executes, regardless of what the agent does. If the goal is a tamper-evident audit record or blocking a misbehaving agent, the plugin is the enforcement layer that actually enforces it.

Most deployments use both: the plugin for mandatory pre-execution enforcement, the MCP server so the agent can surface policy context and manage approvals in-session.

## Install

```bash
openclaw plugins install @vaibot/circuit-breaker-openclaw-plugin
openclaw gateway restart
```

No API key required. On first run the plugin auto-provisions a free-tier account using a machine fingerprint and saves credentials to `~/.vaibot/credentials.json`.

## What you see at runtime

**Allowed tool** — passes through silently.

**Denied tool** — the agent receives the policy reason and reports it:
```
VAIBot denied: exec is not permitted in this workspace.
```

**Approval required** — the agent is blocked and prompted with instructions:
```
VAIBot: 'Bash' requires approval.
content_hash: sha256:a3f9c1...
Approve in the dashboard or run: /vaibot approve sha256:a3f9c1...
```

Once approved, the agent retries the action automatically.

## Decision chain

Each tool call walks this chain in order, stopping at the first source that responds:

```
vaibot-guard (local skill) → VAIBot MCP → VAIBot API → circuit breaker
```

- **vaibot-guard** — a local skill running at `localhost:39111`. Fastest; no network hop. Optional — the plugin works without it.
- **VAIBot MCP** — cloud policy evaluation via the MCP endpoint.
- **VAIBot API** — direct REST fallback.
- **Circuit breaker** — takes over when all upstream sources are unreachable (see below).

You can shorten the chain in config — e.g. `"decisionChain": ["api"]` to skip guard and MCP.

## Circuit breaker

When upstream sources fail 3 times within 10 seconds, the breaker trips and the plugin makes decisions locally until services recover (60 second cooldown, then auto-retry).

While tripped, tools are classified into three groups:

| Classification | Default tools | Behaviour |
|---|---|---|
| Allowlist | `read`, `web_fetch` | Pass through automatically |
| Denylist | `exec`, `write`, `sessions_send`, `message.send` | Hard blocked |
| Unknown | everything else | Held for your approval |

For unknown tools, the agent receives:
```
Circuit breaker active — 'browser' needs approval.
Approve: /guard approve breaker:a3f9c1b8e2d7f041
Deny:    /guard deny breaker:a3f9c1b8e2d7f041
```

After approving, you'll be asked whether to add it to your permanent allowlist:
```
'browser' was approved during a circuit breaker trip.
Add to permanent allowlist? /vaibot allowlist add browser
```

## Slash commands

### `/vaibot`

| Command | Description |
|---|---|
| `/vaibot approve <content_hash>` | Approve a pending tool call via VAIBot API |
| `/vaibot deny <content_hash>` | Deny a pending tool call via VAIBot API |
| `/vaibot allowlist add <tool>` | Add a tool to the breaker allowlist permanently |
| `/vaibot allowlist list` | Show config and runtime allowlist entries |
| `/vaibot allowlist skip` | Dismiss the allowlist prompt without adding |
| `/vaibot help` | Show all subcommands |

### `/guard`

| Command | Description |
|---|---|
| `/guard approvals` | List pending guard approvals |
| `/guard approve <approvalId>` | Approve a guard or breaker-held tool call |
| `/guard deny <approvalId>` | Deny a guard or breaker-held tool call |

## Configuration

All settings are optional. Override in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "circuit-breaker-openclaw-plugin": {
        "enabled": true,
        "config": {
          "mode": "enforce",
          "decisionChain": ["guard", "mcp", "api", "breaker"]
        }
      }
    }
  }
}
```

### Key options

| Option | Default | Description |
|---|---|---|
| `mode` | `"enforce"` | `"enforce"` blocks; `"observe"` logs without blocking |
| `decisionChain` | `["guard","mcp","api","breaker"]` | Sources in priority order |
| `failClosedOnError` | `true` | Deny when all sources fail |
| `guardBaseUrl` | `http://127.0.0.1:39111` | Local vaibot-guard URL |
| `mcpBaseUrl` | `https://api.vaibot.io/v2/mcp` | VAIBot MCP endpoint |
| `apiBaseUrl` | `https://api.vaibot.io` | VAIBot API endpoint |
| `autoBootstrap` | `true` | Provision a free account on first run if no key found |
| `breakerAllowlist` | `["read","web_fetch"]` | Pass-through tools when breaker trips |
| `breakerDenylist` | `["exec","write","sessions_send","message.send"]` | Hard-blocked tools when breaker trips |
| `breakerFailureThreshold` | `3` | Failures before breaker trips |
| `breakerWindowMs` | `10000` | Failure counting window (ms) |
| `breakerCooldownMs` | `60000` | Time before breaker auto-clears (ms) |
| `timeoutMs` | `15000` | Per-request timeout (ms) |
| `decisionCacheTtlMs` | `5000` | Cache allow decisions for this many ms |
| `approvalAutoRetry` | `true` | Automatically retry approved actions |

### Environment variables

Set in `~/.openclaw/.env` or your service environment:

| Variable | Purpose |
|---|---|
| `VAIBOT_API_KEY` | Bearer token for MCP + API fallback (auto-provisioned if absent) |
| `VAIBOT_GUARD_TOKEN` | Auth token for local guard service |
| `VAIBOT_API_BASE_URL` | Override API base URL |
| `VAIBOT_GUARD_BASE_URL` | Override guard base URL |
| `VAIBOT_CREDS_DIR` | Override credentials directory (default: `~/.vaibot`) |

## Modes

**enforce** (default) — tool calls are blocked when the policy says deny or approval_required.

**observe** — all tool calls proceed, but the policy verdict is logged. Useful for auditing before enabling enforcement.

```json
{ "config": { "mode": "observe" } }
```

## Community & support

**[Join the VAIBot Discord](https://discord.gg/mSHYtP5nV)** — get help, share feedback, and connect with other users.

VAIBot is in early access. If you're installing this plugin now, you're among the first operators putting verifiable AI governance into production. Early community members shape the roadmap directly — feature requests, policy design, and integration patterns all come from conversations in Discord.

To become a founding member, join the Discord and introduce yourself in **#founding-members**. Founding members get:
- Direct access to the VAIBot team
- Early previews of upcoming governance features
- Input on default policy design and circuit breaker defaults
- Recognition in the project

## Uninstall

```bash
openclaw plugins uninstall circuit-breaker-openclaw-plugin
openclaw gateway restart
```

---

## Local dev install

When installing from a local path or tarball, OpenClaw's safety scanner may flag the plugin because it reads environment variables and makes network calls (expected behaviour for a governance plugin). Use `--dangerously-force-unsafe-install` to acknowledge this:

```bash
openclaw plugins install --dangerously-force-unsafe-install ./vaibot-circuit-breaker-openclaw-plugin-0.2.2.tgz
openclaw gateway restart
openclaw plugins inspect circuit-breaker-openclaw-plugin
```
