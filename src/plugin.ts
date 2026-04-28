import type {
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
} from "openclaw/plugin-sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo, homedir } from "node:os";
import { join } from "node:path";

// ---- Types ----

type Mode = "enforce" | "observe";

type DecisionSource = "guard" | "mcp" | "api" | "breaker";

type PluginConfig = {
  mode?: Mode;
  guardBaseUrl?: string;
  mcpBaseUrl?: string;
  mcpTokenEnv?: string;
  apiBaseUrl?: string;
  apiKeyEnv?: string;
  dashboardUrl?: string;
  autoBootstrap?: boolean;
  credsDir?: string;
  agent?: string;
  timeoutMs?: number;
  failClosedOnError?: boolean;
  sendToolParams?: boolean;
  maxParamChars?: number;
  maxResultChars?: number;
  decisionCacheTtlMs?: number;
  decisionChain?: string[];
  mcpMaxRetries?: number;
  mcpRetryBaseMs?: number;
  mcpRetryJitterMs?: number;
  breakerFailureThreshold?: number;
  breakerWindowMs?: number;
  breakerCooldownMs?: number;
  breakerAllowlist?: string[];
  breakerDenylist?: string[];
  breakerTelemetryAllowlist?: string[];
  breakerProbeIntervalMs?: number;
  approvalAutoRetry?: boolean;
  approvalPollMs?: number;
  approvalReplayWindowMs?: number;
};

type SavedCredentials = {
  api_key?: string;
  account_id?: string;
  user_id?: string;
  wallet_address?: string;
  wallet_network?: string;
  api_url?: string;
  bootstrapped_at?: string;
};

type BootstrapResponse = {
  api_key?: string;
  account_id?: string;
  user_id?: string;
  wallet_address?: string;
  wallet_network?: string;
  bootstrapped?: boolean;
};

type GuardDecision = {
  decision: "allow" | "deny" | "approve";
  reason?: string;
};

type GuardToolDecideResponse = {
  ok: boolean;
  runId?: string;
  decision?: GuardDecision;
  approvalId?: string;
  expiresAt?: string;
  scope?: { paramsHash?: string };
  risk?: unknown;
  audit?: unknown;
  error?: string;
};

type VaibotApiDecision = {
  decision: "allow" | "deny" | "approval_required";
  reason: string;
};

type VaibotApiResponse = {
  ok: boolean;
  run_id: string;
  risk: { risk: string; reason: string };
  decision: VaibotApiDecision;
  receipt_id: string;
  content_hash: string;
};

type PendingAction = {
  key: string;
  toolName: string;
  params: unknown;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  channelId?: string;
  approvalId?: string;
  contentHash?: string;
  paramsHash?: string;
  runId?: string;
  intentHash?: string;
  idempotencyKey?: string;
  expiresAt: number;
};

// ---- Helpers ----

function clampStr(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    return value.length > maxChars ? value.slice(0, maxChars) + "…(truncated)" : value;
  }
  return value;
}

function safeJson(value: unknown, maxChars: number): unknown {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxChars) return value;
    return { truncated: true, json: s.slice(0, maxChars) + "…(truncated)" };
  } catch {
    return { unserializable: true };
  }
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text || "{}");
  } catch {
    json = { ok: false, error: `Invalid JSON (${res.status})`, raw: text.slice(0, 500) };
  }

  return json as T;
}

function parseMcpDecisionText(text: string): { decision?: GuardDecision; runId?: string; contentHash?: string } {
  // Try canonical JSON first (structured MCP response)
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object" && (json.decision || json.shadow_decision)) {
      // Prefer shadow_decision (raw policy verdict) over decision (server-observe-coerced).
      // This mirrors the Claude Code pre-hook's posture — the raw verdict is the legal truth;
      // the coerced decision exists so clients without shadow awareness don't block in observe.
      const source = json.shadow_decision ?? json.decision;
      const raw = typeof source === "object" ? source.decision : source;
      const reason = typeof source === "object" ? source.reason : undefined;
      const normalized = String(raw).toLowerCase();
      const decision: GuardDecision = normalized === "allow"
        ? { decision: "allow", reason: reason ?? "MCP allow" }
        : normalized === "approval_required" || normalized === "approve" || normalized === "approval"
          ? { decision: "approve", reason: reason ?? "MCP approval required" }
          : { decision: "deny", reason: reason ?? "MCP deny" };
      return { decision, runId: json.run_id, contentHash: json.content_hash };
    }
  } catch {
    // Not JSON — fall through to legacy prose parsing
  }

  // Legacy prose format (e.g. "Decision:  ALLOW\nrun_id:  run_123\ncontent_hash:  sha256:abc")
  const decisionMatch = text.match(/Decision:\s+(\w+)/i);
  const runMatch = text.match(/run_id:\s*([\w:-]+)/i);
  const hashMatch = text.match(/content_hash:\s*([\w:.-]+)/i);

  if (!decisionMatch) return {};
  const raw = decisionMatch[1].toLowerCase();
  const decision: GuardDecision = raw === "allow"
    ? { decision: "allow", reason: "MCP allow" }
    : raw === "approval_required" || raw === "approve" || raw === "approval"
      ? { decision: "approve", reason: "MCP approval required" }
      : { decision: "deny", reason: "MCP deny" };

  return { decision, runId: runMatch?.[1], contentHash: hashMatch?.[1] };
}

function normalizeDecisionChain(value: unknown): DecisionSource[] {
  const fallback: DecisionSource[] = ["guard", "mcp", "api", "breaker"];
  if (!Array.isArray(value)) return fallback;

  const mapped = value
    .map((v) => String(v).trim().toLowerCase())
    .map((v) => (v === "skill" ? "guard" : v))
    .filter((v): v is DecisionSource => (v === "guard" || v === "mcp" || v === "api" || v === "breaker"));

  return mapped.length > 0 ? Array.from(new Set(mapped)) : fallback;
}

function classifyError(err: unknown): { kind: "timeout" | "error"; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const isTimeout = name === "AbortError" || /timeout|timed out|AbortError/i.test(raw);
  return { kind: isTimeout ? "timeout" : "error", message: raw };
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseDelayMs: number; jitterMs: number }
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const delay = opts.baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * opts.jitterMs);
      if (attempt < opts.retries) await sleep(delay);
    }
  }
  throw lastErr;
}

async function getJson<T>(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    headers: headers ?? {},
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text || "{}");
  } catch {
    json = { ok: false, error: `Invalid JSON (${res.status})`, raw: text.slice(0, 500) };
  }

  return json as T;
}

function toSessionId(ctx: PluginHookAgentContext): string {
  return String(ctx.sessionId || ctx.sessionKey || "unknown-session");
}

