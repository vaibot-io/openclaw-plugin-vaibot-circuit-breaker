declare module "openclaw/plugin-sdk" {
  export type OpenClawPluginApi = {
    pluginConfig: Record<string, unknown>;
    runtime: {
      state: { resolveStateDir: () => string };
      config: {
        writeConfigFile: (path: string, data: unknown) => void;
        loadConfig: (path: string) => unknown;
      };
      system: {
        enqueueSystemEvent: (text: string, opts: { sessionKey?: string; agentId?: string }) => void;
      };
    };
    logger: {
      info?: (msg: string) => void;
      warn?: (msg: string) => void;
      error?: (msg: string) => void;
    };
    on: (event: string, handler: (...args: any[]) => any) => void;
    registerCommand: (cmd: {
      name: string;
      description: string;
      acceptsArgs: boolean;
      handler: (ctx: { args?: string }) => Promise<{ text: string }>;
    }) => void;
  };

  export type PluginHookBeforeToolCallEvent = {
    toolName: string;
    params?: unknown;
    runId?: string;
    toolCallId?: string;
  };

  export type PluginHookAfterToolCallEvent = {
    toolName: string;
    params?: unknown;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  };

  export type PluginHookAgentContext = {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    channelId?: string;
    workspaceDir?: string;
  };

  export type PluginHookBeforeToolCallResult = {
    block: boolean;
    blockReason: string;
  };
}
