/**
 * Credential resolution and redaction.
 *
 * API keys live in DSH's credential seam (`ctx.credentials`) or in the process
 * environment, never in the plugin config. A service stores only a reference
 * name (`searxngApiKeyEnv`, `firecrawlApiKeyEnv`).
 *
 * Resolution order:
 *   1. `ctx.credentials.resolve(ref)` — the managed store
 *   2. `process.env[ref]` — a direct fallback for hosts without the service
 *
 * Nothing here logs a key, returns a key to a browser, or puts one in an error.
 */
import { logDebug } from './log.js'
import type { HostContextLike } from './types.js'

/** Look up an optional DSH service without letting a missing one break the plugin. */
export function getService<T = Record<string, unknown>>(ctx: HostContextLike | undefined, name: string): T | undefined {
  if (ctx === undefined) return undefined
  const candidates: unknown[] = []
  try {
    if (typeof ctx.get === 'function') candidates.push(ctx.get(name))
  } catch {
    /* an unavailable service can throw in some compositions */
  }
  try {
    if (typeof ctx.reflect?.get === 'function') {
      candidates.push(ctx.reflect.get(name, false))
      candidates.push(ctx.reflect.get(name))
    }
  } catch {
    /* same */
  }
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate as T
  }
  return undefined
}

/** A resolved credential and where it came from (never logged with its value). */
export interface ApiKey {
  value: string
  source: string
}

/** True for the environment-variable-style reference names this plugin accepts. */
export function isCredentialRefName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

/**
 * Resolve one service's credential. Keys are optional: a self-hosted SearXNG or
 * Firecrawl frequently needs none, so absence is not an error here — the request
 * layer omits the auth header and the server's own 401 is the signal.
 */
export async function resolveApiKey(
  ctx: HostContextLike | undefined,
  ref: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ApiKey | undefined> {
  if (!isCredentialRefName(ref)) return undefined
  const credentials = getService<NonNullable<HostContextLike['credentials']>>(ctx, 'credentials')
  if (credentials?.resolve !== undefined) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        return {
          value: hit.value,
          source: typeof hit.source === 'string' && hit.source !== '' ? hit.source : 'credentials'
        }
      }
    } catch (error) {
      // A refusing credential store must not mask the environment fallback.
      logDebug('credentials.resolve failed; trying the process environment', {
        ref,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const ambient = env[ref]
  if (typeof ambient === 'string' && ambient.trim() !== '') {
    return { value: ambient.trim(), source: 'environment' }
  }
  return undefined
}

/** Describe one service's key without resolving its value. */
export async function describeApiKey(
  ctx: HostContextLike | undefined,
  ref: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ configured: boolean; source: string | null }> {
  const credentials = getService<NonNullable<HostContextLike['credentials']>>(ctx, 'credentials')
  if (credentials?.describe !== undefined) {
    try {
      const info = await credentials.describe(ref)
      if (info !== undefined && info.configured === true) {
        return { configured: true, source: typeof info.source === 'string' ? info.source : 'credentials' }
      }
    } catch {
      /* fall through to the environment check */
    }
  }
  const ambient = env[ref]
  if (typeof ambient === 'string' && ambient.trim() !== '') return { configured: true, source: 'environment' }
  return { configured: false, source: null }
}

/**
 * Remove every occurrence of a known secret from text that may reach a model,
 * a log, or the browser. Also scrubs common accidental header echoes as a
 * second line of defence.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    out = out.split(secret).join('[redacted]')
  }
  return out
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, '$1[redacted]')
    .replace(/((?:x-)?api[-_ ]?key\s*[:=]\s*)[^\s,;"']+/gi, '$1[redacted]')
}

/** Recursively scrub every string in a JSON-shaped value. */
export function redactDeep<T>(value: T, secrets: Array<string | undefined>): T {
  if (typeof value === 'string') return redactSecrets(value, secrets) as unknown as T
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, secrets)) as unknown as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactDeep(entry, secrets)])
    ) as unknown as T
  }
  return value
}