// ---- Credentials (shared with Claude Code plugin at ~/.vaibot/credentials.json) ----

function loadSavedCredentials(credsDir: string): SavedCredentials | null {
  try {
    const file = join(credsDir, "credentials.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as SavedCredentials;
  } catch { /* corrupt / unreadable — ignore */ }
  return null;
}

function saveCredentials(credsDir: string, creds: SavedCredentials): void {
  try {
    mkdirSync(credsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(credsDir, "credentials.json"), JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}

/**
 * Forensic correlation fingerprint — NOT machine attestation. Matches the Claude
 * Code plugin's algorithm so the same user/host/cwd maps to the same account
 * whichever plugin bootstraps first. Server uses this for bootstrap idempotency.
 */
function getFingerprint(): string {
  const user = userInfo().username;
  const host = hostname();
  const cwd = process.cwd();
  return createHash("sha256").update(`${user}@${host}:${cwd}`).digest("hex");
}

function resolveConfig(api: OpenClawPluginApi): Required<PluginConfig> {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;

  return {
    mode: (cfg.mode ?? "enforce") as Mode,
    guardBaseUrl: String(cfg.guardBaseUrl ?? process.env.VAIBOT_GUARD_BASE_URL ?? "http://127.0.0.1:39111").replace(/\/$/, ""),
    mcpBaseUrl: String(cfg.mcpBaseUrl ?? process.env.VAIBOT_MCP_URL ?? "https://api.vaibot.io/v2/mcp").replace(/\/$/, ""),
    mcpTokenEnv: String(cfg.mcpTokenEnv ?? "VAIBOT_API_KEY"),
    apiBaseUrl: String(cfg.apiBaseUrl ?? process.env.VAIBOT_API_BASE_URL ?? "https://api.vaibot.io").replace(/\/$/, ""),
    apiKeyEnv: String(cfg.apiKeyEnv ?? "VAIBOT_API_KEY"),
    dashboardUrl: String(cfg.dashboardUrl ?? process.env.VAIBOT_DASHBOARD_URL ?? "https://www.vaibot.io").replace(/\/$/, ""),
    autoBootstrap: cfg.autoBootstrap !== false,
    credsDir: String(cfg.credsDir ?? process.env.VAIBOT_CREDS_DIR ?? join(homedir(), ".vaibot")),
    agent: String(cfg.agent ?? "openclaw"),
    timeoutMs: Number.isFinite(cfg.timeoutMs) ? Number(cfg.timeoutMs) : 15000,
    failClosedOnError: cfg.failClosedOnError !== false,
    sendToolParams: cfg.sendToolParams !== false,
    maxParamChars: Number.isFinite(cfg.maxParamChars) ? Number(cfg.maxParamChars) : 20000,
    maxResultChars: Number.isFinite(cfg.maxResultChars) ? Number(cfg.maxResultChars) : 20000,
    decisionCacheTtlMs: Number.isFinite(cfg.decisionCacheTtlMs) ? Number(cfg.decisionCacheTtlMs) : 5000,
    decisionChain: normalizeDecisionChain(cfg.decisionChain),
    mcpMaxRetries: Number.isFinite(cfg.mcpMaxRetries) ? Number(cfg.mcpMaxRetries) : 2,
    mcpRetryBaseMs: Number.isFinite(cfg.mcpRetryBaseMs) ? Number(cfg.mcpRetryBaseMs) : 300,
    mcpRetryJitterMs: Number.isFinite(cfg.mcpRetryJitterMs) ? Number(cfg.mcpRetryJitterMs) : 200,
    breakerFailureThreshold: Number.isFinite(cfg.breakerFailureThreshold) ? Number(cfg.breakerFailureThreshold) : 3,
    breakerWindowMs: Number.isFinite(cfg.breakerWindowMs) ? Number(cfg.breakerWindowMs) : 10000,
    breakerCooldownMs: Number.isFinite(cfg.breakerCooldownMs) ? Number(cfg.breakerCooldownMs) : 60000,
    breakerAllowlist: Array.isArray(cfg.breakerAllowlist) ? cfg.breakerAllowlist : ["read", "web_fetch"],
    breakerDenylist: Array.isArray(cfg.breakerDenylist) ? cfg.breakerDenylist : ["exec", "write", "sessions_send", "message.send"],
    breakerTelemetryAllowlist: Array.isArray(cfg.breakerTelemetryAllowlist) ? cfg.breakerTelemetryAllowlist : [],
    breakerProbeIntervalMs: Number.isFinite(cfg.breakerProbeIntervalMs) ? Number(cfg.breakerProbeIntervalMs) : 15000,
    approvalAutoRetry: cfg.approvalAutoRetry !== false,
    approvalPollMs: Number.isFinite(cfg.approvalPollMs) ? Number(cfg.approvalPollMs) : 15000,
    approvalReplayWindowMs: Number.isFinite(cfg.approvalReplayWindowMs) ? Number(cfg.approvalReplayWindowMs) : 30 * 60 * 1000,
  };
}

// ---- Circuit Breaker ----

export class CircuitBreaker {
  private failures: number[] = [];
  private trippedAt: number | null = null;
  private lastError: string | null = null;

  constructor(private cfg: Required<PluginConfig>) {}

  load(state?: { failures?: number[]; trippedAt?: number | null; lastError?: string | null }) {
    this.failures = Array.isArray(state?.failures) ? state!.failures : [];
    this.trippedAt = typeof state?.trippedAt === "number" ? state!.trippedAt : null;
    this.lastError = typeof state?.lastError === "string" ? state!.lastError : null;
  }

  snapshot() {
    return { failures: this.failures, trippedAt: this.trippedAt, lastError: this.lastError };
  }

  recordFailure(err?: string) {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter((t) => now - t <= this.cfg.breakerWindowMs);
    if (err) this.lastError = err;

    if (this.failures.length >= this.cfg.breakerFailureThreshold) {
      this.trippedAt = now;
    }
  }

  recordSuccess() {
    this.failures = [];
    this.trippedAt = null;
    this.lastError = null;
  }

  isTripped(): boolean {
    if (!this.trippedAt) return false;
    const now = Date.now();
    if (now - this.trippedAt > this.cfg.breakerCooldownMs) {
      this.trippedAt = null;
      this.failures = [];
      this.lastError = null;
      return false;
    }
    return true;
  }

  canAllow(toolName: string): boolean {
    if (this.cfg.breakerDenylist.includes(toolName)) return false;
    if (this.cfg.breakerAllowlist.includes(toolName)) return true;
    return false;
  }
}

// ---- Plugin ----

export function createCircuitBreaker(api: OpenClawPluginApi) {
  const cfg = resolveConfig(api);
  const breaker = new CircuitBreaker(cfg);
  const decisionCache = new Map<string, { decision: GuardDecision; meta?: any; expiresAt: number }>();
  const activeRuns = new Map<string, { runId?: string; source: "guard" | "api" | "mcp"; contentHash?: string; replayOf?: string }>();
  const pending = new Map<string, PendingAction>();
  const replayByIntentHash = new Map<string, { contentHash: string; expiresAt: number }>();

  const stateDir = api.runtime.state.resolveStateDir();
  const statePath = `${stateDir}/vaibot-circuit-breaker-v2.json`;
  let lastTripLogged = false;

  // Auto-bootstrap state. Seed from saved credentials so restarts reuse the same account.
  const initialCreds = loadSavedCredentials(cfg.credsDir);
  let bootstrappedKey: string | null = initialCreds?.api_key ? String(initialCreds.api_key) : null;
  let bootstrapPromise: Promise<void> | null = null;
  const nudgedSessions = new Set<string>();

  function persistBreakerState() {
    try {
      const snap = breaker.snapshot();
      api.runtime.config.writeConfigFile(statePath, snap as any);
    } catch (err) {
      api.logger.warn?.(`vaibot-circuitbreaker: failed to persist breaker state (${String(err)})`);
    }
  }

  function loadBreakerState() {
    try {
      const state = api.runtime.config.loadConfig(statePath) as any;
      breaker.load(state ?? undefined);
    } catch {
      // ignore
    }
  }

  // approvals for guard (single-use)
  const approvedByParamsHash = new Map<string, string>();

  let guardHealthOk: boolean | null = null;
  let guardHealthTs = 0;

  function runKey(ctx: PluginHookAgentContext, event: PluginHookBeforeToolCallEvent | PluginHookAfterToolCallEvent): string {
    const session = toSessionId(ctx);
    const runId = event.runId ?? "unknown-run";
    const toolCallId = (event as any).toolCallId ?? "unknown-toolcall";
    return `${session}:${runId}:${String(toolCallId)}:${event.toolName}`;
  }

  function cacheKey(event: PluginHookBeforeToolCallEvent): string {
    let p = "";
    try {
      p = JSON.stringify(event.params ?? {});
    } catch {
      p = "{\"unserializable\":true}";
    }
    if (p.length > 2000) p = p.slice(0, 2000);
    return `${event.toolName}:${p}`;
  }

  async function buildIntentHash(event: PluginHookBeforeToolCallEvent): Promise<string> {
    const payload = stableStringify({ tool: event.toolName, params: event.params ?? {} });
    return `sha256:${await sha256Hex(payload)}`;
  }

  function getGuardAuthHeaders(): Record<string, string> {
    const token = String(process.env.VAIBOT_GUARD_TOKEN ?? "").trim();
    if (!token) return {};
    return { authorization: `Bearer ${token}` };
  }

  async function checkGuardHealth(): Promise<boolean> {
    const now = Date.now();
    if (guardHealthOk !== null && now - guardHealthTs < 5000) return guardHealthOk;
    guardHealthTs = now;
    try {
      const res = await getJson<{ ok?: boolean }>(`${cfg.guardBaseUrl}/health`, cfg.timeoutMs, getGuardAuthHeaders());
      guardHealthOk = !!res?.ok;
    } catch {
      guardHealthOk = false;
    }
    return guardHealthOk;
  }

  async function decideWithGuard(event: PluginHookBeforeToolCallEvent, ctx: PluginHookAgentContext) {
    const sessionId = toSessionId(ctx);
    const paramsHash = `sha256:${await sha256Hex(stableStringify({ toolName: event.toolName, params: event.params ?? {} }))}`;
    const approvalId = approvedByParamsHash.get(paramsHash);

    const payload: any = {
      sessionId,
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      toolName: event.toolName,
      runId: event.runId,
      toolCallId: event.toolCallId,
      workspaceDir: ctx.workspaceDir,
      ts: Date.now(),
    };
    if (cfg.sendToolParams) payload.params = safeJson(event.params, cfg.maxParamChars);
    if (approvalId) payload.approval = { approvalId };

    const raw = await postJson<GuardToolDecideResponse>(
      `${cfg.guardBaseUrl}/v1/decide/tool`,
      payload,
      cfg.timeoutMs,
      getGuardAuthHeaders(),
    );

    const decision: GuardDecision = (raw?.decision ?? {
      decision: "deny",
      reason: raw?.error || "Guard did not return a decision",
    }) as GuardDecision;

    if (approvalId) approvedByParamsHash.delete(paramsHash);

    return { decision, raw };
  }

  function getApiKey(): string {
    const fromEnv = String(process.env[cfg.apiKeyEnv] ?? "").trim();
    if (fromEnv) return fromEnv;
    return bootstrappedKey ?? "";
  }

  function getMcpToken(): string {
    const fromEnv = String(process.env[cfg.mcpTokenEnv] ?? "").trim();
    if (fromEnv) return fromEnv;
    return bootstrappedKey ?? "";
  }

  /**
   * Auto-bootstrap a free-tier account on first run. No-ops if autoBootstrap is
   * disabled, or if a key is already resolvable via env or saved credentials.
   * Errors are logged but never rethrown — a missing key is handled downstream
   * by the usual failClosedOnError path.
   */
  async function bootstrap(): Promise<void> {
    if (!cfg.autoBootstrap) return;
    if (getApiKey()) return;

    const fingerprint = getFingerprint();
    let res: BootstrapResponse;
    try {
      res = await postJson<BootstrapResponse>(
        `${cfg.apiBaseUrl}/v2/bootstrap`,
        { fingerprint, agent: cfg.agent },
        cfg.timeoutMs,
      );
    } catch (err) {
      api.logger.warn?.(`vaibot-circuitbreaker: bootstrap failed (${String(err)})`);
      return;
    }

    if (res?.api_key) {
      bootstrappedKey = String(res.api_key);
      saveCredentials(cfg.credsDir, {
        api_key: res.api_key,
        account_id: res.account_id,
        user_id: res.user_id,
        wallet_address: res.wallet_address,
        wallet_network: res.wallet_network,
        api_url: cfg.apiBaseUrl,
        bootstrapped_at: new Date().toISOString(),
      });
      const claimUrl = `${cfg.dashboardUrl}/claim?api_key=${encodeURIComponent(res.api_key)}`;
      api.logger.info?.(
        `vaibot-circuitbreaker: account provisioned` +
          (res.wallet_address ? ` (identity ${res.wallet_address} on ${res.wallet_network})` : "") +
          `. Claim to approve from the dashboard: ${claimUrl}`,
      );
      return;
    }

    if (res?.bootstrapped === false) {
      api.logger.warn?.(
        `vaibot-circuitbreaker: account already provisioned but no api_key returned. ` +
          `Set ${cfg.apiKeyEnv} manually or check ${join(cfg.credsDir, "credentials.json")}.`,
      );
      return;
    }

    api.logger.warn?.(
      `vaibot-circuitbreaker: bootstrap returned no api_key — skipping (response: ${JSON.stringify(res).slice(0, 200)})`,
    );
  }

  /**
   * One-shot per-session nudge pointing at the claim URL when the account is
   * still synthetic (`claimed:false`). Best-effort; never blocks tool calls.
   */
  async function maybeNudgeUnclaimed(sessionId: string): Promise<void> {
    if (nudgedSessions.has(sessionId)) return;
    // Only nudge when running on a bootstrapped key — env-provided keys are
    // the user's own and already associated with a claimed account.
    const envKey = String(process.env[cfg.apiKeyEnv] ?? "").trim();
    if (envKey) return;
    const apiKey = bootstrappedKey;
    if (!apiKey) return;
    try {
      const res = await getJson<{ claimed?: boolean }>(
        `${cfg.apiBaseUrl}/v2/accounts/me`,
        cfg.timeoutMs,
        { authorization: `Bearer ${apiKey}` },
      );
      nudgedSessions.add(sessionId);
      if (res?.claimed === false) {
        const claimUrl = `${cfg.dashboardUrl}/claim?api_key=${encodeURIComponent(apiKey)}`;
        api.logger.info?.(
          `vaibot-circuitbreaker: claim your account to approve from the dashboard: ${claimUrl}`,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  async function decideWithMcp(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookAgentContext,
    approvedContentHash?: string,
  ) {
    const token = getMcpToken();
    if (!token) throw new Error(`Missing ${cfg.mcpTokenEnv} for MCP endpoint`);

    const args: any = {
      session_id: String(ctx.sessionId || ctx.sessionKey || "unknown"),
      agent_id: String(ctx.agentId || "unknown"),
      agent_model: cfg.agent,
      tool: event.toolName,
      params: cfg.sendToolParams ? safeJson(event.params, cfg.maxParamChars) : undefined,
      workspace_dir: ctx.workspaceDir,
      command: event.toolName === "exec" ? safeJson((event.params as any)?.command ?? (event.params as any)?.cmd, 500) : undefined,
      target: (event.params as any)?.url ?? (event.params as any)?.path,
      cwd: (event.params as any)?.cwd,
    };
    if (approvedContentHash) args.approved_content_hash = approvedContentHash;

    const payload = {
      jsonrpc: "2.0",
      id: String(Date.now()),
      method: "tools/call",
      params: { name: "vaibot_decide", arguments: args },
    };

    const raw = await withRetries(
      () => postJson<any>(cfg.mcpBaseUrl, payload, cfg.timeoutMs, { authorization: `Bearer ${token}` }),
      { retries: cfg.mcpMaxRetries, baseDelayMs: cfg.mcpRetryBaseMs, jitterMs: cfg.mcpRetryJitterMs },
    );
    const text = raw?.result?.content?.[0]?.text ?? "";
    const parsed = parseMcpDecisionText(String(text));
    if (!parsed.decision) throw new Error("MCP response missing decision");

    // Bug #13 fix: return parsed fields directly so callers get run_id and content_hash
    return {
      decision: parsed.decision,
      raw: { run_id: parsed.runId, content_hash: parsed.contentHash },
    };
  }

  async function decideWithApi(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookAgentContext,
    approvedContentHash?: string,
  ) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error(`Missing ${cfg.apiKeyEnv} for VAIBot API`);

    const payload: any = {
      session_id: String(ctx.sessionId || ctx.sessionKey || "unknown"),
      agent_id: String(ctx.agentId || "unknown"),
      agent_model: cfg.agent,
      tool: event.toolName,
      params: cfg.sendToolParams ? safeJson(event.params, cfg.maxParamChars) : undefined,
      workspace_dir: ctx.workspaceDir,
      intent: {
        command: event.toolName === "exec" ? safeJson((event.params as any)?.command ?? (event.params as any)?.cmd, 500) : undefined,
        target: (event.params as any)?.url ?? (event.params as any)?.path,
        cwd: (event.params as any)?.cwd,
      },
    };
    if (approvedContentHash) payload.approved_content_hash = approvedContentHash;

    const raw = await postJson<VaibotApiResponse & { shadow_decision?: VaibotApiDecision }>(
      `${cfg.apiBaseUrl}/v2/governance/decide`,
      payload,
      cfg.timeoutMs,
      { authorization: `Bearer ${apiKey}` },
    );

    // Prefer shadow_decision (raw policy verdict) over decision (server-observe-coerced).
    // If the server short-circuited via previously_approved, decision will be 'allow' even
    // when shadow_decision is 'approval_required' — we want the effective allow in that case.
    const previouslyApproved = Boolean((raw as any)?.previously_approved);
    const effective = previouslyApproved ? raw?.decision : (raw?.shadow_decision ?? raw?.decision);
    const kind = effective?.decision;
    const reason = effective?.reason;

    const decision: GuardDecision = kind === "approval_required"
      ? { decision: "approve", reason }
      : kind === "allow"
        ? { decision: "allow", reason }
        : { decision: "deny", reason };

    return { decision, raw };
  }

  async function finalizeGuard(event: PluginHookAfterToolCallEvent, ctx: PluginHookAgentContext, guardRunId?: string) {
    if (!guardRunId) {
      api.logger.warn?.("vaibot-circuitbreaker: guard finalize skipped (no runId)");
      return;
    }

    const payload = {
      sessionId: toSessionId(ctx),
      runId: guardRunId,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      runIdOpenClaw: event.runId,
      params: cfg.sendToolParams ? safeJson(event.params, cfg.maxParamChars) : undefined,
      result: safeJson(
        {
          ok: !event.error,
          error: clampStr(event.error, 2000),
          durationMs: event.durationMs,
          result: safeJson(event.result, cfg.maxResultChars),
        },
        cfg.maxResultChars,
      ),
      ts: Date.now(),
    };

    try {
      await postJson(`${cfg.guardBaseUrl}/v1/finalize/tool`, payload, cfg.timeoutMs, getGuardAuthHeaders());
    } catch (err) {
      api.logger.warn?.(`vaibot-circuitbreaker: guard finalize failed (${String(err)})`);
    }
  }

  /**
   * Synthetic finalize for the block paths in onBeforeToolCall. When we return
   * `{ block: true }` the gateway never fires `after_tool_call`, so the server
   * would be left with a dangling decide. Posting finalize here closes the loop
   * and lets receipts distinguish `blocked_until_approved` (awaiting human) from
   * `blocked` (hard deny). Mirrors Claude Code's bestEffortFinalize.
   */
  async function finalizeBlock(runId: string | undefined, outcome: "blocked" | "blocked_until_approved", summary: string) {
    if (!runId) return;
    const apiKey = getApiKey();
    if (!apiKey) return;
    try {
      await postJson(
        `${cfg.apiBaseUrl}/v2/governance/finalize/${encodeURIComponent(runId)}`,
        { outcome, result: { error: summary } },
        cfg.timeoutMs,
        { authorization: `Bearer ${apiKey}` },
      );
    } catch (err) {
      api.logger.warn?.(`vaibot-circuitbreaker: block finalize failed (${String(err)})`);
    }
  }

  async function finalizeApi(event: PluginHookAfterToolCallEvent, ctx: PluginHookAgentContext, runId?: string) {
    if (!runId) {
      api.logger.warn?.("vaibot-circuitbreaker: api finalize skipped (no runId)");
      return;
    }
    const apiKey = getApiKey();
    if (!apiKey) {
      api.logger.warn?.(`vaibot-circuitbreaker: api finalize skipped (no ${cfg.apiKeyEnv})`);
      return;
    }

    const payload = {
      outcome: event.error ? "blocked" : "allowed",
      result: {
        exit_code: (event.result as any)?.exitCode,
        error: clampStr(event.error, 2000),
        duration_ms: event.durationMs,
      },
    };

    try {
      await postJson(`${cfg.apiBaseUrl}/v2/governance/finalize/${encodeURIComponent(runId)}`, payload, cfg.timeoutMs, {
        authorization: `Bearer ${apiKey}`,
      });
    } catch (err) {
      api.logger.warn?.(`vaibot-circuitbreaker: api finalize failed (${String(err)})`);
    }
  }

  async function finalizeReplayLink(
    event: PluginHookAfterToolCallEvent,
    replayOf?: string,
    replayContentHash?: string,
    replayRunId?: string,
  ) {
    if (!replayOf || !replayContentHash) return;
    const apiKey = getApiKey();
    if (!apiKey) return;

    const outcome = event.error ? "blocked" : "allowed";
    const summary = event.error
      ? `Replay execution failed: ${clampStr(event.error, 2000)}`
      : "Replay executed successfully.";

    const payload = {
      replay_content_hash: replayContentHash,
      replay_run_id: replayRunId,
      replay_outcome: outcome,
      replay_summary: summary,
      replay_executed_at: new Date().toISOString(),
    };

    try {
      await postJson(`${cfg.apiBaseUrl}/v2/receipts/${encodeURIComponent(replayOf)}/replay`, payload, cfg.timeoutMs, {
        authorization: `Bearer ${apiKey}`,
      });
    } catch (err) {
      api.logger.warn?.(`vaibot-circuitbreaker: replay link failed (${String(err)})`);
    }
  }

  function enqueueAutoRetry(pendingAction: PendingAction) {
    if (!pendingAction.sessionKey) return;
    const text = [
      `VAIBot approval resolved — retrying blocked action: ${pendingAction.toolName}`,
      `Reason: approval granted.`,
      pendingAction.runId ? `run_id=${pendingAction.runId}` : null,
      pendingAction.contentHash ? `content_hash=${pendingAction.contentHash}` : null,
      pendingAction.approvalId ? `approval_id=${pendingAction.approvalId}` : null,
      pendingAction.intentHash ? `intent_hash=${pendingAction.intentHash}` : null,
      pendingAction.idempotencyKey ? `idempotency_key=${pendingAction.idempotencyKey}` : null,
      `expires_at=${new Date(pendingAction.expiresAt).toISOString()}`,
    ].filter(Boolean).join("\n");

    // Only register a replay pointer when we have a real content_hash. The server
    // short-circuit (approved_content_hash) looks it up as a receipts row, so an
    // intent-hash fallback would miss and re-run policy. Guard-only approvals
    // (no content_hash) use approvedByParamsHash locally instead.
    if (pendingAction.intentHash && pendingAction.contentHash) {
      replayByIntentHash.set(pendingAction.intentHash, {
        contentHash: pendingAction.contentHash,
        expiresAt: pendingAction.expiresAt,
      });
    }

    api.runtime.system.enqueueSystemEvent(text, { sessionKey: pendingAction.sessionKey, agentId: pendingAction.agentId });
  }

  async function pollApprovals() {
    if (!cfg.approvalAutoRetry || pending.size === 0) return;

    const now = Date.now();
    // Collect expired keys first to avoid mutation during iteration
    const expiredKeys: string[] = [];
    for (const [key, p] of pending) {
      if (p.expiresAt <= now) expiredKeys.push(key);
    }
    for (const key of expiredKeys) pending.delete(key);
    if (pending.size === 0) return;

    // Guard approvals: if approvalId no longer pending, assume approved (best-effort)
    try {
      const res = await postJson<any>(`${cfg.guardBaseUrl}/v1/approvals/list`, {}, cfg.timeoutMs, getGuardAuthHeaders());
      const pendingIds = new Set((res?.approvals ?? []).map((a: any) => a.approvalId));
      const resolvedGuard: PendingAction[] = [];
      for (const p of pending.values()) {
        if (!p.approvalId) continue;
        if (!pendingIds.has(p.approvalId)) resolvedGuard.push(p);
      }
      for (const p of resolvedGuard) {
        pending.delete(p.key);
        enqueueAutoRetry(p);
      }
    } catch {
      // ignore guard poll failures
    }

    // API approvals: check receipts for approved status
    try {
      const apiKey = getApiKey();
      if (apiKey) {
        const res = await getJson<any>(`${cfg.apiBaseUrl}/v2/receipts?approval_status=approved&limit=50`, cfg.timeoutMs, {
          authorization: `Bearer ${apiKey}`,
        });
        const approvedHashes = new Set((res?.receipts ?? []).map((r: any) => r.content_hash));
        const resolvedApi: PendingAction[] = [];
        for (const p of pending.values()) {
          if (!p.contentHash) continue;
          if (approvedHashes.has(p.contentHash)) resolvedApi.push(p);
        }
        for (const p of resolvedApi) {
          pending.delete(p.key);
          enqueueAutoRetry(p);
        }
      }
    } catch {
      // ignore API poll failures
    }
  }

  async function probeUpstreams() {
    if (!breaker.isTripped()) return;
    try {
      const ok = await checkGuardHealth();
      if (ok) {
        breaker.recordSuccess();
        persistBreakerState();
        api.logger.info?.("vaibot-circuitbreaker: breaker CLEARED (probe)");
        lastTripLogged = false;
      }
    } catch {
      // ignore probe errors
    }
  }

  async function onBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeToolCallResult | void> {
    // Wait for any in-flight auto-bootstrap so the decision chain sees a
    // resolved API key. Errors are already logged inside bootstrap().
    if (bootstrapPromise) {
      try { await bootstrapPromise; } catch { /* logged inside */ }
    }

    // Fire-and-forget claim nudge — independent of the chain outcome.
    maybeNudgeUnclaimed(toSessionId(ctx)).catch(() => { /* best-effort */ });

    // In observe mode we still run the full chain — the point is to produce
    // the same decide/finalize audit trail enforce produces, just without
    // ever blocking the tool. Early-return would drop all receipts.
    const observeOnly = cfg.mode === "observe";

    const intentHash = await buildIntentHash(event);
    const replayMatch = replayByIntentHash.get(intentHash);
    if (replayMatch && replayMatch.expiresAt <= Date.now()) {
      replayByIntentHash.delete(intentHash);
    }
    const replayOf = replayMatch && replayMatch.expiresAt > Date.now() ? replayMatch.contentHash : undefined;

    function observeAllow(source: string, decision: GuardDecision, extras: string = ""): void {
      api.logger.info?.(
        `vaibot-circuitbreaker [observe]: ${source} would ${decision.decision} ${event.toolName}` +
          (decision.reason ? ` — ${decision.reason}` : "") +
          (extras ? ` ${extras}` : ""),
      );
    }

    // Bug #2 fix: when breaker is tripped, default to DENY (fail-closed).
    // Only telemetry-allowlisted tools pass through. All others are blocked.
    // In observe mode the breaker is informational — log and allow.
    if (breaker.isTripped()) {
      if (!lastTripLogged) {
        api.logger.warn?.(`vaibot-circuitbreaker: breaker is TRIPPED (${observeOnly ? "observe/log-only" : "fail-closed"})`);
        lastTripLogged = true;
      }
      if (cfg.breakerTelemetryAllowlist.includes(event.toolName)) {
        api.logger.info?.(`vaibot-circuitbreaker: breaker telemetry-only allowlist for ${event.toolName}`);
        return;
      }
      if (observeOnly) {
        api.logger.info?.(`vaibot-circuitbreaker [observe]: breaker tripped — would block ${event.toolName}`);
        return;
      }
      return {
        block: true,
        blockReason: `Circuit breaker active — blocked tool: ${event.toolName}`,
      };
    }

    // Cache allow decisions (skip in observe so every call produces a receipt).
    const ck = cacheKey(event);
    if (!observeOnly) {
      const cached = decisionCache.get(ck);
      if (cached && cached.expiresAt > Date.now() && cached.decision.decision === "allow") {
        return;
      }
    }

    // Bug #8 fix: "breaker" is not a decision source in the chain loop — it's handled
    // above when the breaker is tripped. Filter it out of the iteration chain.
    const chain = cfg.decisionChain.filter((source) => source !== "breaker");

    for (const source of chain) {
      if (source === "guard") {
        try {
          const guardOk = await checkGuardHealth();
          if (!guardOk) throw new Error("Guard health check failed (skill missing or unhealthy)");

          const { decision, raw } = await decideWithGuard(event, ctx);
          breaker.recordSuccess();
          persistBreakerState();
          if (lastTripLogged) api.logger.info?.("vaibot-circuitbreaker: breaker CLEARED (guard)");
          lastTripLogged = false;
          api.logger.info?.(`vaibot-circuitbreaker: decision source=guard decision=${decision.decision}`);

          if (decision.decision === "allow" && cfg.decisionCacheTtlMs > 0 && !observeOnly) {
            decisionCache.set(ck, { decision, meta: raw, expiresAt: Date.now() + cfg.decisionCacheTtlMs });
          }

          // Bug #3 fix: Guard doesn't return content_hash, so we don't store one.
          // The runId from Guard is used for finalize linkage.
          const key = runKey(ctx, event);
          if (raw?.runId) activeRuns.set(key, { runId: raw.runId, source: "guard", replayOf });

          if (decision.decision === "allow") {
            if (replayOf) replayByIntentHash.delete(intentHash);
            return;
          }

          if (decision.decision === "approve") {
            if (observeOnly) { observeAllow("guard", decision); return; }
            // Bug #4 fix: Guard returns approvalId/expiresAt/scope at the top level of raw,
            // NOT nested inside raw.decision
            const approvalId = raw?.approvalId as string | undefined;
            const expiresAt = raw?.expiresAt as string | undefined;
            const paramsHash = raw?.scope?.paramsHash as string | undefined;
            const expMs = expiresAt ? Date.parse(expiresAt) : Date.now() + cfg.approvalReplayWindowMs;
            const decisionId = approvalId ?? raw?.runId ?? intentHash;
            const idempotencyKey = `${intentHash}:${decisionId}`;
            const pendingKey = approvalId ?? idempotencyKey;

            // Bug #15 fix: populate approvedByParamsHash so guard approval replay works
            if (approvalId && paramsHash) {
              approvedByParamsHash.set(paramsHash, approvalId);
            }

            pending.set(pendingKey, {
              key: pendingKey,
              toolName: event.toolName,
              params: event.params ?? {},
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              agentId: ctx.agentId,
              channelId: ctx.channelId,
              approvalId,
              paramsHash,
              runId: raw?.runId,
              intentHash,
              idempotencyKey,
              expiresAt: expMs,
            });

            return {
              block: true,
              blockReason:
                `${decision.reason || `Approval required for tool: ${event.toolName}`}` +
                (approvalId ? ` approvalId=${approvalId}` : "") +
                (expiresAt ? ` expiresAt=${expiresAt}` : "") +
                (approvalId ? ` — Approve via /guard approve ${approvalId}` : ""),
            };
          }

          // deny
          if (observeOnly) { observeAllow("guard", decision); return; }
          return {
            block: true,
            blockReason: decision.reason || `Denied by VAIBot-Guard for tool: ${event.toolName}`,
          };
        } catch (err) {
          const classified = classifyError(err);
          breaker.recordFailure(`${classified.kind}: ${classified.message}`);
          persistBreakerState();
          if (breaker.isTripped() && !lastTripLogged) {
            api.logger.error?.(`vaibot-circuitbreaker: breaker TRIPPED (guard) ${classified.kind}=${classified.message}`);
            lastTripLogged = true;
          } else {
            api.logger.warn?.(`vaibot-circuitbreaker: guard ${classified.kind} (${classified.message})`);
          }
        }
      }

      if (source === "mcp") {
        try {
          const { decision, raw } = await decideWithMcp(event, ctx, replayOf);
          breaker.recordSuccess();
          persistBreakerState();
          if (lastTripLogged) api.logger.info?.("vaibot-circuitbreaker: breaker CLEARED (mcp)");
          lastTripLogged = false;
          api.logger.info?.(`vaibot-circuitbreaker: decision source=mcp decision=${decision.decision}`);

          if (decision.decision === "allow" && cfg.decisionCacheTtlMs > 0 && !observeOnly) {
            decisionCache.set(ck, { decision, meta: raw, expiresAt: Date.now() + cfg.decisionCacheTtlMs });
          }

          const key = runKey(ctx, event);
          if (raw?.run_id) activeRuns.set(key, { runId: raw.run_id, source: "mcp", contentHash: raw?.content_hash, replayOf });

          if (decision.decision === "allow") {
            if (replayOf) replayByIntentHash.delete(intentHash);
            return;
          }

          if (decision.decision === "approve") {
            if (observeOnly) { observeAllow("mcp", decision, raw?.content_hash ? `content_hash=${raw.content_hash}` : ""); return; }
            const contentHash = raw?.content_hash;
            const decisionId = contentHash ?? raw?.run_id ?? intentHash;
            const idempotencyKey = `${intentHash}:${decisionId}`;
            const pendingKey = contentHash ?? idempotencyKey;

            pending.set(pendingKey, {
              key: pendingKey,
              toolName: event.toolName,
              params: event.params ?? {},
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              agentId: ctx.agentId,
              channelId: ctx.channelId,
              contentHash,
              runId: raw?.run_id,
              intentHash,
              idempotencyKey,
              expiresAt: Date.now() + cfg.approvalReplayWindowMs,
            });

            activeRuns.delete(key);
            await finalizeBlock(raw?.run_id, "blocked_until_approved", `Plugin enforced: approval_required — ${decision.reason ?? event.toolName}`);

            return {
              block: true,
              blockReason:
                `${decision.reason || `Approval required for tool: ${event.toolName}`}` +
                (contentHash ? ` content_hash=${contentHash}` : "") +
                (contentHash ? ` — Approve in VAIBot UI or via API.` : ""),
            };
          }

          // deny
          if (observeOnly) { observeAllow("mcp", decision); return; }
          activeRuns.delete(key);
          await finalizeBlock(raw?.run_id, "blocked", `Plugin enforced: deny — ${decision.reason ?? event.toolName}`);
          return {
            block: true,
            blockReason: decision.reason || `Denied by VAIBot MCP for tool: ${event.toolName}`,
          };
        } catch (err) {
          const classified = classifyError(err);
          breaker.recordFailure(`${classified.kind}: ${classified.message}`);
          persistBreakerState();
          if (breaker.isTripped() && !lastTripLogged) {
            api.logger.error?.(`vaibot-circuitbreaker: breaker TRIPPED (mcp) ${classified.kind}=${classified.message}`);
            lastTripLogged = true;
          } else {
            api.logger.warn?.(`vaibot-circuitbreaker: MCP ${classified.kind} (${classified.message})`);
          }
        }
      }

      if (source === "api") {
        try {
          const { decision, raw } = await decideWithApi(event, ctx, replayOf);
          breaker.recordSuccess();
          persistBreakerState();
          if (lastTripLogged) api.logger.info?.("vaibot-circuitbreaker: breaker CLEARED (api)");
          lastTripLogged = false;
          api.logger.info?.(`vaibot-circuitbreaker: decision source=api decision=${decision.decision}`);

          if (decision.decision === "allow" && cfg.decisionCacheTtlMs > 0 && !observeOnly) {
            decisionCache.set(ck, { decision, meta: raw, expiresAt: Date.now() + cfg.decisionCacheTtlMs });
          }

          const key = runKey(ctx, event);
          if (raw?.run_id) activeRuns.set(key, { runId: raw.run_id, source: "api", contentHash: raw?.content_hash, replayOf });

          if (decision.decision === "allow") {
            if (replayOf) replayByIntentHash.delete(intentHash);
            return;
          }

          if (decision.decision === "approve") {
            if (observeOnly) { observeAllow("api", decision, raw?.content_hash ? `content_hash=${raw.content_hash}` : ""); return; }
            const contentHash = raw?.content_hash;
            const decisionId = contentHash ?? raw?.run_id ?? intentHash;
            const idempotencyKey = `${intentHash}:${decisionId}`;
            const pendingKey = contentHash ?? idempotencyKey;

            pending.set(pendingKey, {
              key: pendingKey,
              toolName: event.toolName,
              params: event.params ?? {},
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              agentId: ctx.agentId,
              channelId: ctx.channelId,
              contentHash,
              runId: raw?.run_id,
              intentHash,
              idempotencyKey,
              expiresAt: Date.now() + cfg.approvalReplayWindowMs,
            });

            activeRuns.delete(key);
            await finalizeBlock(raw?.run_id, "blocked_until_approved", `Plugin enforced: approval_required — ${decision.reason ?? event.toolName}`);

            return {
              block: true,
              blockReason:
                `${decision.reason || `Approval required for tool: ${event.toolName}`}` +
                (contentHash ? ` content_hash=${contentHash}` : "") +
                (contentHash ? ` — Approve in VAIBot UI or via API.` : ""),
            };
          }

          // deny
          if (observeOnly) { observeAllow("api", decision); return; }
          activeRuns.delete(key);
          await finalizeBlock(raw?.run_id, "blocked", `Plugin enforced: deny — ${decision.reason ?? event.toolName}`);
          return {
            block: true,
            blockReason: decision.reason || `Denied by VAIBot API for tool: ${event.toolName}`,
          };
        } catch (err) {
          const classified = classifyError(err);
          breaker.recordFailure(`${classified.kind}: ${classified.message}`);
          persistBreakerState();
          const msg = `VAIBot API ${classified.kind}: ${classified.message}`;
          if (breaker.isTripped() && !lastTripLogged) {
            api.logger.error?.(`vaibot-circuitbreaker: breaker TRIPPED (api) ${classified.kind}=${classified.message}`);
            lastTripLogged = true;
          } else {
            api.logger.error?.(`vaibot-circuitbreaker: ${msg}`);
          }

          if ((cfg.failClosedOnError || breaker.isTripped()) && !observeOnly) {
            return { block: true, blockReason: msg };
          }
        }
      }
    }

    // Chain exhausted without a clear allow. In observe, always pass through.
    if (observeOnly) {
      api.logger.info?.(`vaibot-circuitbreaker [observe]: chain exhausted for ${event.toolName} — passing through`);
      if (replayOf) replayByIntentHash.delete(intentHash);
      return;
    }

    if (cfg.failClosedOnError) {
      return { block: true, blockReason: "VAIBot decision chain exhausted" };
    }

    // Fallthrough without failClosedOnError: allow and clean up replay.
    if (replayOf) {
      replayByIntentHash.delete(intentHash);
    }

    return;
  }

  async function onAfterToolCall(event: PluginHookAfterToolCallEvent, ctx: PluginHookAgentContext) {
    const key = runKey(ctx, event);
    const run = activeRuns.get(key);
    activeRuns.delete(key);

    if (!run) return;
    if (run.source === "guard") return finalizeGuard(event, ctx, run.runId);

    if (run.source === "api" || run.source === "mcp") {
      await finalizeApi(event, ctx, run.runId);
      await finalizeReplayLink(event, run.replayOf, run.contentHash, run.runId);
    }
  }

  function registerCommands() {
    api.registerCommand({
      name: "vaibot",
      description: "VAIBot approvals (approve/deny) and status",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = String(ctx.args || "").trim();
        const [sub, a1] = args.split(/\s+/);

        if (!sub || sub === "help") {
          return { text: "Usage:\n/vaibot approve <content_hash>\n/vaibot deny <content_hash>" };
        }

        if (sub === "approve" || sub === "deny") {
          if (!a1) return { text: `Missing content_hash. Usage: /vaibot ${sub} <content_hash>` };
          const apiKey = getApiKey();
          if (!apiKey) return { text: `Missing ${cfg.apiKeyEnv}.` };

          const action = sub === "approve" ? "approve" : "deny";
          const path = `/v2/receipts/${encodeURIComponent(a1)}/${action}`;
          const out = await postJson<any>(`${cfg.apiBaseUrl}${path}`, {}, cfg.timeoutMs, {
            authorization: `Bearer ${apiKey}`,
          });

          if (!out?.ok) return { text: `Failed: ${out?.error || "unknown"}` };

          if (sub === "approve") {
            const p = pending.get(a1);
            if (p) {
              pending.delete(a1);
              enqueueAutoRetry(p);
            }
          }

          return { text: `${sub === "approve" ? "Approved" : "Denied"} ${a1}.` };
        }

        return { text: "Unknown subcommand. Try: /vaibot help" };
      },
    });

    api.registerCommand({
      name: "guard",
      description: "VAIBot-Guard approvals (approve/deny)",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = String(ctx.args || "").trim();
        const [sub, a1] = args.split(/\s+/);

        if (!sub || sub === "help") {
          return { text: "Usage:\n/guard approvals\n/guard approve <approvalId>\n/guard deny <approvalId>" };
        }

        if (sub === "approvals") {
          const res = await postJson<any>(`${cfg.guardBaseUrl}/v1/approvals/list`, {}, cfg.timeoutMs, getGuardAuthHeaders());
          const approvals = Array.isArray(res?.approvals) ? res.approvals : [];
          if (approvals.length === 0) return { text: "No pending approvals." };

          const lines = approvals.slice(0, 20).map((a: any) => {
            const id = a.approvalId;
            const reason = a.reason || "approval required";
            const tool = a.request?.toolName ? ` tool=${a.request.toolName}` : "";
            const exp = a.expiresAt ? ` expiresAt=${a.expiresAt}` : "";
            return `- ${id}${tool}${exp} — ${reason}`;
          });
          return { text: ["Pending approvals:", ...lines, approvals.length > 20 ? `(+${approvals.length - 20} more)` : ""].filter(Boolean).join("\n") };
        }

        if (sub === "approve" || sub === "deny") {
          if (!a1) return { text: `Missing approvalId. Usage: /guard ${sub} <approvalId>` };
          const out = await postJson<any>(`${cfg.guardBaseUrl}/v1/approvals/resolve`, { approvalId: a1, action: sub }, cfg.timeoutMs, getGuardAuthHeaders());
          if (!out?.ok) return { text: `Failed: ${out?.error || "unknown"}` };

          if (sub === "approve") {
            const p = pending.get(a1);
            if (p) {
              pending.delete(a1);
              enqueueAutoRetry(p);
            }
          }

          return { text: `${sub === "approve" ? "Approved" : "Denied"} ${a1}.` };
        }

        return { text: "Unknown subcommand. Try: /guard help" };
      },
    });
  }

  function register() {
    loadBreakerState();
    api.on("before_tool_call", onBeforeToolCall);
    api.on("after_tool_call", onAfterToolCall);
    registerCommands();

    // Kick off auto-bootstrap asynchronously. onBeforeToolCall awaits this
    // promise before running the decision chain; if it fails, we fall back
    // to the usual missing-key behavior.
    if (cfg.autoBootstrap && !getApiKey()) {
      bootstrapPromise = bootstrap().finally(() => { bootstrapPromise = null; });
    }

    // Only probe guard health at startup if guard is actually in the chain;
    // otherwise users running api/mcp-only setups pay for an unused localhost
    // probe on every plugin load.
    if (cfg.decisionChain.includes("guard")) {
      checkGuardHealth()
        .then((ok) => {
          if (ok) api.logger.info?.("vaibot-circuitbreaker: guard skill detected (health ok)");
          else api.logger.warn?.("vaibot-circuitbreaker: guard skill missing or unhealthy");
        })
        .catch(() => {
          api.logger.warn?.("vaibot-circuitbreaker: guard skill missing or unhealthy");
        });
    }

    if (cfg.approvalAutoRetry) {
      setInterval(() => {
        pollApprovals().catch((err) => api.logger.warn?.(`vaibot-circuitbreaker: approval poll failed (${String(err)})`));
      }, cfg.approvalPollMs).unref?.();
    }

    if (cfg.breakerProbeIntervalMs > 0) {
      setInterval(() => {
        probeUpstreams().catch((err) => api.logger.warn?.(`vaibot-circuitbreaker: probe failed (${String(err)})`));
      }, cfg.breakerProbeIntervalMs).unref?.();
    }

    api.logger.info?.(
      `vaibot-circuitbreaker loaded (mode=${cfg.mode}, agent=${cfg.agent}, ` +
        `guard=${cfg.guardBaseUrl}, mcp=${cfg.mcpBaseUrl}, api=${cfg.apiBaseUrl}, ` +
        `autoBootstrap=${cfg.autoBootstrap})`,
    );
  }

  return { register };
}

// Test exports (pure helpers)
export const __test = {
  clampStr,
  safeJson,
  stableStringify,
  sha256Hex,
  postJson,
  getJson,
  toSessionId,
  resolveConfig,
  parseMcpDecisionText,
  normalizeDecisionChain,
  classifyError,
  withRetries,
};
