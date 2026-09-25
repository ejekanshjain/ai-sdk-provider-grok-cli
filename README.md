# AI SDK Provider for Grok CLI

Use xAI's [Grok CLI](https://x.ai/cli) (Grok Build) as a model in the [Vercel AI SDK](https://ai-sdk.dev). Calls run through the `grok` command on your machine, so they use your existing Grok login or `XAI_API_KEY`.

Grok CLI is a coding agent. Each call can read files, run commands, and search the web inside the working directory you choose. You see that activity as tool calls and tool results in the AI SDK stream.

## Requirements

- Node.js 22 or newer.
- AI SDK v7 (`ai@^7`) and Zod 4.
- Grok CLI installed and signed in. Run `grok models` to check. Tested with Grok CLI 1.0.41.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

## Install

```bash
npm install ai-sdk-provider-grok-cli ai zod
```

## Quick Start

```ts
import { generateText, streamText } from 'ai'
import { grokCli } from 'ai-sdk-provider-grok-cli'

const { text } = await generateText({
  model: grokCli('grok-4.7', { cwd: '/path/to/project' }),
  prompt: 'Summarize what this project does.'
})

const result = streamText({
  model: grokCli('default'),
  prompt: 'List the scripts in package.json.'
})
for await (const chunk of result.textStream) process.stdout.write(chunk)
```

Use `default` as the model id to keep the model set in your Grok configuration. Run `grok models` to see the ids your account can use.

## How It Works

Each call starts `grok` once in headless mode and reads its streamed JSON output. The provider maps that output to AI SDK stream parts:

- Text and reasoning stream token by token.
- Grok's tool calls and their results arrive as tool parts marked `providerExecuted`.
- The finish part carries token usage, cost, and the Grok session id.

Canceling the call with an `AbortSignal` stops the Grok process.

## Settings

Pass settings as the second argument to `grokCli(modelId, settings)`, or share them with `createGrokCli({ defaultSettings })`. Invalid settings throw when you create the model.

| Setting                              | Description                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `cwd`                                | Working directory for the agent. Defaults to the current process directory.    |
| `grokPath`                           | Path to the `grok` binary. Defaults to `grok` on your PATH.                    |
| `env`                                | Extra environment variables for the Grok process.                              |
| `tools`                              | Allowlist of built-in tools, for example `['read_file', 'grep']`.              |
| `disallowedTools`                    | Built-in tools to remove.                                                      |
| `permissionMode`                     | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, or `plan`.   |
| `alwaysApprove`                      | Run every tool without asking. Deny rules and hooks still apply.               |
| `allow`, `deny`                      | Permission rules such as `Bash(npm *)`.                                        |
| `disableWebSearch`                   | Remove the web search and fetch tools.                                         |
| `noSubagents`                        | Stop Grok from spawning subagents.                                             |
| `maxTurns`                           | Stop after this many agent turns. The call finishes with reason `length`.      |
| `reasoningEffort`                    | For example `low`, `high`, or `max`. Overrides the AI SDK `reasoning` option.  |
| `rules`                              | Extra rules appended to Grok's system prompt.                                  |
| `systemPromptOverride`               | Replace Grok's system prompt entirely.                                         |
| `sandbox`                            | Grok sandbox profile for filesystem and network access.                        |
| `resume`, `forkSession`, `sessionId` | Session controls. See [Sessions](#sessions).                                   |
| `timeoutMs`                          | Stop Grok and fail the call after this many milliseconds. No limit by default. |
| `extraArgs`                          | Extra CLI flags, appended as-is.                                               |
| `logger`, `verbose`                  | Custom logger or `false` to silence logs. `verbose` adds debug output.         |

AI SDK system messages are appended to Grok's system prompt with `--rules`. Grok keeps its own coding-agent instructions.

## Tools and Permissions

The provider passes no permission flags unless you set them, so your Grok configuration decides whether tools need approval. Headless runs cannot ask you for approval. Set `alwaysApprove` or `permissionMode` when an agent needs to edit files or run commands.

Custom AI SDK tools are not supported. Grok runs only its built-in tools and the MCP servers in your Grok configuration. Passing `tools` to `generateText` produces an `unsupported` warning.

Grok ignores tool names it does not recognize. `tools: ['none']` leaves every tool enabled, so list real tool names.

## Sessions

Every call starts a fresh Grok session and sends the whole conversation as a transcript. Read the session id from `providerMetadata['grok-cli'].sessionId`.

To continue a session, pass `resume` per call. The provider then sends only the messages after the last assistant turn, because the Grok session already holds the earlier ones:

```ts
const second = await generateText({
  model: grokCli('default'),
  messages,
  providerOptions: { 'grok-cli': { resume: sessionId } }
})
```

Set `forkSession: true` to branch into a new session id instead of appending to the original. Per-call `providerOptions['grok-cli']` accepts `resume`, `forkSession`, `sessionId`, `reasoningEffort`, `maxTurns`, and `rules`.

## Structured Output

`Output.object()` and other JSON schemas map to Grok's `--json-schema` flag, which constrains the answer to the schema. The provider returns Grok's structured result as the final text, so prose from earlier agent turns does not break JSON parsing.

JSON mode without a schema runs as plain text and produces a warning.

## Images

Image parts are sent to Grok as base64 content blocks. Grok drops images smaller than 512 total pixels. Grok stores each image in its session folder and opens it with its `read_file` tool, so keep `read_file` in `tools` when you send images. Other file types are skipped with a warning.

## Provider Metadata

`providerMetadata['grok-cli']` contains:

- `sessionId`: the Grok session id, for `resume`.
- `costUsd`: the reported cost. Absent when Grok could not report a complete cost.
- `durationMs` and `durationApiMs`: wall-clock time and model time.
- `numTurns`: agent turns in this call.
- `modelUsage`: per-model token and cost breakdown.

Usage follows AI SDK conventions. `inputTokens.total` includes cache reads, and `inputTokens.noCache` excludes them.

## Errors

- A signed-out CLI throws `LoadAPIKeyError`. Run `grok login` or set `XAI_API_KEY`.
- A missing binary throws `APICallError` with install steps. Set `grokPath` if `grok` is not on your PATH.
- Other failures throw `APICallError` with the exit code and the end of Grok's stderr in `data`.

Only rate-limit errors are retryable. A retried agent run could repeat file edits and commands.

## Limitations

- Sampling options such as `temperature`, `topP`, `seed`, `stopSequences`, and `maxOutputTokens` are ignored with a warning.
- Subagent activity is not streamed. You see the subagent tool call and its final result.
- Each call starts a new process, which adds startup time.
- Windows `.cmd` shims are untested. Set `grokPath` to the real executable if spawning fails.

## Development

```bash
npm install
npm run validate    # typecheck, format check, lint, test, build
node examples/basic.ts
```

The tests replay a recorded Grok run and fake the `grok` process, so they need no login and cost nothing. Examples call the real CLI and use your Grok account. They rely on Node's built-in TypeScript support, available in Node 22.18 and newer.

## License

MIT
