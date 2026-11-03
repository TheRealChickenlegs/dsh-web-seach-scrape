/**
 * Configuration resolution.
 *
 * Priority (higher wins):
 *   1. Plugin config — the `config:` of the profile entry, written by the plugin page
 *   2. Config file   — `~/.dsh-web-search-scrape/config.json` (or $DSH_WEB_SEARCH_SCRAPE_CONFIG)
 *   3. Environment   — scalar settings and the two endpoint URLs
 *   4. Built-in defaults
 *
 * SECURITY: this module never reads, writes, or echoes an API key value. A service
 * carries an `apiKeyEnv` credential reference resolved at call time by `credentials.ts`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_FIRECRAWL_API_KEY_ENV,
  DEFAULT_SEARXNG_API_KEY_ENV,
  ENV_CONFIG,
  ENV_FIRECRAWL_URL,
  ENV_PREFIX,
  ENV_SEARXNG_URL,
  PLUGIN_ID
} from './identity.js'
import { logDebug, logWarn } from './log.js'
import type { ResolvedConfig } from './types.js'

/** Built-in defaults. The endpoints match the common local self-hosted setup. */
export const DEFAULTS = {
  searxngUrl: 'http://127.0.0.1:8080',
  searxngAuthHeader: 'Authorization',
  searxngAuthPrefix: 'Bearer ',
  searxngTimeoutMs: 15_000,
  searxngMaxSnippetChars: 500,

  firecrawlUrl: 'http://127.0.0.1:3002',
  firecrawlApiVersion: 'auto' as const,
  firecrawlFormats: ['markdown'],
  firecrawlOnlyMainContent: true,
  firecrawlTimeoutMs: 60_000,
  firecrawlJobTimeoutMs: 600_000,
  firecrawlPollIntervalMs: 1_500,
  firecrawlMaxUrls: 50,
  firecrawlRetries: 2,

  maxInlineChars: 20_000,
  writeMetadata: true
} as const

/** Recognised values, kept here so the UI and validation share one source. */
export const API_VERSIONS = ['auto', 'v1', 'v2'] as const
export const PROXY_MODES = ['auto', 'basic', 'stealth', 'enhanced'] as const
export const TIME_RANGES = ['day', 'week', 'month', 'year'] as const
export const SAFE_SEARCH_LEVELS = [0, 1, 2] as const
export const SCRAPE_FORMATS = [
  'markdown',
  'html',
  'rawHtml',
  'links',
  'images',
  'screenshot',
  'summary',
  'json',
  'product'
] as const

