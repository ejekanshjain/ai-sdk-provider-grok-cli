import { readFileSync } from 'node:fs'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { GrokStreamMapper, mapFinishReason, mapUsage, type GrokEvent } from './grok-stream-mapper'

// Recorded from `grok -p ... --output-format streaming-messages-json --include-partial-messages`
// with Grok CLI 1.0.41: two tool calls (search_tool, read_file), then a text answer.
const fixture = readFileSync(new URL('./__fixtures__/tool-call-run.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line) as GrokEvent)

function replay(events: GrokEvent[], jsonMode = false) {
  let id = 0
  const mapper = new GrokStreamMapper({ jsonMode, generateId: () => `id-${id++}` })
  const parts = events.flatMap(event => mapper.handle(event))
  parts.push(...mapper.flush())
  return { mapper, parts }
}

const ofType = <T extends LanguageModelV4StreamPart['type']>(
  parts: LanguageModelV4StreamPart[],
  type: T
) =>
  parts.filter(
    (part): part is Extract<LanguageModelV4StreamPart, { type: T }> => part.type === type
  )

describe('GrokStreamMapper', () => {
  it('maps a recorded run into ordered text, reasoning, and tool parts', () => {
    const { mapper, parts } = replay(fixture)

    expect(mapper.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(parts[0]).toMatchObject({ type: 'response-metadata', id: mapper.sessionId })
    expect(ofType(parts, 'reasoning-delta').length).toBeGreaterThan(0)

    const calls = ofType(parts, 'tool-call')
    const results = ofType(parts, 'tool-result')
    expect(calls.map(call => call.toolName)).toEqual(['search_tool', 'read_file'])
    expect(results.map(result => result.toolCallId)).toEqual(calls.map(call => call.toolCallId))
    expect(calls.every(call => call.providerExecuted && call.dynamic)).toBe(true)
    expect(JSON.parse(calls[1]!.input)).toEqual({ target_file: '/tmp/grok-e2e/secret.txt' })
    expect(results[1]!.result).toMatchObject({ type: 'ReadFile' })

    const text = ofType(parts, 'text-delta')
      .map(part => part.delta)
      .join('')
    expect(text).toBe('PINEAPPLE-7')
    expect(ofType(parts, 'text-start')).toHaveLength(ofType(parts, 'text-end').length)
    expect(mapper.result?.stop_reason).toBe('end_turn')
  })

  it('builds parts from complete assistant messages when partial events are missing', () => {
    const { parts } = replay([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Look it up.' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { target_file: 'a.txt' } }
          ]
        }
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'hello', is_error: true }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
    ])

    expect(ofType(parts, 'reasoning-delta')[0]?.delta).toBe('Look it up.')
    expect(ofType(parts, 'tool-call')[0]).toMatchObject({
      toolCallId: 'call_1',
      input: '{"target_file":"a.txt"}'
    })
    expect(ofType(parts, 'tool-result')[0]).toMatchObject({ result: 'hello', isError: true })
    expect(ofType(parts, 'text-delta')[0]?.delta).toBe('Done.')
  })

  it('emits only the structured output as text in JSON mode', () => {
    const { parts } = replay(
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Let me think. {"a":1}' }] }
        },
        { type: 'result', subtype: 'success', structured_output: { a: 1 } } as GrokEvent
      ],
      true
    )

    expect(ofType(parts, 'text-delta').map(part => part.delta)).toEqual(['{"a":1}'])
  })

  it('ignores subagent traffic', () => {
    const { parts } = replay([
      {
        type: 'assistant',
        parent_tool_use_id: 'call_parent',
        message: { content: [{ type: 'text', text: 'subagent chatter' }] }
      }
    ])

    expect(parts).toEqual([])
  })
})

describe('mapFinishReason', () => {
  it('treats a max-turns stop as a length finish', () => {
    expect(mapFinishReason({ type: 'result', subtype: 'error_max_turns' })).toEqual({
      unified: 'length',
      raw: 'max_turns'
    })
    expect(mapFinishReason({ type: 'result', stop_reason: 'end_turn' }).unified).toBe('stop')
  })
})

describe('mapUsage', () => {
  it('adds cache buckets to the uncached input count', () => {
    const usage = mapUsage({
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 10,
      output_tokens: 50,
      reasoning_tokens: 20
    })

    expect(usage.inputTokens).toEqual({ total: 1010, noCache: 100, cacheRead: 900, cacheWrite: 10 })
    expect(usage.outputTokens).toEqual({ total: 50, text: 30, reasoning: 20 })
  })
})
