# Changelog

All notable changes to `@vaibot/circuit-breaker-openclaw-plugin`.

## [1.3.2] — 2026-09-28 — guard 2.3.0

### Changed
- **Vendored guard refreshed to 2.3.0**, taken from the published tarball and verified
  against the digest the registry reports (`ecdd56a7f87604435e06a2eafc6de4b96bb7918b`),
  so the committed copy is provably what npm serves. It brings:

  - the **git classification fix** — `git -C <path> …` no longer launders
    `reset --hard`, `clean -f` or `push --force` from ask to allow, and `branch -D` /
    `tag -d` are no longer classified as reads;
  - **`floorAsk`**, a verdict tier no preset can make silent;
  - **approval leases** and **batch approvals**, which this breaker inherits through
    the guard's decision path rather than implementing itself.

  **This changes what runs without asking, on the `permissive` preset.** The guard
  gained a third verdict tier — `floorAsk`, which always asks and which no preset can
  lower — so actions that cannot be undone by whoever authorised them now prompt even
  under `permissive`, which previously never prompted. Measured on the vendored
  classifier this breaker uses in-process:

  | command | 2.2.1 | 2.3.0 |
  |---|---|---|
  | `git branch -D <branch>` | allow | **ask** |
  | `git -C <path> reset --hard` | allow | **ask** |
  | `npm publish` · `cargo publish` | allow | **ask** |
  | `git status` · `npm test` | allow | allow |

  Routine work is untouched — there is a test table asserting exactly that, so the
  tier cannot drift into "ask about everything". If the new prompts are unwelcome, the
  lever is the preset, not the breaker version.

## [1.3.1] — 2026-09-27 — vendored guard 2.2.1

### Changed
- Vendored guard refreshed to **2.2.1**, a declaration-only fix: the guard's
  `lib/guard-bootstrap.d.mts` was missing seven exports the module genuinely has.
  Runtime was unaffected. This package also gained its own `typecheck` script, which
  is the guard rail that was missing when the type error shipped.

## [1.3.0] — 2026-09-26 — containment on every degraded path

### Added
- **The account-wide containment stop is honoured before any other decision.** Every
  path where this plugin degrades skipped the guard, and so skipped containment; those
  are exactly the paths an account-wide block has to survive. The check reads the
  machine-wide record, which needs no daemon, no network and no credentials. Unlike
  the other breakers this one needs no governance-tool name exemption — its operator
  path is the `/vaibot` slash commands, which the gateway does not route through
  `before_tool_call`.
- A test that an already-approved replay pointer does not survive containment.

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
