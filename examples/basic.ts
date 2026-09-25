// Runs one prompt with your Grok login and prints the answer, cost, and session id.
// Build first: npm run build && node examples/basic.ts
import { generateText } from 'ai'
import { grokCli } from '../dist/index.js'

const { text, usage, providerMetadata } = await generateText({
  model: grokCli('default', { tools: ['read_file', 'list_dir', 'grep'] }),
  prompt: 'In two sentences, what does the project in this folder do?'
})

console.log(text)
console.log('\nTokens:', usage.totalTokens)
console.log('Grok metadata:', providerMetadata?.['grok-cli'])
