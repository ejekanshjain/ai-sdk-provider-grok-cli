import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  NoSuchModelError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
  type SharedV4Warning
} from '@ai-sdk/provider'
import { generateId, parseProviderOptions } from '@ai-sdk/provider-utils'
import { convertToGrokPrompt } from './convert-to-grok-prompt'
import { createGrokError, createNotFoundError, createTimeoutError } from './errors'
import {
  buildProviderMetadata,
  GrokStreamMapper,
  mapFinishReason,
  mapUsage,
  type GrokEvent
} from './grok-stream-mapper'
import { resolveLogger } from './logger'
import type { GrokCliModelId, GrokCliSettings, Logger } from './types'
import { getSettingsWarnings, grokCliProviderOptionsSchema } from './validation'

export const PROVIDER_ID = 'grok-cli'

/** Grace period for Grok to exit on its own after its final line, before it gets SIGTERM. */
const EXIT_GRACE_MS = 10_000
/** Grace period between SIGTERM and SIGKILL. Grok saves the session on SIGTERM. */
const KILL_GRACE_MS = 5_000
const STDERR_LIMIT = 16_384

const UNSUPPORTED_OPTIONS = [
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed',
  'maxOutputTokens'
] as const

type TextContent = Extract<LanguageModelV4Content, { type: 'text' | 'reasoning' }>

interface CallPlan {
  args: string[]
  blocks: unknown[]
  jsonMode: boolean
  warnings: SharedV4Warning[]
  settings: GrokCliSettings
}

/**
 * AI SDK language model backed by the Grok CLI in headless mode.
 * Each call spawns `grok` once, streams its Messages-format NDJSON, and exits.
 */
