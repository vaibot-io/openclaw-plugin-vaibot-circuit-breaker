import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { __test, CircuitBreaker } from './plugin.js'

describe('helpers', () => {
  it('clampStr truncates long strings', () => {
    const out = __test.clampStr('a'.repeat(10), 5)
    expect(out).toBe('aaaaa…(truncated)')
  })

  it('clampStr leaves non-strings unchanged', () => {
    expect(__test.clampStr(123, 5)).toBe(123)
  })

  it('safeJson returns original for small objects', () => {
    const obj = { a: 1 }
    expect(__test.safeJson(obj, 100)).toEqual(obj)
  })

  it('safeJson truncates large json', () => {
    const obj = { a: 'x'.repeat(50) }
    const out = __test.safeJson(obj, 10) as any
    expect(out.truncated).toBe(true)
    expect(String(out.json)).toContain('…(truncated)')
  })

  it('safeJson handles circular structures', () => {
    const obj: any = { a: 1 }
    obj.self = obj
    const out = __test.safeJson(obj, 100)
    expect(out).toEqual({ unserializable: true })
  })

  it('stableStringify sorts keys', () => {
    const out = __test.stableStringify({ b: 2, a: 1 })
    expect(out).toBe('{"a":1,"b":2}')
  })

  it('sha256Hex is deterministic', async () => {
    const out = await __test.sha256Hex('test')
    expect(out).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
  })
})

describe('fetch wrappers', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('postJson returns parsed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ ok: true }),
      status: 200,
    }) as any

    const out = await __test.postJson<{ ok: boolean }>('http://x', { a: 1 }, 1000)
    expect(out.ok).toBe(true)
  })

  it('postJson handles invalid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => 'not-json',
      status: 500,
    }) as any

    const out = await __test.postJson<any>('http://x', { a: 1 }, 1000)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Invalid JSON')
  })

  it('getJson returns parsed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ ok: true }),
      status: 200,
    }) as any

    const out = await __test.getJson<{ ok: boolean }>('http://x', 1000)
    expect(out.ok).toBe(true)
  })

  it('withRetries retries failed attempts', async () => {
    let attempts = 0
    const out = await __test.withRetries(async () => {
      attempts += 1
      if (attempts < 2) throw new Error('nope')
      return 'ok'
    }, { retries: 2, baseDelayMs: 1, jitterMs: 0 })
    expect(out).toBe('ok')
    expect(attempts).toBe(2)
  })
})

describe('misc helpers', () => {
  it('toSessionId prefers sessionId', () => {
    expect(__test.toSessionId({ sessionId: 's1' } as any)).toBe('s1')
  })

  it('toSessionId falls back to sessionKey', () => {
    expect(__test.toSessionId({ sessionKey: 'k1' } as any)).toBe('k1')
  })

  it('toSessionId uses unknown-session fallback', () => {
    expect(__test.toSessionId({} as any)).toBe('unknown-session')
  })

  it('resolveConfig applies defaults', () => {
    const api = { pluginConfig: {} } as any
    const cfg = __test.resolveConfig(api)
    expect(cfg.mode).toBe('enforce')
    expect(cfg.guardBaseUrl).toContain('http://127.0.0.1:39111')
    expect(cfg.mcpBaseUrl).toContain('https://api.vaibot.io/v2/mcp')
    expect(cfg.apiBaseUrl).toContain('https://api.vaibot.io')
    expect(cfg.decisionChain).toEqual(['guard', 'mcp', 'api', 'breaker'])
  })

  it('normalizeDecisionChain maps skill alias and filters invalid entries', () => {
    const out = __test.normalizeDecisionChain(['skill', 'mcp', 'breaker', 'nope'])
    expect(out).toEqual(['guard', 'mcp', 'breaker'])
  })

  it('classifyError detects timeouts', () => {
    const err = new Error('timeout occurred')
    const out = __test.classifyError(err)
    expect(out.kind).toBe('timeout')
  })

  it('parseMcpDecisionText extracts decision and ids', () => {
    const text = [
      'VAIBot Governance Decision',
      'Decision:  APPROVAL_REQUIRED',
      'run_id:        run_123',
      'content_hash:  hash_abc',
    ].join('\n')
    const out = __test.parseMcpDecisionText(text)
    expect(out.decision?.decision).toBe('approve')
    expect(out.runId).toBe('run_123')
    expect(out.contentHash).toBe('hash_abc')
  })

  it('parseMcpDecisionText parses canonical JSON MCP output', () => {
    const text = JSON.stringify({
      ok: true,
      run_id: 'run_json_123',
      decision: { decision: 'approval_required', reason: 'Needs approval' },
      content_hash: 'sha256:jsonabc'
    })
    const out = __test.parseMcpDecisionText(text)
    expect(out.decision?.decision).toBe('approve')
    expect(out.decision?.reason).toBe('Needs approval')
    expect(out.runId).toBe('run_json_123')
    expect(out.contentHash).toBe('sha256:jsonabc')
  })

  it('parseMcpDecisionText falls back to legacy prose MCP output', () => {
    const text = [
      'VAIBot Governance Decision',
      'Decision:  DENY',
      'run_id:        run_legacy_123',
      'content_hash:  sha256:legacyabc',
    ].join('\n')
    const out = __test.parseMcpDecisionText(text)
    expect(out.decision?.decision).toBe('deny')
    expect(out.runId).toBe('run_legacy_123')
    expect(out.contentHash).toBe('sha256:legacyabc')
  })
})

describe('CircuitBreaker class', () => {
  const cfg = {
    mode: 'enforce',
    guardBaseUrl: 'http://127.0.0.1:39111',
    mcpBaseUrl: 'https://api.vaibot.io/v2/mcp',
    mcpTokenEnv: 'VAIBOT_API_KEY',
    apiBaseUrl: 'https://api.vaibot.io',
    apiKeyEnv: 'VAIBOT_API_KEY',
    timeoutMs: 1000,
    failClosedOnError: true,
    sendToolParams: true,
    maxParamChars: 1000,
    maxResultChars: 1000,
    decisionCacheTtlMs: 0,
    decisionChain: ['guard', 'mcp', 'api', 'breaker'],
    mcpMaxRetries: 1,
    mcpRetryBaseMs: 10,
    mcpRetryJitterMs: 5,
    breakerFailureThreshold: 2,
    breakerWindowMs: 1000,
    breakerCooldownMs: 1000,
    breakerAllowlist: ['read'],
    breakerDenylist: ['exec'],
    breakerTelemetryAllowlist: [],
    breakerProbeIntervalMs: 0,
    approvalAutoRetry: false,
    approvalPollMs: 1000,
    approvalReplayWindowMs: 1000,
  } as const

  it('trips after threshold failures', () => {
    const breaker = new CircuitBreaker(cfg as any)
    breaker.recordFailure()
    expect(breaker.isTripped()).toBe(false)
    breaker.recordFailure()
    expect(breaker.isTripped()).toBe(true)
  })

  it('cooldown clears trip state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const breaker = new CircuitBreaker(cfg as any)
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.isTripped()).toBe(true)

    vi.advanceTimersByTime(cfg.breakerCooldownMs + 1)
    expect(breaker.isTripped()).toBe(false)

    vi.useRealTimers()
  })

  it('recordSuccess clears failures and trip', () => {
    const breaker = new CircuitBreaker(cfg as any)
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.isTripped()).toBe(true)
    breaker.recordSuccess()
    expect(breaker.isTripped()).toBe(false)
    expect(breaker.snapshot().failures).toEqual([])
  })

  it('load restores persisted state', () => {
    const breaker = new CircuitBreaker(cfg as any)
    breaker.load({ failures: [Date.now()], trippedAt: Date.now(), lastError: 'test' })
    expect(breaker.isTripped()).toBe(true)
    expect(breaker.snapshot().lastError).toBe('test')
  })
})

