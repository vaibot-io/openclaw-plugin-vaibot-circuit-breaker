# @vaibot/circuit-breaker-openclaw-plugin

OpenClaw Gateway plugin that enforces VAIBot governance decisions with a multi-source decision chain and circuit-breaker fallback.

**Decision chain:** vaibot-guard (local) → MCP server → VAIBot API → circuit breaker (fail-closed)

## Quick Install

```bash
openclaw plugins install @vaibot/circuit-breaker-openclaw-plugin
openclaw gateway restart
```

That's it. The plugin loads with sensible defaults — no config required.

## Local Dev / Tarball Install Notes

When installing from a local path or freshly packed tarball, OpenClaw may block installation unless you explicitly acknowledge the plugin's runtime shape. This plugin legitimately reads environment variables (for local guard/API auth) and makes network calls (guard/MCP/API decision chain), which can trip the built-in unsafe-pattern scanner.

Example local install:

```bash
openclaw plugins install --dangerously-force-unsafe-install ./vaibot-circuit-breaker-openclaw-plugin-0.2.1.tgz
openclaw gateway restart
```

Notes:
- The publish bundle is intended to ship runtime files only; test files should not be included in the tarball.
- `--dangerously-force-unsafe-install` should be treated as a deliberate local-dev/operator action, not the default happy path for end users.

To verify:

```bash
openclaw plugins inspect circuit-breaker-openclaw-plugin
```

## Optional: Set API Key

If you want MCP/API fallback (recommended), add your key:

```bash
echo 'VAIBOT_API_KEY=vb_live_...' >> ~/.openclaw/.env
openclaw gateway restart
```

Without a key, the plugin still works — it uses the local guard skill and falls back to the circuit breaker.

## Alternative: npm Install

If you prefer npm (e.g., for CI or scripted setups):

```bash
npm install -g @vaibot/circuit-breaker-openclaw-plugin
openclaw gateway restart
```

The postinstall script copies the plugin into OpenClaw's extensions directory and patches `openclaw.json` automatically.

## Configuration

All config is optional. Defaults are production-ready.

Add overrides in `~/.openclaw/openclaw.json` under `plugins.entries.circuit-breaker-openclaw-plugin.config`:

```json
{
  "plugins": {
    "entries": {
      "circuit-breaker-openclaw-plugin": {
        "enabled": true,
        "config": {
          "mode": "enforce",
          "guardBaseUrl": "http://127.0.0.1:39111",
          "mcpBaseUrl": "https://api.vaibot.io/v2/mcp",
          "apiBaseUrl": "https://api.vaibot.io"
        }
      }
    }
  }
}
```

### Key Options

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `"enforce"` | `"enforce"` blocks denied tools; `"observe"` logs only |
| `decisionChain` | `["guard","mcp","api","breaker"]` | Decision sources in priority order |
| `failClosedOnError` | `true` | Deny tool calls when all decision sources fail |
| `guardBaseUrl` | `http://127.0.0.1:39111` | Local vaibot-guard service URL |
| `mcpBaseUrl` | `https://api.vaibot.io/v2/mcp` | VAIBot MCP endpoint |
| `apiBaseUrl` | `https://api.vaibot.io` | VAIBot API endpoint |
| `breakerAllowlist` | `["read","web_fetch"]` | Tools allowed during breaker mode |
| `breakerDenylist` | `["exec","write","sessions_send","message.send"]` | Tools always denied during breaker mode |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `VAIBOT_API_KEY` | Bearer token for MCP + API fallback |
| `VAIBOT_GUARD_TOKEN` | Auth token for local guard service (if required) |

Set these in `~/.openclaw/.env` or your service environment.

## Upgrade from v1

1. The plugin ID changed to `circuit-breaker-openclaw-plugin`
2. Set `VAIBOT_API_KEY` (used for MCP + API fallbacks)
3. Optionally customize `decisionChain` to skip sources you don't use

## Security Posture

- Default mode: **enforce** with **fail-closed** on errors
- Breaker mode denies `exec`, `write`, `sessions_send`, `message.send` by default
- Only explicit allowlist tools (`read`, `web_fetch`) work during breaker mode
- Guard/MCP/API outages trip the breaker automatically

## Uninstall

```bash
openclaw plugins uninstall circuit-breaker-openclaw-plugin
openclaw gateway restart
```
