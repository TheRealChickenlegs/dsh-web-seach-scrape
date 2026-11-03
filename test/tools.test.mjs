import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertSchemaSubset, createFakeFirecrawl, createFakeSearxng, isolateConfig, validateValue } from './helpers.mjs'
import {
  CRAWL_PARAMETERS,
  MAP_PARAMETERS,
  SCRAPE_PARAMETERS,
  SEARCH_PARAMETERS,
  STATUS_PARAMETERS,
  createCrawlTool,
  createMapTool,
  createScrapeTool,
  createSearchTool,
  createStatusTool
} from '../lib/index.js'

isolateConfig()

function configFor(overrides) {
  return { firecrawlRetries: 0, firecrawlPollIntervalMs: 250, firecrawlJobTimeoutMs: 10_000, ...overrides }
}

const TOOLS = [
  ['web_search_advanced', SEARCH_PARAMETERS, createSearchTool],
  ['web_scrape', SCRAPE_PARAMETERS, createScrapeTool],
  ['web_map', MAP_PARAMETERS, createMapTool],
  ['web_crawl', CRAWL_PARAMETERS, createCrawlTool],
  ['web_status', STATUS_PARAMETERS, createStatusTool]
]

test('every tool schema stays inside the enforced JSON-Schema subset', () => {
  for (const [name, schema] of TOOLS) {
    assert.equal(schema.type, 'object', `${name} parameters must be an object root`)
    assert.doesNotThrow(() => assertSchemaSubset(schema), `${name} parameters`)
  }
})

test('every tool declares name, description, schema, render and execute', () => {
  for (const [name, , factory] of TOOLS) {
    const tool = factory({})
    assert.equal(tool.name, name)
    assert.ok(tool.description.length > 80, `${name} needs a real description`)
    assert.doesNotThrow(() => assertSchemaSubset(tool.output.schema), `${name} output`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.timeoutMs, 'number')
  }
})

test('web_scrape uses a single scrape for one URL and batch for several', async () => {
  const fake = await createFakeFirecrawl()
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-scrape-'))
  try {
    const tool = createScrapeTool(configFor({ firecrawlUrl: fake.url }))
    const single = await tool.execute({ urls: ['https://example.com/a'] }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, single).length, 0)
    assert.equal(single.pages.length, 1)
    assert.ok(fake.state.requests.some((request) => request.path === '/v2/scrape'))

    fake.state.requests.length = 0
    const many = await tool.execute({ urls: ['https://example.com/a', 'https://example.com/b'] }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, many).length, 0)
    assert.equal(many.pages.length, 2)
    assert.ok(fake.state.requests.some((request) => request.path === '/v2/batch/scrape'))
    assert.match(many.text, /Scraped 2 page/)
  } finally {
    await fake.close()
  }
})

test('web_scrape rejects a non-http URL before spending a request', async () => {
  const tool = createScrapeTool({})
  await assert.rejects(() => tool.execute({ urls: ['file:///etc/passwd'] }, {}), /must use http or https/)
  await assert.rejects(() => tool.execute({ urls: [] }, {}), /at least one http\(s\) URL/)
})

test('web_scrape needs a prompt for the json format', async () => {
  const tool = createScrapeTool({})
  await assert.rejects(
    () => tool.execute({ urls: ['https://example.com'], formats: ['json'] }, {}),
    /needs `extract` with a prompt/
  )
})

test('a long page is saved in full and previewed inline', async () => {
  const fake = await createFakeFirecrawl()
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-long-'))
  try {
    const tool = createScrapeTool(configFor({ firecrawlUrl: fake.url, maxInlineChars: 500 }))
    const result = await tool.execute({ urls: ['https://example.com/long'] }, { agent: { cwd } })
    // The fake body is short; force a save by pointing save_to at a directory.
    const forced = await tool.execute({ urls: ['https://example.com/long'], save_to: 'out' }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, forced).length, 0)
    const saved = forced.pages[0].savedPath
    assert.ok(saved, 'the page was written to disk')
    assert.match(readFileSync(saved, 'utf8'), /body text/)
    assert.ok(saved.startsWith(path.join(cwd, 'out')))
    // The metadata sidecar is written next to it.
    const files = readdirSync(path.join(cwd, 'out'))
    assert.ok(files.some((file) => file.endsWith('.json')))
    assert.equal(result.ok, true)
  } finally {
    await fake.close()
  }
})

test('an extraction that returns nothing carries the server warning', async () => {
  const fake = await createFakeFirecrawl({ jsonWorks: false })
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-extract-'))
  try {
    const tool = createScrapeTool(configFor({ firecrawlUrl: fake.url }))
    const result = await tool.execute(
      { urls: ['https://example.com'], formats: ['markdown'], extract: { prompt: 'title' } },
      { agent: { cwd } }
    )
    assert.equal(validateValue(tool.output.schema, result).length, 0)
    assert.match(result.pages[0].warning, /JSON extraction failed/)
    assert.match(result.text, /Note: JSON extraction failed/)
  } finally {
    await fake.close()
  }
})

