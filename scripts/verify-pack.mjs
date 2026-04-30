#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const REQUIRED = new Set([
  'LICENSE',
  'README.md',
  'index.ts',
  'openclaw.plugin.json',
  'package.json',
  'scripts/postinstall.mjs',
  'src/openclaw-plugin-sdk.d.ts',
  'src/plugin.ts',
])

const FORBIDDEN_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
]

function main() {
  const raw = execFileSync('npm', ['pack', '--json', '--dry-run'], { encoding: 'utf8' })
  const parsed = JSON.parse(raw)
  const pack = Array.isArray(parsed) ? parsed[0] : parsed
  const files = Array.isArray(pack?.files) ? pack.files.map((f) => f.path) : []

  const missing = [...REQUIRED].filter((file) => !files.includes(file))
  const forbidden = files.filter((file) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)))

  if (missing.length || forbidden.length) {
    if (missing.length) {
      console.error('Missing required pack files:')
      for (const file of missing) console.error(`- ${file}`)
    }
    if (forbidden.length) {
      console.error('Forbidden pack files present:')
      for (const file of forbidden) console.error(`- ${file}`)
    }
    process.exit(1)
  }

  console.log(`Pack verification passed (${files.length} files).`)
}

main()
