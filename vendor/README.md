# Vendored dependencies

## `vaibot-guard/` — a committed, real-file copy of `@vaibot/guard`

**Current version: `1.0.1`** (keep in lockstep with the version the `vaibot` CLI
installs globally and with the codex/claudecode plugin vendors).

### Why this is vendored

`openclaw plugins install` copies the plugin into `~/.openclaw/extensions/<id>/` via
the `postinstall` `copyDir`, which **deliberately skips `node_modules`** — so the
`@vaibot/guard` dependency never travels with the plugin and bare
`import "@vaibot/guard/..."` resolves to nothing at the loaded location
(`MODULE_NOT_FOUND`). The guard is committed here and `src/plugin.ts` imports it by
**relative path** (`../vendor/vaibot-guard/scripts/...`), making the plugin
self-contained. `copyDir` copies `vendor/` (it is NOT in the skip-list), so the
guard reaches the extensions dir.

Two hard requirements:

- **Real files, no symlinks** — never a pnpm/workspace symlink. Refresh via `npm pack`.
- **Same version as the CLI-installed guard** — version skew can break the per-host
  single-guard adopt-not-duplicate invariant.

### Refresh after an `@vaibot/guard` release

```sh
cd packages/openclaw-circuitbreaker-plugin
npm pack @vaibot/guard@<version>
rm -rf vendor/vaibot-guard && mkdir -p vendor/vaibot-guard
tar xzf vaibot-guard-<version>.tgz && cp -RL package/. vendor/vaibot-guard/ && rm -rf package vaibot-guard-<version>.tgz
find vendor/vaibot-guard -type l    # must print nothing
npm test
```

Then update the version above and `devDependencies["@vaibot/guard"]` in `package.json`.
