/**
 * Authenticated, same-origin route used by the plugin page to test both services.
 *
 * Why this exists: the browser must never hold an API key, and a request straight
 * from the page to SearXNG/Firecrawl would be blocked by CORS. The page asks the
 * host, which uses the already-configured endpoints and credentials.
 *
 * Security properties:
 * - The route only talks to the *configured* endpoints, so it cannot be used to
 *   make the host reach an arbitrary URL.
 * - DSH's connection service authenticates the request exactly like /api
 *   (`requestRejection`); when that service is absent the route is loopback-only.
 * - JSON content type + a custom header make a cross-site request require a CORS
 *   preflight, which this route never grants.
 * - Request bodies are capped, responses are `no-store`, and error text is
 *   redacted before it leaves the host.
 */
import { resolveConfig } from './config.js'
import { formatError } from './errors.js'
import { getService, resolveApiKey, redactSecrets } from './credentials.js'
import { probeCapabilities } from './firecrawl/capabilities.js'
import { searxngInstanceInfo } from './searxng.js'
import { ROUTE_HEADER, ROUTE_PREFIX } from './identity.js'
import { logDebug, logWarn } from './log.js'
import type { HostContextLike, HttpRequestLike, HttpResponseLike, ResolvedConfig, WebServerLike } from './types.js'

const MAX_BODY_BYTES = 16 * 1024

function headerValue(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function sendJson(response: HttpResponseLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('content-length', String(Buffer.byteLength(payload)))
  response.end(payload)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

async function readJsonBody(request: HttpRequestLike): Promise<Record<string, unknown>> {
  if (typeof request[Symbol.asyncIterator] !== 'function') throw new Error('request body is not readable')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Record<string, unknown>
}

/** Redact both configured key values from any text leaving the host. */
async function secretsFor(ctx: HostContextLike, config: ResolvedConfig): Promise<Array<string | undefined>> {
  const [searxng, firecrawl] = await Promise.all([
    resolveApiKey(ctx, config.searxngApiKeyEnv),
    resolveApiKey(ctx, config.firecrawlApiKeyEnv)
  ])
  return [searxng?.value, firecrawl?.value]
}

/**
 * Build the probe handler. Exported separately so it can be exercised without a
 * live DSH composition.
 */
export function createProbeRouteHandler(
  ctx: HostContextLike,
  pluginConfig: unknown,
  resolver: (config?: unknown) => ResolvedConfig = (value) => resolveConfig(value)
) {
  return async function handleProbe(request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
    if (pathname !== `${ROUTE_PREFIX}/probe`) {
      sendJson(response, 404, { ok: false, code: 'NOT_FOUND', error: 'not found' })
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      sendJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'use POST' })
      return
    }

    // Owner authentication. Without the connection service (unusual composition)
    // fall back to a loopback-only check rather than exposing the route.
    const connection = getService<NonNullable<HostContextLike['connection']>>(ctx, 'connection')
    if (connection?.requestRejection !== undefined) {
      let rejection: number | undefined
      try {
        rejection = connection.requestRejection(request)
      } catch {
        rejection = 401
      }
      if (rejection !== undefined) {
        sendJson(response, rejection, { ok: false, code: 'UNAUTHORIZED', error: 'authentication required' })
        return
      }
    } else if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, {
        ok: false,
        code: 'FORBIDDEN',
        error: 'this route is loopback-only without the connection service'
      })
      return
    }

    // CSRF fence: JSON + a custom header can only be produced by the same-origin page.
    const contentType = (headerValue(request, 'content-type') ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      sendJson(response, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'content-type must be application/json' })
      return
    }
    if (headerValue(request, ROUTE_HEADER) !== '1') {
      sendJson(response, 403, { ok: false, code: 'FORBIDDEN', error: `missing ${ROUTE_HEADER}: 1 header` })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        error: error instanceof Error ? error.message : 'invalid request body'
      })
      return
    }

    let config: ResolvedConfig
    try {
      config = resolver(pluginConfig)
    } catch (error) {
      sendJson(response, 500, { ok: false, code: 'CONFIG_ERROR', error: formatError(error) })
      return
    }

    const secrets = await secretsFor(ctx, config)
    const redact = (value: string): string => redactSecrets(value, secrets)

    try {
      const searxngKey = await resolveApiKey(ctx, config.searxngApiKeyEnv)
      const firecrawlKey = await resolveApiKey(ctx, config.firecrawlApiKeyEnv)
      const [searxng, firecrawl] = await Promise.all([
        searxngInstanceInfo(config, searxngKey?.value),
        probeCapabilities(config, firecrawlKey?.value, {
          force: body.refresh === true,
          probeFormats: body.probe_formats !== false
        })
      ])
      logDebug('Probe route served', {
        searxngReachable: searxng.reachable,
        firecrawlReachable: firecrawl.reachable,
        preferred: firecrawl.preferred
      })
      sendJson(response, 200, {
        ok: true,
        searxng: {
          url: searxng.url,
          reachable: searxng.reachable,
          version: searxng.version ?? null,
          instanceName: searxng.instanceName ?? null,
          categories: searxng.categories,
          engines: searxng.engines,
          locales: searxng.locales.slice(0, 80),
          keyConfigured: searxngKey !== undefined,
          error: searxng.error === undefined ? null : redact(searxng.error)
        },
        firecrawl: {
          url: firecrawl.url,
          reachable: firecrawl.reachable,
          preferred: firecrawl.preferred,
          versions: {
            v1: firecrawl.versions.v1 ?? null,
            v2: firecrawl.versions.v2 ?? null
          },
          formats: firecrawl.formats,
          deprecations: firecrawl.deprecations,
          keyConfigured: firecrawlKey !== undefined,
          probedAt: firecrawl.probedAt,
          error: firecrawl.error === undefined ? null : redact(firecrawl.error)
        },
        problems: config.problems
      })
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        code: 'PROBE_FAILED',
        error: redact(formatError(error))
      })
    }
  }
}

/**
 * Register the probe route when the composition mounts a web server.
 * Returns false when no injection is possible; the plugin still works without
 * the route (the page shows the fields, only "Test" needs it).
 */
export function registerProbeRoute(ctx: HostContextLike, pluginConfig: unknown): boolean {
  if (typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = getService<WebServerLike>(webCtx, 'webServer')
      if (server?.register === undefined) return
      const handler = createProbeRouteHandler(webCtx, pluginConfig)
      try {
        const effect = webCtx.effect
        const register = () =>
          server.register!({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: (request, response) => handler(request, response)
          })
        if (typeof effect === 'function') {
          effect(register, 'web-search-scrape: probe route')
        } else {
          register()
        }
        logDebug('Registered probe route', { path: `${ROUTE_PREFIX}/probe` })
      } catch (error) {
        logWarn(`Could not register the probe route: ${formatError(error)}`)
      }
    })
    return true
  } catch (error) {
    logWarn(`Could not inject the web server: ${formatError(error)}`)
    return false
  }
}
