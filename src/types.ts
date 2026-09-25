/**
 * Model ids the Grok CLI accepts. `default` omits `--model` so the CLI uses its configured default.
 * Run `grok models` to see the ids available to your account.
 */
export type GrokCliModelId =
  'default' | 'grok-4.7' | 'grok-4.7-build-fast' | 'grok-4.6' | 'grok-4.5' | (string & {})

/** Values accepted by `grok --permission-mode`. */
export type GrokPermissionMode =
  'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions' | 'plan'

/** Receives provider diagnostics. `debug` and `info` only fire when `verbose` is on. */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Settings for a Grok CLI language model. Pass them to `createGrokCli({ defaultSettings })`
 * or as the second argument of `grokCli(modelId, settings)`.
 */
export interface GrokCliSettings {
  /** Path to the `grok` binary. Defaults to `grok` on your PATH. */
  grokPath?: string
  /** Working directory the agent runs in. Defaults to the current process directory. */
  cwd?: string
  /** Extra environment variables for the Grok process, merged over `process.env`. */
  env?: Record<string, string | undefined>

  /** Permission mode for tool use. Omit to follow your Grok configuration. */
  permissionMode?: GrokPermissionMode
  /** Run every tool without asking. Deny rules and hooks still apply. */
  alwaysApprove?: boolean
  /** Permission allow rules, for example `Bash(npm *)`. */
  allow?: string[]
  /** Permission deny rules, for example `Bash(rm *)`. */
  deny?: string[]
  /** Allowlist of built-in tools. Grok ignores unknown names and keeps its MCP meta-tools. */
  tools?: string[]
  /** Built-in tools to remove. */
  disallowedTools?: string[]
  /** Remove the web search and web fetch tools. */
  disableWebSearch?: boolean
  /** Prevent the agent from spawning subagents. */
  noSubagents?: boolean
  /** Stop after this many agent turns. The call then finishes with reason `length`. */
  maxTurns?: number
  /** Reasoning effort, for example `low`, `high`, or `max`. Overrides the AI SDK `reasoning` option. */
  reasoningEffort?: string
  /** Extra rules appended to Grok's system prompt. AI SDK system messages are appended after these. */
  rules?: string
  /** Replace Grok's system prompt entirely. Grok then ignores `rules` and system messages. */
  systemPromptOverride?: string
  /** Sandbox profile for filesystem and network access. */
  sandbox?: string

  /**
   * Resume an existing Grok session by id. Only the newest user turn of the prompt is sent,
   * because the session already holds the earlier history.
   */
  resume?: string
  /** With `resume`, continue in a new session id instead of appending to the original. */
  forkSession?: boolean
  /** UUID for a new session. With `resume`, it names the forked session. */
  sessionId?: string

  /** Kill the Grok process and fail the call after this many milliseconds. No limit by default. */
  timeoutMs?: number
  /** Extra CLI arguments appended as-is, for flags this provider does not model. */
  extraArgs?: string[]

  /** Custom logger, or `false` to silence all provider logs. Defaults to `console`. */
  logger?: Logger | false
  /** Log debug and info messages. */
  verbose?: boolean
}

/** Settings you can override per call with `providerOptions: { 'grok-cli': { ... } }`. */
export type GrokCliProviderOptions = Pick<
  GrokCliSettings,
  'resume' | 'forkSession' | 'sessionId' | 'reasoningEffort' | 'maxTurns' | 'rules'
>

/** Metadata returned under `providerMetadata['grok-cli']`. */
export interface GrokCliProviderMetadata {
  sessionId?: string
  costUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
}
