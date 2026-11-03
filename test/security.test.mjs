import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeFirecrawl, createFakeSearxng, createHostContext, isolateConfig } from './helpers.mjs'
import {
  PluginError,
  createProbeRouteHandler,
  redactDeep,
  redactSecrets,
  resolveConfig,
  scrapePage
} from '../lib/index.js'

isolateConfig()

const ROUTE = '/plugin/web-search-scrape/api/probe'

function makeRequest(options = {}) {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  return {
    method: options.method ?? 'POST',
    url: options.url ?? ROUTE,
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = typeof body === 'string' ? body : String(body ?? '')
    }
  }
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', 'x-dsh-web-search-scrape': '1', ...extra }
}

test('redactSecrets removes a key and common header echoes', () => {
  const text = 'authorization: Bearer super-secret-key-123 and "super-secret-key-123"'
  const redacted = redactSecrets(text, ['super-secret-key-123'])
  assert.doesNotMatch(redacted, /super-secret-key-123/)
  assert.match(redacted, /\[redacted\]/)
})

test('redactDeep scrubs nested values', () => {
  const redacted = redactDeep({ a: 'key-abcdef', b: ['key-abcdef'], c: { d: 'key-abcdef' } }, ['key-abcdef'])
  assert.doesNotMatch(JSON.stringify(redacted), /key-abcdef/)
})

test('the probe route answers with both instances and never echoes a key', async () => {
  const searxng = await createFakeSearxng()
  const firecrawl = await createFakeFirecrawl()
  process.env.SEARXNG_API_KEY = 'super-secret-key-123'
  try {
    const ctx = createHostContext()
    const handler = createProbeRouteHandler(
      ctx,
      { searxngUrl: searxng.url, firecrawlUrl: firecrawl.url },
      (value) => resolveConfig(value, process.env)
    )
    const request = makeRequest({ headers: jsonHeaders(), body: JSON.stringify({ refresh: true }) })
    const response = makeResponse()
    await handler(request, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    const payload = JSON.parse(response.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.searxng.reachable, true)
    assert.equal(payload.firecrawl.reachable, true)
    assert.equal(payload.searxng.keyConfigured, true)
    assert.doesNotMatch(response.body, /super-secret-key-123/)
    assert.doesNotMatch(response.body, /Bearer /)
  } finally {
    delete process.env.SEARXNG_API_KEY
    await searxng.close()
    await firecrawl.close()
  }
})

test('the probe route rejects an unknown path, a wrong method and a non-JSON body', async () => {
  const handler = createProbeRouteHandler(createHostContext(), {}, (value) => resolveConfig(value, process.env))

  const notFound = makeResponse()
  await handler(makeRequest({ url: '/plugin/web-search-scrape/api/other', headers: jsonHeaders() }), notFound)
  assert.equal(notFound.statusCode, 404)

  const wrongMethod = makeResponse()
  await handler(makeRequest({ method: 'GET', headers: jsonHeaders() }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const wrongType = makeResponse()
  await handler(makeRequest({ headers: { 'x-dsh-web-search-scrape': '1', 'content-type': 'text/plain' } }), wrongType)
  assert.equal(wrongType.statusCode, 415)

  const noHeader = makeResponse()
  await handler(makeRequest({ headers: { 'content-type': 'application/json' } }), noHeader)
  assert.equal(noHeader.statusCode, 403)

  const badJson = makeResponse()
  await handler(makeRequest({ headers: jsonHeaders(), body: '{ oops' }), badJson)
  assert.equal(badJson.statusCode, 400)

  const tooLarge = makeResponse()
  await handler(makeRequest({ headers: jsonHeaders(), body: JSON.stringify({ blob: 'x'.repeat(20 * 1024) }) }), tooLarge)
  assert.equal(tooLarge.statusCode, 400)
  assert.match(tooLarge.body, /too large/)
})

test('the probe route honours the connection service and falls back to loopback', async () => {
  const rejecting = createHostContext({ connection: { requestRejection: () => 401 } })
  const handler = createProbeRouteHandler(rejecting, {}, (value) => resolveConfig(value, process.env))
  const rejected = makeResponse()
  await handler(makeRequest({ headers: jsonHeaders() }), rejected)
  assert.equal(rejected.statusCode, 401)

  const loopbackOnly = createProbeRouteHandler(createHostContext(), {}, (value) => resolveConfig(value, process.env))
  const offLoopback = makeResponse()
  await loopbackOnly(makeRequest({ headers: jsonHeaders(), remoteAddress: '10.1.2.3' }), offLoopback)
  assert.equal(offLoopback.statusCode, 403)

  const loopback = makeResponse()
  await loopbackOnly(makeRequest({ headers: jsonHeaders() }), loopback)
  assert.equal(loopback.statusCode, 200)
})

test('a provider error never contains the key and carries a code', async () => {
  const fake = await createFakeFirecrawl({ apiKey: 'right-key' })
  try {
    const config = resolveConfig({ firecrawlUrl: fake.url, firecrawlRetries: 0 }, process.env)
    await assert.rejects(
      () => scrapePage(config, 'wrong-key-abcdef', 'https://example.com', { urls: [], formats: ['markdown'] }),
      (error) => {
        assert.doesNotMatch(error.message, /wrong-key-abcdef/)
        assert.doesNotMatch(error.message, /right-key/)
        return true
      }
    )
  } finally {
    await fake.close()
  }
})

test('coded errors keep their code and message', () => {
  const error = new PluginError('boom', 'WEB_JOB_TIMEOUT')
  assert.equal(error.code, 'WEB_JOB_TIMEOUT')
  assert.equal(error.message, 'boom')
  assert.equal(error.name, 'WebError')
})
