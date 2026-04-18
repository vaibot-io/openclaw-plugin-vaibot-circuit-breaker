import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  it('canAllow uses allow/deny lists', () => {
    const breaker = new CircuitBreaker(cfg as any)
    expect(breaker.canAllow('read')).toBe(true)
    expect(breaker.canAllow('exec')).toBe(false)
    expect(breaker.canAllow('other')).toBe(false)
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

  const baseCfg = {
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

  // ---- Observe mode ----

  it('observe mode always passes through without calling upstreams', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ mode: 'observe' })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const fetchMock = mockFetch()
    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toBeUndefined()
    // Only the initial health check from register(), no decision calls
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  // ---- Breaker fail-closed (Bug #2) ----

  it('blocks all tools when breaker is tripped (fail-closed)', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ breakerFailureThreshold: 1 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Trip the breaker: guard health fail, MCP fail, API fail → all fail, breaker trips
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchMock as any

    const handler = (api as any).__handlers['before_tool_call']
    // First call trips breaker via chain failures
    await handler(baseEvent, baseCtx)

    // Reset mock — subsequent call should be blocked by breaker without any fetch
    const fetchMock2 = vi.fn()
    globalThis.fetch = fetchMock2 as any

    const res = await handler({ ...baseEvent, toolCallId: 't2' }, baseCtx)
    expect(res).toEqual({
      block: true,
      blockReason: expect.stringContaining('Circuit breaker active'),
    })
    // No fetches — breaker blocks before any upstream call
    expect(fetchMock2).not.toHaveBeenCalled()
  })

  it('telemetry-allowlisted tools pass through even when breaker is tripped', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({ breakerFailureThreshold: 1, breakerTelemetryAllowlist: ['telemetry_log'] })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Trip the breaker
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchMock as any

    const handler = (api as any).__handlers['before_tool_call']
    await handler(baseEvent, baseCtx) // trips breaker

    const fetchMock2 = vi.fn()
    globalThis.fetch = fetchMock2 as any

    // telemetry_log should pass
    const res = await handler({ toolName: 'telemetry_log', params: {}, runId: 'r2', toolCallId: 't3' }, baseCtx)
    expect(res).toBeUndefined()

    // non-telemetry tool should still block
    const res2 = await handler({ toolName: 'write', params: {}, runId: 'r3', toolCallId: 't4' }, baseCtx)
    expect(res2?.block).toBe(true)
  })

  // ---- Guard approval flow (Bug #4, #15) ----

  it('guard approve extracts approvalId/expiresAt/scope from top-level raw', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi()
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch(
      { ok: true }, // guard health
      { // guard decide: approval_required
        ok: true,
        decision: { decision: 'approve', reason: 'Needs human review' },
        runId: 'guard_run_1',
        approvalId: 'appr_123',
        expiresAt: '2026-12-31T00:00:00Z',
        scope: { paramsHash: 'sha256:abc' },
      },
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(res.blockReason).toContain('approvalId=appr_123')
    expect(res.blockReason).toContain('expiresAt=2026-12-31T00:00:00Z')
    expect(res.blockReason).toContain('/guard approve appr_123')
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
    )

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res.block).toBe(true)
    expect(res.blockReason).toContain('content_hash=sha256:api_hash')
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

    const fetchMock = mockFetch(
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

  // ---- failClosedOnError false: allow on chain exhaustion ----

  it('allows tool when failClosedOnError=false and chain exhausted', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({
      failClosedOnError: false,
      decisionChain: ['guard'],
      breakerFailureThreshold: 100, // high so breaker never trips
    })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    // Guard health fail → chain exhausted with no success
    mockFetch({ ok: false })

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    // failClosedOnError=false → should allow
    expect(res).toBeUndefined()
  })

  it('blocks tool when failClosedOnError=true and chain exhausted', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    const api = makeApi({
      failClosedOnError: true,
      decisionChain: ['guard'],
      breakerFailureThreshold: 100,
    })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    mockFetch({ ok: false })

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    expect(res).toEqual({ block: true, blockReason: 'VAIBot decision chain exhausted' })
  })

  // ---- MCP missing token ----

  it('MCP source fails when token env is not set', async () => {
    // Deliberately no VAIBOT_API_KEY
    const api = makeApi({ decisionChain: ['mcp'], breakerFailureThreshold: 100 })
    const { createCircuitBreaker } = await import('./plugin.js')
    createCircuitBreaker(api as any).register()

    const handler = (api as any).__handlers['before_tool_call']
    const res = await handler(baseEvent, baseCtx)
    // failClosedOnError=true → blocks
    expect(res?.block).toBe(true)
  })

  // ---- Guard sends auth header ----

  it('includes VAIBOT_GUARD_TOKEN as authorization header', async () => {
    process.env.VAIBOT_API_KEY = 'test-token'
    process.env.VAIBOT_GUARD_TOKEN = 'guard-secret'
    const api = makeApi({ decisionChain: ['guard'] })
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
