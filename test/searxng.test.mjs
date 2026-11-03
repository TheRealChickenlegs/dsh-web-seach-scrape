import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeSearxng, isolateConfig } from './helpers.mjs'
import { limitOutcome, mapSearxngResponse, resolveConfig, searchSearxng, searxngInstanceInfo } from '../lib/index.js'

isolateConfig()

function configFor(url, extra = {}) {
  return resolveConfig({ searxngUrl: url, searxngCategories: [], ...extra }, {})
}

test('maps and de-duplicates results, capping snippets', () => {
  const outcome = mapSearxngResponse(
    {
      results: [
        { url: 'https://a', title: 'A', content: 'x'.repeat(600), publishedDate: '2026-01-01' },
        { url: 'https://a', title: 'A dup', content: 'dup' },
        { url: 'https://b', title: 'B', content: 'short', pubdate: '2026-02-02' },
        { title: 'no url' }
      ],
      answers: ['Answer one', '  ']
    },
    100
  )
  assert.equal(outcome.sources.length, 2)
  assert.equal(outcome.sources[0].url, 'https://a')
  assert.equal(outcome.sources[0].snippet.length, 100)
  assert.equal(outcome.sources[1].publishedAt, '2026-02-02')
  assert.equal(outcome.content, 'Answer one')
  assert.equal(outcome.truncated, false)
})

test('limitOutcome reports truncation', () => {
  const outcome = { sources: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], truncated: false }
  const limited = limitOutcome(outcome, 2)
  assert.equal(limited.sources.length, 2)
  assert.equal(limited.truncated, true)
  assert.deepEqual(limited.sources.map((source) => source.url), ['a', 'b'])
})

test('forwards filters to SearXNG and reads the answer text', async () => {
  const fake = await createFakeSearxng()
  try {
    const config = configFor(fake.url)
    const outcome = await searchSearxng(config, undefined, {
      query: 'deepseek harness',
      categories: ['general', 'news'],
      engines: ['braveapi'],
      language: 'en',
      page: 3,
      timeRange: 'week',
      safeSearch: 1
    })
    const sent = fake.state.requests.find((request) => request.path === '/search')
    assert.equal(fake.state.searches, 1)
    assert.equal(sent.query.q, 'deepseek harness')
    assert.equal(sent.query.format, 'json')
    assert.equal(sent.query.categories, 'general,news')
    assert.equal(sent.query.engines, 'braveapi')
    assert.equal(sent.query.language, 'en')
    assert.equal(sent.query.pageno, '3')
    assert.equal(sent.query.time_range, 'week')
    assert.equal(sent.query.safesearch, '1')
    assert.equal(outcome.sources.length, 2)
  } finally {
    await fake.close()
  }
})

test('an HTML answer explains the missing json format', async () => {
  const fake = await createFakeSearxng({ htmlOnly: true })
  try {
    await assert.rejects(
      () => searchSearxng(configFor(fake.url), undefined, { query: 'x' }),
      /Add "json" to search\.formats/
    )
  } finally {
    await fake.close()
  }
})

test('a 403 mentions the public-instance bot filter', async () => {
  const fake = await createFakeSearxng({ requireHeader: { name: 'authorization', value: 'Bearer secret-key' } })
  try {
    await assert.rejects(
      () => searchSearxng(configFor(fake.url), undefined, { query: 'x' }),
      /HTTP 403/
    )
    // With the key, the same instance answers.
    const outcome = await searchSearxng(configFor(fake.url), 'secret-key', { query: 'x' })
    assert.equal(outcome.sources.length, 2)
  } finally {
    await fake.close()
  }
})

test('a server error surfaces its message', async () => {
  const fake = await createFakeSearxng({ fail: true })
  try {
    await assert.rejects(() => searchSearxng(configFor(fake.url), undefined, { query: 'x' }), /HTTP 500/)
  } finally {
    await fake.close()
  }
})

test('an unconfigured endpoint is a clear error', async () => {
  await assert.rejects(
    () => searchSearxng(resolveConfig({ searxngUrl: 'ftp://bad' }, {}), undefined, { query: 'x' }),
    /No SearXNG endpoint is configured/
  )
})

test('instance info lists the engines, categories and locales', async () => {
  const fake = await createFakeSearxng()
  try {
    const info = await searxngInstanceInfo(configFor(fake.url), undefined)
    assert.equal(info.reachable, true)
    assert.equal(info.version, '2026.10.16+test')
    assert.equal(info.instanceName, 'Test SearXNG')
    assert.deepEqual(info.categories, ['general', 'web', 'news'])
    assert.deepEqual(
      info.engines.map((engine) => engine.name),
      ['braveapi', 'arxiv', 'disabled-engine']
    )
    assert.deepEqual(Object.keys(info.locales).length > 0, true)
  } finally {
    await fake.close()
  }
})

test('instance info reports an unreachable instance instead of throwing', async () => {
  const info = await searxngInstanceInfo(resolveConfig({ searxngUrl: 'http://127.0.0.1:1' }, {}), undefined)
  assert.equal(info.reachable, false)
  assert.ok(typeof info.error === 'string')
})