test('web_map returns links and reports the total', async () => {
  const fake = await createFakeFirecrawl()
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-map-'))
  try {
    const tool = createMapTool(configFor({ firecrawlUrl: fake.url }))
    const result = await tool.execute({ url: 'https://example.com', search: 'docs' }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, result).length, 0)
    assert.equal(result.total, 3)
    assert.equal(result.truncated, false)
    assert.match(result.text, /Mapped https:\/\/example.com/)
  } finally {
    await fake.close()
  }
})

test('web_crawl returns pages and can resume a job id', async () => {
  const fake = await createFakeFirecrawl({ crawlDelayPolls: 1 })
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-crawl-'))
  try {
    const tool = createCrawlTool(configFor({ firecrawlUrl: fake.url }))
    const result = await tool.execute({ url: 'https://example.com', limit: 5 }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, result).length, 0)
    assert.equal(result.job_id, 'crawl-1')
    assert.equal(result.status, 'completed')
    assert.equal(result.pages.length, 2)

    // Resuming does not start a second crawl.
    fake.state.requests.length = 0
    const resumed = await tool.execute({ job_id: 'crawl-1' }, { agent: { cwd } })
    assert.equal(resumed.job_id, 'crawl-1')
    assert.equal(fake.state.requests.filter((request) => request.path === '/v2/crawl' && request.method === 'POST').length, 0)
  } finally {
    await fake.close()
  }
})

test('web_crawl saves each page when a destination is given', async () => {
  const fake = await createFakeFirecrawl({ crawlDelayPolls: 1 })
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-crawl-save-'))
  try {
    const tool = createCrawlTool(configFor({ firecrawlUrl: fake.url }))
    const result = await tool.execute({ url: 'https://example.com', save_to: 'crawl-out' }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, result).length, 0)
    assert.ok(result.pages.every((page) => typeof page.savedPath === 'string'))
    for (const page of result.pages) assert.ok(readFileSync(page.savedPath, 'utf8').length > 0)
  } finally {
    await fake.close()
  }
})

test('web_search_advanced falls back to Firecrawl search when SearXNG fails', async () => {
  const searxng = await createFakeSearxng({ fail: true })
  const firecrawl = await createFakeFirecrawl()
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-fallback-'))
  try {
    const tool = createSearchTool(configFor({ searxngUrl: searxng.url, firecrawlUrl: firecrawl.url }))
    const result = await tool.execute({ query: 'deepseek' }, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, result).length, 0)
    assert.equal(result.source, 'firecrawl')
    assert.equal(result.sources.length, 2)
    assert.match(result.text, /Firecrawl search for "deepseek"/)
  } finally {
    await searxng.close()
    await firecrawl.close()
  }
})

test('web_search_advanced stays on SearXNG when it works', async () => {
  const searxng = await createFakeSearxng()
  const firecrawl = await createFakeFirecrawl()
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-search-'))
  try {
    const tool = createSearchTool(configFor({ searxngUrl: searxng.url, firecrawlUrl: firecrawl.url }))
    const result = await tool.execute({ query: 'deepseek', categories: ['news'], limit: 1 }, { agent: { cwd } })
    assert.equal(result.source, 'searxng')
    assert.equal(result.sources.length, 1)
    assert.equal(result.truncated, true)
    const sent = searxng.state.requests.find((request) => request.path === '/search')
    assert.equal(sent.query.categories, 'news')
    assert.equal(firecrawl.state.requests.length, 0)
  } finally {
    await searxng.close()
    await firecrawl.close()
  }
})

test('web_status reports both instances and their capabilities', async () => {
  const searxng = await createFakeSearxng()
  const firecrawl = await createFakeFirecrawl()
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-wss-status-'))
  try {
    const tool = createStatusTool(configFor({ searxngUrl: searxng.url, firecrawlUrl: firecrawl.url }))
    const result = await tool.execute({}, { agent: { cwd } })
    assert.equal(validateValue(tool.output.schema, result).length, 0)
    assert.equal(result.searxng.reachable, true)
    assert.match(result.searxng.version, /2026\.10\.16/)
    assert.deepEqual(result.searxng.engines, ['braveapi', 'arxiv', 'disabled-engine'])
    assert.equal(result.firecrawl.reachable, true)
    assert.equal(result.firecrawl.preferred, 'v2')
    assert.ok(result.firecrawl.formats.includes('markdown'))
    assert.ok(result.firecrawl.formats.includes('json'))
    assert.ok(!result.firecrawl.formats.includes('summary'))
    assert.match(result.text, /## SearXNG/)
    assert.match(result.text, /## Firecrawl/)
  } finally {
    await searxng.close()
    await firecrawl.close()
  }
})
