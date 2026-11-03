/**
 * Firecrawl capability discovery.
 *
 * The question is not "is it up" but "what does this instance actually expose".
 * Two cheap signals answer it:
 *   - `POST <endpoint> {}` → 400/422 proves the route exists (validation ran),
 *     404 "… is not a Firecrawl API endpoint" proves it does not, 401/403 proves
 *     it exists but needs a key;
 *   - one real scrape of a stable page proves which response formats work. A
 *     self-hosted instance without an LLM provider, for example, answers
 *     `summary` with HTTP 500 while `markdown`/`html`/`links` succeed.
 *
 * Results are cached briefly because the answer only changes when the instance
 * or its configuration changes. Nothing is probed at plugin start.
 */
import { isMissingEndpoint } from './client.js'
import { errorBodyText, requestJson } from '../http.js'
import { logDebug } from '../log.js'
import type {
  EndpointState,
  FirecrawlCapabilities,
  FirecrawlVersionCapabilities,
  FormatSupport,
  ResolvedConfig
} from '../types.js'

/** How long a probe result is trusted. */
export const PROBE_TTL_MS = 10 * 60 * 1000

/** A page that exists for exactly this purpose and costs the instance almost nothing. */
export const DEFAULT_PROBE_URL = 'https://example.com'

interface CacheEntry {
  key: string
  at: number
  value: FirecrawlCapabilities
}

let cache: CacheEntry | undefined

/** Drop the cached capability picture (tests, or after the endpoint changes). */
export function resetCapabilityCache(): void {
  cache = undefined
}

function cacheKey(config: ResolvedConfig, hasKey: boolean): string {
  return `${config.firecrawlUrl ?? ''}|${config.firecrawlApiVersion}|${hasKey ? 'key' : 'nokey'}`
}

const ENDPOINT_OPERATIONS: Array<{ name: string; path: string }> = [
  { name: 'scrape', path: 'scrape' },
  { name: 'search', path: 'search' },
  { name: 'map', path: 'map' },
  { name: 'crawl', path: 'crawl' },
  { name: 'batchScrape', path: 'batch/scrape' },
  { name: 'extract', path: 'extract' }
]

function classify(status: number, text: string): EndpointState {
  if (status === 404 && /is not a Firecrawl API endpoint/i.test(text)) return 'absent'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status >= 200 && status < 500) return 'present'
  // A 5xx still proves the route exists; it is reported as present with a note.
  return 'present'
}

/** Probe one version's endpoint set with empty bodies. */
async function probeVersion(
  config: ResolvedConfig,
  key: string | undefined,
  version: 'v1' | 'v2',
  signal: AbortSignal | undefined
): Promise<FirecrawlVersionCapabilities> {
  const base = (config.firecrawlUrl ?? '').replace(/\/+$/, '')
  const endpoints: Record<string, EndpointState> = {}

  await Promise.all(
    ENDPOINT_OPERATIONS.map(async (operation) => {
      const url = `${base}/${version}/${operation.path}`
      try {
        const response = await requestJson(url, {
          method: 'POST',
          headers: key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` },
          body: {},
          timeoutMs: Math.min(config.firecrawlTimeoutMs, 20_000),
          retries: 0,
          ...(signal === undefined ? {} : { signal })
        })
        endpoints[operation.name] = classify(response.status, response.text)
      } catch (error) {
        if (signal?.aborted === true) throw error
        endpoints[operation.name] = 'error'
      }
    })
  )

  const reachable = Object.values(endpoints).some((state) => state !== 'absent' && state !== 'error')
  return { reachable, endpoints }
}

/** One scrape request used to learn format support. */
async function probeFormat(
  config: ResolvedConfig,
  key: string | undefined,
  version: 'v1' | 'v2',
  formats: unknown[],
  probeUrl: string,
  signal: AbortSignal | undefined,
  produced?: (data: Record<string, unknown>) => boolean
): Promise<{ ok: boolean; note?: string }> {
  const base = (config.firecrawlUrl ?? '').replace(/\/+$/, '')
  try {
    const response = await requestJson(`${base}/${version}/scrape`, {
      method: 'POST',
      headers: key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` },
      body: { url: probeUrl, formats },
      timeoutMs: Math.min(config.firecrawlTimeoutMs, 45_000),
      retries: 0,
      ...(signal === undefined ? {} : { signal })
    })
    if (response.ok) {
      if (produced === undefined) return { ok: true }
      const data = (response.json as { data?: unknown } | undefined)?.data
      const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      if (record !== undefined && produced(record)) return { ok: true }
      // A 200 with nothing produced is a capability failure, not a success: a
      // self-hosted instance without an LLM answers `json: null` plus a warning.
      const warning = record === undefined ? undefined : errorBodyText(JSON.stringify({ error: record.warning }))
      return {
        ok: false,
        note: warning ?? 'the instance returned no value for this format'
      }
    }
    const reason = errorBodyText(response.text)
    return { ok: false, ...(reason === undefined ? {} : { note: reason }) }
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) }
  }
}

