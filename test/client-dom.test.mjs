import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React from 'react'

const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** Load the bundle into a jsdom window and run apply() against a mock page host. */
function mountPage(options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:49175/'
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.Event = dom.window.Event
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const mutateCalls = []
  const credentialCalls = []
  const describeCalls = []
  let snapshot = { status: 'ready', writable: true, revision: 7, value: { searxngUrl: 'http://127.0.0.1:8080' } }
  const listeners = new Set()
  const form = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return snapshot
    },
    async mutate(ops, revision) {
      mutateCalls.push({ ops, revision })
      for (const op of ops) {
        if (op.op === 'unset') delete snapshot.value[op.path[0]]
        else snapshot.value = { ...snapshot.value, [op.path[0]]: op.value }
      }
      snapshot = { ...snapshot, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return true
    }
  }
  const credentials = {
    describe: async (refs) => {
      describeCalls.push(refs)
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: false }])) }
    },
    set: async (ref, value) => {
      credentialCalls.push({ op: 'set', ref, value })
      return { ok: true }
    },
    unset: async (ref) => {
      credentialCalls.push({ op: 'unset', ref })
      return { ok: true }
    }
  }

  let slot = null
  const ctx = {
    remote: options.noCredentials === true ? {} : { credentials },
    configForms: {
      get: () => form,
      whileServed(_namespaces, register) {
        return register(new Set(['dsh-web-search-scrape']))
      }
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(definition, component) {
        slot = { definition, component }
        return () => {}
      }
    },
    effect(body) {
      return body()
    }
  }

  let contribution = null
  dom.window.__ModuleLoader__ = {
    load(value) {
      contribution = value
    }
  }
  vm.runInThisContext(source, { filename: 'client.js' })
  assert.ok(contribution)
  const exports = contribution.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  exports.apply(ctx)
  assert.ok(slot, 'the config page registered')
  return { dom, slot, form, mutateCalls, credentialCalls, describeCalls, ctx }
}

