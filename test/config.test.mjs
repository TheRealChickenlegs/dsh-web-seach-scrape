import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isolateConfig } from './helpers.mjs'
import {
  DEFAULTS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  configFilePath,
  normalizeEndpoint,
  readConfigFile,
  resolveConfig
} from '../lib/index.js'

isolateConfig()

test('defaults are the documented local endpoints', () => {
  const config = resolveConfig(undefined, process.env)
  assert.equal(config.searxngUrl, DEFAULTS.searxngUrl)
  assert.equal(config.firecrawlUrl, DEFAULTS.firecrawlUrl)
  assert.equal(config.firecrawlApiVersion, 'auto')
  assert.deepEqual(config.firecrawlFormats, ['markdown'])
  assert.equal(config.firecrawlOnlyMainContent, true)
  assert.equal(config.searxngCategories.length > 0, true)
  assert.deepEqual(config.problems, [])
})

test('plugin config wins over file and environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-web-search-scrape-config-'))
  const file = path.join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ searxngUrl: 'http://file:8080', firecrawlUrl: 'http://file:3002' }), 'utf8')

  const env = {
    ...process.env,
    DSH_WEB_SEARCH_SCRAPE_CONFIG: file,
    SEARXNG_URL: 'http://env:8080',
    FIRECRAWL_URL: 'http://env:3002'
  }
  assert.equal(resolveConfig(undefined, env).searxngUrl, 'http://file:8080')

  const config = resolveConfig({ searxngUrl: 'http://plugin:8080' }, env)
  assert.equal(config.searxngUrl, 'http://plugin:8080')
  // Untouched keys still fall through to the file layer.
  assert.equal(config.firecrawlUrl, 'http://file:3002')
})

test('environment supplies the conventional endpoint names', () => {
  const env = { ...process.env, SEARXNG_URL: 'http://searx.local:8888', FIRECRAWL_URL: 'http://firecrawl.local:3002' }
  const config = resolveConfig(undefined, env)
  assert.equal(config.searxngUrl, 'http://searx.local:8888')
  assert.equal(config.firecrawlUrl, 'http://firecrawl.local:3002')
})

test('volatile references are unwrapped', () => {
  const config = resolveConfig({ searxngUrl: { get: () => 'http://wrapped:8080' } }, process.env)
  assert.equal(config.searxngUrl, 'http://wrapped:8080')
})

test('an invalid endpoint is reported and dropped, not thrown', () => {
  const config = resolveConfig({ searxngUrl: 'ftp://nope', firecrawlUrl: 'not a url' }, process.env)
  assert.equal(config.searxngUrl, undefined)
  assert.equal(config.firecrawlUrl, undefined)
  assert.equal(config.problems.length, 2)
  assert.match(config.problems.join('\n'), /must use http or https/)
  assert.match(config.problems.join('\n'), /not a valid URL/)
})

test('endpoints with credentials or a query string are rejected', () => {
  assert.match(normalizeEndpoint('http://user:pass@host:8080').error ?? '', /must not embed credentials/)
  assert.match(normalizeEndpoint('http://host:8080/?a=1').error ?? '', /must not contain a query string/)
  assert.deepEqual(normalizeEndpoint('http://host:8080/'), { url: 'http://host:8080' })
})

test('a credential reference must look like an environment variable name', () => {
  const config = resolveConfig({ searxngApiKeyEnv: 'not a name' }, process.env)
  assert.equal(config.searxngApiKeyEnv, 'SEARXNG_API_KEY')
  assert.match(config.problems.join('\n'), /environment-variable-style name/)
})

test('enums are validated and unknown scrape formats are dropped', () => {
  const config = resolveConfig(
    {
      firecrawlApiVersion: 'v9',
      firecrawlProxy: 'turbo',
      searxngTimeRange: 'decade',
      firecrawlFormats: ['markdown', 'bogus'],
      searxngSafeSearch: 7
    },
    {}
  )
  assert.equal(config.firecrawlApiVersion, 'auto')
  assert.equal(config.firecrawlProxy, undefined)
  assert.equal(config.searxngTimeRange, undefined)
  assert.equal(config.searxngSafeSearch, undefined)
  assert.deepEqual(config.firecrawlFormats, ['markdown'])
  assert.equal(config.problems.length, 5)
})

test('lists accept a comma-separated string from the environment', () => {
  const config = resolveConfig(undefined, {
    ...process.env,
    DSH_WEB_SEARCH_SCRAPE_SEARXNG_CATEGORIES: 'general, news',
    DSH_WEB_SEARCH_SCRAPE_SEARXNG_ENGINES: 'braveapi,arxiv',
    DSH_WEB_SEARCH_SCRAPE_FIRECRAWL_FORMATS: 'markdown,links'
  })
  assert.deepEqual(config.searxngCategories, ['general', 'news'])
  assert.deepEqual(config.searxngEngines, ['braveapi', 'arxiv'])
  assert.deepEqual(config.firecrawlFormats, ['markdown', 'links'])
})

test('numbers are clamped to their accepted range', () => {
  const config = resolveConfig(
    { firecrawlMaxUrls: 10_000, firecrawlRetries: -3, maxInlineChars: 10 },
    {}
  )
  assert.equal(config.firecrawlMaxUrls, 200)
  assert.equal(config.firecrawlRetries, 0)
  assert.equal(config.maxInlineChars, 500)
})

test('booleans accept environment spellings', () => {
  const config = resolveConfig(undefined, {
    ...process.env,
    DSH_WEB_SEARCH_SCRAPE_FIRECRAWL_ONLY_MAIN_CONTENT: 'false',
    DSH_WEB_SEARCH_SCRAPE_WRITE_METADATA: 'no'
  })
  assert.equal(config.firecrawlOnlyMainContent, false)
  assert.equal(config.writeMetadata, false)
})

test('config file location honours the override and ~ expansion', () => {
  // Compare against the platform's own resolution: on Windows "/tmp/x.json" is
  // "D:\tmp\x.json", so a literal expectation would be a POSIX-only assertion.
  assert.equal(
    configFilePath({ ...process.env, DSH_WEB_SEARCH_SCRAPE_CONFIG: '/tmp/x.json' }),
    path.resolve('/tmp/x.json')
  )
  assert.equal(
    configFilePath({ ...process.env, DSH_WEB_SEARCH_SCRAPE_CONFIG: '~/x.json' }),
    path.join(homedir(), 'x.json')
  )
  // Exact comparison rather than a regex: `path.sep` is a backslash on Windows,
  // which is a regex escape there and silently corrupts the pattern.
  assert.equal(
    configFilePath({ ...process.env, DSH_WEB_SEARCH_SCRAPE_CONFIG: '' }),
    path.join(homedir(), `.${PLUGIN_ID}`, 'config.json')
  )
})

test('a broken config file is ignored with a warning, not a crash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-web-search-scrape-broken-'))
  const file = path.join(dir, 'config.json')
  writeFileSync(file, '{ not json', 'utf8')
  assert.deepEqual(readConfigFile({ ...process.env, DSH_WEB_SEARCH_SCRAPE_CONFIG: file }), {})
})

test('identity matches package.json', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, PLUGIN_ID)
  assert.equal(pkg.version, PLUGIN_VERSION)
})
