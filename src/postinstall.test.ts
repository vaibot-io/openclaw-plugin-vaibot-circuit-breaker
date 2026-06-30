import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — importing the plain .mjs install script for its pure helpers
import { patchConfig, stripRejectedPathKeys } from '../scripts/postinstall.mjs'

const PLUGIN_ID = 'circuit-breaker-openclaw-plugin'
const SCRIPT = fileURLToPath(new URL('../scripts/postinstall.mjs', import.meta.url))

describe('openclaw postinstall — config patch (pure)', () => {
  it('registers the plugin enabled, never with a path key', () => {
    const { config } = patchConfig({})
    expect(config.plugins.entries[PLUGIN_ID]).toEqual({ enabled: true })
  })

  it('heals a stale path key on our own entry (the corruption the user hit)', () => {
    const input = { plugins: { entries: { [PLUGIN_ID]: { enabled: true, path: '/old/ext/cb' } } } }
    const { config, healed } = patchConfig(input)
    expect('path' in config.plugins.entries[PLUGIN_ID]).toBe(false)
    expect(config.plugins.entries[PLUGIN_ID]).toEqual({ enabled: true })
    expect(healed).toContain(PLUGIN_ID)
  })

  it('repairs a rejected path key on OTHER plugin entries too', () => {
    const input = { plugins: { entries: { slack: { enabled: true, path: '/y' }, browser: { enabled: true } } } }
    const healed = stripRejectedPathKeys(input)
    expect(input.plugins.entries.slack).toEqual({ enabled: true })
    expect(healed).toEqual(['slack'])
  })

  it('preserves unrelated config — no data loss', () => {
    const input = {
      env: { ANTHROPIC_API_KEY: 'sk-keep' },
      gateway: { port: 18789 },
      plugins: { entries: { [PLUGIN_ID]: { enabled: true, path: '/z' }, brave: { enabled: true } } },
    }
    const { config } = patchConfig(input)
    expect(config.env.ANTHROPIC_API_KEY).toBe('sk-keep')
    expect(config.gateway.port).toBe(18789)
    expect(config.plugins.entries.brave).toEqual({ enabled: true })
  })
})

describe('openclaw postinstall — end to end', () => {
  function run(stateDir: string, configPath: string) {
    execFileSync('node', [SCRIPT], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_EXTENSIONS_DIR: path.join(stateDir, 'extensions'),
        OPENCLAW_PLUGIN_INSTALL: '', // falsy ⇒ run the patch (not the native-install skip)
      },
      stdio: 'ignore',
    })
  }

  it('running the script heals a corrupt config in place without data loss', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-postinstall-'))
    const configPath = path.join(stateDir, 'openclaw.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'sk-keep' },
        plugins: { entries: { [PLUGIN_ID]: { enabled: true, path: '/old/extensions/cb' } } },
      }),
    )
    try {
      run(stateDir, configPath)
      const out = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      expect(out.env.ANTHROPIC_API_KEY).toBe('sk-keep')
      expect(out.plugins.entries[PLUGIN_ID].enabled).toBe(true)
      expect('path' in out.plugins.entries[PLUGIN_ID]).toBe(false)
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('never overwrites a config that is present but unparseable', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-postinstall-'))
    const configPath = path.join(stateDir, 'openclaw.json')
    const garbage = '{ this is : not json,,, '
    fs.writeFileSync(configPath, garbage)
    try {
      run(stateDir, configPath)
      // Untouched (we refuse to clobber); a .bak exists alongside it.
      expect(fs.readFileSync(configPath, 'utf8')).toBe(garbage)
      expect(fs.existsSync(`${configPath}.bak`)).toBe(true)
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
