import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeFirecrawl, createFakeSearxng, createHostContext, isolateConfig } from './helpers.mjs'
import { ROUTE_PREFIX, TOOL_NAMES, apply } from '../lib/index.js'

isolateConfig()

function harness(overrides = {}) {
  const tools = { registered: [], register(definition) { this.registered.push(definition) } }
  const searchProviders = []
  const fetchProviders = []
  const web = {
    registerSearchProvider(provider) {
      searchProviders.push(provider)
    },
    registerFetchProvider(provider) {
      fetchProviders.push(provider)
    }
  }
  const settings = []
  const routes = []
  const services = {
    tools,
    web,
    settings: { configure: (options, fiber) => settings.push({ options, fiber }) },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    },
    ...overrides
  }
  const ctx = createHostContext(services)
  return { ctx, tools, web, searchProviders, fetchProviders, settings, routes, services }
}

test('apply registers the five tools and both seam providers', () => {
  const h = harness()
  apply(h.ctx, { searxngUrl: 'http://127.0.0.1:8080', firecrawlUrl: 'http://127.0.0.1:3002' })

  assert.equal(h.tools.registered.length, 5)
  assert.deepEqual(
    h.tools.registered.map((tool) => tool.name),
    [...TOOL_NAMES]
  )
  assert.equal(h.searchProviders.length, 1)
  assert.equal(h.searchProviders[0].id, 'searxng')
  assert.equal(h.fetchProviders.length, 1)
  assert.equal(h.fetchProviders[0].id, 'firecrawl')
  assert.equal(h.settings.length, 1)
  assert.equal(h.settings[0].options.auto, false)
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].path, ROUTE_PREFIX)
})

test('the registered providers answer through the seam contract', async () => {
  const searxng = await createFakeSearxng()
  const firecrawl = await createFakeFirecrawl()
  try {
    const h = harness()
    apply(h.ctx, { searxngUrl: searxng.url, firecrawlUrl: firecrawl.url })

    const search = await h.searchProviders[0].search({ query: 'x', maxResults: 5 })
    assert.ok(Array.isArray(search.sources))
    assert.ok(search.sources.length > 0)
    assert.equal(typeof search.truncated, 'boolean')

    const fetched = await h.fetchProviders[0].fetch({ url: 'https://example.com/page' })
    assert.equal(fetched.body.kind, 'text')
    assert.match(fetched.body.content, /# https:\/\/example.com\/page/)
    assert.equal(fetched.statusCode, 200)
  } finally {
    await searxng.close()
    await firecrawl.close()
  }
})

test('a provider registration failure does not stop the tools or the other provider', () => {
  const h = harness()
  h.web.registerSearchProvider = () => {
    throw new Error('duplicate provider id "searxng"')
  }
  apply(h.ctx, { searxngUrl: 'http://127.0.0.1:8080', firecrawlUrl: 'http://127.0.0.1:3002' })
  assert.equal(h.tools.registered.length, 5)
  assert.equal(h.fetchProviders.length, 1)
})

test('a host without the web service still gets the tools', () => {
  const h = harness({ web: undefined })
  apply(h.ctx, {})
  assert.equal(h.tools.registered.length, 5)
  assert.equal(h.fetchProviders.length, 0)
})

test('a host without a tool registry is a warning, not a crash', () => {
  const h = harness({ tools: undefined })
  assert.doesNotThrow(() => apply(h.ctx, {}))
})

test('the tools work end to end after apply', async () => {
  const searxng = await createFakeSearxng()
  const firecrawl = await createFakeFirecrawl()
  try {
    const h = harness()
    apply(h.ctx, { searxngUrl: searxng.url, firecrawlUrl: firecrawl.url, firecrawlPollIntervalMs: 250 })

    const status = h.tools.registered.find((tool) => tool.name === 'web_status')
    const result = await status.execute({}, { agent: { cwd: process.cwd() } })
    assert.equal(result.searxng.reachable, true)
    assert.equal(result.firecrawl.reachable, true)

    const scrape = h.tools.registered.find((tool) => tool.name === 'web_scrape')
    const pages = await scrape.execute({ urls: ['https://example.com/a', 'https://example.com/b'] }, { agent: { cwd: process.cwd() } })
    assert.equal(pages.pages.length, 2)
  } finally {
    await searxng.close()
    await firecrawl.close()
  }
})
