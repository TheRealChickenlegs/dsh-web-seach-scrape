/**
 * Shared test fixtures: fake SearXNG and Firecrawl servers plus a structural
 * host context. Everything talks to 127.0.0.1 only — no external network.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.setMaxListeners(0)

/** Point config resolution at a path that does not exist, so a developer's own config cannot leak into tests. */
export function isolateConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-web-search-scrape-test-'))
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DSH_WEB_SEARCH_SCRAPE_')) delete process.env[key]
    if (key === 'SEARXNG_URL' || key === 'FIRECRAWL_URL' || key === 'SEARXNG_API_KEY' || key === 'FIRECRAWL_API_KEY') {
      delete process.env[key]
    }
  }
  process.env.DSH_WEB_SEARCH_SCRAPE_CONFIG = path.join(dir, 'does-not-exist.json')
  return dir
}

/** Read a JSON request body (bounded by the test server). */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}

function send(response, status, value) {
  const payload = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

/** Start a server on an ephemeral loopback port and return its URL. */
async function listen(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      send(response, 500, { success: false, error: String(error) })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    close: () => new Promise((resolve) => server.close(resolve)),
    server
  }
}

/**
 * Fake SearXNG.
 *
 * Options:
 *   results        override results[]
 *   fail           respond 500
 *   htmlOnly       answer HTML (the `json` format is not enabled)
 *   requireHeader  { name, value } — 403 when absent
 */
export async function createFakeSearxng(options = {}) {
  const state = { requests: [], searches: 0, configs: 0 }

  const instance = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    state.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })

    if (options.requireHeader) {
      const value = request.headers[options.requireHeader.name]
      if (value !== options.requireHeader.value) {
        send(response, 403, { error: 'Forbidden' })
        return
      }
    }

    if (url.pathname === '/search') {
      state.searches += 1
      if (options.fail === true) {
        send(response, 500, { error: 'search backend exploded' })
        return
      }
      if (options.htmlOnly === true) {
        const html = '<html><body>results</body></html>'
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(html)
        return
      }
      if (url.searchParams.get('format') !== 'json') {
        send(response, 400, { error: 'Invalid value for parameter format' })
        return
      }
      const results = options.results ?? [
        { url: 'https://example.com/a', title: 'A', content: 'alpha '.repeat(200), publishedDate: '2026-01-02T00:00:00Z', score: 1 },
        { url: 'https://example.com/a', title: 'A duplicate', content: 'dup' },
        { url: 'https://example.com/b', title: 'B', content: 'beta', pubdate: '2026-02-03' }
      ]
      send(response, 200, {
        query: url.searchParams.get('q'),
        results,
        answers: ['An instant answer.'],
        infoboxes: [],
        suggestions: ['suggestion'],
        corrections: [],
        unresponsive_engines: [['kagi', 'timeout']]
      })
      return
    }

    if (url.pathname === '/config') {
      state.configs += 1
      send(response, 200, {
        version: '2026.10.16+test',
        instance_name: 'Test SearXNG',
        default_locale: 'en',
        safe_search: 0,
        categories: ['general', 'web', 'news'],
        engines: [
          { name: 'braveapi', categories: ['general', 'web'], enabled: true },
          { name: 'arxiv', categories: ['science'], enabled: true },
          { name: 'disabled-engine', categories: ['general'], enabled: false }
        ],
        locales: { en: 'English', de: 'Deutsch' }
      })
      return
    }

    send(response, 404, { error: 'not found' })
  })

  return { ...instance, state }
}

const V2_ONLY = 'both'

/**
 * Fake Firecrawl.
 *
 * Options:
 *   mode            'both' | 'v1-only' | 'v2-only'
 *   summaryWorks    whether the `summary` format succeeds (default false, like an
 *                   instance without an LLM provider)
 *   apiKey          when set, a request without `Authorization: Bearer <key>` is 401
 *   jsonWorks       whether structured extraction returns a value (default true;
 *                   false mimics an instance whose LLM provider is unconfigured)
 *   jsonStatus      respond with this status for a json/extract request instead
 *   batchDelayPolls number of polls before a batch job reports completed (default 1)
 *   crawlDelayPolls number of polls before a crawl reports completed (default 1)
 *   missing         array of "<version>:<op>" entries to answer 404 for
 */
