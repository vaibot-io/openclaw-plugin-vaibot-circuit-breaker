# @vaibot/circuit-breaker-openclaw-plugin

## Install (npm)

```bash
npm install @vaibot/circuit-breaker-openclaw-plugin
```

Postinstall will:
- detect OpenClaw state dir (`OPENCLAW_STATE_DIR` or `~/.openclaw`)
- copy plugin into `${OPENCLAW_STATE_DIR}/extensions/vaibot-circuit-breaker-v2`
- patch `openclaw.json` (or `OPENCLAW_CONFIG_PATH` if set)

Environment overrides:
- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH`
- `OPENCLAW_EXTENSIONS_DIR`

## Install (manual)

1) **Enable plugin in OpenClaw config** (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "vaibot-circuit-breaker-v2": {
        "enabled": true,
        "path": "/path/to/vaibot-v2/packages/openclaw-circuitbreaker-plugin",
        "config": {
          "mode": "enforce",
          "guardBaseUrl": "http://127.0.0.1:39111",
          "mcpBaseUrl": "https://api.vaibot.io/v2/mcp",
          "mcpTokenEnv": "VAIBOT_API_KEY",
          "apiBaseUrl": "https://api.vaibot.io",
          "apiKeyEnv": "VAIBOT_API_KEY"
        }
      }
    }
  }
}
```

2) **Set env vars** (in `~/.openclaw/.env` or service env):

```
VAIBOT_API_KEY=vb_live_...
VAIBOT_GUARD_TOKEN=...   # if guard requires auth
```

3) **Restart gateway**

```bash
openclaw gateway restart
```

4) **Verify**
Look for:
```
vaibot-circuitbreaker loaded (mode=..., guard=..., mcp=..., api=...)
```

---

## Notes
- Decision chain: **vaibot-guard → MCP → VAIBot API → circuit breaker**
- MCP endpoint default: `https://api.vaibot.io/v2/mcp`

## Config Reference (v2)
Key options (plugin config):
- `decisionChain`: array of sources in order. Supports `skill` (alias for `guard`), `mcp`, `api`, `breaker`. Default: `['guard','mcp','api','breaker']`.
- `mcpMaxRetries`, `mcpRetryBaseMs`, `mcpRetryJitterMs`: MCP retry + backoff settings.
- `breakerTelemetryAllowlist`: tools that remain allowed in breaker mode for telemetry-only flows.
- `breakerProbeIntervalMs`: probe interval to auto-clear breaker when upstream recovers.

## Upgrade Path (v1 → v2)
- Update plugin id to `vaibot-circuit-breaker-v2` in `openclaw.json`.
- Ensure `VAIBOT_API_KEY` is set (used for MCP + API fallbacks).
- Add optional `decisionChain` if you want to skip any decision sources.

## Security Posture
- Default mode is **enforce** with **fail-closed** on errors.
- Breaker mode only allows explicit allowlists; exec/write/send are denied by default.
- Guard/MCP/API outages will trip the breaker and block high‑risk operations.
