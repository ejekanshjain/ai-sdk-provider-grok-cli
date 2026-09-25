import type { LanguageModelV4Prompt } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { convertToGrokPrompt } from './convert-to-grok-prompt'

// Smallest valid PNG header, enough for media type sniffing.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const conversation: LanguageModelV4Prompt = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: [{ type: 'text', text: 'What is in a.txt?' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read_file',
        output: { type: 'text', value: 'hello' }
      },
      { type: 'text', text: 'It says hello.' }
    ]
  },
  { role: 'user', content: [{ type: 'text', text: 'Translate it to French.' }] }
]

describe('convertToGrokPrompt', () => {
  it('sends a lone user message as plain text and system messages separately', () => {
    const prompt = convertToGrokPrompt([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] }
    ])

    expect(prompt).toEqual({
      blocks: [{ type: 'text', text: 'Hi' }],
      system: 'Be brief.',
      warnings: []
    })
  })

  it('flattens a multi-turn conversation into a transcript', () => {
    const [block] = convertToGrokPrompt(conversation).blocks

    expect(block).toEqual({
      type: 'text',
      text: [
        'User: What is in a.txt?',
        'Assistant called tool read_file with input: {"path":"a.txt"}\n\n' +
          'Tool result (read_file): hello\n\n' +
          'Assistant: It says hello.',
        'User: Translate it to French.'
      ].join('\n\n')
    })
  })

  it('sends only the newest turn when resuming a session', () => {
    const prompt = convertToGrokPrompt(conversation, { resuming: true })

    expect(prompt.blocks).toEqual([{ type: 'text', text: 'Translate it to French.' }])
  })

  it('rejects a resume with no new message after the assistant', () => {
    expect(() => convertToGrokPrompt(conversation.slice(0, 3), { resuming: true })).toThrow(
      /needs a new message/
    )
  })

  it('attaches images as base64 blocks and skips other files with a warning', () => {
    const prompt = convertToGrokPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'file', mediaType: 'image/*', data: { type: 'data', data: PNG_BYTES } },
          { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'JVBERi0=' } }
        ]
      }
    ])

    expect(prompt.blocks).toEqual([
      { type: 'text', text: 'Describe this\n[Image 1]' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    ])
    expect(prompt.warnings).toEqual([
      'Grok CLI only accepts image files. Skipped a file of type application/pdf.'
    ])
  })
})