/** Probe which response formats this instance can actually produce. */
async function probeFormats(
  config: ResolvedConfig,
  key: string | undefined,
  version: 'v1' | 'v2',
  probeUrl: string,
  signal: AbortSignal | undefined
): Promise<FormatSupport> {
  const formats: FormatSupport = {}
  const notes: Record<string, string> = {}

  const basic = await probeFormat(config, key, version, ['markdown', 'html', 'links'], probeUrl, signal)
  formats.markdown = basic.ok
  formats.html = basic.ok
  formats.links = basic.ok
  if (!basic.ok && basic.note !== undefined) notes.markdown = basic.note

  const jsonProbe =
    version === 'v2'
      ? await probeFormat(
          config,
          key,
          version,
          [{ type: 'json', prompt: 'Return the page title.', schema: { type: 'object', properties: { title: { type: 'string' } } } }],
          probeUrl,
          signal,
          (data) => data.json !== null && data.json !== undefined
        )
      : await probeFormat(config, key, version, ['json'], probeUrl, signal, (data) => data.json !== null && data.json !== undefined)
  formats.json = jsonProbe.ok
  if (!jsonProbe.ok && jsonProbe.note !== undefined) notes.json = jsonProbe.note

  const summary = await probeFormat(config, key, version, ['summary'], probeUrl, signal, (data) => typeof data.summary === 'string' && data.summary !== '')
  formats.summary = summary.ok
  if (!summary.ok && summary.note !== undefined) notes.summary = summary.note

  if (Object.keys(notes).length > 0) formats.notes = notes
  return formats
}

/**
 * Build the capability picture for the configured instance.
 *
 * @param config - resolved plugin config
 * @param key    - credential value, when configured (never returned)
 * @param options.force bypasses the cache; `probeFormats: false` skips the format requests
 */
export async function probeCapabilities(
  config: ResolvedConfig,
  key: string | undefined,
  options: { signal?: AbortSignal; force?: boolean; probeFormats?: boolean; probeUrl?: string } = {}
): Promise<FirecrawlCapabilities> {
  const base = config.firecrawlUrl
  const hasKey = key !== undefined && key !== ''
  const key0 = cacheKey(config, hasKey)

  if (options.force !== true && cache !== undefined && cache.key === key0 && Date.now() - cache.at < PROBE_TTL_MS) {
    return cache.value
  }

  if (base === undefined) {
    return {
      url: '',
      reachable: false,
      versions: {},
      preferred: 'v2',
      formats: {},
      deprecations: [],
      authorized: hasKey,
      probedAt: Date.now(),
      error: 'No Firecrawl endpoint is configured.'
    }
  }

  logDebug('Probing Firecrawl capabilities', { base, version: config.firecrawlApiVersion })

  const [v2, v1] = await Promise.all([
    probeVersion(config, key, 'v2', options.signal),
    probeVersion(config, key, 'v1', options.signal)
  ])

  const deprecations: string[] = []
  if (v2.endpoints.extract === 'present') {
    deprecations.push('/v2/extract is deprecated by Firecrawl; this plugin uses /v2/scrape with a json format instead.')
  }

  const hasScrape = (version: FirecrawlVersionCapabilities | undefined): boolean =>
    version !== undefined && version.endpoints.scrape === 'present'

  let preferred: 'v1' | 'v2'
  if (config.firecrawlApiVersion === 'v1' && hasScrape(v1)) preferred = 'v1'
  else if (config.firecrawlApiVersion === 'v2' && hasScrape(v2)) preferred = 'v2'
  else if (hasScrape(v2)) preferred = 'v2'
  else if (hasScrape(v1)) preferred = 'v1'
  else preferred = config.firecrawlApiVersion === 'v1' ? 'v1' : 'v2'

  let formats: FormatSupport = {}
  if (options.probeFormats !== false && (hasScrape(v2) || hasScrape(v1))) {
    const version: 'v1' | 'v2' = hasScrape(preferred === 'v2' ? v2 : v1) ? preferred : hasScrape(v2) ? 'v2' : 'v1'
    formats = await probeFormats(config, key, version, options.probeUrl ?? DEFAULT_PROBE_URL, options.signal)
    if (formats.summary === false) {
      deprecations.push('The `summary` format is unavailable on this instance (it needs an LLM provider).')
    }
    if (formats.json === false) {
      deprecations.push(
        version === 'v1'
          ? 'Structured extraction (`json`/extract) is only available on Firecrawl v2.'
          : 'Structured extraction (`json`) produced no value on this instance; it needs an LLM provider on the Firecrawl side.'
      )
    }
  }

  const reachable = v2.reachable || v1.reachable
  const value: FirecrawlCapabilities = {
    url: base,
    reachable,
    versions: { v1, v2 },
    preferred,
    formats,
    deprecations,
    authorized: hasKey,
    probedAt: Date.now(),
    ...(reachable
      ? {}
      : {
          error:
            'The Firecrawl endpoint did not answer any known API route on v1 or v2. ' +
            'Check the URL (it should be the API root, e.g. http://127.0.0.1:3002) and that the service is running.'
        })
  }

  cache = { key: key0, at: Date.now(), value }
  return value
}

/** One-line summary of an endpoint map, for text output. */
export function summarizeEndpoints(version: FirecrawlVersionCapabilities | undefined): string {
  if (version === undefined) return 'not probed'
  if (!version.reachable) return 'unreachable'
  return Object.entries(version.endpoints)
    .map(([name, state]) => `${name}:${state === 'present' ? 'yes' : state}`)
    .join(' ')
}
