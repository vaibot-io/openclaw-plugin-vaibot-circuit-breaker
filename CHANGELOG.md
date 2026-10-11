# Changelog

All notable changes to `@vaibot/circuit-breaker-openclaw-plugin`.

## [Unreleased]

### Fixed
- **An approved guard call is replayed reliably.** The plugin now keys a held call's
  approval on its own hash of the exact call, the same key the retry looks up. A retry
  of the identical call presents its approval whatever form the guard received the
  params in: truncated past `maxParamChars`, with `undefined` values, or not sent at
  all (`sendToolParams: false`). Only the identical call presents it.
- **Observe mode no longer lets the catastrophic floor through.** The guard marks a
  catastrophic deny `floor: true` and expects every client to block it in every mode.
  This plugin never read the marker, so in observe mode such a call was logged as "would
  deny" and then ran. Every observe pass-through now honours the floor:
  - **guard:** a deny with `floor: true` blocks. Other denies are still only logged.
  - **mcp / api:** their answer has no floor marker, so a deny blocks when the local
    classifier rates the call catastrophic, the same floor the guard applies. The run
    is finalized `blocked`, as in enforce.
  - **breaker tripped / chain exhausted:** a catastrophic call blocks with the existing
    "VAIBot floor — … blocked" reason.

  Everything below the floor still behaves as before in observe: logged, not blocked.
  The block reasons are the existing enforce ones; no wording changed.
- **With the breaker tripped, a catastrophic call is no longer approvable** (enforce).
  It was held for `/guard approve` like any risky call. It now blocks outright, matching
  the chain-exhausted path and the claudecode/codex guard-down floor.
- **A denied guard approval is no longer auto-retried.** The poller read "no longer on
  the pending list" as "approved", but that list is pending-only, so **denied**,
  **expired** and already-**used** approvals leave it too. After a "No" the agent was told
  "approval resolved — retrying", and the guard then blocked the retry. On a guard with
  the `approval-status` capability (guard 2.3.1, read from `/health`), the poller now
  asks `POST /v1/approvals/status` what each id resolved to:
  - only `approved` is retried;
  - `denied`, `used`, `expired` and `unknown` are dropped and logged;
  - an id the reply leaves out, or a failed status call, stays pending for the next poll.

  An older guard without the capability keeps the previous behaviour.
- **Guard approvals work again.** When the guard escalated a call, the plugin read the
  approval's id, expiry and scope from the **top level** of the response, but the guard
  returns them **inside `decision`**, and always has. On a real guard all three came
  back `undefined`:
  - the pending entry had no `approvalId`, so the poller skipped it and **never
    auto-retried** after an approval;
  - `approvedByParamsHash` was never set, so a **retry never presented the approval**,
    and the guard escalated again under a new id;
  - the block message never showed `approvalId=` or `/guard approve <id>`, so the user
    couldn't see what to approve.

  The plugin now reads them from `decision`, with the top level kept as a fallback. The
  test mock had the same wrong shape, which is how this got through. It now matches a
  real guard, and a new test checks that a retry presents the approval it was blocked
  with.

  Known follow-up: the poller still treats "no longer pending" as "approved". With
  approvals now visible, a **denied** approval triggers an auto-retry that the guard
  then blocks (`status=denied`). That's safe but noisy. A proper fix needs a guard
  endpoint that reports a single approval's status.

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
