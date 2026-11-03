import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeFirecrawl, isolateConfig } from './helpers.mjs'
import {
  firecrawlSearch,
  mapSite,
  pollCrawl,
  probeCapabilities,
  resetCapabilityCache,
  resetVersionCache,
  resolveConfig,
  scrapePage,
  scrapeUrls,
  startCrawl
} from '../lib/index.js'

isolateConfig()

function configFor(url, extra = {}) {
  return resolveConfig({ firecrawlUrl: url, firecrawlRetries: 0, ...extra }, {})
}

test('scrapes one page with markdown through v2', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl()
  try {
    const page = await scrapePage(configFor(fake.url), undefined, 'https://example.com/a', { urls: [], formats: ['markdown'] })
    assert.equal(page.ok, true)
    assert.equal(page.url, 'https://example.com/a')
    assert.equal(page.title, 'Title of https://example.com/a')
    assert.match(page.markdown, /# https:\/\/example.com\/a/)
    assert.equal(page.statusCode, 200)
    const sent = fake.state.requests.find((request) => request.path === '/v2/scrape')
    assert.ok(sent, 'v2 scrape was used')
    assert.equal(sent.body.url, 'https://example.com/a')
    assert.deepEqual(sent.body.formats, ['markdown'])
  } finally {
    await fake.close()
  }
})

test('auto falls back to v1 when the instance has no v2', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl({ mode: 'v1-only' })
  try {
    const page = await scrapePage(configFor(fake.url), undefined, 'https://example.com/b', { urls: [], formats: ['markdown'] })
    assert.equal(page.ok, true)
    assert.ok(fake.state.requests.some((request) => request.path === '/v2/scrape'))
    assert.ok(fake.state.requests.some((request) => request.path === '/v1/scrape'))
  } finally {
    await fake.close()
  }
})

test('scrapes several pages through the batch endpoint', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl({ batchDelayPolls: 1 })
  try {
    const result = await scrapeUrls(
      configFor(fake.url),
      undefined,
      { urls: ['https://example.com/x', 'https://example.com/y'], formats: ['markdown'] }
    )
    assert.equal(result.pages.length, 2)
    assert.equal(result.jobId, 'batch-1')
    assert.ok(result.pages.every((page) => page.ok))
    assert.ok(fake.state.requests.some((request) => request.path === '/v2/batch/scrape'))
    // Polled until completed rather than scraping twice.
    assert.equal(fake.state.scrapes, 0)
  } finally {
    await fake.close()
  }
})

test('reports a job timeout with the live job id instead of losing it', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl({ batchDelayPolls: 100 })
  try {
    const config = configFor(fake.url, { firecrawlJobTimeoutMs: 5_000, firecrawlPollIntervalMs: 250 })
    const result = await scrapeUrls(config, undefined, { urls: ['https://example.com/x', 'https://example.com/y'] })
    assert.equal(result.timedOut, true)
    assert.equal(result.jobId, 'batch-1')
  } finally {
    await fake.close()
  }
})

test('structured extraction uses the v2 json format object', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl()
  try {
    const page = await scrapePage(
      configFor(fake.url),
      undefined,
      'https://example.com/c',
      {
        urls: [],
        formats: ['markdown'],
        extract: { prompt: 'title', schema: { type: 'object', properties: { title: { type: 'string' } } } }
      }
    )
    assert.deepEqual(page.json, { title: 'Title of https://example.com/c', extracted: true })
    const sent = fake.state.requests.find((request) => request.path === '/v2/scrape')
    const jsonFormat = sent.body.formats.find((entry) => typeof entry === 'object')
    assert.equal(jsonFormat.type, 'json')
    assert.equal(jsonFormat.prompt, 'title')
  } finally {
    await fake.close()
  }
})

test('a pinned v1 explains that extraction needs v2', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl()
  try {
    await assert.rejects(
      () =>
        scrapePage(configFor(fake.url, { firecrawlApiVersion: 'v1' }), undefined, 'https://example.com/d', {
          urls: [],
          extract: { prompt: 'title' }
        }),
      /needs Firecrawl v2/
    )
  } finally {
    await fake.close()
  }
})