/** Set an input's value the way a user would, so React sees the change. */
function type(dom, input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function click(dom, button) {
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

async function mount(options = {}) {
  const page = mountPage(options)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(page.dom.window.document.getElementById('root'))
  await React.act(async () => {
    root.render(React.createElement(page.slot.component, { view: 'page' }))
  })
  return { ...page, root }
}

async function settle() {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

test('the page renders every service field with the saved values', async () => {
  const page = await mount()
  const document = page.dom.window.document
  try {
    assert.equal(document.getElementById('ws-searxngUrl').value, 'http://127.0.0.1:8080')
    assert.ok(document.getElementById('ws-firecrawlUrl'), 'firecrawl URL field')
    assert.ok(document.getElementById('ws-searxngCategories'), 'categories field')
    assert.ok(document.getElementById('ws-firecrawlApiVersion'), 'API version select')
    assert.ok(document.getElementById('ws-maxInlineChars'), 'output field')
    assert.match(document.getElementById('root').textContent, /Search — SearXNG/)
    assert.match(document.getElementById('root').textContent, /Scrape — Firecrawl/)
    assert.deepEqual(page.describeCalls.at(-1), ['SEARXNG_API_KEY', 'FIRECRAWL_API_KEY'])
  } finally {
    await React.act(async () => { page.root.unmount() })
  }
})

test('saving writes only the changed field with the current revision', async () => {
  const page = await mount()
  const document = page.dom.window.document
  try {
    const input = document.getElementById('ws-searxngUrl')
    await React.act(async () => { type(page.dom, input, 'http://192.168.10.10:8080') })
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save')
    assert.ok(save)
    await React.act(async () => { click(page.dom, save) })
    await settle()
    assert.equal(page.mutateCalls.length, 1)
    assert.deepEqual(page.mutateCalls[0].ops, [{ op: 'set', path: ['searxngUrl'], value: 'http://192.168.10.10:8080' }])
    assert.equal(page.mutateCalls[0].revision, 7)
    assert.match(document.getElementById('root').textContent, /Saved\./)
  } finally {
    await React.act(async () => { page.root.unmount() })
  }
})

test('a list field is saved as an array and a cleared field unsets', async () => {
  const page = await mount()
  const document = page.dom.window.document
  try {
    const categories = document.getElementById('ws-searxngCategories')
    await React.act(async () => { type(page.dom, categories, 'general, news') })
    const save = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save')
    await React.act(async () => { click(page.dom, save) })
    await settle()
    assert.deepEqual(page.mutateCalls[0].ops, [{ op: 'set', path: ['searxngCategories'], value: ['general', 'news'] }])

    await React.act(async () => { type(page.dom, document.getElementById('ws-searxngUrl'), '') })
    await React.act(async () => { click(page.dom, save) })
    await settle()
    assert.deepEqual(page.mutateCalls[1].ops, [{ op: 'unset', path: ['searxngUrl'] }])
  } finally {
    await React.act(async () => { page.root.unmount() })
  }
})

test('an API key is written to the credentials service and never into the config', async () => {
  const page = await mount()
  const document = page.dom.window.document
  try {
    const keyInput = document.querySelector('input[aria-label="SearXNG API key"]')
    assert.ok(keyInput)
    await React.act(async () => { type(page.dom, keyInput, 'sk_none_needed') })
    const saveKey = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save key')
    await React.act(async () => { click(page.dom, saveKey) })
    await settle()
    assert.deepEqual(page.credentialCalls, [{ op: 'set', ref: 'SEARXNG_API_KEY', value: 'sk_none_needed' }])
    assert.equal(page.mutateCalls.length, 0, 'no config write happened')
    assert.match(document.getElementById('root').textContent, /configured/)
  } finally {
    await React.act(async () => { page.root.unmount() })
  }
})

test('“Test both services” asks the host and renders the report', async () => {
  const page = await mount()
  const document = page.dom.window.document
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          searxng: {
            url: 'http://127.0.0.1:8080',
            reachable: true,
            version: '2026.10.16+ff8f5ddcc',
            instanceName: 'SearXNG',
            categories: ['general'],
            engines: [{ name: 'braveapi' }, { name: 'arxiv' }],
            locales: ['en'],
            keyConfigured: true,
            error: null
          },
          firecrawl: {
            url: 'http://127.0.0.1:3002',
            reachable: true,
            preferred: 'v2',
            versions: {
              v1: { reachable: true, endpoints: { scrape: 'present', search: 'present' } },
              v2: { reachable: true, endpoints: { scrape: 'present', search: 'present' } }
            },
            formats: { markdown: true, html: true, links: true, summary: false, json: true },
            deprecations: [],
            keyConfigured: false,
            probedAt: Date.now(),
            error: null
          },
          problems: []
        })
    }
  }
  try {
    const test = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Test both services')
    await React.act(async () => { click(page.dom, test) })
    await settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/plugin/web-search-scrape/api/probe')
    assert.equal(calls[0].init.headers['x-dsh-web-search-scrape'], '1')
    assert.equal(calls[0].init.headers['content-type'], 'application/json')

    const text = document.getElementById('root').textContent
    assert.match(text, /Instance report/)
    assert.match(text, /2026\.10\.16/)
    assert.match(text, /braveapi/)
    assert.match(text, /Preferred API/)
  } finally {
    globalThis.fetch = originalFetch
    await React.act(async () => { page.root.unmount() })
  }
})

test('the page stays usable when the credentials service is absent', async () => {
  const page = await mount({ noCredentials: true })
  const document = page.dom.window.document
  try {
    assert.match(document.getElementById('root').textContent, /credentials service unavailable/)
    assert.ok(document.getElementById('ws-searxngUrl'))
    assert.equal(document.querySelectorAll('[data-slot-error]').length, 0)
  } finally {
    await React.act(async () => { page.root.unmount() })
  }
})
