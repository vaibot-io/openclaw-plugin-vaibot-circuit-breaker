#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'circuit-breaker-openclaw-plugin'
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.openclaw')

function tryParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, value: null }
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function backupFile(p) {
  if (!fs.existsSync(p)) return null
  const backupPath = `${p}.bak`
  fs.copyFileSync(p, backupPath)
  return backupPath
}

function isSameDir(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

function resolveStateDir() {
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR
  return DEFAULT_STATE_DIR
}

function resolveConfigPath(stateDir) {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH
  return path.join(stateDir, 'openclaw.json')
}

function resolveExtensionsDir(stateDir) {
  if (process.env.OPENCLAW_EXTENSIONS_DIR) return process.env.OPENCLAW_EXTENSIONS_DIR
  return path.join(stateDir, 'extensions')
}

// Dev-only / non-shippable dirs that must never be copied into the extensions
// dir — .git in particular holds read-only objects that EACCES on re-copy.
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (COPY_SKIP.has(entry.name)) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(srcPath, destPath)
    else if (entry.isFile()) {
      // Remove any existing (possibly read-only) target so the copy can't EACCES.
      try { fs.rmSync(destPath, { force: true }) } catch { /* best-effort */ }
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ── Pure config helpers (exported for tests) ───────────────────────────────

/**
 * Current OpenClaw rejects a `path` key on ANY plugin entry ("Unrecognized key:
 * path" — it discovers the plugin from the extensions dir by id) and treats the
 * WHOLE openclaw.json as invalid when one is present, which breaks every
 * `openclaw` command. Strip `path` from every entry so installing this plugin
 * REPAIRS a config that an older build corrupted. Returns the ids it healed.
 */
export function stripRejectedPathKeys(config) {
  const healed = []
  const entries = config?.plugins?.entries
  if (entries && typeof entries === 'object') {
    for (const [id, entry] of Object.entries(entries)) {
      if (entry && typeof entry === 'object' && 'path' in entry) {
        delete entry.path
        healed.push(id)
      }
    }
  }
  return healed
}

/**
 * Register this plugin ({ enabled: true }, never a `path`) and heal any rejected
 * keys left by older installs. Pure: takes the current config (or null), returns
 * the patched config + the list of entry ids it healed.
 */
export function patchConfig(config) {
  const next = config && typeof config === 'object' ? config : {}
  next.plugins = next.plugins ?? {}
  next.plugins.entries = next.plugins.entries ?? {}
  // Heal rejected `path` keys across ALL entries first (so `healed` reflects every
  // repair, including our own), then ensure our entry is registered + enabled.
  const healed = stripRejectedPathKeys(next)
  next.plugins.entries[PLUGIN_ID] = { ...(next.plugins.entries[PLUGIN_ID] ?? {}), enabled: true }
  return { config: next, healed }
}

// ── Side-effecting install ─────────────────────────────────────────────────

function main() {
  const stateDir = resolveStateDir()
  const configPath = resolveConfigPath(stateDir)
  const extensionsDir = resolveExtensionsDir(stateDir)
  const pluginDest = path.join(extensionsDir, PLUGIN_ID)

  // Avoid self-copy loops if already installed in place.
  if (!isSameDir(PKG_ROOT, pluginDest)) {
    copyDir(PKG_ROOT, pluginDest)
  }

  // Read the existing config. If the file exists and is non-empty but does NOT
  // parse as JSON, never overwrite it — that would nuke the user's whole config.
  let current = {}
  let unparseable = false
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8')
    if (raw.trim()) {
      const parsed = tryParse(raw)
      if (parsed.ok) current = parsed.value ?? {}
      else unparseable = true
    }
  }

  const backupPath = backupFile(configPath)

  if (unparseable) {
    process.stderr.write(
      `[vaibot] ${configPath} is not valid JSON — left it untouched (backup: ${backupPath}).\n` +
      `[vaibot] Fix the JSON, then finish with \`openclaw plugins install ${PLUGIN_ID}\`.\n`
    )
  } else {
    const { config, healed } = patchConfig(current)
    writeJson(configPath, config)
    process.stdout.write(`\n`)
    process.stdout.write(`  ✅ VAIBot Circuit Breaker v2 installed\n`)
    process.stdout.write(`  📁 Plugin: ${pluginDest}\n`)
    process.stdout.write(`  📝 Config: ${configPath}\n`)
    if (backupPath) process.stdout.write(`  💾 Backup: ${backupPath}\n`)
    const others = healed.filter((id) => id !== PLUGIN_ID)
    if (others.length) {
      process.stdout.write(`  🩹 Repaired a rejected 'path' key on: ${others.join(', ')}\n`)
    }
    process.stdout.write(`\n`)
    process.stdout.write(`  Next steps:\n`)
    process.stdout.write(`    1. Set VAIBOT_API_KEY in ~/.openclaw/.env (optional — needed for MCP/API fallback)\n`)
    process.stdout.write(`    2. openclaw gateway restart\n`)
    process.stdout.write(`    3. openclaw plugins inspect ${PLUGIN_ID}\n`)
    process.stdout.write(`\n`)
  }
}

// Only run when invoked directly (npm postinstall: `node ./scripts/postinstall.mjs`).
// Importing the module (tests) must not trigger any side effects.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // Skip if OpenClaw's native installer already handled placement + registration.
  if (process.env.OPENCLAW_PLUGIN_INSTALL) {
    process.stdout.write(`[vaibot] Skipping postinstall — OpenClaw native install detected.\n`)
    process.exit(0)
  }
  try {
    main()
  } catch (err) {
    // Auto-wire is a best-effort convenience — never fail the consumer's install
    // over it. Surface the fallback path and exit 0.
    process.stderr.write(`[vaibot] postinstall skipped (auto-wire failed, non-fatal): ${err?.message ?? err}\n`)
    process.stderr.write(`[vaibot] Finish setup with \`vaibot plugin add openclaw\` or \`openclaw plugins install\`.\n`)
    process.exit(0)
  }
}
