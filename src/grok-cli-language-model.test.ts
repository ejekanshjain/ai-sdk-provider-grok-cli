import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { LoadAPIKeyError, type LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildArgs, GrokCliLanguageModel } from './grok-cli-language-model'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const fixtureLines = readFileSync(
  new URL('./__fixtures__/tool-call-run.jsonl', import.meta.url),
  'utf8'
)

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: string | null
  kill: ReturnType<typeof vi.fn>
  args: string[]
  promptFile: string
}

/** Fakes a `grok` process that prints `stdout`, then exits with `exitCode`. */
function fakeGrok({ stdout = '', stderr = '', exitCode = 0, hang = false } = {}) {
  const child = new EventEmitter() as FakeChild
  spawnMock.mockImplementationOnce((_command: string, args: string[]) => {
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.args = args
    child.promptFile = readFileSync(args[0]!.slice('--prompt-file='.length), 'utf8')
    child.kill = vi.fn(() => {
      child.signalCode = 'SIGTERM'
      child.stdout.end()
      child.emit('close', null, 'SIGTERM')
      return true
    })
    if (!hang) {
      setImmediate(() => {
        child.stderr.end(stderr)
        child.stdout.end(stdout, () => {
          child.exitCode = exitCode
          setImmediate(() => child.emit('close', exitCode, null))
        })
      })
    }
    return child
  })
  return child
}

const callOptions = (overrides: Partial<LanguageModelV4CallOptions> = {}) =>
  ({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'What is the launch code?' }] }],
    ...overrides
  }) as LanguageModelV4CallOptions

const model = new GrokCliLanguageModel({ modelId: 'grok-4.7', settings: { logger: false } })

beforeEach(() => spawnMock.mockReset())

describe('GrokCliLanguageModel', () => {
  it('runs grok headlessly and returns content, usage, and session metadata', async () => {
    const child = fakeGrok({ stdout: fixtureLines })

    const result = await model.doGenerate(callOptions({ temperature: 0.2 }))

    expect(child.args).toContain('--model=grok-4.7')
    expect(JSON.parse(child.promptFile)).toEqual([
      { type: 'text', text: 'What is the launch code?' }
    ])
    expect(result.content.filter(part => part.type === 'tool-call')).toHaveLength(2)
    expect(result.content.at(-1)).toEqual({ type: 'text', text: 'PINEAPPLE-7' })
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'end_turn' })
    expect(result.usage.inputTokens).toMatchObject({
      noCache: 35081,
      cacheRead: 4864,
      total: 39945
    })
    expect(result.providerMetadata?.['grok-cli']).toMatchObject({
      sessionId: expect.any(String),
      numTurns: 3
    })
    expect(result.warnings).toContainEqual({
      type: 'unsupported',
      feature: 'temperature',
      details: 'Grok CLI ignores it.'
    })
  })

  it('reports a signed-out CLI as a LoadAPIKeyError', async () => {
    fakeGrok({ stderr: 'Error: not logged in. Run grok login.', exitCode: 1 })

    await expect(model.doGenerate(callOptions())).rejects.toBeInstanceOf(LoadAPIKeyError)
  })

  it('surfaces the error line Grok prints before exiting', async () => {
    fakeGrok({
      stdout: '{"type":"error","message":"Couldn\'t set model \'x\': unknown model id"}\n',
      exitCode: 1
    })

    await expect(model.doGenerate(callOptions())).rejects.toThrow(/unknown model id/)
  })

  it('stops the grok process when the call is aborted', async () => {
    const child = fakeGrok({ hang: true })
    const controller = new AbortController()

    const { stream } = await model.doStream(callOptions({ abortSignal: controller.signal }))
    const reader = stream.getReader()
    await reader.read()
    controller.abort()

    await expect(reader.read()).rejects.toThrow()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('buildArgs', () => {
  it('passes values with = so text starting with a dash is not read as a flag', () => {
    const args = buildArgs({
      modelId: 'default',
      settings: { maxTurns: 3, tools: ['read_file', 'grep'] },
      rules: '- be brief'
    })

    expect(args).not.toContainEqual(expect.stringMatching(/^--model/))
    expect(args).toEqual(
      expect.arrayContaining(['--tools=read_file,grep', '--max-turns=3', '--rules=- be brief'])
    )
  })

  it('only sends a session id with resume when forking', () => {
    const resumeOnly = buildArgs({
      modelId: 'default',
      settings: { resume: 'abc', sessionId: '7f1c1a3e-5b7e-4a57-9c1b-0d5a1b2c3d4e' }
    })
    const fork = buildArgs({
      modelId: 'default',
      settings: {
        resume: 'abc',
        forkSession: true,
        sessionId: '7f1c1a3e-5b7e-4a57-9c1b-0d5a1b2c3d4e'
      }
    })

    expect(resumeOnly).not.toContainEqual(expect.stringMatching(/^--session-id/))
    expect(fork).toEqual(expect.arrayContaining(['--resume=abc', '--fork-session']))
    expect(fork).toContainEqual(expect.stringMatching(/^--session-id=/))
  })

  it('replaces rules with the system prompt override', () => {
    const args = buildArgs({
      modelId: 'default',
      settings: { systemPromptOverride: 'You are terse.' },
      rules: 'ignored'
    })

    expect(args).toContain('--system-prompt-override=You are terse.')
    expect(args).not.toContainEqual(expect.stringMatching(/^--rules/))
  })
})
