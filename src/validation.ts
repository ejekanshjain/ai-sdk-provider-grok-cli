import { z } from 'zod'
import type { GrokCliProviderOptions, GrokCliSettings } from './types'

const nonEmpty = z.string().trim().min(1)

const loggerSchema = z.custom<GrokCliSettings['logger']>(
  value =>
    value === false ||
    (typeof value === 'object' &&
      value !== null &&
      ['debug', 'info', 'warn', 'error'].every(
        method => typeof (value as Record<string, unknown>)[method] === 'function'
      )),
  'logger must be false or an object with debug, info, warn, and error methods'
)

/** Per-call overrides accepted under `providerOptions['grok-cli']`. */
export const grokCliProviderOptionsSchema = z
  .object({
    resume: nonEmpty.optional(),
    forkSession: z.boolean().optional(),
    sessionId: z.uuid().optional(),
    reasoningEffort: nonEmpty.optional(),
    maxTurns: z.number().int().positive().optional(),
    rules: z.string().optional()
  })
  .strict() satisfies z.ZodType<GrokCliProviderOptions>

export const grokCliSettingsSchema = grokCliProviderOptionsSchema
  .extend({
    grokPath: nonEmpty.optional(),
    cwd: nonEmpty.optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    permissionMode: z
      .enum(['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'])
      .optional(),
    alwaysApprove: z.boolean().optional(),
    allow: z.array(nonEmpty).optional(),
    deny: z.array(nonEmpty).optional(),
    tools: z.array(nonEmpty).min(1, 'tools must list at least one tool').optional(),
    disallowedTools: z.array(nonEmpty).optional(),
    disableWebSearch: z.boolean().optional(),
    noSubagents: z.boolean().optional(),
    systemPromptOverride: z.string().optional(),
    sandbox: nonEmpty.optional(),
    timeoutMs: z.number().int().positive().optional(),
    extraArgs: z.array(z.string()).optional(),
    logger: loggerSchema.optional(),
    verbose: z.boolean().optional()
  })
  .strict() satisfies z.ZodType<GrokCliSettings>

/**
 * Validates settings and returns warnings for conflicting options.
 * Throws a descriptive error when a setting has the wrong shape.
 */
export function validateSettings(settings: GrokCliSettings): { warnings: string[] } {
  const parsed = grokCliSettingsSchema.safeParse(settings)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid Grok CLI settings: ${issues.join('; ')}`)
  }
  return { warnings: getSettingsWarnings(settings) }
}

/** Returns warnings for setting combinations the Grok CLI rejects or ignores. */
export function getSettingsWarnings(settings: GrokCliSettings): string[] {
  const warnings: string[] = []
  if (settings.sessionId && settings.resume && !settings.forkSession) {
    warnings.push('sessionId is ignored with resume unless forkSession is true.')
  }
  if (settings.forkSession && !settings.resume) {
    warnings.push('forkSession has no effect without resume.')
  }
  if (
    settings.alwaysApprove &&
    settings.permissionMode &&
    settings.permissionMode !== 'bypassPermissions'
  ) {
    warnings.push(`alwaysApprove overrides permissionMode '${settings.permissionMode}'.`)
  }
  if (settings.systemPromptOverride !== undefined && settings.rules) {
    warnings.push(
      'rules are ignored because systemPromptOverride replaces the whole system prompt.'
    )
  }
  return warnings
}
