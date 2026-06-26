#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PLUGIN_ID = 'circuit-breaker-openclaw-plugin'
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.openclaw')

// ---- Skip if OpenClaw's native installer already handled placement ----
if (process.env.OPENCLAW_PLUGIN_INSTALL) {
  process.stdout.write(`[vaibot] Skipping postinstall — OpenClaw native install detected.\n`)
  process.exit(0)
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
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

function main() {
  const stateDir = resolveStateDir()
  const configPath = resolveConfigPath(stateDir)
  const extensionsDir = resolveExtensionsDir(stateDir)
  const pluginDest = path.join(extensionsDir, PLUGIN_ID)

  // Avoid self-copy loops if already installed
  if (!isSameDir(PKG_ROOT, pluginDest)) {
    copyDir(PKG_ROOT, pluginDest)
  }

  // Patch OpenClaw config (with backup)
  const backupPath = backupFile(configPath)
  const config = readJsonSafe(configPath) ?? {}
  config.plugins = config.plugins ?? {}
  config.plugins.entries = config.plugins.entries ?? {}

  // Current OpenClaw rejects a `path` key on plugin entries ("Unrecognized key: path"
  // — it discovers the plugin from the extensions dir by id), and a stale `path` makes
  // the WHOLE openclaw.json invalid (breaking `openclaw plugins list`). Register with
  // { enabled: true } only, and strip any `path` left by an older install.
  const entry = { ...(config.plugins.entries[PLUGIN_ID] ?? {}), enabled: true }
  delete entry.path
  config.plugins.entries[PLUGIN_ID] = entry

  writeJson(configPath, config)

  process.stdout.write(`\n`)
  process.stdout.write(`  ✅ VAIBot Circuit Breaker v2 installed\n`)
  process.stdout.write(`  📁 Plugin: ${pluginDest}\n`)
  process.stdout.write(`  📝 Config: ${configPath}\n`)
  if (backupPath) process.stdout.write(`  💾 Backup: ${backupPath}\n`)
  process.stdout.write(`\n`)
  process.stdout.write(`  Next steps:\n`)
  process.stdout.write(`    1. Set VAIBOT_API_KEY in ~/.openclaw/.env (optional — needed for MCP/API fallback)\n`)
  process.stdout.write(`    2. openclaw gateway restart\n`)
  process.stdout.write(`    3. openclaw plugins inspect ${PLUGIN_ID}\n`)
  process.stdout.write(`\n`)
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
