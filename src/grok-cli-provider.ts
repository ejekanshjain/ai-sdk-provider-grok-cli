import { NoSuchModelError, type ProviderV4 } from '@ai-sdk/provider'
import { GrokCliLanguageModel } from './grok-cli-language-model'
import { resolveLogger } from './logger'
import type { GrokCliModelId, GrokCliSettings } from './types'
import { validateSettings } from './validation'

export interface GrokCliProvider extends ProviderV4 {
  (modelId: GrokCliModelId, settings?: GrokCliSettings): GrokCliLanguageModel
  languageModel(modelId: GrokCliModelId, settings?: GrokCliSettings): GrokCliLanguageModel
  chat(modelId: GrokCliModelId, settings?: GrokCliSettings): GrokCliLanguageModel
}

export interface GrokCliProviderSettings {
  /** Settings applied to every model this provider creates. Model settings override them. */
  defaultSettings?: GrokCliSettings
}

/**
 * Creates a Grok CLI provider. Settings are validated when a model is created,
 * so a typo fails fast instead of on the first call.
 *
 * @example
 * const grok = createGrokCli({ defaultSettings: { cwd: '/path/to/project' } })
 * const { text } = await generateText({ model: grok('grok-4.7'), prompt: 'Summarize this repo' })
 */
export function createGrokCli(options: GrokCliProviderSettings = {}): GrokCliProvider {
  const createModel = (modelId: GrokCliModelId, settings: GrokCliSettings = {}) => {
    const merged = { ...options.defaultSettings, ...settings }
    const { warnings } = validateSettings(merged)
    const logger = resolveLogger(merged.logger, merged.verbose)
    warnings.forEach(warning => logger.warn(warning))
    return new GrokCliLanguageModel({ modelId, settings: merged })
  }

  const provider = function (modelId: GrokCliModelId, settings?: GrokCliSettings) {
    if (new.target) throw new Error('Call the Grok CLI provider as a function, not with new.')
    return createModel(modelId, settings)
  }

  return Object.assign(provider, {
    specificationVersion: 'v4' as const,
    languageModel: createModel,
    chat: createModel,
    embeddingModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' })
    },
    imageModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: 'imageModel' })
    }
  })
}

/** Default Grok CLI provider using `grok` on your PATH and your Grok configuration. */
export const grokCli = createGrokCli()