test('the summary format failure quotes the server reason', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl({ summaryWorks: false })
  try {
    await assert.rejects(
      () => scrapePage(configFor(fake.url), undefined, 'https://example.com/e', { urls: [], formats: ['summary'] }),
      /HTTP 500/
    )
  } finally {
    await fake.close()
  }
})

test('a rejected API key is an actionable error', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl({ apiKey: 'right-key' })
  try {
    await assert.rejects(
      () => scrapePage(configFor(fake.url), 'wrong-key', 'https://example.com/f', { urls: [], formats: ['markdown'] }),
      /Set the API key for Firecrawl/
    )
    const page = await scrapePage(configFor(fake.url), 'right-key', 'https://example.com/f', { urls: [], formats: ['markdown'] })
    assert.equal(page.ok, true)
  } finally {
    await fake.close()
  }
})

test('maps a site from v2 link objects', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl()
  try {
    const result = await mapSite(configFor(fake.url), undefined, { url: 'https://example.com', limit: 10 })
    assert.equal(result.links.length, 3)
    assert.equal(result.links[0], 'https://example.com/docs/a')
    assert.equal(result.version, 'v2')
  } finally {
    await fake.close()
  }
})

test('starts and polls a crawl', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl({ crawlDelayPolls: 1 })
  try {
    const config = configFor(fake.url)
    const started = await startCrawl(config, undefined, { url: 'https://example.com', limit: 2 })
    assert.equal(started.jobId, 'crawl-1')
    const waited = await pollCrawl(config, undefined, started.jobId, { timeoutMs: 5_000 })
    assert.equal(waited.done, true)
    assert.equal(waited.snapshot.pages.length, 2)
    const sent = fake.state.requests.find((request) => request.path === '/v2/crawl')
    assert.equal(sent.body.limit, 2)
    assert.deepEqual(sent.body.scrapeOptions.formats, ['markdown'])
  } finally {
    await fake.close()
  }
})

test('search maps both response shapes', async () => {
  resetVersionCache()
  const fake = await createFakeFirecrawl()
  try {
    const v2 = await firecrawlSearch(configFor(fake.url), undefined, { query: 'x', limit: 3 })
    assert.equal(v2.sources.length, 2)
    assert.equal(v2.sources[0].url, 'https://example.com/one')

    resetVersionCache()
    const v1 = await firecrawlSearch(configFor(fake.url, { firecrawlApiVersion: 'v1' }), undefined, { query: 'x' })
    assert.equal(v1.sources.length, 2)
  } finally {
    await fake.close()
  }
})

test('the capability probe reports both versions, formats and deprecations', async () => {
  resetVersionCache()
  resetCapabilityCache()
  const fake = await createFakeFirecrawl({ summaryWorks: false })
  try {
    const caps = await probeCapabilities(configFor(fake.url), undefined, { probeFormats: true })
    assert.equal(caps.reachable, true)
    assert.equal(caps.preferred, 'v2')
    assert.equal(caps.versions.v2.endpoints.scrape, 'present')
    assert.equal(caps.versions.v1.endpoints.scrape, 'present')
    assert.equal(caps.formats.markdown, true)
    assert.equal(caps.formats.links, true)
    assert.equal(caps.formats.json, true)
    assert.equal(caps.formats.summary, false)
    assert.ok(caps.deprecations.some((line) => /summary/.test(line)))
    assert.ok(caps.deprecations.some((line) => /extract is deprecated/.test(line)))
  } finally {
    await fake.close()
  }
})

test('the capability probe marks absent endpoints on a v1-only instance', async () => {
  resetVersionCache()
  resetCapabilityCache()
  const fake = await createFakeFirecrawl({ mode: 'v1-only' })
  try {
    const caps = await probeCapabilities(configFor(fake.url), undefined, { probeFormats: false })
    assert.equal(caps.versions.v2.endpoints.scrape, 'absent')
    assert.equal(caps.versions.v1.endpoints.scrape, 'present')
    assert.equal(caps.preferred, 'v1')
  } finally {
    await fake.close()
  }
})

test('an unreachable instance is reported, not thrown', async () => {
  resetVersionCache()
  resetCapabilityCache()
  const caps = await probeCapabilities(configFor('http://127.0.0.1:1'), undefined, { probeFormats: false })
  assert.equal(caps.reachable, false)
  assert.ok(typeof caps.error === 'string')
})
