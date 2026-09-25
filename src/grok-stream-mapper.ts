import type {
  JSONObject,
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage
} from '@ai-sdk/provider'

/** One NDJSON line from `grok --output-format streaming-messages-json`. Fields are read defensively. */
export interface GrokEvent {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  parent_tool_use_id?: string | null
  event?: StreamEvent
  /** Message body on `assistant`/`user` lines, or error text on `error` lines. */
  message?: { content?: unknown } | string
}

/** The terminal `result` line, carrying spend, stop reason, and structured output. */
export interface GrokResultEvent {
  type: 'result'
  subtype?: string
  is_error?: boolean
  result?: string
  stop_reason?: string
  session_id?: string
  num_turns?: number
  duration_ms?: number
  duration_api_ms?: number
  total_cost_usd?: number
  usage?: Record<string, unknown>
  modelUsage?: Record<string, unknown>
  structured_output?: unknown
  errors?: unknown[]
}

interface StreamEvent {
  type: string
  index?: number
  content_block?: ContentBlock
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
}

interface ContentBlock {
  type: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  thinking?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

type OpenBlock =
  | { kind: 'text' | 'reasoning'; id: string; text: string }
  | { kind: 'tool'; toolCallId: string; toolName: string; input: string }

const TOOL_USE_TYPES = new Set(['tool_use', 'server_tool_use'])

/**
 * Converts Grok's Messages-format events into AI SDK stream parts, one event at a time.
 * Every tool runs inside Grok, so tool parts are marked `providerExecuted` and `dynamic`.
 *
 * In JSON mode, text is held back and emitted once at the end, because Grok's
 * `structured_output` is the authoritative answer and earlier turns may contain prose.
 */
export class GrokStreamMapper {
  sessionId?: string
  modelId?: string
  result?: GrokResultEvent
  errorMessage?: string

  private blocks = new Map<number, OpenBlock>()
  private streamedMessage = false
  private lastMessageText = ''
  private textInEarlierMessage = false
  private textInThisMessage = false
  private toolNames = new Map<string, string>()
  private emittedToolCalls = new Set<string>()
  private emittedToolResults = new Set<string>()

  constructor(private readonly options: { jsonMode: boolean; generateId: () => string }) {}

  handle(event: GrokEvent): LanguageModelV4StreamPart[] {
    switch (event.type) {
      case 'system':
        return this.handleSystem(event)
      case 'stream_event':
        return isSubagent(event) || !event.event ? [] : this.handleStreamEvent(event.event)
      case 'assistant':
        return isSubagent(event) ? [] : this.handleAssistant(contentBlocks(event))
      case 'user':
        return isSubagent(event) ? [] : this.handleToolResults(contentBlocks(event))
      case 'result':
        this.result = event as unknown as GrokResultEvent
        this.sessionId = this.result.session_id ?? this.sessionId
        return []
      case 'error':
        this.errorMessage = typeof event.message === 'string' ? event.message : 'Grok CLI error'
        return []
      default:
        return []
    }
  }

  /** Closes open parts and, in JSON mode, emits the final JSON text. Call once before `finish`. */
  flush(): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = []
    for (const index of [...this.blocks.keys()]) parts.push(...this.closeBlock(index))
    if (this.options.jsonMode) {
      const structured = this.result?.structured_output
      const text = structured == null ? this.lastMessageText.trim() : JSON.stringify(structured)
      if (text) parts.push(...this.textPart(text))
    }
    return parts
  }

  private handleSystem(event: GrokEvent): LanguageModelV4StreamPart[] {
    if (event.subtype !== 'init') return []
    this.sessionId = event.session_id
    this.modelId = event.model
    return [
      {
        type: 'response-metadata',
        id: event.session_id,
        modelId: event.model,
        timestamp: new Date()
      }
    ]
  }

  private handleStreamEvent(event: StreamEvent): LanguageModelV4StreamPart[] {
    const index = event.index ?? 0
    switch (event.type) {
      case 'message_start':
        this.streamedMessage = true
        this.startMessage()
        return []
      case 'content_block_start':
        return event.content_block ? this.openBlock(index, event.content_block) : []
      case 'content_block_delta':
        return this.appendDelta(index, event.delta ?? {})
      case 'content_block_stop':
        return this.closeBlock(index)
      default:
        return []
    }
  }