/** Credential reference grammar shared with DSH's credentials service. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Environment variable → config key for scalar settings. */
const ENV_SCALARS: Record<string, string> = {
  [`${ENV_PREFIX}_SEARXNG_URL`]: 'searxngUrl',
  [`${ENV_PREFIX}_SEARXNG_API_KEY_ENV`]: 'searxngApiKeyEnv',
  [`${ENV_PREFIX}_SEARXNG_AUTH_HEADER`]: 'searxngAuthHeader',
  [`${ENV_PREFIX}_SEARXNG_AUTH_PREFIX`]: 'searxngAuthPrefix',
  [`${ENV_PREFIX}_SEARXNG_CATEGORIES`]: 'searxngCategories',
  [`${ENV_PREFIX}_SEARXNG_ENGINES`]: 'searxngEngines',
  [`${ENV_PREFIX}_SEARXNG_LANGUAGE`]: 'searxngLanguage',
  [`${ENV_PREFIX}_SEARXNG_SAFESEARCH`]: 'searxngSafeSearch',
  [`${ENV_PREFIX}_SEARXNG_TIME_RANGE`]: 'searxngTimeRange',
  [`${ENV_PREFIX}_SEARXNG_TIMEOUT_MS`]: 'searxngTimeoutMs',
  [`${ENV_PREFIX}_SEARXNG_MAX_SNIPPET_CHARS`]: 'searxngMaxSnippetChars',
  [`${ENV_PREFIX}_FIRECRAWL_URL`]: 'firecrawlUrl',
  [`${ENV_PREFIX}_FIRECRAWL_API_KEY_ENV`]: 'firecrawlApiKeyEnv',
  [`${ENV_PREFIX}_FIRECRAWL_API_VERSION`]: 'firecrawlApiVersion',
  [`${ENV_PREFIX}_FIRECRAWL_FORMATS`]: 'firecrawlFormats',
  [`${ENV_PREFIX}_FIRECRAWL_ONLY_MAIN_CONTENT`]: 'firecrawlOnlyMainContent',
  [`${ENV_PREFIX}_FIRECRAWL_PROXY`]: 'firecrawlProxy',
  [`${ENV_PREFIX}_FIRECRAWL_TIMEOUT_MS`]: 'firecrawlTimeoutMs',
  [`${ENV_PREFIX}_FIRECRAWL_JOB_TIMEOUT_MS`]: 'firecrawlJobTimeoutMs',
  [`${ENV_PREFIX}_FIRECRAWL_POLL_INTERVAL_MS`]: 'firecrawlPollIntervalMs',
  [`${ENV_PREFIX}_FIRECRAWL_MAX_URLS`]: 'firecrawlMaxUrls',
  [`${ENV_PREFIX}_FIRECRAWL_RETRIES`]: 'firecrawlRetries',
  [`${ENV_PREFIX}_OUTPUT_DIR`]: 'outputDir',
  [`${ENV_PREFIX}_MAX_INLINE_CHARS`]: 'maxInlineChars',
  [`${ENV_PREFIX}_WRITE_METADATA`]: 'writeMetadata'
}

/** Resolve the non-secret config file location. */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_CONFIG]
  if (override !== undefined && override.trim() !== '') return path.resolve(expandHome(override.trim()))
  return path.join(os.homedir(), `.${PLUGIN_ID}`, 'config.json')
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unwrap Schemastery volatile references so plugin config reads as plain values. */
export function unwrapVolatile(value: unknown): unknown {
  if (isPlainObject(value) && typeof (value as { get?: unknown }).get === 'function') {
    return unwrapVolatile((value as { get: () => unknown }).get())
  }
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]))
  }
  return value
}

/** Read the config file; a broken file counts as absent and never takes the plugin down. */
export function readConfigFile(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const file = configFilePath(env)
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) {
      logWarn(`Config file ${file} is not a JSON object; ignoring it.`)
      return {}
    }
    return parsed
  } catch (error) {
    logWarn(`Cannot read config file ${file}; ignoring it (${error instanceof Error ? error.message : String(error)}).`)
    return {}
  }
}

/** Read scalar settings and the two URL fallbacks from the environment. */
export function configFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, key] of Object.entries(ENV_SCALARS)) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    out[key] = raw.trim()
  }
  const searxng = env[ENV_SEARXNG_URL]
  if (out.searxngUrl === undefined && searxng !== undefined && searxng.trim() !== '') out.searxngUrl = searxng.trim()
  const firecrawl = env[ENV_FIRECRAWL_URL]
  if (out.firecrawlUrl === undefined && firecrawl !== undefined && firecrawl.trim() !== '') {
    out.firecrawlUrl = firecrawl.trim()
  }
  return out
}

/** First non-blank string across the layers. */
function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/** First numeric value across the layers, clamped to the accepted range. */
function pickNumber(min: number, max: number, ...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) continue
    return Math.min(max, Math.max(min, Math.round(number)))
  }
  return undefined
}

/** First boolean value across the layers; strings accept true/false, 1/0, yes/no, on/off. */
function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase()
      if (lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'on') return true
      if (lowered === 'false' || lowered === '0' || lowered === 'no' || lowered === 'off') return false
    }
  }
  return undefined
}

/** First list value across the layers; a string is split on commas. */
function pickList(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const list = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      return list
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    }
  }
  return undefined
}

/** First value matching one of `allowed` (case-insensitive) across the layers. */
function pickEnum<T extends string>(allowed: readonly T[], ...values: unknown[]): T | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const candidate = value.trim().toLowerCase()
    const match = allowed.find((entry) => entry.toLowerCase() === candidate)
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Validate and normalise an endpoint root.
 *
 * Rejects anything that is not a bare http(s) origin+path: credentials, a query
 * string, or a fragment in a configured endpoint is a configuration mistake, not
 * a URL to honour.
 */