describe('createCircuitBreaker integration', () => {
  const originalFetch = globalThis.fetch

  // NOTE: autoBootstrap explicitly false and credsDir pointed at a non-existent
  // path so tests don't trigger real /v2/bootstrap calls or pick up the
  // developer's real ~/.vaibot/credentials.json at module init.
  const baseCfg = {
    mode: 'enforce',
    guardBaseUrl: 'http://127.0.0.1:39111',
    mcpBaseUrl: 'https://api.vaibot.io/v2/mcp',
    mcpTokenEnv: 'VAIBOT_API_KEY',
    apiBaseUrl: 'https://api.vaibot.io',
    apiKeyEnv: 'VAIBOT_API_KEY',
    dashboardUrl: 'https://www.vaibot.io',
    autoBootstrap: false,
    credsDir: '/tmp/vaibot-cb-test-no-creds-xyz',
    agent: 'openclaw',
    timeoutMs: 1000,
    failClosedOnError: true,
    sendToolParams: true,
    maxParamChars: 1000,
    maxResultChars: 1000,
    decisionCacheTtlMs: 0,
    decisionChain: ['guard', 'mcp', 'api', 'breaker'],
    mcpMaxRetries: 0,
    mcpRetryBaseMs: 1,
    mcpRetryJitterMs: 0,
    breakerFailureThreshold: 3,
    breakerWindowMs: 60000,
    breakerCooldownMs: 60000,
    breakerAllowlist: ['read'],
    breakerDenylist: ['exec'],
    breakerTelemetryAllowlist: ['telemetry_log'],
    breakerProbeIntervalMs: 0,
    approvalAutoRetry: false,
    approvalPollMs: 60000,
    approvalReplayWindowMs: 60000,
  } as const

  const baseEvent = { toolName: 'write', params: { path: '/tmp/a' }, runId: 'r1', toolCallId: 't1' }
  const baseCtx = { sessionId: 's1', agentId: 'a1', workspaceDir: '/tmp', sessionKey: 'sk1' }

  function makeApi(overrides: any = {}) {
    const handlers: Record<string, any> = {}
    const logs: { level: string; msg: string }[] = []
    const systemEvents: any[] = []
    return {
      pluginConfig: { ...baseCfg, ...overrides },
      runtime: {
        state: { resolveStateDir: () => '/tmp' },
        config: {
          writeConfigFile: () => {},
          loadConfig: () => ({})
        },
        system: { enqueueSystemEvent: (...args: any[]) => { systemEvents.push(args) } }
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
      __systemEvents: systemEvents,
    }
  }

  function mockFetch(...responses: any[]) {
    const fn = vi.fn()
    for (const r of responses) {
      fn.mockResolvedValueOnce({
        text: async () => JSON.stringify(r),
        status: 200,
      })
    }
    globalThis.fetch = fn as any
    return fn
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.VAIBOT_API_KEY
    delete process.env.VAIBOT_GUARD_TOKEN
  })

  // ---- Decision chain fallthrough ----

  it('falls back to MCP when guard health fails', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: false }, // guard health
      { result: { content: [{ text: 'Decision: allow\nrun_id: run_1\ncontent_hash: hash_1' }] } }, // MCP
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses guard decision when healthy (no MCP call)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'allow' }, runId: 'g1' }, // guard decide
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler({ toolName: 'read', params: { path: '/tmp/a' }, runId: 'r2', toolCallId: 't2' }, baseCtx)
    expect(res).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('guard deny blocks tool', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'deny', reason: 'too risky' }, runId: 'g1' }, // guard deny
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toEqual({ block: true, blockReason: 'too risky' })
  })

  it('guard-published effective_mode=observe overrides cfg.mode=enforce (deny → observe-allow)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi() // cfg.mode is 'enforce' for this suite
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // The guard resolves the account to observe and PUBLISHES it. Even though the
    // local cfg.mode is 'enforce', the plugin must honor the guard's mode on the
    // guard path and NOT block the deny — this is the account-flips-to-observe
    // recovery path working end-to-end without touching the plugin config.
    mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'deny', reason: 'too risky' }, runId: 'g1', effective_mode: 'observe' },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toBeUndefined() // observe: logged, not blocked (guard mode wins over cfg.mode)
  })

  it('falls through to API when both guard and MCP fail', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: false }, // guard health fail
      {}, // MCP returns empty (missing decision → throws)
      { ok: true, run_id: 'api_1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h1' }, // API allow
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toBeUndefined() // allow
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // ---- Observe mode (runs chain, never blocks) ----

  it('observe mode runs the decision chain but never blocks on deny', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true, run_id: 'obs_deny_1', decision: { decision: 'deny', reason: 'too risky' }, content_hash: 'sha256:obs1' },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)

    // Never blocks in observe
    expect(res).toBeUndefined()
    // But did call the API — receipt + decide event were created
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/v2/governance/decide')

    // And logged the would-be enforcement
    expect((api as any).__logs.some((l: any) => /observe.*would deny/.test(l.msg))).toBe(true)
  })

  it('observe mode allows but logs approval_required', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true, run_id: 'obs_appr_1', decision: { decision: 'approval_required', reason: 'Needs review' }, content_hash: 'sha256:obs_appr' },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)

    expect(res).toBeUndefined()
    expect((api as any).__logs.some((l: any) => /observe.*would approve/.test(l.msg))).toBe(true)
  })

  it('observe mode bypasses the decision cache so every call is audited', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'], decisionCacheTtlMs: 60000 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true, run_id: 'obs_a1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
      { ok: true, run_id: 'obs_a2', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const event = { toolName: 'read', params: { path: '/tmp/same' }, runId: 'r1', toolCallId: 't1' }
    await handler(event, baseCtx)
    await handler({ ...event, toolCallId: 't2' }, baseCtx)

    expect(fetchMock).toHaveBeenCalledTimes(2) // no cache short-circuit
  })

  it('observe mode logs but does not block when breaker is tripped', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'], breakerFailureThreshold: 1 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Trip the breaker via an API failure
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    // Next call: breaker tripped — in observe, should allow
    const fetchMock2 = vi.fn()
    globalThis.fetch = fetchMock2 as any
    const res = await handler({ ...baseEvent, toolCallId: 't2' }, baseCtx)
    expect(res).toBeUndefined()
    expect(fetchMock2).not.toHaveBeenCalled()
    expect((api as any).__logs.some((l: any) => /observe.*breaker tripped/.test(l.msg))).toBe(true)
  })

  // ---- #2 shadow_decision preference ----

  // ---- The catastrophic floor (Tier-0) blocks in EVERY mode, observe included ----

  // The local classifier rates this catastrophic (verdictHint "deny"). The denylist
  // is emptied so these tests exercise the floor, not the denylist.
  const floorEvent = { toolName: 'exec', params: { command: 'rm -rf /' }, runId: 'r1', toolCallId: 'tf1' }

  it('observe: a guard deny marked floor:true still blocks', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ breakerDenylist: [] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'deny', reason: 'Classifier: matches destructive pattern', floor: true }, runId: 'g1', effective_mode: 'observe' },
    )

    const res = await (api as any).__handlers['before_tool_call'](floorEvent, baseCtx)
    expect(res).toEqual({ block: true, blockReason: 'Classifier: matches destructive pattern' })
    expect((api as any).__logs.some((l: any) => /observe.*catastrophic floor blocks exec/.test(l.msg))).toBe(true)
  })

  it('observe: a guard deny WITHOUT floor:true is still only logged', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ breakerDenylist: [] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true },
      { ok: true, decision: { decision: 'deny', reason: 'policy deny', floor: false }, runId: 'g1', effective_mode: 'observe' },
    )

    expect(await (api as any).__handlers['before_tool_call'](floorEvent, baseCtx)).toBeUndefined()
  })

  it('observe: an API deny of a catastrophic call blocks, and the run is finalized blocked', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'], breakerDenylist: [] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true, run_id: 'obs_floor_1', decision: { decision: 'deny', reason: 'dangerous' }, content_hash: 'sha256:f1' },
      { ok: true }, // finalize
    )

    const res = await (api as any).__handlers['before_tool_call'](floorEvent, baseCtx)
    expect(res).toEqual({ block: true, blockReason: 'dangerous' })
    const [finalizeUrl, finalizeInit] = fetchMock.mock.calls[1]
    expect(finalizeUrl).toContain('/v2/governance/finalize/obs_floor_1')
    expect(JSON.parse(finalizeInit.body).outcome).toBe('blocked')
  })

  it('observe: an MCP deny of a catastrophic call blocks', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['mcp'], breakerDenylist: [] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { result: { content: [{ text: 'Decision: deny\nrun_id: m1\ncontent_hash: hash_m1' }] } },
      { ok: true }, // finalize
    )

    const res = await (api as any).__handlers['before_tool_call'](floorEvent, baseCtx)
    expect(res).toMatchObject({ block: true })
    expect((api as any).__logs.some((l: any) => /observe.*mcp — catastrophic floor blocks exec/.test(l.msg))).toBe(true)
  })

  it('observe: chain exhausted on a catastrophic call blocks with the floor reason', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'], breakerDenylist: [], breakerFailureThreshold: 99 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const res = await (api as any).__handlers['before_tool_call'](floorEvent, baseCtx)
    expect(res).toMatchObject({ block: true })
    expect(res.blockReason).toMatch(/^VAIBot floor — exec blocked \(matches destructive pattern\)/)
  })

  it('observe: breaker tripped on a catastrophic call blocks, without calling out', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe', decisionChain: ['api'], breakerDenylist: [], breakerFailureThreshold: 1 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx) // trips the breaker

    const fetchMock2 = vi.fn()
    globalThis.fetch = fetchMock2 as any
    const res = await handler(floorEvent, baseCtx)
    expect(res).toMatchObject({ block: true })
    expect(res.blockReason).toMatch(/^VAIBot floor — exec blocked/)
    expect(fetchMock2).not.toHaveBeenCalled()
  })

  it('enforce: breaker tripped on a catastrophic call blocks outright, not held for approval', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'], breakerDenylist: [], breakerFailureThreshold: 1 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx) // trips the breaker

    const res = await handler(floorEvent, baseCtx)
    expect(res).toMatchObject({ block: true })
    expect(res.blockReason).toMatch(/^VAIBot floor — exec blocked/)
    expect(res.blockReason).not.toMatch(/approve/i)
  })

  it('API path prefers shadow_decision over decision (server-observe-coerced)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Server is in observe mode, so decision is coerced to allow; shadow is the raw verdict.
    mockFetch({
      ok: true,
      run_id: 'shadow_r1',
      decision: { decision: 'allow', reason: 'observe-coerced' },
      shadow_decision: { decision: 'deny', reason: 'policy says no' },
      content_hash: 'sha256:shadow',
    })

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)

    // Client enforces on the raw verdict, not the server-coerced allow.
    expect(res?.block).toBe(true)
    expect(res?.blockReason).toBe('policy says no')
  })

  it('API path honours server previously_approved short-circuit (decision wins over shadow)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Server says: shadow is still approval_required (policy didn't change), but
    // decision is allow because previously_approved kicked in.
    mockFetch({
      ok: true,
      run_id: 'prev_r1',
      previously_approved: true,
      decision: { decision: 'allow', reason: 'previously approved' },
      shadow_decision: { decision: 'approval_required', reason: 'needs review' },
      content_hash: 'sha256:prev',
    })

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)

    // Plugin should allow — previously_approved is the authoritative short-circuit.
    expect(res).toBeUndefined()
  })

  it('API decide payload includes agent_model from cfg.agent', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'], agent: 'openclaw' })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch({
      ok: true,
      run_id: 'r1',
      decision: { decision: 'allow', reason: 'ok' },
      content_hash: 'sha256:x',
    })

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.agent_model).toBe('openclaw')
  })

  it('MCP decide payload includes agent_model from cfg.agent', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['mcp'], agent: 'openclaw' })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch({
      result: { content: [{ text: JSON.stringify({
        ok: true, run_id: 'mcp_r1',
        decision: { decision: 'allow', reason: 'ok' },
        content_hash: 'sha256:x',
      })}] },
    })

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.params.arguments.agent_model).toBe('openclaw')
  })

  it('MCP parser prefers shadow_decision when both present', () => {
    const text = JSON.stringify({
      ok: true,
      run_id: 'mcp_shadow_1',
      decision: { decision: 'allow', reason: 'observe-coerced' },
      shadow_decision: { decision: 'approval_required', reason: 'needs review' },
      content_hash: 'sha256:mcpshadow',
    })
    const out = __test.parseMcpDecisionText(text)
    expect(out.decision?.decision).toBe('approve')
    expect(out.decision?.reason).toBe('needs review')
  })

  // ---- #3 approved_content_hash retry short-circuit ----

  it('sends approved_content_hash on retry after approval via /vaibot approve', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const registered: Array<{ name: string; handler: (ctx: any) => any }> = []
    const baseApi = makeApi({ decisionChain: ['api'] })
    ;(baseApi as any).registerCommand = (cmd: any) => { registered.push({ name: cmd.name, handler: cmd.handler }) }

    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(baseApi as any).register()

    const fetchMock = mockFetch(
      // First decide → approval_required
      { ok: true, run_id: 'api_r1', decision: { decision: 'approval_required', reason: 'Needs review' }, content_hash: 'sha256:approved_h1' },
      // Synthetic finalize (blocked_until_approved) fired from the approve branch
      { ok: true },
      // /vaibot approve API call
      { ok: true },
      // Second decide (after approval) → server honors approved_content_hash → allow
      { ok: true, run_id: 'api_r2', decision: { decision: 'allow', reason: 'previously approved' }, shadow_decision: { decision: 'approval_required', reason: 'Needs review' }, content_hash: 'sha256:approved_h1', previously_approved: true },
    )

    const handler = (baseApi as any).__handlers['before_tool_call']
    const event = { toolName: 'write', params: { path: '/tmp/foo' }, runId: 'r1', toolCallId: 't1' }

    // 1) first call blocks on approval_required
    const res1 = await handler(event, baseCtx)
    expect(res1?.block).toBe(true)

    // 2) trigger /vaibot approve — populates replayByIntentHash via enqueueAutoRetry
    const vaibotCmd = registered.find((c) => c.name === 'vaibot')!
    await vaibotCmd.handler({ args: 'approve sha256:approved_h1' })

    // 3) second call for same intent must now include approved_content_hash
    const res2 = await handler({ ...event, toolCallId: 't2' }, baseCtx)
    expect(res2).toBeUndefined() // allowed

    // Inspect the 4th fetch (second decide) body — 2nd is the synthetic block finalize
    const decideRetry = fetchMock.mock.calls[3]
    const body = JSON.parse(decideRetry[1].body)
    expect(body.approved_content_hash).toBe('sha256:approved_h1')
  })

  it('MCP decide payload carries approved_content_hash when replay is pending', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const registered: Array<{ name: string; handler: (ctx: any) => any }> = []
    const baseApi = makeApi({ decisionChain: ['mcp'] })
    ;(baseApi as any).registerCommand = (cmd: any) => { registered.push({ name: cmd.name, handler: cmd.handler }) }

    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(baseApi as any).register()

    const fetchMock = mockFetch(
      // First MCP decide → approval_required
      { result: { content: [{ text: JSON.stringify({
        ok: true, run_id: 'mcp_r1',
        decision: { decision: 'approval_required', reason: 'Needs review' },
        content_hash: 'sha256:mcp_approved_h1',
      })}] } },
      // Synthetic finalize (blocked_until_approved) fired from the approve branch
      { ok: true },
      // /vaibot approve API call
      { ok: true },
      // Second MCP decide → allow (server honored approved_content_hash)
      { result: { content: [{ text: JSON.stringify({
        ok: true, run_id: 'mcp_r2',
        decision: { decision: 'allow', reason: 'previously approved' },
        content_hash: 'sha256:mcp_approved_h1',
      })}] } },
    )

    const handler = (baseApi as any).__handlers['before_tool_call']
    const event = { toolName: 'write', params: { path: '/tmp/bar' }, runId: 'r1', toolCallId: 't1' }

    await handler(event, baseCtx)

    const vaibotCmd = registered.find((c) => c.name === 'vaibot')!
    await vaibotCmd.handler({ args: 'approve sha256:mcp_approved_h1' })

    const res2 = await handler({ ...event, toolCallId: 't2' }, baseCtx)
    expect(res2).toBeUndefined()

    // Inspect 4th fetch (second MCP decide) — approved_content_hash is in args
    const decideRetry = fetchMock.mock.calls[3]
    const body = JSON.parse(decideRetry[1].body)
    expect(body.params.arguments.approved_content_hash).toBe('sha256:mcp_approved_h1')
  })

  // ---- Breaker fail-closed (Bug #2) ----

  it('when tripped, classifier-safe tools pass but ambiguous tools are held (fail-closed)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ breakerFailureThreshold: 1 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Trip the breaker: guard health fail, MCP fail, API fail → all fail, breaker trips
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchMock as any

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx) // first call trips breaker via chain failures

    // Reset mock — the tripped path decides LOCALLY via the classifier (no fetch).
    const fetchMock2 = vi.fn()
    globalThis.fetch = fetchMock2 as any

    // classifier-safe tool (read) passes through.
    const safe = await handler({ toolName: 'read', params: { file_path: 'x.ts' }, runId: 'r2', toolCallId: 't2' }, baseCtx)
    expect(safe).toBeUndefined()

    // ambiguous/unknown tool is held for approval (fail-closed).
    const held = await handler({ toolName: 'frobnicate_widget', params: {}, runId: 'r3', toolCallId: 't3' }, baseCtx)
    expect(held).toEqual({
      block: true,
      blockReason: expect.stringContaining('Circuit breaker active'),
    })

    // No upstream fetches — the tripped breaker decides locally.
    expect(fetchMock2).not.toHaveBeenCalled()
  })

  // ---- Guard approval flow (Bug #4, #15) ----

  it('guard approve extracts approvalId/expiresAt/scope from decision (the real guard shape)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true }, // guard health
      { // guard decide: approval_required
        ok: true,
        // The real guard shape: approvalId/expiresAt/scope live INSIDE decision.
        decision: {
          decision: 'approve', reason: 'Needs human review',
          approvalId: 'appr_123', expiresAt: '2026-12-31T00:00:00Z', scope: { paramsHash: 'sha256:abc' },
        },
        runId: 'guard_run_1',
      },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(res.blockReason).toContain('approvalId=appr_123')
    expect(res.blockReason).toContain('expiresAt=2026-12-31T00:00:00Z')
    expect(res.blockReason).toContain('/guard approve appr_123')
  })

  // A real guard returns the approval INSIDE decision. Reading it from the top
  // level found nothing, so a retry never presented the approval and the guard
  // escalated again under a new id. The retry must carry the approval it got.
  it('guard approval: a retry of the same call presents the approvalId it was blocked with', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // The scope a real guard computes for this call: sha256 over the stable JSON
    // of { toolName, params } — the same hash the plugin derives on the retry.
    const { createHash } = await import('node:crypto')
    const paramsHash = `sha256:${createHash('sha256').update('{"params":{"path":"/tmp/a"},"toolName":"write"}').digest('hex')}`
    const escalate = {
      ok: true,
      runId: 'guard_run_esc',
      decision: {
        decision: 'approve', reason: 'Needs human review',
        approvalId: 'appr_live', expiresAt: '2026-12-31T00:00:00Z', scope: { paramsHash },
      },
    }
    const allow = { ok: true, runId: 'guard_run_retry', decision: { decision: 'allow', reason: 'Approved by user' } }
    // Health is answered with { ok: true } wherever the plugin asks for it.
    const fetchMock = mockFetch({ ok: true }, escalate, { ok: true }, allow, { ok: true }, { ok: true })

    const handler = (api as any).__handlers['before_tool_call']
    const first = await handler(baseEvent, baseCtx)
    expect(first.block).toBe(true)
    expect(first.blockReason).toContain('approvalId=appr_live')

    await handler({ ...baseEvent, toolCallId: 't2' }, baseCtx)
    const decides = fetchMock.mock.calls.filter(([url]: any[]) => String(url).endsWith('/v1/decide/tool'))
    expect(decides.length).toBe(2)
    expect(JSON.parse(decides[0][1].body).approval).toBeUndefined()
    expect(JSON.parse(decides[1][1].body).approval).toEqual({ approvalId: 'appr_live' })
  })

  // The guard's scope hash covers the params as SENT (truncated past maxParamChars,
  // undefined keys dropped, {} with sendToolParams off), so it can differ from the
  // plugin's hash of the full call. The retry must still present the approval, and
  // only for the identical call.
  async function heldThenRetried(overrides: any, firstEvent: any, retryEvent: any) {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi(overrides)
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()
    const escalate = {
      ok: true,
      runId: 'guard_run_esc',
      decision: {
        decision: 'approve', reason: 'Needs human review',
        approvalId: 'appr_scope', expiresAt: '2099-01-01T00:00:00Z', scope: { paramsHash: 'sha256:as-the-guard-saw-it' },
      },
    }
    const allow = { ok: true, runId: 'guard_run_retry', decision: { decision: 'allow', reason: 'Approved by user' } }
    const fetchMock = mockFetch({ ok: true }, escalate, { ok: true }, allow, { ok: true }, { ok: true })
    const handler = (api as any).__handlers['before_tool_call']
    expect((await handler(firstEvent, baseCtx)).block).toBe(true)
    await handler(retryEvent, baseCtx)
    const decides = fetchMock.mock.calls.filter(([url]: any[]) => String(url).endsWith('/v1/decide/tool'))
    return JSON.parse(decides[1][1].body).approval
  }

  it('guard approval: a retry presents it when the params carry an undefined key', async () => {
    const ev = { toolName: 'write', params: { path: '/tmp/a', mode: undefined }, runId: 'r1', toolCallId: 't1' }
    expect(await heldThenRetried({}, ev, { ...ev, toolCallId: 't2' })).toEqual({ approvalId: 'appr_scope' })
  })

  it('guard approval: a retry presents it when the params were truncated for the guard', async () => {
    const ev = { toolName: 'write', params: { path: '/tmp/a', content: 'x'.repeat(5000) }, runId: 'r1', toolCallId: 't1' }
    expect(await heldThenRetried({}, ev, { ...ev, toolCallId: 't2' })).toEqual({ approvalId: 'appr_scope' })
  })

  it('guard approval: a retry presents it when tool params are not sent to the guard', async () => {
    const ev = { toolName: 'write', params: { path: '/tmp/a' }, runId: 'r1', toolCallId: 't1' }
    expect(await heldThenRetried({ sendToolParams: false }, ev, { ...ev, toolCallId: 't2' })).toEqual({ approvalId: 'appr_scope' })
  })

  it('guard approval: a DIFFERENT call that the guard would see identically does not present it', async () => {
    const ev = { toolName: 'write', params: { path: '/tmp/a', content: 'x'.repeat(5000) }, runId: 'r1', toolCallId: 't1' }
    const other = { ...ev, toolCallId: 't2', params: { path: '/tmp/a', content: 'x'.repeat(4999) + 'y' } }
    expect(await heldThenRetried({}, ev, other)).toBeUndefined()
  })

  // ---- Approval poller: what an approval that left the pending list resolved to ----
  // /v1/approvals/list is PENDING only, so "missing" may mean approved OR denied /
  // used / expired. Reading it as approved auto-retried refusals. With the guard's
  // approval-status capability the poller asks, and only `approved` is retried.

  function routedGuard({ capabilities = ['approval-status'], status = 'approved', statusFails = false, omit = false, expiresAt = '2099-01-01T00:00:00Z' }: any = {}) {
    const calls: string[] = []
    const fn = vi.fn(async (url: any, init: any) => {
      const u = String(url)
      calls.push(u)
      const reply = (body: any) => ({ status: 200, text: async () => JSON.stringify(body) })
      if (u.endsWith('/health')) return reply({ ok: true, capabilities })
      if (u.endsWith('/v1/decide/tool')) {
        return reply({ ok: true, runId: 'run_poll', decision: { decision: 'approve', reason: 'Needs human review', approvalId: 'appr_poll', expiresAt, scope: { paramsHash: 'sha256:x' } } })
      }
      if (u.endsWith('/v1/approvals/list')) return reply({ ok: true, approvals: [] }) // it left the pending list
      if (u.endsWith('/v1/approvals/status')) {
        if (statusFails) throw new Error('guard unreachable')
        const ids = JSON.parse(init.body).approvalIds
        return reply({ ok: true, approvals: omit ? [] : ids.map((approvalId: string) => ({ approvalId, status })) })
      }
      return reply({ ok: true, receipts: [] })
    })
    globalThis.fetch = fn as any
    return { fn, calls }
  }

  async function blockThenPoll(api: any) {
    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    await vi.advanceTimersByTimeAsync(1001)
  }

  it('poller: an approval the guard reports approved is auto-retried', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ status: 'approved' })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(g.calls.some((u) => u.endsWith('/v1/approvals/status'))).toBe(true)
      expect((api as any).__systemEvents.length).toBe(1)
      expect(String((api as any).__systemEvents[0][0])).toContain('retrying blocked action')
    } finally { vi.useRealTimers() }
  })

  it('poller: a DENIED approval is not auto-retried', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      routedGuard({ status: 'denied' })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect((api as any).__systemEvents.length).toBe(0)
      expect((api as any).__logs.some((l: any) => /resolved denied — not retrying/.test(l.msg))).toBe(true)
      // and it is settled: a later poll does not retry it either
      await vi.advanceTimersByTimeAsync(1001)
      expect((api as any).__systemEvents.length).toBe(0)
    } finally { vi.useRealTimers() }
  })

  // ---- Guard runs of blocked calls are settled (the gateway fires no after_tool_call) ----

  const guardFinalizes = (fn: any) =>
    fn.mock.calls
      .filter(([u]: any) => String(u).endsWith('/v1/finalize/tool'))
      .map(([, init]: any) => JSON.parse(init.body))

  it('a guard deny finalizes its run as blocked, with no approval answer', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'deny', reason: 'policy deny' }, runId: 'g_deny' },
      { ok: true }, // finalize
    )

    const res = await (api as any).__handlers['before_tool_call'](baseEvent, baseCtx)
    expect(res).toEqual({ block: true, blockReason: 'policy deny' })
    const [fin] = guardFinalizes(fetchMock)
    expect(fin.runId).toBe('g_deny')
    expect(fin.result).toMatchObject({ ok: false, outcome: 'blocked' })
    expect(fin.result.approval).toBeUndefined()
  })

  it('a guard approval hold is not finalized at decide time', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const g = routedGuard()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const res = await (api as any).__handlers['before_tool_call'](baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(guardFinalizes(g.fn)).toEqual([])
  })

  it('poller: a DENIED guard approval settles the original run as a person\'s denial', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ status: 'denied' })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(guardFinalizes(g.fn)).toEqual([expect.objectContaining({ runId: 'run_poll', result: { ok: false, approval: 'denied' } })])
      await vi.advanceTimersByTimeAsync(1001)
      expect(guardFinalizes(g.fn).length).toBe(1) // settled once
    } finally { vi.useRealTimers() }
  })

  it('poller: an EXPIRED guard approval settles the run as expired on a guard that understands it', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ status: 'expired', capabilities: ['approval-status', 'approval-resolutions'] })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(guardFinalizes(g.fn)).toEqual([expect.objectContaining({ runId: 'run_poll', result: { ok: false, approval: 'expired' } })])
    } finally { vi.useRealTimers() }
  })

  it('poller: an EXPIRED approval is left open on a guard without approval-resolutions', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ status: 'expired' })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(guardFinalizes(g.fn)).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('poller: an APPROVED guard approval does not finalize the original run (the replay redeems it)', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ status: 'approved', capabilities: ['approval-status', 'approval-resolutions'] })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(guardFinalizes(g.fn)).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('poller: a guard approval that lapses locally settles the run as expired', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ expiresAt: new Date(Date.now() + 500).toISOString(), capabilities: ['approval-status', 'approval-resolutions'] })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(guardFinalizes(g.fn)).toEqual([expect.objectContaining({ runId: 'run_poll', result: { ok: false, approval: 'expired' } })])
      expect((api as any).__systemEvents.length).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('/guard deny settles the held call\'s run as a person\'s denial', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const registered: Array<{ name: string; handler: (ctx: any) => any }> = []
    const api = makeApi()
    ;(api as any).registerCommand = (cmd: any) => { registered.push({ name: cmd.name, handler: cmd.handler }) }
    const g = routedGuard()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    await (api as any).__handlers['before_tool_call'](baseEvent, baseCtx)
    const out = await registered.find((c) => c.name === 'guard')!.handler({ args: 'deny appr_poll' })
    expect(out.text).toBe('Denied appr_poll.')
    expect(guardFinalizes(g.fn)).toEqual([expect.objectContaining({ runId: 'run_poll', result: { ok: false, approval: 'denied' } })])
  })

  it('poller: an older guard without approval-status keeps the previous retry behaviour', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      const g = routedGuard({ capabilities: [] })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect(g.calls.some((u) => u.endsWith('/v1/approvals/status'))).toBe(false)
      expect((api as any).__systemEvents.length).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('poller: an id the status reply leaves out stays pending and is asked about again', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      routedGuard({ omit: true })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect((api as any).__systemEvents.length).toBe(0)
      routedGuard({ status: 'approved' })
      await vi.advanceTimersByTimeAsync(1001)
      expect((api as any).__systemEvents.length).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('poller: if the status call fails, the approval stays pending and is retried once known', async () => {
    vi.useFakeTimers()
    try {
      process.env.VAIBOT_API_KEY = 'test-token'
      const api = makeApi({ approvalAutoRetry: true, approvalPollMs: 1000 })
      routedGuard({ statusFails: true })
      const { createCircuitBreaker } = await import('./plugin.js')
      createCircuitBreaker(api as any).register()
      await blockThenPoll(api)
      expect((api as any).__systemEvents.length).toBe(0)
      routedGuard({ status: 'approved' })
      await vi.advanceTimersByTimeAsync(1001)
      expect((api as any).__systemEvents.length).toBe(1)
    } finally { vi.useRealTimers() }
  })

  // ---- MCP approval flow ----

  it('MCP approve blocks with content_hash', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['mcp'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { result: { content: [{ text: JSON.stringify({
        ok: true, run_id: 'mcp_run_1',
        decision: { decision: 'approval_required', reason: 'Needs approval' },
        content_hash: 'sha256:mcp_hash_1'
      })}] } },
      { ok: true }, // synthetic finalize (blocked_until_approved)
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(res.blockReason).toContain('content_hash=sha256:mcp_hash_1')
  })

  // ---- API decision paths ----

  it('API deny blocks with reason', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true, run_id: 'api_1', decision: { decision: 'deny', reason: 'Policy violation' }, content_hash: 'h1' },
      { ok: true }, // synthetic finalize (blocked)
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toEqual({ block: true, blockReason: 'Policy violation' })
  })

  it('API approval_required blocks and enqueues pending', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true, run_id: 'api_2', decision: { decision: 'approval_required', reason: 'Needs review' }, content_hash: 'sha256:api_hash' },
      { ok: true }, // synthetic finalize (blocked_until_approved)
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(res.blockReason).toContain('content_hash=sha256:api_hash')
  })

  // ---- blocked_until_approved finalize polish ----

  it('API approval_required posts synthetic finalize with blocked_until_approved', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true, run_id: 'api_r1', decision: { decision: 'approval_required', reason: 'Needs review' }, content_hash: 'sha256:h' },
      { ok: true }, // synthetic finalize
    )

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const finalizeCall = fetchMock.mock.calls[1]
    expect(finalizeCall[0]).toBe('https://api.vaibot.io/v2/governance/finalize/api_r1')
    const body = JSON.parse(finalizeCall[1].body)
    expect(body.outcome).toBe('blocked_until_approved')
    expect(body.result.error).toContain('approval_required')
    expect(body.result.error).toContain('Needs review')
  })

  it('API deny posts synthetic finalize with blocked', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true, run_id: 'api_r2', decision: { decision: 'deny', reason: 'policy violation' }, content_hash: 'sha256:h' },
      { ok: true }, // synthetic finalize
    )

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const finalizeCall = fetchMock.mock.calls[1]
    expect(finalizeCall[0]).toBe('https://api.vaibot.io/v2/governance/finalize/api_r2')
    const body = JSON.parse(finalizeCall[1].body)
    expect(body.outcome).toBe('blocked')
    expect(body.result.error).toContain('deny')
    expect(body.result.error).toContain('policy violation')
  })

  it('MCP approval_required posts synthetic finalize with blocked_until_approved', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['mcp'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { result: { content: [{ text: JSON.stringify({
        ok: true, run_id: 'mcp_r1',
        decision: { decision: 'approval_required', reason: 'Needs review' },
        content_hash: 'sha256:h',
      })}] } },
      { ok: true }, // synthetic finalize
    )

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const finalizeCall = fetchMock.mock.calls[1]
    expect(finalizeCall[0]).toBe('https://api.vaibot.io/v2/governance/finalize/mcp_r1')
    const body = JSON.parse(finalizeCall[1].body)
    expect(body.outcome).toBe('blocked_until_approved')
  })

  it('block finalize is skipped when decide returns no run_id', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['api'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true, decision: { decision: 'deny', reason: 'no run id' } },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1) // decide only, no finalize
  })

  // ---- Decision cache ----

  it('caches allow decisions and skips upstream on second call', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionCacheTtlMs: 60000, decisionChain: ['guard'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'allow' }, runId: 'g1' }, // guard decide
    )

    const handler = (api as any).__handlers['before_tool_call']
    const event = { toolName: 'read', params: { path: '/tmp/same' }, runId: 'r1', toolCallId: 't1' }
    await handler(event, baseCtx)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Second call with same tool+params should hit cache
    const res2 = await handler({ ...event, toolCallId: 't2' }, baseCtx)
    expect(res2).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2) // no new fetches
  })

  // ---- Finalize (afterToolCall) ----

  it('finalizes to guard after allow', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['guard'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'allow' }, runId: 'guard_run_fin' }, // guard decide
    )

    const beforeHandler = (api as any).__handlers['before_tool_call']
    const afterHandler = (api as any).__handlers['after_tool_call']
    const event = { toolName: 'read', params: { path: '/tmp/a' }, runId: 'r1', toolCallId: 't1' }
    await beforeHandler(event, baseCtx)

    // Now finalize
    mockFetch({ ok: true }) // guard finalize response
    const afterEvent = { ...event, result: { ok: true }, error: undefined, durationMs: 100 }
    await afterHandler(afterEvent, baseCtx)

    // fetch was called for finalize
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toContain('/v1/finalize/tool')
  })

  it('finalizes to API after MCP allow', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['mcp'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { result: { content: [{ text: JSON.stringify({
        ok: true, run_id: 'mcp_run_fin',
        decision: { decision: 'allow', reason: 'ok' },
        content_hash: 'sha256:fin_hash'
      })}] } },
    )

    const beforeHandler = (api as any).__handlers['before_tool_call']
    const afterHandler = (api as any).__handlers['after_tool_call']
    const event = { toolName: 'write', params: { path: '/tmp/b' }, runId: 'r1', toolCallId: 't1' }
    await beforeHandler(event, baseCtx)

    // Finalize
    mockFetch({ ok: true }) // api finalize response
    const afterEvent = { ...event, result: { ok: true }, error: undefined, durationMs: 50 }
    await afterHandler(afterEvent, baseCtx)

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toContain('/v2/governance/finalize/mcp_run_fin')
  })

  it('skips finalize when no runId was tracked (logs warning)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ decisionChain: ['guard'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // afterToolCall with no matching beforeToolCall
    const afterHandler = (api as any).__handlers['after_tool_call']
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any

    await afterHandler(
      { toolName: 'read', params: {}, runId: 'r_no_before', toolCallId: 't_no_before', result: {}, durationMs: 10 },
      baseCtx
    )
    // No fetch calls — no activeRun found
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ---- failClosedOnError is LOCKED fail-closed (the false escape hatch is removed) ----

  it('chain exhaustion degrades to the local classifier — safe passes, risky held', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({
      decisionChain: ['guard'],
      breakerFailureThreshold: 100, // high so the breaker never trips
    })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Guard unreachable → chain exhausted with no server-backed decision.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any

    const handler = (api as any).__handlers['before_tool_call']
    // Safe tool (write /tmp) passes locally — the agent is NOT bricked.
    expect(await handler(baseEvent, baseCtx)).toBeUndefined()
    // Risky/unknown tool is held for local approval — the floor still governs.
    const risky = await handler({ toolName: 'frobnicate_widget', params: {}, runId: 'r9', toolCallId: 't9' }, baseCtx)
    expect(risky).toMatchObject({ block: true })
  })

  it('chain exhaustion holds a risky tool for local approval (floor)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({
      failClosedOnError: true,
      decisionChain: ['guard'],
      breakerFailureThreshold: 100,
    })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler({ toolName: 'frobnicate_widget', params: {}, runId: 'rx', toolCallId: 'tx' }, baseCtx)
    expect(res).toMatchObject({ block: true })
    expect(res.blockReason).toContain('needs approval')
  })

  // ---- MCP missing token: keyless degrade to the local classifier ----

  it('MCP source without a token degrades to the local classifier (keyless)', async () => {
    // Deliberately no VAIBOT_API_KEY → mcp has no token → chain exhausts → local floor.
    const api = makeApi({ decisionChain: ['mcp'], breakerFailureThreshold: 100 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any

    const handler = (api as any).__handlers['before_tool_call']
    // Safe tool passes locally (no brick); risky is held.
    expect(await handler(baseEvent, baseCtx)).toBeUndefined()
    const risky = await handler({ toolName: 'frobnicate_widget', params: {}, runId: 'rm', toolCallId: 'tm' }, baseCtx)
    expect(risky?.block).toBe(true)
  })

  // ---- Guard sends auth header ----

  it('includes VAIBOT_GUARD_TOKEN as authorization header', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    process.env.VAIBOT_GUARD_TOKEN = 'guard-secret'
    // Explicit guardBaseUrl = connect-only override: use the env token and skip
    // the rendezvous lock (otherwise a live guard's lock token wins, by design).
    const api = makeApi({ decisionChain: ['guard'], guardBaseUrl: 'http://127.0.0.1:39111' })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch(
      { ok: true }, // guard health
      { ok: true, decision: { decision: 'allow' }, runId: 'g1' },
    )

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    // Check that health check included auth header
    const healthCall = fetchMock.mock.calls[0]
    expect(healthCall[1]?.headers?.authorization).toBe('Bearer guard-secret')
  })
})

