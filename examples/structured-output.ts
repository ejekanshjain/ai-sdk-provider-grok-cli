// Asks Grok for JSON that matches a Zod schema. Grok enforces the schema with --json-schema.
// Build first: npm run build && node examples/structured-output.ts
import { generateText, Output } from 'ai'
import { z } from 'zod'
import { grokCli } from '../dist/index.js'

const { output } = await generateText({
  model: grokCli('default'),
  output: Output.object({
    schema: z.object({
      name: z.string(),
      ingredients: z.array(z.string()),
      minutes: z.number()
    })
  }),
  prompt: 'Give me a recipe for a quick weeknight pasta.'
})

console.log(output)
