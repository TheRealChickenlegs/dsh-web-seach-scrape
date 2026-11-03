import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeFirecrawl, createFakeSearxng, createHostContext, isolateConfig } from './helpers.mjs'
import { FirecrawlFetchProvider, SearxngSearchProvider, resolveConfig } from '../lib/index.js'

isolateConfig()

test('the search provider reports its id and endpoint availability', () => {
  const provider = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: 'http://127.0.0.1:8080' }, process.env) }))
  assert.equal(provider.id, 'searxng')
  assert.equal(provider.available(), true)

  const broken = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: 'ftp://nope' }, process.env) }))
  assert.equal(broken.available(), false)
  assert.equal(broken.id, 'searxng')
})

test('the fetch provider reports its id and endpoint availability', () => {
  const provider = new FirecrawlFetchProvider(() => ({ config: resolveConfig({ firecrawlUrl: 'http://127.0.0.1:3002' }, process.env) }))
  assert.equal(provider.id, 'firecrawl')
  assert.equal(provider.available(), true)
  assert.equal(new FirecrawlFetchProvider(() => ({ config: resolveConfig({ firecrawlUrl: 'bad' }, process.env) })).available(), false)
})

test('search returns the seam shape and honours maxResults', async () => {
  const fake = await createFakeSearxng()
  try {
    const provider = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: fake.url }, process.env) }))
    const result = await provider.search({ query: 'x', maxResults: 1 })
    assert.equal(result.sources.length, 1)
    assert.equal(result.truncated, true)
    assert.equal(typeof result.sources[0].url, 'string')
  } finally {
    await fake.close()
  }
})

test('search resolves the API key from the environment', async () => {
  const fake = await createFakeSearxng({ requireHeader: { name: 'authorization', value: 'Bearer env-key' } })
  process.env.SEARXNG_API_KEY = 'env-key'
  try {
    const provider = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: fake.url }, process.env) }))
    const result = await provider.search({ query: 'x' })
    assert.ok(result.sources.length > 0)
  } finally {
    delete process.env.SEARXNG_API_KEY
    await fake.close()
  }
})

test('search failures are coded and actionable', async () => {
  const fake = await createFakeSearxng({ fail: true })
  try {
    const provider = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: fake.url }, process.env) }))
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR')
        assert.match(error.message, /SearXNG search provider/)
        return true
      }
    )
  } finally {
    await fake.close()
  }
})

test('an aborted search is reported as WEB_ABORTED', async () => {
  const fake = await createFakeSearxng()
  try {
    const provider = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: fake.url }, process.env) }))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => provider.search({ query: 'x' }, controller.signal),
      (error) => {
        assert.equal(error.code, 'WEB_ABORTED')
        return true
      }
    )
  } finally {
    await fake.close()
  }
})

test('an unconfigured search endpoint is WEB_PROVIDER_UNAVAILABLE', async () => {
  const provider = new SearxngSearchProvider(() => ({ config: resolveConfig({ searxngUrl: 'ftp://nope' }, process.env) }))
  await assert.rejects(
    () => provider.search({ query: 'x' }),
    (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_UNAVAILABLE')
      return true
    }
  )
})

test('fetch returns markdown as a text body with the page status', async () => {
  const fake = await createFakeFirecrawl()
  try {
    const provider = new FirecrawlFetchProvider(() => ({ config: resolveConfig({ firecrawlUrl: fake.url }, process.env) }))
    const result = await provider.fetch({ url: 'https://example.com/page' })
    assert.equal(result.url, 'https://example.com/page')
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.kind, 'text')
    assert.match(result.body.content, /# https:\/\/example.com\/page/)
    assert.equal(result.truncated, false)
  } finally {
    await fake.close()
  }
})

test('fetch resolves its key through the credentials service', async () => {
  const fake = await createFakeFirecrawl({ apiKey: 'stored-key' })
  const calls = []
  const host = createHostContext({
    credentials: {
      resolve: async (ref) => {
        calls.push(ref)
        return ref === 'FIRECRAWL_API_KEY' ? { value: 'stored-key', source: 'credentials' } : undefined
      },
      describe: async () => ({ configured: true })
    }
  })
  try {
    const provider = new FirecrawlFetchProvider(() => ({ config: resolveConfig({ firecrawlUrl: fake.url }, process.env), host }))
    const result = await provider.fetch({ url: 'https://example.com/page' })
    assert.equal(result.statusCode, 200)
    assert.deepEqual(calls, ['FIRECRAWL_API_KEY'])
  } finally {
    await fake.close()
  }
})

test('a fetch failure names the provider and the configuration to check', async () => {
  const fake = await createFakeFirecrawl({ summaryWorks: false })
  try {
    // Ask for a format the fake cannot produce by pinning a v1 instance without markdown support is not possible;
    // instead use an unreachable endpoint to prove the message shape.
    const provider = new FirecrawlFetchProvider(() => ({ config: resolveConfig({ firecrawlUrl: 'http://127.0.0.1:1' }, process.env) }))
    await assert.rejects(
      () => provider.fetch({ url: 'https://example.com' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR')
        assert.match(error.message, /Firecrawl fetch provider/)
        return true
      }
    )
  } finally {
    await fake.close()
  }
})