describe('auto-bootstrap and claim nudge', () => {
  const originalFetch = globalThis.fetch
  let testCredsDir: string

  // Chain is ['api'] only so bootstrap/nudge/decide are the *only* fetches
  // — no guard-health noise to sequence around.
  const baseCfg = {
    mode: 'enforce',
    guardBaseUrl: 'http://127.0.0.1:39111',
    mcpBaseUrl: 'https://api.vaibot.io/v2/mcp',
    mcpTokenEnv: 'VAIBOT_API_KEY',
    apiBaseUrl: 'https://api.vaibot.io',
    apiKeyEnv: 'VAIBOT_API_KEY',
    dashboardUrl: 'https://www.vaibot.io',
    autoBootstrap: true,
    agent: 'openclaw',
    timeoutMs: 1000,
    failClosedOnError: true,
    sendToolParams: true,
    maxParamChars: 1000,
    maxResultChars: 1000,
    decisionCacheTtlMs: 0,
    decisionChain: ['api'],
    mcpMaxRetries: 0,
    mcpRetryBaseMs: 1,
    mcpRetryJitterMs: 0,
    breakerFailureThreshold: 100,
    breakerWindowMs: 60000,
    breakerCooldownMs: 60000,
    breakerAllowlist: [],
    breakerDenylist: [],
    breakerTelemetryAllowlist: [],
    breakerProbeIntervalMs: 0,
    approvalAutoRetry: false,
    approvalPollMs: 60000,
    approvalReplayWindowMs: 60000,
  } as const

  const baseEvent = { toolName: 'write', params: { path: '/tmp/boot-a' }, runId: 'r1', toolCallId: 't1' }
  const baseCtx = { sessionId: 's-boot-1', agentId: 'a1', workspaceDir: '/tmp', sessionKey: 'sk1' }

  function makeApi(overrides: any = {}) {
    const handlers: Record<string, any> = {}
    const logs: { level: string; msg: string }[] = []
    return {
      pluginConfig: { ...baseCfg, credsDir: testCredsDir, ...overrides },
      runtime: {
        state: { resolveStateDir: () => '/tmp' },
        config: {
          writeConfigFile: () => {},
          loadConfig: () => ({})
        },
        system: { enqueueSystemEvent: () => {} }
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

  function mockFetch(...responses: any[]) {
    const fn = vi.fn()
    for (const r of responses) {
      fn.mockResolvedValueOnce({
        text: async () => JSON.stringify(r),
        status: 200,
      })
    }
    globalThis.fetch = fn as any
    return fn
  }

  beforeEach(() => {
    testCredsDir = `/tmp/vaibot-cb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.VAIBOT_API_KEY
    try { fs.rmSync(testCredsDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('bootstraps when no API key is resolvable and autoBootstrap is true', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    const fetchMock = mockFetch(
      { api_key: 'boot_k1', account_id: 'acct_1', user_id: 'user_1', wallet_address: '0xabc', wallet_network: 'base-sepolia' },
      { claimed: false }, // nudge
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)

    expect(res).toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.vaibot.io/v2/bootstrap')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.agent).toBe('openclaw')
    expect(typeof body.fingerprint).toBe('string')
    expect(body.fingerprint).toHaveLength(64) // sha256 hex
  })

  it('skips bootstrap when VAIBOT_API_KEY env is set', async () => {
    process.env.VAIBOT_API_KEY = 'env-key-1'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    const fetchMock = mockFetch(
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    // Only decide — no /v2/bootstrap, no /v2/accounts/me
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/v2/governance/decide')
  })

  it('skips bootstrap when saved credentials already exist', async () => {
    fs.mkdirSync(testCredsDir, { recursive: true })
    fs.writeFileSync(
      path.join(testCredsDir, 'credentials.json'),
      JSON.stringify({ api_key: 'saved_k1', account_id: 'saved_acct' }),
    )

    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    const fetchMock = mockFetch(
      { claimed: true }, // nudge (uses saved key)
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const urls = fetchMock.mock.calls.map((c: any[]) => c[0])
    expect(urls.some((u: string) => u.includes('/v2/bootstrap'))).toBe(false)
    expect(urls[0]).toContain('/v2/accounts/me')
    expect(urls[1]).toContain('/v2/governance/decide')

    // Decide must use the saved key
    const decideCall = fetchMock.mock.calls[1]
    expect(decideCall[1].headers.authorization).toBe('Bearer saved_k1')
  })

  it('logs a warning and continues when bootstrap network call fails', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchMock as any

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)

    // No key → bootstrap warns → chain exhausts → LOCAL classifier governs (not bricked);
    // baseEvent is a safe write, so it passes locally.
    expect(res).toBeUndefined()
    expect((api as any).__logs.some((l: any) => l.level === 'warn' && /bootstrap failed/.test(l.msg))).toBe(true)
  })

  it('warns when bootstrap response has bootstrapped:false without api_key', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    mockFetch({ bootstrapped: false })

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    expect((api as any).__logs.some((l: any) =>
      l.level === 'warn' &&
      /no api_key found locally/.test(l.msg) &&
      /vaibot login/.test(l.msg) &&      // recovery path 1
      /checking .*credentials\.json/.test(l.msg) // recovery path 2 (manual)
    )).toBe(true)
  })

  it('saves bootstrapped credentials to credsDir/credentials.json', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    mockFetch(
      { api_key: 'boot_k2', account_id: 'acct_2', user_id: 'u2', wallet_address: '0xdef', wallet_network: 'base-sepolia' },
      { claimed: true },
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    // Awaiting the handler guarantees the bootstrap promise has resolved.
    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const credsPath = path.join(testCredsDir, 'credentials.json')
    expect(fs.existsSync(credsPath)).toBe(true)
    const saved = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
    // v3 env-namespaced slim store: prod (default apiBaseUrl) slot holds only
    // api_key + wallet_address; account_id/user_id/api_url/etc. are not stored.
    expect(saved.version).toBe(3)
    expect(saved.active_env).toBe('production')
    expect(saved.environments.production.api_key).toBe('boot_k2')
    expect(saved.environments.production.wallet_address).toBe('0xdef')
    expect(saved.environments.production.account_id).toBeUndefined()
    expect(saved.environments.production.api_url).toBeUndefined()
  })

  it('uses bootstrapped api_key for subsequent decide calls', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    const fetchMock = mockFetch(
      { api_key: 'boot_k3' },
      { claimed: true },
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    // 3rd call is the decide — should carry the bootstrapped key
    const decideCall = fetchMock.mock.calls[2]
    expect(decideCall[0]).toContain('/v2/governance/decide')
    expect(decideCall[1].headers.authorization).toBe('Bearer boot_k3')
  })

  it('emits claim nudge once per session when claimed:false', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    const fetchMock = mockFetch(
      { api_key: 'boot_k4' },
      { claimed: false },
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
      { ok: true, run_id: 'r2', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h2' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)
    await handler({ ...baseEvent, toolCallId: 't2' }, baseCtx)

    // Only one /v2/accounts/me call across the two handler invocations.
    const nudgeCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/v2/accounts/me'))
    expect(nudgeCalls).toHaveLength(1)

    const claimLogs = (api as any).__logs.filter((l: any) =>
      l.level === 'info' && /claim your account/i.test(l.msg)
    )
    expect(claimLogs).toHaveLength(1)
    expect(claimLogs[0].msg).toContain('api_key=boot_k4')
  })

  it('suppresses claim nudge log when claimed:true', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    mockFetch(
      { api_key: 'boot_k5' },
      { claimed: true },
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const claimLogs = (api as any).__logs.filter((l: any) =>
      l.level === 'info' && /claim your account/i.test(l.msg)
    )
    expect(claimLogs).toHaveLength(0)
  })

  it('includes provisioned account fingerprint log with claim URL on bootstrap', async () => {
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')

    mockFetch(
      { api_key: 'boot_k6', wallet_address: '0xbeef', wallet_network: 'base-sepolia' },
      { claimed: true },
      { ok: true, run_id: 'r1', decision: { decision: 'allow', reason: 'ok' }, content_hash: 'h' },
    )

    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx)

    const provisionedLogs = (api as any).__logs.filter((l: any) =>
      l.level === 'info' && /account provisioned/.test(l.msg)
    )
    expect(provisionedLogs).toHaveLength(1)
    expect(provisionedLogs[0].msg).toContain('0xbeef')
    expect(provisionedLogs[0].msg).toContain('base-sepolia')
    expect(provisionedLogs[0].msg).toContain('api_key=boot_k6')
  })
})