  private openBlock(index: number, block: ContentBlock): LanguageModelV4StreamPart[] {
    if (block.type === 'text' || block.type === 'thinking') {
      const kind = block.type === 'text' ? 'text' : 'reasoning'
      const open: OpenBlock = { kind, id: this.options.generateId(), text: '' }
      this.blocks.set(index, open)
      if (kind === 'text' && this.options.jsonMode) return []
      return [{ type: kind === 'text' ? 'text-start' : 'reasoning-start', id: open.id }]
    }
    if (TOOL_USE_TYPES.has(block.type) && block.id && !this.emittedToolCalls.has(block.id)) {
      const toolName = block.name ?? 'unknown'
      this.toolNames.set(block.id, toolName)
      this.blocks.set(index, { kind: 'tool', toolCallId: block.id, toolName, input: '' })
      return [
        { type: 'tool-input-start', id: block.id, toolName, providerExecuted: true, dynamic: true }
      ]
    }
    return this.handleToolResults([block])
  }

  private appendDelta(
    index: number,
    delta: NonNullable<StreamEvent['delta']>
  ): LanguageModelV4StreamPart[] {
    const open = this.blocks.get(index)
    if (!open) return []
    const text =
      open.kind === 'tool' ? delta.partial_json : open.kind === 'text' ? delta.text : delta.thinking
    if (!text) return []

    if (open.kind === 'tool') {
      open.input += text
      return [{ type: 'tool-input-delta', id: open.toolCallId, delta: text }]
    }
    open.text += text
    if (open.kind === 'text') {
      this.lastMessageText += text
      if (this.options.jsonMode) return []
      return [{ type: 'text-delta', id: open.id, delta: this.separated(text) }]
    }
    return [{ type: 'reasoning-delta', id: open.id, delta: text }]
  }

  private closeBlock(index: number): LanguageModelV4StreamPart[] {
    const open = this.blocks.get(index)
    if (!open) return []
    this.blocks.delete(index)
    if (open.kind === 'tool') {
      this.emittedToolCalls.add(open.toolCallId)
      return [
        { type: 'tool-input-end', id: open.toolCallId },
        this.toolCall(open.toolCallId, open.toolName, open.input || '{}')
      ]
    }
    if (open.kind === 'text' && this.options.jsonMode) return []
    return [{ type: open.kind === 'text' ? 'text-end' : 'reasoning-end', id: open.id }]
  }

  /**
   * A complete assistant message follows its partial events. When partial events already
   * streamed it, only tool calls missing from the stream are emitted.
   */
  private handleAssistant(content: ContentBlock[]): LanguageModelV4StreamPart[] {
    const streamed = this.streamedMessage
    this.streamedMessage = false
    const parts: LanguageModelV4StreamPart[] = []
    if (!streamed) this.startMessage()

    for (const block of content) {
      if (TOOL_USE_TYPES.has(block.type) && block.id) {
        if (this.emittedToolCalls.has(block.id)) continue
        const toolName = block.name ?? 'unknown'
        const input = JSON.stringify(block.input ?? {})
        this.toolNames.set(block.id, toolName)
        this.emittedToolCalls.add(block.id)
        parts.push(
          {
            type: 'tool-input-start',
            id: block.id,
            toolName,
            providerExecuted: true,
            dynamic: true
          },
          { type: 'tool-input-delta', id: block.id, delta: input },
          { type: 'tool-input-end', id: block.id },
          this.toolCall(block.id, toolName, input)
        )
      } else if (streamed) {
        continue
      } else if (block.type === 'text' && block.text) {
        this.lastMessageText += block.text
        if (!this.options.jsonMode) parts.push(...this.textPart(this.separated(block.text)))
      } else if (block.type === 'thinking' && block.thinking) {
        const id = this.options.generateId()
        parts.push(
          { type: 'reasoning-start', id },
          { type: 'reasoning-delta', id, delta: block.thinking },
          { type: 'reasoning-end', id }
        )
      } else {
        parts.push(...this.handleToolResults([block]))
      }
    }
    return parts
  }

