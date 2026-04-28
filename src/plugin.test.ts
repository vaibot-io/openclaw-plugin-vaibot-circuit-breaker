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

    // No key → decide throws → chain exhausted → fail-closed block
    expect(res?.block).toBe(true)
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
      l.level === 'warn' && /already provisioned but no api_key returned/.test(l.msg)
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
    expect(saved.api_key).toBe('boot_k2')
    expect(saved.account_id).toBe('acct_2')
    expect(saved.wallet_address).toBe('0xdef')
    expect(saved.api_url).toBe('https://api.vaibot.io')
    expect(typeof saved.bootstrapped_at).toBe('string')
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
