import {
  InvalidPromptError,
  type LanguageModelV4FilePart,
  type LanguageModelV4Prompt,
  type LanguageModelV4ToolResultOutput
} from '@ai-sdk/provider'
import { convertToBase64, resolveFullMediaType } from '@ai-sdk/provider-utils'

/** ACP content block, the format `grok --prompt-file` accepts as a JSON array. */
export type GrokContentBlock =
  { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export interface GrokPrompt {
  blocks: GrokContentBlock[]
  /** Joined system messages, passed to Grok as extra rules. */
  system?: string
  warnings: string[]
}

type Message = LanguageModelV4Prompt[number]

/**
 * Converts an AI SDK prompt into Grok content blocks.
 *
 * A fresh session receives the whole conversation as a transcript. A resumed session
 * already holds the history, so `resuming` sends only the messages after the last assistant turn.
 */
export function convertToGrokPrompt(
  prompt: LanguageModelV4Prompt,
  { resuming = false }: { resuming?: boolean } = {}
): GrokPrompt {
  const warnings: string[] = []
  const images: GrokContentBlock[] = []
  const system = prompt
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')
  const conversation = prompt.filter(message => message.role !== 'system')

  let messages = conversation
  if (resuming) {
    const lastAssistant = conversation.findLastIndex(message => message.role === 'assistant')
    messages = conversation.slice(lastAssistant + 1)
  }
  if (messages.length === 0) {
    throw new InvalidPromptError({
      prompt,
      message: resuming
        ? 'Resuming a Grok session needs a new message after the last assistant turn.'
        : 'The prompt needs at least one user message.'
    })
  }

  const renderContext: RenderContext = { images, warnings }
  const onlyUserTurns = messages.every(message => message.role === 'user')
  const text = onlyUserTurns
    ? messages.map(message => renderUserContent(message, renderContext)).join('\n\n')
    : messages.map(message => renderTranscriptEntry(message, renderContext)).join('\n\n')

  return {
    blocks: [{ type: 'text', text }, ...images],
    system: system || undefined,
    warnings
  }
}

interface RenderContext {
  images: GrokContentBlock[]
  warnings: string[]
}

function renderTranscriptEntry(message: Message, context: RenderContext): string {
  switch (message.role) {
    case 'user':
      return `User: ${renderUserContent(message, context)}`
    case 'assistant':
      return message.content
        .map(part => {
          switch (part.type) {
            case 'text':
              return `Assistant: ${part.text}`
            case 'tool-call':
              return `Assistant called tool ${part.toolName} with input: ${JSON.stringify(part.input)}`
            case 'tool-result':
              return `Tool result (${part.toolName}): ${renderToolOutput(part.output)}`
            default:
              return undefined
          }
        })
        .filter(Boolean)
        .join('\n\n')
    case 'tool':
      return message.content
        .map(part =>
          part.type === 'tool-result'
            ? `Tool result (${part.toolName}): ${renderToolOutput(part.output)}`
            : `Tool approval (${part.approvalId}): ${part.approved ? 'approved' : 'denied'}`
        )
        .join('\n\n')
    default:
      return ''
  }
}

function renderUserContent(message: Message, context: RenderContext): string {
  if (message.role !== 'user') return ''
  return message.content
    .map(part => {
      if (part.type === 'text') return part.text
      const image = toImageBlock(part, context.warnings)
      if (!image) return undefined
      context.images.push(image)
      return `[Image ${context.images.length}]`
    })
    .filter(Boolean)
    .join('\n')
}

function toImageBlock(
  part: LanguageModelV4FilePart,
  warnings: string[]
): GrokContentBlock | undefined {
  if (!part.mediaType.startsWith('image/')) {
    warnings.push(`Grok CLI only accepts image files. Skipped a file of type ${part.mediaType}.`)
    return undefined
  }

  let data: string | Uint8Array | undefined
  if (part.data.type === 'data') {
    data = part.data.data
  } else if (part.data.type === 'url' && part.data.url.protocol === 'data:') {
    data = part.data.url.href.slice(part.data.url.href.indexOf(',') + 1)
  }
  if (data === undefined) {
    warnings.push('Grok CLI needs inline image data. Skipped an image passed by URL or reference.')
    return undefined
  }

  try {
    return {
      type: 'image',
      mimeType: resolveFullMediaType({ part: { ...part, data: { type: 'data', data } } }),
      data: convertToBase64(data)
    }
  } catch {
    warnings.push(
      `Skipped an image because its media type ${part.mediaType} could not be detected.`
    )
    return undefined
  }
}

function renderToolOutput(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'execution-denied':
      return `Execution denied${output.reason ? `: ${output.reason}` : ''}`
    case 'content':
      return output.value
        .map(item => (item.type === 'text' ? item.text : `[${item.type}]`))
        .join('\n')
  }
}
