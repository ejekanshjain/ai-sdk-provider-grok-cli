import type { Logger } from './types'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

/**
 * Resolves the logger for a model. `false` silences everything, and `debug`/`info`
 * only reach the underlying logger when `verbose` is on.
 */
export function resolveLogger(logger: Logger | false | undefined, verbose = false): Logger {
  if (logger === false) return silentLogger
  const base: Logger = logger ?? {
    debug: message => console.warn(`[grok-cli] ${message}`),
    info: message => console.warn(`[grok-cli] ${message}`),
    warn: message => console.warn(`[grok-cli] ${message}`),
    error: message => console.error(`[grok-cli] ${message}`)
  }
  return {
    debug: message => verbose && base.debug(message),
    info: message => verbose && base.info(message),
    warn: message => base.warn(message),
    error: message => base.error(message)
  }
}
