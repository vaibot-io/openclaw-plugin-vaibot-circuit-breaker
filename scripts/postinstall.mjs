#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PLUGIN_ID = 'vaibot-circuit-breaker-v2'
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.openclaw')

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

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(srcPath, destPath)
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath)
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

  const existing = config.plugins.entries[PLUGIN_ID]
  if (!existing || existing.path !== pluginDest || existing.enabled !== true) {
    config.plugins.entries[PLUGIN_ID] = {
      ...(existing ?? {}),
      enabled: true,
      path: pluginDest,
    }
  }

  writeJson(configPath, config)

  process.stdout.write(`[vaibot] Installed ${PLUGIN_ID} → ${pluginDest}\n`)
  if (backupPath) process.stdout.write(`[vaibot] Backup created: ${backupPath}\n`)
  process.stdout.write(`[vaibot] Updated ${configPath}\n`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`[vaibot] postinstall failed: ${err?.message ?? err}\n`)
  process.exitCode = 1
}