  /** Emits `tool_result` and inline `web_search_tool_result` blocks, once per tool call. */
  private handleToolResults(content: ContentBlock[]): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = []
    for (const block of content) {
      const isResult = block.type === 'tool_result' || block.type === 'web_search_tool_result'
      const toolCallId = block.tool_use_id
      if (!isResult || !toolCallId || this.emittedToolResults.has(toolCallId)) continue
      this.emittedToolResults.add(toolCallId)

      const toolName = this.toolNames.get(toolCallId) ?? 'unknown'
      if (!this.emittedToolCalls.has(toolCallId)) {
        this.emittedToolCalls.add(toolCallId)
        parts.push(this.toolCall(toolCallId, toolName, '{}'))
      }
      const isError =
        block.is_error === true ||
        (isObject(block.content) && block.content.type === 'web_search_tool_result_error')
      parts.push({
        type: 'tool-result',
        toolCallId,
        toolName,
        result: normalizeToolResult(block.content),
        isError,
        dynamic: true
      })
    }
    return parts
  }

  private toolCall(toolCallId: string, toolName: string, input: string): LanguageModelV4StreamPart {
    return { type: 'tool-call', toolCallId, toolName, input, providerExecuted: true, dynamic: true }
  }

  /** Marks the start of a new model message. Grok sends one message per agent turn. */
  private startMessage() {
    this.textInEarlierMessage ||= this.textInThisMessage
    this.textInThisMessage = false
    this.lastMessageText = ''
  }

  /**
   * Prefixes the first text of a later turn with a blank line. All Grok turns form one AI SDK
   * step, so without it the text before and after a tool call runs together.
   */
  private separated(text: string): string {
    const prefix = this.textInEarlierMessage && !this.textInThisMessage ? '\n\n' : ''
    this.textInThisMessage = true
    return prefix + text
  }

  private textPart(text: string): LanguageModelV4StreamPart[] {
    const id = this.options.generateId()
    return [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
      { type: 'text-end', id }
    ]
  }
}

/** Maps Grok's snake_case stop reason (and result subtype) to the AI SDK finish reason. */
export function mapFinishReason(result: GrokResultEvent | undefined): LanguageModelV4FinishReason {
  const raw = result?.subtype === 'error_max_turns' ? 'max_turns' : result?.stop_reason
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { unified: 'stop', raw }
    case 'max_tokens':
    case 'max_turns':
    case 'max_turn_requests':
      return { unified: 'length', raw }
    case 'refusal':
      return { unified: 'content-filter', raw }
    default:
      return { unified: 'other', raw }
  }
}

/**
 * Converts Grok's result usage to AI SDK usage. Grok reports `input_tokens` without cache hits,
 * and `output_tokens` includes reasoning tokens.
 */
export function mapUsage(usage: Record<string, unknown> | undefined): LanguageModelV4Usage {
  const noCache = asNumber(usage?.input_tokens)
  const cacheRead = asNumber(usage?.cache_read_input_tokens)
  const cacheWrite = asNumber(usage?.cache_creation_input_tokens)
  const output = asNumber(usage?.output_tokens)
  const reasoning = asNumber(usage?.reasoning_tokens)
  const inputTotal =
    noCache === undefined ? undefined : noCache + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    inputTokens: { total: inputTotal, noCache, cacheRead, cacheWrite },
    outputTokens: {
      total: output,
      text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
      reasoning
    },
    raw: usage as JSONObject | undefined
  }
}

/** Builds `providerMetadata['grok-cli']` from the result line. */
export function buildProviderMetadata(
  sessionId: string | undefined,
  result: GrokResultEvent | undefined
): JSONObject {
  const metadata: JSONObject = {
    sessionId,
    costUsd: result?.total_cost_usd,
    durationMs: result?.duration_ms,
    durationApiMs: result?.duration_api_ms,
    numTurns: result?.num_turns,
    modelUsage: result?.modelUsage as JSONObject | undefined
  }
  for (const key of Object.keys(metadata)) {
    if (metadata[key] === undefined) delete metadata[key]
  }
  return metadata
}

function normalizeToolResult(content: unknown): NonNullable<JSONValue> {
  if (Array.isArray(content) && content.every(item => isObject(item) && item.type === 'text')) {
    content = content.map(item => (item as { text: string }).text).join('\n')
  }
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed) as NonNullable<JSONValue>
      } catch {
        // Looks like JSON but is not, so keep the original string.
      }
    }
    return content
  }
  return (content ?? '') as NonNullable<JSONValue>
}

function contentBlocks(event: GrokEvent): ContentBlock[] {
  const content = typeof event.message === 'object' ? event.message.content : undefined
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isObject) : []
}

function isSubagent(event: GrokEvent): boolean {
  return event.parent_tool_use_id != null
}

function isObject(value: unknown): value is Record<string, unknown> & ContentBlock {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
