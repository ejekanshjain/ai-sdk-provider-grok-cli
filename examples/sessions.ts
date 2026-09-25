// Continues a Grok session across calls. When you pass `resume`, the provider sends only
// your newest message, because the Grok session already holds the earlier turns.
// Build first: npm run build && node examples/sessions.ts
import { generateText, type ModelMessage } from 'ai'
import { grokCli } from '../dist/index.js'

const model = grokCli('default', { tools: ['read_file'] })
const messages: ModelMessage[] = [{ role: 'user', content: 'Pick a random fruit and remember it.' }]

const first = await generateText({ model, messages })
const sessionId = first.providerMetadata?.['grok-cli']?.sessionId as string
console.log('Session:', sessionId, '\nGrok:', first.text)

messages.push(...first.response.messages, { role: 'user', content: 'Which fruit did you pick?' })
const second = await generateText({
  model,
  messages,
  providerOptions: { 'grok-cli': { resume: sessionId } }
})
console.log('Grok:', second.text)
