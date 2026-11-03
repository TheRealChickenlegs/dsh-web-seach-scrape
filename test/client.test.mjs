import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'

const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** Load the browser bundle with a fake module loader and run its apply(). */
function load({ withCredentials = true } = {}) {
  let contribution = null
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        contribution = value
      }
    }
  }
  vm.runInThisContext(source, { filename: 'client.js' })
  assert.ok(contribution, 'the bundle registered a module')
  const exports = contribution.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })

  const calls = { whileServed: [], inject: [], register: [], mutate: [] }
  let slot = null
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: { searxngUrl: 'http://127.0.0.1:8080' } }),
    mutate: async (ops, revision) => {
      calls.mutate.push({ ops, revision })
      return true
    }
  }
  const credentials = { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true }), unset: async () => ({ ok: true }) }
  const ctx = {
    remote: withCredentials ? { credentials } : {},
    configForms: {
      get: (id) => {
        calls.get = id
        return form
      },
      whileServed(namespaces, register) {
        calls.whileServed.push(namespaces)
        return register(new Set(namespaces))
      }
    },
    slots: {
      inject(name, callback) {
        calls.inject.push(name)
        return callback()
      },
      register(definition, component) {
        calls.register.push(definition)
        slot = { definition, component }
        return () => {}
      }
    },
    effect(body) {
      return body()
    }
  }
  exports.apply(ctx)
  return { exports, slot, calls, form, credentials, ctx }
}

test('the bundle registers with the package id and the expected services', () => {
  const { exports } = load()
  assert.equal(exports.name, 'web-search-scrape')
  assert.deepEqual(exports.inject, ['slots', 'configForms', 'remote', 'remote.credentials'])
})

test('apply registers the row configuration page with the package#row key', () => {
  const { slot, calls } = load()
  assert.ok(slot, 'a page was registered')
  assert.equal(slot.definition.name, 'plugins.row.config')
  assert.equal(slot.definition.key, 'dsh-web-search-scrape#dsh-web-search-scrape')
  assert.deepEqual(calls.whileServed, [['dsh-web-search-scrape']])
  assert.deepEqual(calls.inject, ['plugins.row.config'])
  assert.equal(calls.get, 'dsh-web-search-scrape')
})

test('the page component is a function that renders a search section', () => {
  const { slot } = load()
  // Render to a React element tree without a DOM and inspect the props.
  const element = slot.component({ view: 'page' })
  assert.equal(typeof element.type, 'function')
  assert.equal(typeof element.props.form.mutate, 'function')
})
