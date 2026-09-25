// Streams reasoning, tool activity, and the answer as Grok works.
// Build first: npm run build && node examples/streaming.ts
import { streamText } from 'ai'
import { grokCli } from '../dist/index.js'

const result = streamText({
  model: grokCli('default', { tools: ['read_file', 'list_dir', 'grep'] }),
  prompt: 'Find the package name in package.json and explain what it is for.'
})

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'reasoning-delta':
      process.stdout.write(`\x1b[2m${part.text}\x1b[0m`)
      break
    case 'text-delta':
      process.stdout.write(part.text)
      break
    case 'tool-call':
      console.log(`\n→ ${part.toolName} ${JSON.stringify(part.input)}`)
      break
    case 'tool-result':
      console.log(`← ${part.toolName} done`)
      break
    case 'error':
      console.error('\nError:', part.error)
      break
  }
}
console.log('\nFinish reason:', await result.finishReason)