export async function createFakeFirecrawl(options = {}) {
  const mode = options.mode ?? V2_ONLY
  const missing = new Set(options.missing ?? [])
  const state = { requests: [], batchPolls: 0, crawlPolls: 0, scrapes: 0 }

  const VERBATIM_FORMATS = ['markdown', 'html', 'rawHtml', 'rawBase64', 'links', 'images', 'screenshot', 'screenshot@fullPage', 'extract', 'json', 'summary', 'changeTracking', 'branding', 'product', 'menu']

  function endpointMissing(version, operation) {
    if (missing.has(`${version}:${operation}`)) return true
    if (mode === 'v1-only' && version === 'v2') return true
    if (mode === 'v2-only' && version === 'v1') return true
    return false
  }

  function jsonValue(url) {
    if (options.jsonWorks === false) return { value: null, warning: 'JSON extraction failed: Unauthorized' }
    return { value: { title: `Title of ${url}` } }
  }

  function scrapeData(version, body) {
    const url = body.url
    const formats = Array.isArray(body.formats) ? body.formats : ['markdown']
    const data = { metadata: { title: `Title of ${url}`, sourceURL: url, statusCode: 200, language: 'en' } }
    for (const format of formats) {
      if (typeof format === 'string') {
        if (format === 'markdown') data.markdown = `# ${url}\n\nbody text`
        else if (format === 'html') data.html = `<html><body>${url}</body></html>`
        else if (format === 'rawHtml') data.rawHtml = `<html><body class="raw">${url}</body></html>`
        else if (format === 'links') data.links = [`${url}#one`, `${url}#two`]
        else if (format === 'images') data.images = [`${url}/one.png`, { url: `${url}/two.png` }]
        else if (format === 'product') data.product = { title: 'Widget', price: '9.99', availability: 'in_stock' }
        else if (format === 'screenshot') data.screenshot = `http://127.0.0.1/screenshot.png`
        else if (format === 'summary') data.summary = `Summary of ${url}`
        else if (format === 'json') {
          const result = jsonValue(url)
          data.json = result.value
          if (result.warning !== undefined) data.warning = result.warning
        } else if (format === 'extract') {
          const result = jsonValue(url)
          data.extract = result.value
          if (result.warning !== undefined) data.warning = result.warning
        }
      } else if (format && typeof format === 'object' && format.type === 'json') {
        const result = jsonValue(url)
        data.json = result.value
        if (result.warning !== undefined) data.warning = result.warning
      }
    }
    return data
  }

  const instance = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const body = request.method === 'POST' ? await readBody(request) : {}
    state.requests.push({
      method: request.method,
      path: url.pathname,
      body,
      headers: request.headers
    })

    if (options.apiKey !== undefined) {
      const auth = request.headers.authorization
      if (auth !== `Bearer ${options.apiKey}`) {
        send(response, 401, { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' })
        return
      }
    }

    const segments = url.pathname.split('/').filter((segment) => segment !== '')
    const version = segments[0]
    if (version !== 'v1' && version !== 'v2') {
      send(response, 404, { success: false, code: 'NOT_FOUND', error: `POST ${url.pathname} is not a Firecrawl API endpoint.` })
      return
    }
    const batched = segments[1] === 'batch' && segments[2] === 'scrape'
    const operation = batched ? 'batchScrape' : segments[1]
    const rest = batched ? 'batch/scrape' : segments[1]
    const tail = batched ? segments[3] : segments[2]

    if (request.method === 'POST') {
      if (endpointMissing(version, operation)) {
        send(response, 404, {
          success: false,
          code: 'NOT_FOUND',
          error: `POST /${version}/${rest} is not a Firecrawl API endpoint.`,
          documentation_url: 'https://docs.firecrawl.dev'
        })
        return
      }

      if (operation === 'scrape') {
        state.scrapes += 1
        const formats = Array.isArray(body.formats) ? body.formats : ['markdown']
        const wantsJson = formats.some(
          (format) => format === 'json' || format === 'extract' || (format !== null && typeof format === 'object' && format.type === 'json')
        )
        if (wantsJson && typeof options.jsonStatus === 'number') {
          send(response, options.jsonStatus, { success: false, code: 'UNKNOWN_ERROR', error: 'An error occurred. Error ID: test-json' })
          return
        }
        if (typeof body.url !== 'string' || body.url === '') {
          send(response, 400, { success: false, code: 'BAD_REQUEST', error: 'url is required' })
          return
        }
        for (const format of formats) {
          if (format !== null && typeof format === 'object') {
            // v1 has no object formats; v2 accepts only the json object.
            if (version === 'v1' || format.type !== 'json') {
              send(response, 400, {
                success: false,
                code: 'BAD_REQUEST',
                error: 'Bad Request',
                details: [{ code: 'invalid_value', values: VERBATIM_FORMATS }]
              })
              return
            }
          } else if (typeof format === 'string' && !VERBATIM_FORMATS.includes(format)) {
            send(response, 400, { success: false, code: 'BAD_REQUEST', error: 'Bad Request', details: [{ code: 'invalid_value', values: VERBATIM_FORMATS }] })
            return
          }
        }
        if (version === 'v1') {
          // v1 pairs formats with their options and rejects a one-sided request.
          const hasJsonOptions = body.jsonOptions !== undefined
          const hasExtractOptions = body.extract !== undefined
          const jsonFormat = formats.includes('json') || formats.includes('extract')
          if (jsonFormat !== (hasJsonOptions || hasExtractOptions)) {
            send(response, 400, {
              success: false,
              code: 'BAD_REQUEST',
              error: "When 'extract' or 'json' format is specified, corresponding options must be provided, and vice versa"
            })
            return
          }
        }
        if (formats.includes('summary') && options.summaryWorks !== true) {
          send(response, 500, { success: false, code: 'UNKNOWN_ERROR', error: 'An error occurred. Error ID: test-summary' })
          return
        }
        send(response, 200, { success: true, data: scrapeData(version, body) })
        return
      }

      if (operation === 'search') {
        if (typeof body.query !== 'string' || body.query === '') {
          send(response, 400, { success: false, code: 'BAD_REQUEST', error: 'query is required' })
          return
        }
        if (version === 'v1' && body.sources !== undefined) {
          send(response, 400, {
            success: false,
            error: 'Invalid request body',
            details: [{ code: 'unrecognized_keys', keys: ['sources'], path: [], message: 'Unrecognized key: "sources"' }]
          })
          return
        }
        const items = [
          { url: 'https://example.com/one', title: 'One', description: 'First result' },
          { url: 'https://example.com/one', title: 'One again', description: 'Duplicate URL' },
          { url: 'https://example.com/two', title: 'Two', description: 'Second result', publishedAt: '2026-03-04' }
        ]
        if (version === 'v1') send(response, 200, { success: true, data: items })
        else send(response, 200, { success: true, data: { web: items }, creditsUsed: 2, id: 'search-id' })
        return
      }

      if (operation === 'map') {
        if (typeof body.url !== 'string' || body.url === '') {
          send(response, 400, { success: false, code: 'BAD_REQUEST', error: 'url is required' })
          return
        }
        const links = ['https://example.com/docs/a', 'https://example.com/docs/b', 'https://example.com/docs/c']
        if (version === 'v1') send(response, 200, { success: true, links })
        else send(response, 200, { success: true, id: 'map-id', links: links.map((link) => ({ url: link })) })
        return
      }

      if (operation === 'crawl') {
        if (typeof body.url !== 'string' || body.url === '') {
          send(response, 400, { success: false, code: 'BAD_REQUEST', error: 'url is required' })
          return
        }
        send(response, 200, { success: true, id: 'crawl-1', url: `http://127.0.0.1/${version}/crawl/crawl-1` })
        return
      }

      if (operation === 'batchScrape') {
        if (!Array.isArray(body.urls) || body.urls.length === 0) {
          send(response, 400, { success: false, code: 'BAD_REQUEST', error: 'urls is required' })
          return
        }
        send(response, 200, { success: true, id: 'batch-1', url: `http://127.0.0.1/${version}/batch/scrape/batch-1`, invalidURLs: [] })
        return
      }

      if (operation === 'extract') {
        send(response, 200, {
          success: true,
          id: 'extract-1',
          urlTrace: [],
          warnings: [`/${version}/extract is deprecated. Use /${version}/scrape with formats including a 'json' format object.`],
          replacement: `/${version}/scrape`
        })
        return
      }

      send(response, 404, { success: false, code: 'NOT_FOUND', error: `POST /${version}/${rest} is not a Firecrawl API endpoint.` })
      return
    }

    // ── GET job status ──────────────────────────────────────────────────
    if (request.method === 'GET' && tail !== undefined) {
      if (rest === 'batch/scrape') {
        state.batchPolls += 1
        const done = state.batchPolls > (options.batchDelayPolls ?? 1)
        const urls = ['https://example.com/x', 'https://example.com/y']
        if (!done) {
          send(response, 200, { success: true, status: 'scraping', completed: 1, total: urls.length })
          return
        }
        send(response, 200, {
          success: true,
          status: 'completed',
          completed: urls.length,
          total: urls.length,
          creditsUsed: 2,
          expiresAt: '2030-01-01T00:00:00.000Z',
          data: urls.map((url) => ({
            markdown: `# ${url}\n\nbody`,
            metadata: { title: `Title of ${url}`, sourceURL: url, statusCode: 200 }
          }))
        })
        return
      }

      if (rest === 'crawl') {
        state.crawlPolls += 1
        const done = state.crawlPolls > (options.crawlDelayPolls ?? 1)
        if (!done) {
          send(response, 200, { success: true, status: 'scraping', completed: 0, total: 2 })
          return
        }
        send(response, 200, {
          success: true,
          status: 'completed',
          completed: 2,
          total: 2,
          data: [
            { markdown: '# page one\n\ncontent', metadata: { title: 'Page One', sourceURL: 'https://example.com/one', statusCode: 200 } },
            { markdown: '# page two\n\ncontent', metadata: { title: 'Page Two', sourceURL: 'https://example.com/two', statusCode: 200 } }
          ]
        })
        return
      }
    }

    send(response, 404, { success: false, code: 'NOT_FOUND', error: `GET ${url.pathname} is not a Firecrawl API endpoint.` })
  })

  return { ...instance, state }
}

