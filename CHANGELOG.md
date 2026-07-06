# Changelog

All notable changes to `@vaibot/circuit-breaker-openclaw-plugin`.

## [1.2.0] — 2026-07-05 — account key recovery

### Changed
- On `bootstrapped:false` (account exists but no local API key — e.g. the key was
  lost), the plugin now warns with **both** recovery paths instead of a dead end:
  run `vaibot login` (re-issues a key via your session) **or** set the api-key env /
  check `credentials.json`. Both are valid; neither replaces the other.

## [1.1.0] — 2026-07-04 — graceful degrade + honest receipts

### Changed
- **Keyless / guard-down now degrades to the local classifier instead of blanket-blocking.**
  When the decision chain is exhausted (no key, or the guard unreachable), the plugin governs
  locally: classifier-safe tools pass, the denylist + catastrophic floor block, and risky
  tools are held — so a missing key or a transient outage no longer dead-ends every tool.
  `bootstrap`/network failures degrade to this floor rather than throwing.
- Re-vendored `@vaibot/guard` 2.1.0:
  - destructive host-config verbs hard-deny (`systemctl stop|disable|mask`, `service … stop`,
    `launchctl unload|remove|bootout`, `crontab` install) — matched on wrapped/absolute/`sh -c`
    forms, un-overridable by any preset;
  - the guard's OWN lifecycle is allow-listed (systemd + macOS `launchctl io.vaibot.guard` +
    CLI + the `:39111` health probe), so managing the guard never prompts; teardown still denies;
  - honest receipts: `risk_level` matches the decision, and an allowed action reads `allowed`.

### Notes
- OpenClaw already defaults to **`enforce`** (`cfg.mode ?? "enforce"`) via plugin
  config — not `VAIBOT_MODE` env — and already degrades a missing guard through its
  adopt → systemd → breaker/local chain. Per the gateway-is-the-control-point design
  (keep this plugin thin), the CLI plugins' cold-start conditioned-degrade logic was
  intentionally NOT grafted onto this gateway plugin; its fresh-install story is the
  existing systemd-start path. See the guard's `THREAT-MODEL.md` §9.