export class GrokCliLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4'
  readonly provider = PROVIDER_ID
  readonly supportedUrls = {}
  readonly modelId: GrokCliModelId

  private readonly settings: GrokCliSettings
  private readonly logger: Logger

  constructor({ modelId, settings = {} }: { modelId: GrokCliModelId; settings?: GrokCliSettings }) {
    if (!modelId.trim()) {
      throw new NoSuchModelError({ modelId, modelType: 'languageModel' })
    }
    this.modelId = modelId
    this.settings = settings
    this.logger = resolveLogger(settings.logger, settings.verbose)
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { stream, request } = await this.doStream(options)
    const content: LanguageModelV4Content[] = []
    const openParts = new Map<string, TextContent>()
    let warnings: SharedV4Warning[] = []
    let response: LanguageModelV4GenerateResult['response']
    let finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> | undefined

    for await (const part of stream) {
      switch (part.type) {
        case 'stream-start':
          warnings = part.warnings
          break
        case 'response-metadata':
          response = { id: part.id, modelId: part.modelId, timestamp: part.timestamp }
          break
        case 'text-start':
        case 'reasoning-start': {
          const entry: TextContent =
            part.type === 'text-start'
              ? { type: 'text', text: '' }
              : { type: 'reasoning', text: '' }
          openParts.set(part.id, entry)
          content.push(entry)
          break
        }
        case 'text-delta':
        case 'reasoning-delta': {
          const open = openParts.get(part.id)
          if (open) open.text += part.delta
          break
        }
        case 'tool-call':
        case 'tool-result':
          content.push(part)
          break
        case 'error':
          throw part.error
        case 'finish':
          finish = part
          break
      }
    }

    if (!finish) throw createGrokError({ message: 'Grok CLI stream ended without a result' })
    return {
      content,
      finishReason: finish.finishReason,
      usage: finish.usage,
      providerMetadata: finish.providerMetadata,
      request,
      response,
      warnings
    }
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const signal = options.abortSignal
    signal?.throwIfAborted()

    const plan = await this.planCall(options)
    const tempDir = await mkdtemp(join(tmpdir(), 'grok-cli-'))
    const promptFile = join(tempDir, 'prompt.json')
    await writeFile(promptFile, JSON.stringify(plan.blocks), { mode: 0o600 })
    const args = [`--prompt-file=${promptFile}`, ...plan.args]
    const grokPath = plan.settings.grokPath ?? 'grok'
    const mapper = new GrokStreamMapper({ jsonMode: plan.jsonMode, generateId })
    const logger = this.logger
    // Shared with `cancel`, which runs when the consumer stops reading early.
    let settled = false
    let stopProcess = () => {}

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        let stderr = ''
        let timeout: NodeJS.Timeout | undefined
        let exitGrace: NodeJS.Timeout | undefined

        logger.debug(`spawning ${grokPath} ${plan.args.join(' ')}`)
        const child = spawn(grokPath, args, {
          cwd: plan.settings.cwd,
          env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1', ...plan.settings.env },
          stdio: ['ignore', 'pipe', 'pipe']
        })

        stopProcess = () => {
          if (child.exitCode !== null || child.signalCode !== null) return
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
        }

        const cleanup = () => {
          clearTimeout(timeout)
          signal?.removeEventListener('abort', onAbort)
          rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }

        const enqueue = (part: LanguageModelV4StreamPart) => {
          if (!settled) controller.enqueue(part)
        }

        const fail = (error: unknown) => {
          if (settled) return
          enqueue({ type: 'error', error })
          settled = true
          controller.close()
          stopProcess()
          cleanup()
        }

        const complete = () => {
          if (settled) return
          mapper.flush().forEach(enqueue)
          enqueue({
            type: 'finish',
            usage: mapUsage(mapper.result?.usage),
            finishReason: mapFinishReason(mapper.result),
            providerMetadata: {
              [PROVIDER_ID]: buildProviderMetadata(mapper.sessionId, mapper.result)
            }
          })
          settled = true
          controller.close()
          cleanup()
          exitGrace = setTimeout(stopProcess, EXIT_GRACE_MS)
          exitGrace.unref()
        }

        function onAbort() {
          if (settled) return
          settled = true
          controller.error(signal?.reason)
          stopProcess()
          cleanup()
        }

        signal?.addEventListener('abort', onAbort, { once: true })
        if (plan.settings.timeoutMs) {
          const ms = plan.settings.timeoutMs
          timeout = setTimeout(() => fail(createTimeoutError(ms)), ms)
        }

        enqueue({ type: 'stream-start', warnings: plan.warnings })

        createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
          if (settled || !line.trim()) return
          let event: GrokEvent
          try {
            event = JSON.parse(line) as GrokEvent
          } catch {
            logger.debug(`skipping non-JSON stdout line: ${line.slice(0, 200)}`)
            return
          }
          if (options.includeRawChunks) enqueue({ type: 'raw', rawValue: event })
          mapper.handle(event).forEach(enqueue)

          const result = mapper.result
          if (event.type !== 'result' || !result) return
          if (result.is_error && result.subtype !== 'error_max_turns') {
            const errors = Array.isArray(result.errors) ? result.errors.join('; ') : ''
            fail(
              createGrokError({
                message: errors || result.result || `Grok CLI run failed (${result.subtype})`,
                stderr,
                args
              })
            )
          } else {
            complete()
          }
        })

        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)
        })

        child.on('error', (error: NodeJS.ErrnoException) => {
          fail(
            error.code === 'ENOENT'
              ? createNotFoundError(grokPath, error)
              : createGrokError({ message: error.message, stderr, args, cause: error })
          )
          cleanup()
        })

        child.on('close', (exitCode, exitSignal) => {
          clearTimeout(exitGrace)
          cleanup()
          if (settled) return
          if (mapper.result) return complete()
          const message =
            mapper.errorMessage ??
            (exitCode === 0
              ? 'Grok CLI exited without a result'
              : `Grok CLI exited with ${exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`}`)
          fail(createGrokError({ message, exitCode, stderr, args }))
        })
      },
      cancel() {
        settled = true
        stopProcess()
      }
    })

    return { stream, request: { body: { args: plan.args } } }
  }

  /** Merges per-call options into the settings, converts the prompt, and builds CLI arguments. */
  private async planCall(options: LanguageModelV4CallOptions): Promise<CallPlan> {
    const callOptions = await parseProviderOptions({
      provider: PROVIDER_ID,
      providerOptions: options.providerOptions,
      schema: grokCliProviderOptionsSchema
    })
    const settings: GrokCliSettings = { ...this.settings, ...callOptions }
    const warnings: SharedV4Warning[] = []
    const warn = (message: string) => {
      warnings.push({ type: 'other', message })
      this.logger.warn(message)
    }

    for (const option of UNSUPPORTED_OPTIONS) {
      if (options[option] !== undefined) {
        warnings.push({ type: 'unsupported', feature: option, details: 'Grok CLI ignores it.' })
      }
    }
    if (options.tools?.length) {
      warnings.push({
        type: 'unsupported',
        feature: 'tools',
        details: 'Grok CLI runs its own built-in and MCP tools. Custom AI SDK tools are ignored.'
      })
    }
    if (options.toolChoice && options.toolChoice.type !== 'auto') {
      warnings.push({ type: 'unsupported', feature: 'toolChoice' })
    }

    const schema =
      options.responseFormat?.type === 'json' ? options.responseFormat.schema : undefined
    if (options.responseFormat?.type === 'json' && !schema) {
      warnings.push({
        type: 'unsupported',
        feature: 'responseFormat',
        details: 'JSON output without a schema runs as plain text. Pass a schema to enforce JSON.'
      })
    }

    const prompt = convertToGrokPrompt(options.prompt, { resuming: Boolean(settings.resume) })
    prompt.warnings.forEach(warn)
    getSettingsWarnings(settings).forEach(warn)
    if (settings.systemPromptOverride !== undefined && prompt.system) {
      warn('System messages are ignored because systemPromptOverride replaces the system prompt.')
    }

    const reasoningEffort =
      settings.reasoningEffort ??
      (options.reasoning && options.reasoning !== 'provider-default'
        ? options.reasoning
        : undefined)
    const rules = [settings.rules, prompt.system].filter(Boolean).join('\n\n')

    return {
      args: buildArgs({ modelId: this.modelId, settings, reasoningEffort, rules, schema }),
      blocks: prompt.blocks,
      jsonMode: Boolean(schema),
      warnings,
      settings
    }
  }
}

/**
 * Builds the CLI arguments for one headless call, excluding the prompt file.
 * Values use `--flag=value` so text starting with `-`, like a markdown list, is not read as a flag.
 */
export function buildArgs({
  modelId,
  settings,
  reasoningEffort,
  rules,
  schema
}: {
  modelId: string
  settings: GrokCliSettings
  reasoningEffort?: string
  rules?: string
  schema?: unknown
}): string[] {
  const args = ['--output-format', 'streaming-messages-json', '--include-partial-messages']
  const add = (flag: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') args.push(`${flag}=${value}`)
  }

  if (modelId !== 'default') add('--model', modelId)
  add('--reasoning-effort', reasoningEffort)
  if (schema) add('--json-schema', JSON.stringify(schema))

  add('--resume', settings.resume)
  if (settings.resume && settings.forkSession) args.push('--fork-session')
  if (!settings.resume || settings.forkSession) add('--session-id', settings.sessionId)

  if (settings.alwaysApprove) args.push('--always-approve')
  add('--permission-mode', settings.permissionMode)
  settings.allow?.forEach(rule => add('--allow', rule))
  settings.deny?.forEach(rule => add('--deny', rule))
  add('--tools', settings.tools?.join(','))
  add('--disallowed-tools', settings.disallowedTools?.join(','))
  if (settings.disableWebSearch) args.push('--disable-web-search')
  if (settings.noSubagents) args.push('--no-subagents')
  add('--max-turns', settings.maxTurns)
  add('--sandbox', settings.sandbox)

  if (settings.systemPromptOverride !== undefined) {
    args.push(`--system-prompt-override=${settings.systemPromptOverride}`)
  } else {
    add('--rules', rules)
  }

  args.push(...(settings.extraArgs ?? []))
  return args
}