/** A structural host context whose injections resolve immediately. */
export function createHostContext(services = {}) {
  const context = {
    reflect: {
      get(name, strict) {
        const value = services[name]
        if (value !== undefined) return value
        if (strict) throw new Error(`service ${name} is unavailable`)
        return undefined
      }
    },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      const available = names.every((name) => services[name] !== undefined)
      if (available) callback(context)
      return () => {}
    },
    effect(callback) {
      return callback()
    },
    fiber: { id: 'test-fiber' },
    settings: services.settings,
    web: services.web,
    credentials: services.credentials,
    webServer: services.webServer,
    connection: services.connection
  }
  return context
}

/** A tool execution context with a requested working directory. */
export function execFor(cwd) {
  return { agent: { cwd }, signal: undefined }
}

/* ─────────────────────── schema-subset assertions ─────────────────────── */

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples'
])

/** Assert a raw schema uses only the harness's enforced JSON-Schema subset. */
export function assertSchemaSubset(schema, path = 'root') {
  assertPlain(schema, path)
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) throw new Error(`${path} uses unsupported schema key "${key}"`)
  }
  if (schema.type !== undefined) {
    const allowed = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
    if (!allowed.includes(schema.type)) throw new Error(`${path} has unsupported type "${schema.type}"`)
  }
  if (schema.properties !== undefined) {
    for (const [name, child] of Object.entries(schema.properties)) assertSchemaSubset(child, `${path}.properties.${name}`)
  }
  if (schema.items !== undefined) assertSchemaSubset(schema.items, `${path}.items`)
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) throw new Error(`${path}.oneOf needs at least two branches`)
    schema.oneOf.forEach((child, index) => assertSchemaSubset(child, `${path}.oneOf[${index}]`))
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new Error(`${path}.required must be an array`)
    for (const name of schema.required) {
      if (schema.properties === undefined || schema.properties[name] === undefined) {
        throw new Error(`${path}.required names "${name}", which is not declared in properties`)
      }
    }
  }
}

function assertPlain(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a schema object`)
  }
}

/** Validate a value against the enforced subset; returns a list of violations. */
export function validateValue(schema, value, path = 'value') {
  const violations = []
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter((branch) => validateValue(branch, value, path).length === 0)
    if (matching.length !== 1) violations.push(`${path} must match exactly one oneOf branch`)
    return violations
  }
  if (schema.const !== undefined && value !== schema.const) violations.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.join(', ')}`)
  }
  const type = schema.type
  if (type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const ok =
      (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (type === 'number' && typeof value === 'number') ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'object' && actual === 'object') ||
      (type !== 'integer' && type !== 'number' && type !== 'array' && type !== 'object' && actual === type)
    if (!ok) violations.push(`${path} must be ${type}, got ${actual}`)
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => violations.push(...validateValue(schema.items, entry, `${path}[${index}]`)))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) violations.push(`${path}.${name} is required`)
    }
    for (const [name, entry] of Object.entries(value)) {
      const child = schema.properties?.[name]
      if (child === undefined) {
        if (schema.additionalProperties === false) violations.push(`${path}.${name} is not allowed`)
        continue
      }
      violations.push(...validateValue(child, entry, `${path}.${name}`))
    }
  }
  return violations
}
