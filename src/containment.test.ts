import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Containment is the account-wide stop. The guard enforces it for any call that
// reaches the daemon; this file pins the half the plugin owns — the paths where
// the daemon is never consulted, which are exactly the paths a stop has to
// survive. Those are the same paths the decision chain treats as degraded, and
// observe mode, which lets everything through with only a log line.
//
// The record's path is resolved from HOME when the vendored bootstrap module
// loads, so HOME is redirected to a sandbox BEFORE the first dynamic import of
// the plugin. That also keeps the suite away from the developer's real record —
// running it against a live one would read genuine machine state.
const sandboxHome = mkdtempSync(join(tmpdir(), 'vaibot-openclaw-containment-'))
const realHome = process.env.HOME

function writeRecord(record: unknown | string) {
  const guardDir = join(sandboxHome, '.vaibot', 'guard')
  mkdirSync(guardDir, { recursive: true })
  // A string is written verbatim so a corrupt record can be seeded.
  writeFileSync(
    join(guardDir, 'containment.json'),
    typeof record === 'string' ? record : JSON.stringify(record),
  )
}

const baseCfg = {
  mode: 'enforce',
  guardBaseUrl: 'http://127.0.0.1:39111',
  mcpBaseUrl: 'https://api.vaibot.io/v2/mcp',
  mcpTokenEnv: 'VAIBOT_API_KEY',
  apiBaseUrl: 'https://api.vaibot.io',
  apiKeyEnv: 'VAIBOT_API_KEY',
  dashboardUrl: 'https://www.vaibot.io',
  autoBootstrap: false,
  credsDir: '/tmp/vaibot-containment-test-no-creds',
  agent: 'openclaw',
  timeoutMs: 1000,
  failClosedOnError: true,
  sendToolParams: true,
  maxParamChars: 1000,
  decisionChain: ['guard'],
  approvalAutoRetry: false,
  approvalPollMs: 60_000,
  breakerProbeIntervalMs: 0,
}

const baseEvent = { toolName: 'write', params: { path: '/tmp/a' }, runId: 'r1', toolCallId: 't1' }
const baseCtx = { sessionId: 's1', agentId: 'a1', workspaceDir: '/tmp', sessionKey: 'sk1' }

function makeApi(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, any> = {}
  const logs: { level: string; msg: string }[] = []
  return {
    pluginConfig: { ...baseCfg, ...overrides },
    runtime: {
      state: { resolveStateDir: () => '/tmp' },
      config: { writeConfigFile: () => {}, loadConfig: () => ({}) },
      system: { enqueueSystemEvent: () => {} },
    },
    logger: {
      info: (msg: string) => logs.push({ level: 'info', msg }),
      warn: (msg: string) => logs.push({ level: 'warn', msg }),
      error: (msg: string) => logs.push({ level: 'error', msg }),
    },
    on: (name: string, fn: any) => { handlers[name] = fn },
    registerCommand: () => {},
    __handlers: handlers,
    __logs: logs,
  }
}

// A fetch that fails the assertion if it is ever reached: containment must not
// need the daemon, the control plane, or anything on the network.
function forbidNetwork() {
  const original = globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error('containment must not make a network call')
  }) as any
  return () => { globalThis.fetch = original }
}

async function gate(cfgOverrides: Record<string, unknown> = {}) {
  const api = makeApi(cfgOverrides)
  const { createCircuitBreaker } = await import('./plugin.js')
  createCircuitBreaker(api as any).register()
  return { api, handler: (api as any).__handlers['before_tool_call'] }
}

describe('containment', () => {
  beforeAll(() => { process.env.HOME = sandboxHome })
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    try { rmSync(sandboxHome, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('blocks a tool call while engaged, without touching the network', async () => {
    writeRecord({ contained: true, reason: 'laptop looks compromised', at: new Date().toISOString() })
    const restore = forbidNetwork()
    try {
      const { handler } = await gate()
      const res = await handler(baseEvent, baseCtx)
      expect(res?.block).toBe(true)
      expect(res?.blockReason).toMatch(/containment engaged/i)
      expect(res?.blockReason).toMatch(/laptop looks compromised/)
    } finally {
      restore()
    }
  })

  it('observe mode does NOT lift it — nothing else survives observe', async () => {
    writeRecord({ contained: true, reason: null, at: new Date().toISOString() })
    const restore = forbidNetwork()
    try {
      const { handler } = await gate({ mode: 'observe' })
      const res = await handler(baseEvent, baseCtx)
      expect(res?.block).toBe(true)
    } finally {
      restore()
    }
  })

  it('an absent record means not engaged, so normal governance proceeds', async () => {
    try { rmSync(join(sandboxHome, '.vaibot', 'guard', 'containment.json'), { force: true }) } catch { /* fine */ }
    const { handler } = await gate()
    // Reaching the chain at all is the assertion: the containment branch did not
    // fire. The chain's own outcome is covered by plugin.test.ts.
    const res = await handler(baseEvent, baseCtx).catch(() => undefined)
    expect(res?.blockReason ?? '').not.toMatch(/containment engaged/i)
  })

  it('a corrupt record does not claim containment', async () => {
    // The plugin reads this on every tool call: it must never take the gate down,
    // and must never fail INTO a stop.
    writeRecord('{ not json')
    const { handler } = await gate()
    const res = await handler(baseEvent, baseCtx).catch(() => undefined)
    expect(res?.blockReason ?? '').not.toMatch(/containment engaged/i)
  })

  it('only a literal true engages it', async () => {
    for (const value of ['true', 1, {}, [], 'yes']) {
      writeRecord({ contained: value })
      const { handler } = await gate()
      const res = await handler(baseEvent, baseCtx).catch(() => undefined)
      expect(res?.blockReason ?? '').not.toMatch(/containment engaged/i)
    }
  })
})
