import { APICallError, LoadAPIKeyError } from '@ai-sdk/provider'

/** Pseudo-URL recorded on errors, since the provider talks to a local process instead of HTTP. */
export const GROK_CLI_URL = 'grok-cli://headless'

const AUTH_PATTERN =
  /not (logged in|authenticated)|unauthori[sz]ed|authentication (failed|required)|invalid api key|grok login|\b401\b/i
const RATE_LIMIT_PATTERN = /rate.?limit|usage limit|too many requests|\b429\b/i

export interface GrokErrorDetails {
  message: string
  exitCode?: number | null
  stderr?: string
  args?: string[]
  cause?: unknown
}

/**
 * Converts a Grok CLI failure into an AI SDK error. Sign-in problems become `LoadAPIKeyError`.
 * Only rate limits are retryable, because a retried agent run can repeat file edits and commands.
 */
export function createGrokError({
  message,
  exitCode,
  stderr,
  args,
  cause
}: GrokErrorDetails): APICallError | LoadAPIKeyError {
  const haystack = `${message}\n${stderr ?? ''}`
  if (AUTH_PATTERN.test(haystack)) {
    return new LoadAPIKeyError({
      message: `Grok CLI is not signed in: ${message}. Run 'grok login' or set XAI_API_KEY.`
    })
  }
  const stderrTail = stderr?.trim().slice(-1000)
  return new APICallError({
    message:
      stderrTail && !message.includes(stderrTail) ? `${message} | stderr: ${stderrTail}` : message,
    url: GROK_CLI_URL,
    requestBodyValues: { args },
    isRetryable: RATE_LIMIT_PATTERN.test(haystack),
    cause,
    data: { exitCode: exitCode ?? undefined, stderr: stderrTail }
  })
}

/** Error for a missing `grok` binary, with install guidance. */
export function createNotFoundError(grokPath: string, cause: unknown): APICallError {
  return new APICallError({
    message: `Grok CLI not found at '${grokPath}'. Install it with 'curl -fsSL https://x.ai/cli/install.sh | bash' or set grokPath.`,
    url: GROK_CLI_URL,
    requestBodyValues: {},
    isRetryable: false,
    cause
  })
}

/** Error for a call that exceeded `timeoutMs`. */
export function createTimeoutError(timeoutMs: number): APICallError {
  return new APICallError({
    message: `Grok CLI timed out after ${timeoutMs} ms and was stopped.`,
    url: GROK_CLI_URL,
    requestBodyValues: {},
    isRetryable: false,
    data: { code: 'TIMEOUT', timeoutMs }
  })
}