export function normalizeEndpoint(value: string): { url: string } | { error: string } {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { error: `"${value}" is not a valid URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `"${value}" must use http or https` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: `"${value}" must not embed credentials; use the API key field instead` }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { error: `"${value}" must not contain a query string or fragment` }
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return { url: `${parsed.origin}${pathname}` }
}

/**
 * Resolve the config layers into a ready-to-use config.
 * Invalid values are replaced with defaults and recorded in `problems`; the
 * plugin never fails to load because of a bad config file.
 */
export function resolveConfig(pluginConfig?: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const plain = unwrapVolatile(pluginConfig)
  const fromPlugin = isPlainObject(plain) ? plain : {}
  if (pluginConfig !== undefined && !isPlainObject(plain)) {
    logWarn('Plugin config is not an object; ignoring it (only a JSON object is accepted).')
  }
  const fromFile = readConfigFile(env)
  const fromEnv = configFromEnv(env)

  /** All layers for one key, highest priority first. */
  const layers = (key: string): unknown[] => [fromPlugin[key], fromFile[key], fromEnv[key]]

  const problems: string[] = []

  const readEndpoint = (label: string, fallback: string, ...values: unknown[]): string | undefined => {
    const raw = pickString(...values)
    if (raw === undefined) return fallback
    const normalised = normalizeEndpoint(raw)
    if ('error' in normalised) {
      problems.push(`${label} endpoint ignored: ${normalised.error}`)
      return undefined
    }
    return normalised.url
  }

  const apiKeyEnv = (label: string, fallback: string, ...values: unknown[]): string => {
    const raw = pickString(...values)
    if (raw === undefined) return fallback
    if (!CREDENTIAL_REF_PATTERN.test(raw)) {
      problems.push(`${label} API key reference "${raw}" must be an environment-variable-style name; using ${fallback}.`)
      return fallback
    }
    return raw
  }

  const searxngUrl = readEndpoint('SearXNG', DEFAULTS.searxngUrl, ...layers('searxngUrl'))
  const firecrawlUrl = readEndpoint('Firecrawl', DEFAULTS.firecrawlUrl, ...layers('firecrawlUrl'))

  const safeSearchRaw = layers('searxngSafeSearch').find((value) => value !== undefined)
  const safeSearchNumber = typeof safeSearchRaw === 'string' ? Number(safeSearchRaw.trim()) : safeSearchRaw
  let safeSearch: 0 | 1 | 2 | undefined
  if (typeof safeSearchNumber === 'number' && (SAFE_SEARCH_LEVELS as readonly number[]).includes(safeSearchNumber)) {
    safeSearch = safeSearchNumber as 0 | 1 | 2
  } else if (safeSearchRaw !== undefined) {
    problems.push('searxngSafeSearch must be 0, 1 or 2; using the instance default.')
  }

  const timeRange = pickEnum(TIME_RANGES, ...layers('searxngTimeRange'))
  if (timeRange === undefined && pickString(...layers('searxngTimeRange')) !== undefined) {
    problems.push(`searxngTimeRange must be one of ${TIME_RANGES.join(', ')}; using the instance default.`)
  }

  const apiVersionRaw = layers('firecrawlApiVersion').find((value) => value !== undefined)
  const apiVersion = pickEnum(API_VERSIONS, ...layers('firecrawlApiVersion')) ?? 'auto'
  if (apiVersionRaw !== undefined && pickEnum(API_VERSIONS, apiVersionRaw) === undefined) {
    problems.push(`firecrawlApiVersion must be one of ${API_VERSIONS.join(', ')}; using auto.`)
  }

  const proxyRaw = layers('firecrawlProxy').find((value) => value !== undefined)
  const proxy = pickEnum(PROXY_MODES, ...layers('firecrawlProxy'))
  if (proxyRaw !== undefined && proxy === undefined) {
    problems.push(`firecrawlProxy must be one of ${PROXY_MODES.join(', ')}; using the server default.`)
  }

  const requestedFormats = pickList(...layers('firecrawlFormats')) ?? [...DEFAULTS.firecrawlFormats]
  const acceptedFormats = requestedFormats.filter((format) => (SCRAPE_FORMATS as readonly string[]).includes(format))
  const rejectedFormats = requestedFormats.filter((format) => !(SCRAPE_FORMATS as readonly string[]).includes(format))
  if (rejectedFormats.length > 0) {
    problems.push(`Unknown scrape format(s) ignored: ${rejectedFormats.join(', ')}.`)
  }

  const categories = pickList(...layers('searxngCategories')) ?? ['general']
  const engines = pickList(...layers('searxngEngines')) ?? []

  const resolved: ResolvedConfig = {
    searxngUrl,
    searxngApiKeyEnv: apiKeyEnv('SearXNG', DEFAULT_SEARXNG_API_KEY_ENV, ...layers('searxngApiKeyEnv')),
    searxngAuthHeader: pickString(...layers('searxngAuthHeader')) ?? DEFAULTS.searxngAuthHeader,
    searxngAuthPrefix: pickString(...layers('searxngAuthPrefix')) ?? DEFAULTS.searxngAuthPrefix,
    searxngCategories: categories,
    searxngEngines: engines,
    searxngLanguage: pickString(...layers('searxngLanguage')),
    searxngSafeSearch: safeSearch,
    searxngTimeRange: timeRange,
    searxngTimeoutMs: pickNumber(1_000, 120_000, ...layers('searxngTimeoutMs')) ?? DEFAULTS.searxngTimeoutMs,
    searxngMaxSnippetChars:
      pickNumber(0, 5_000, ...layers('searxngMaxSnippetChars')) ?? DEFAULTS.searxngMaxSnippetChars,

    firecrawlUrl,
    firecrawlApiKeyEnv: apiKeyEnv('Firecrawl', DEFAULT_FIRECRAWL_API_KEY_ENV, ...layers('firecrawlApiKeyEnv')),
    firecrawlApiVersion: apiVersion,
    firecrawlFormats: acceptedFormats.length > 0 ? acceptedFormats : [...DEFAULTS.firecrawlFormats],
    firecrawlOnlyMainContent:
      pickBoolean(...layers('firecrawlOnlyMainContent')) ?? DEFAULTS.firecrawlOnlyMainContent,
    firecrawlProxy: proxy,
    firecrawlTimeoutMs: pickNumber(1_000, 300_000, ...layers('firecrawlTimeoutMs')) ?? DEFAULTS.firecrawlTimeoutMs,
    firecrawlJobTimeoutMs:
      pickNumber(5_000, 3_600_000, ...layers('firecrawlJobTimeoutMs')) ?? DEFAULTS.firecrawlJobTimeoutMs,
    firecrawlPollIntervalMs:
      pickNumber(250, 30_000, ...layers('firecrawlPollIntervalMs')) ?? DEFAULTS.firecrawlPollIntervalMs,
    firecrawlMaxUrls: pickNumber(1, 200, ...layers('firecrawlMaxUrls')) ?? DEFAULTS.firecrawlMaxUrls,
    firecrawlRetries: pickNumber(0, 5, ...layers('firecrawlRetries')) ?? DEFAULTS.firecrawlRetries,

    outputDir: pickString(...layers('outputDir')),
    maxInlineChars: pickNumber(500, 500_000, ...layers('maxInlineChars')) ?? DEFAULTS.maxInlineChars,
    writeMetadata: pickBoolean(...layers('writeMetadata')) ?? DEFAULTS.writeMetadata,

    problems
  }

  logDebug('Config resolved', {
    configFile: configFilePath(env),
    searxngUrl: resolved.searxngUrl,
    firecrawlUrl: resolved.firecrawlUrl,
    apiVersion: resolved.firecrawlApiVersion,
    formats: resolved.firecrawlFormats,
    problems: problems.length
  })
  return resolved
}
