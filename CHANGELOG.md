# Changelog

All notable changes to `@vaibot/circuit-breaker-openclaw-plugin`.

## [Unreleased] — vendored guard refresh

### Changed
- Synced vendored `@vaibot/guard` to the fresh-install release: system-config
  commands (`systemctl` / `service` / `launchctl` / `crontab` / `cron`) now escalate
  to **human approval on the command head** instead of hard-denying;
  `policy.default.json` v0.3 (empty `denyTokens`); and the launcher tees the daemon's
  boot output to `~/.vaibot/guard/launch.log` with a 10s cold-start budget.

### Notes
- OpenClaw already defaults to **`enforce`** (`cfg.mode ?? "enforce"`) via plugin
  config — not `VAIBOT_MODE` env — and already degrades a missing guard through its
  adopt → systemd → breaker/local chain. Per the gateway-is-the-control-point design
  (keep this plugin thin), the CLI plugins' cold-start conditioned-degrade logic was
  intentionally NOT grafted onto this gateway plugin; its fresh-install story is the
  existing systemd-start path. See the guard's `THREAT-MODEL.md` §9.
