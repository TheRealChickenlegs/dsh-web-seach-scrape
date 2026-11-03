/**
 * Web Search & Scrape plugin-page configuration UI.
 *
 * The host half exports a volatile Config schema; DSH exposes those fields through
 * ctx.configForms. This bundle registers the row's configuration page in the
 * Plugins panel and writes only the fields the user actually changed, so the
 * config-file and environment layers keep working for untouched fields.
 *
 * API keys are NOT part of the config. The page sends a key once to
 * ctx.remote.credentials and never reads it back; the host resolves it by
 * reference name at request time.
 *
 * Plain JS on purpose: the DSH client module loader serves this file directly,
 * and the platform provides React. No bundler or UI-primitive dependency.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-scrape',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var PACKAGE_ID = 'dsh-web-search-scrape'
    var ENTRY_ID = 'dsh-web-search-scrape'
    var ROW_KEY = PACKAGE_ID + '#' + ENTRY_ID
    var STYLE_ID = PACKAGE_ID + '/settings.css'
    var ROUTE = '/plugin/web-search-scrape/api/probe'
    var ROUTE_HEADER = 'x-dsh-web-search-scrape'
    var DEFAULT_SEARXNG_KEY_REF = 'SEARXNG_API_KEY'
    var DEFAULT_FIRECRAWL_KEY_REF = 'FIRECRAWL_API_KEY'
    var REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

    var GROUPS = [
      {
        id: 'searxng',
        title: 'Search — SearXNG',
        note: 'Every field is optional. Leave one blank to inherit from the config file, environment variable, or built-in default.',
        fields: [
          { key: 'searxngUrl', label: 'Instance URL', type: 'text', placeholder: 'http://127.0.0.1:8080', hint: 'The SearXNG root; /search and /config are appended. Use an address this DSH process can reach (127.0.0.1, not 0.0.0.0).' },
          { key: 'searxngApiKeyEnv', label: 'API key name', type: 'text', placeholder: DEFAULT_SEARXNG_KEY_REF, hint: 'Credential name (also an environment variable name). The value is stored separately and never shown.' },
          { key: 'searxngAuthHeader', label: 'Auth header', type: 'text', placeholder: 'Authorization', hint: 'Header used to send the key, e.g. Authorization or X-API-Key. Leave blank to send no auth header (most self-hosted instances need none).' },
          { key: 'searxngAuthPrefix', label: 'Auth prefix', type: 'text', placeholder: 'Bearer ', hint: 'Prefix before the key. Use "Bearer " for a token scheme, or leave blank for a bare value.' },
          { key: 'searxngCategories', label: 'Default categories', type: 'list', placeholder: 'general', hint: 'Comma-separated SearXNG categories, e.g. general, news, science. "Test both services" lists what the instance serves.' },
          { key: 'searxngEngines', label: 'Default engines', type: 'list', placeholder: 'All enabled engines', hint: 'Comma-separated engine names, e.g. braveapi, arxiv. Blank uses every enabled engine.' },
          { key: 'searxngLanguage', label: 'Default language', type: 'text', placeholder: 'Instance default', hint: 'Language filter such as en, de, en-US. Blank leaves the instance default.' },
          { key: 'searxngSafeSearch', label: 'Safe search', type: 'select', options: [['', 'Instance default'], ['0', '0 — off'], ['1', '1 — moderate'], ['2', '2 — strict']], hint: 'Safe-search level for every search that does not override it.' },
          { key: 'searxngTimeRange', label: 'Default time range', type: 'select', options: [['', 'Any time'], ['day', 'Past day'], ['week', 'Past week'], ['month', 'Past month'], ['year', 'Past year']], hint: 'Restricts results by publication date for engines that support it.' },
          { key: 'searxngTimeoutMs', label: 'Search timeout (ms)', type: 'number', placeholder: '15000', hint: 'Resource backstop for one search (1000-120000). Keep it below the tool-call budget.' },
          { key: 'searxngMaxSnippetChars', label: 'Snippet cap (characters)', type: 'number', placeholder: '500', hint: 'Cut each source snippet at this length (0-5000).' }
        ]
      },
      {
        id: 'firecrawl',
        title: 'Scrape — Firecrawl',
        note: 'SearXNG answers web_search and Firecrawl answers web_fetch. The scrape, map and crawl tools also use this endpoint.',
        fields: [
          { key: 'firecrawlUrl', label: 'Instance URL', type: 'text', placeholder: 'http://127.0.0.1:3002', hint: 'The Firecrawl API root (the address that answers /v2/scrape). /v1 and /v2 are both probed.' },
          { key: 'firecrawlApiKeyEnv', label: 'API key name', type: 'text', placeholder: DEFAULT_FIRECRAWL_KEY_REF, hint: 'Credential name (also an environment variable name). The value is stored separately and never shown.' },
          { key: 'firecrawlApiVersion', label: 'API version', type: 'select', options: [['', 'auto — prefer v2, fall back to v1'], ['auto', 'auto'], ['v2', 'v2 only'], ['v1', 'v1 only']], hint: 'auto detects each operation: if v2 has no such endpoint it retries on v1 and remembers the answer.' },
          { key: 'firecrawlFormats', label: 'Default formats', type: 'list', placeholder: 'markdown', hint: 'Comma-separated: markdown, html, links, screenshot, summary, json. "json" needs an extract prompt and Firecrawl v2.' },
          { key: 'firecrawlOnlyMainContent', label: 'Main content only', type: 'select', options: [['', 'Inherit (on)'], ['true', 'true — drop navigation and footers'], ['false', 'false — keep the whole page']], hint: 'Default for scrapes that do not pass only_main_content.' },
          { key: 'firecrawlProxy', label: 'Proxy mode', type: 'select', options: [['', 'Server default'], ['auto', 'auto'], ['basic', 'basic'], ['stealth', 'stealth'], ['enhanced', 'enhanced']], hint: 'Sent on v2 requests only. stealth/enhanced help with bot-protected sites.' },
          { key: 'firecrawlTimeoutMs', label: 'Request timeout (ms)', type: 'number', placeholder: '60000', hint: 'One Firecrawl HTTP request (1000-300000).' },
          { key: 'firecrawlJobTimeoutMs', label: 'Job timeout (ms)', type: 'number', placeholder: '600000', hint: 'How long a batch scrape or crawl may run before the tool returns its live job id (5000-3600000).' },
          { key: 'firecrawlPollIntervalMs', label: 'Poll interval (ms)', type: 'number', placeholder: '1500', hint: 'How often to check a running job (250-30000).' },
          { key: 'firecrawlMaxUrls', label: 'Max URLs per scrape', type: 'number', placeholder: '50', hint: 'Upper bound on web_scrape urls in one call (1-200).' },
          { key: 'firecrawlRetries', label: 'Retries', type: 'number', placeholder: '2', hint: 'Retries for rate-limited (429) and transient network failures (0-5).' }
        ]
      },
      {
        id: 'output',
        title: 'Output',
        note: 'Long pages are written to disk in full; the result carries a bounded preview and the file path.',
        fields: [
          { key: 'outputDir', label: 'Output directory', type: 'text', placeholder: 'Session working directory', hint: 'Where oversized scrapes and crawl pages are saved. ~ is expanded; relative paths resolve against the session directory.' },
          { key: 'maxInlineChars', label: 'Inline characters', type: 'number', placeholder: '20000', hint: 'How much of one page is returned to the model before the rest is cut and saved (500-500000).' },
          { key: 'writeMetadata', label: 'Write JSON sidecars', type: 'select', options: [['', 'Inherit (on)'], ['true', 'true'], ['false', 'false']], hint: 'Write a metadata sidecar next to each saved page.' }
        ]
      }
    ]

    var CSS = [
      '.ws-root{display:flex;flex-direction:column;gap:16px;max-width:820px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ws-head{display:flex;flex-direction:column;gap:6px}',
      '.ws-title{margin:0;font-size:16px;font-weight:700;line-height:24px}',
      '.ws-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.ws-group{display:flex;flex-direction:column;gap:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));padding-top:14px}',
      '.ws-groupTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      '.ws-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.ws-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 14px}',
      '.ws-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.ws-label{font-size:12px;font-weight:600;line-height:18px}',
      '.ws-input,.ws-select{font:inherit;font-size:13px;line-height:20px;padding:5px 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f1115);box-sizing:border-box;width:100%}',
      '.ws-input:focus-visible,.ws-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d93f8));outline-offset:1px}',
      '.ws-input:disabled,.ws-select:disabled{opacity:.55}',
      '.ws-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.ws-key{border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-l2,rgba(15,17,21,.03))}',
      '.ws-keyHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ws-keyTitle{font-size:12px;font-weight:600}',
      '.ws-badge{font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16))}',
      '.ws-badgeOk{color:var(--dsw-alias-state-business-primary,#4d93f8);border-color:currentColor}',
      '.ws-badgeWarn{color:var(--dsw-alias-state-warning-primary,#b7791f);border-color:currentColor}',
      '.ws-keyRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ws-keyRow .ws-input{flex:1 1 220px}',
      '.ws-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}',
      '.ws-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));background:0 0;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.ws-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(15,17,21,.05))}',
      '.ws-btn:disabled{opacity:.5;cursor:default}',
      '.ws-btnPrimary{background:var(--dsw-alias-state-business-primary,#4d93f8);border-color:transparent;color:#fff}',
      '.ws-msg{margin:0;font-size:12px;line-height:18px}',
      '.ws-ok{color:var(--dsw-alias-state-business-primary,#4d93f8)}',
      '.ws-err{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.ws-state{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.ws-report{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));border-radius:10px;padding:12px}',
      '.ws-reportTitle{margin:0;font-size:12px;font-weight:700;line-height:18px}',
      '.ws-kv{display:grid;grid-template-columns:130px 1fr;gap:2px 10px;font-size:12px;line-height:18px}',
      '.ws-k{color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.ws-v{overflow-wrap:anywhere}',
      '.ws-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.ws-pill{display:inline-block;padding:0 6px;border-radius:6px;border:.5px solid currentColor;margin:0 4px 4px 0;font-size:11px;line-height:16px}'
    ].join('\n')

    function installStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = PACKAGE_ID
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (_) {}
    }

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      var copy = {}
      if (props) for (var key in props) if (Object.prototype.hasOwnProperty.call(props, key)) copy[key] = props[key]
      // Children are passed positionally, not as a single array child: React only
      // requires keys for genuine lists, and turning every element into a list
      // child would demand keys on plain sibling markup.
      return React.createElement.apply(null, [type, copy].concat(children))
    }

    function useSnapshot(form) {
      return React.useSyncExternalStore(
        function (listener) { return form.subscribe(listener) },
        function () { return form.getSnapshot() }
      )
    }

    function errorText(cause) {
      if (cause && typeof cause.message === 'string' && cause.message) return cause.message
      return String(cause)
    }

    /** The credentials namespace, if this deployment composed it. */
    function credentialsOf(ctx) {
      try {
        if (ctx.remote && ctx.remote.credentials) return ctx.remote.credentials
      } catch (_) {}
      return null
    }

    /** Run one remote call and normalise `{ok,value}` / throw into a result. */
    function callRemote(service, method, args) {
      if (!service || typeof service[method] !== 'function') {
        return Promise.resolve({ ok: false, error: 'The credentials service is unavailable in this DSH deployment; use the environment variable instead.' })
      }
      try {
        return Promise.resolve(service[method].apply(service, args)).then(
          function (result) {
            if (result && result.ok === false) {
              return { ok: false, error: (result.error && result.error.message) || 'The credentials service refused the request.' }
            }
            return { ok: true, value: (result && result.value) || {} }
          },
          function (cause) { return { ok: false, error: errorText(cause) } }
        )
      } catch (cause) {
        return Promise.resolve({ ok: false, error: errorText(cause) })
      }
    }

    function rawValue(snapshot, key) {
      var value = snapshot && snapshot.value
      return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
    }

    function textValue(snapshot, field, edits) {
      if (Object.prototype.hasOwnProperty.call(edits, field.key)) return edits[field.key]
      var value = rawValue(snapshot, field.key)
      if (value === undefined || value === null) return ''
      if (Array.isArray(value)) return value.join(', ')
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return String(value)
    }

    /** Config-write operations for the fields the user actually changed. */
    function buildOps(fields, edits, snapshot, setError) {
      var ops = []
      var keys = Object.keys(edits)
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index]
        var field = null
        for (var scan = 0; scan < fields.length; scan += 1) if (fields[scan].key === key) field = fields[scan]
        if (!field) continue
        var raw = edits[key]
        var text = typeof raw === 'string' ? raw.trim() : raw
        if (text === '' || text === undefined || text === null) {
          ops.push({ op: 'unset', path: [key] })
          continue
        }
        if (field.type === 'number') {
          var number = Number(text)
          if (!Number.isFinite(number)) {
            setError('Enter a valid number for "' + field.label + '", or leave it blank to inherit.')
            return null
          }
          ops.push({ op: 'set', path: [key], value: number })
        } else if (field.type === 'boolean') {
          if (text !== 'true' && text !== 'false') {
            setError('Choose true or false for "' + field.label + '", or leave it inherited.')
            return null
          }
          ops.push({ op: 'set', path: [key], value: text === 'true' })
        } else if (field.type === 'list') {
          var list = String(text).split(',').map(function (entry) { return entry.trim() }).filter(function (entry) { return entry !== '' })
          if (list.length === 0) ops.push({ op: 'unset', path: [key] })
          else ops.push({ op: 'set', path: [key], value: list })
        } else {
          ops.push({ op: 'set', path: [key], value: String(text) })
        }
      }
      return ops
    }

    function Field(props) {
      var field = props.field
      var id = 'ws-' + field.key
      var value = props.value
      var control
      if (field.type === 'select') {
        control = h(
          'select',
          {
            id: id,
            className: 'ws-select',
            value: value,
            disabled: props.disabled,
            onChange: function (event) { props.onEdit(field.key, event.target.value) }
          },
          field.options.map(function (option) {
            return h('option', { key: option[0], value: option[0] }, option[1])
          })
        )
      } else {
        control = h('input', {
          id: id,
          className: 'ws-input',
          type: 'text',
          inputMode: field.type === 'number' ? 'decimal' : 'text',
          autoComplete: 'off',
          value: value,
          placeholder: field.placeholder || '',
          disabled: props.disabled,
          onChange: function (event) { props.onEdit(field.key, event.target.value) }
        })
      }
      return h(
        'div',
        { className: 'ws-field' },
        h('label', { className: 'ws-label', htmlFor: id }, field.label),
        control,
        field.hint ? h('p', { className: 'ws-hint' }, field.hint) : null
      )
    }

    function KeyRow(props) {
      var ref = props.refName
      var state = props.state
      var badge
      if (!props.available) badge = h('span', { className: 'ws-badge ws-badgeWarn' }, 'credentials service unavailable')
      else if (state === undefined) badge = h('span', { className: 'ws-badge' }, 'checking…')
      else if (state.configured) badge = h('span', { className: 'ws-badge ws-badgeOk' }, 'configured' + (state.source ? ' · ' + state.source : ''))
      else badge = h('span', { className: 'ws-badge' }, 'not set')

      return h(
        'div',
        { className: 'ws-key' },
        h(
          'div',
          { className: 'ws-keyHead' },
          h('span', { className: 'ws-keyTitle' }, props.title),
          h('span', { className: 'ws-mono' }, ref),
          badge
        ),
        h(
          'div',
          { className: 'ws-keyRow' },
          h('input', {
            className: 'ws-input',
            type: 'password',
            autoComplete: 'new-password',
            placeholder: state && state.configured ? 'Enter a new key to replace the stored one' : 'Paste the API key',
            value: props.draft,
            disabled: props.busy || !props.available,
            onChange: function (event) { props.onDraft(event.target.value) },
            'aria-label': props.title
          }),
          h(
            'button',
            {
              className: 'ws-btn ws-btnPrimary',
              type: 'button',
              disabled: props.busy || !props.available || props.draft.trim() === '',
              onClick: props.onSave
            },
            props.busy ? 'Saving…' : 'Save key'
          ),
          h(
            'button',
            {
              className: 'ws-btn',
              type: 'button',
              disabled: props.busy || !props.available || !(state && state.configured),
              onClick: props.onClear
            },
            'Clear'
          )
        ),
        h('p', { className: 'ws-hint' }, 'The key is sent once to DSH’s credentials store and never read back into this page. Leave it blank to keep the current key.'),
        props.error ? h('p', { className: 'ws-msg ws-err' }, props.error) : null
      )
    }

    function Report(props) {
      var data = props.data
      if (!data) return null
      var searxng = data.searxng || {}
      var firecrawl = data.firecrawl || {}
      var rows = []

      function push(label, value) {
        if (value === undefined || value === null || value === '') return
        rows.push([rows.length + ':' + label, label, value])
      }

      push('SearXNG', searxng.reachable ? 'reachable' : 'unreachable')
      push('Version', searxng.version)
      push('Instance', searxng.instanceName)
      push('Key', searxng.keyConfigured ? 'configured' : 'not set')
      push('Categories', (searxng.categories || []).join(', '))
      push('Engines', (searxng.engines || []).map(function (engine) { return engine.name }).join(', '))
      if (searxng.error) push('SearXNG error', searxng.error)

      push('Firecrawl', firecrawl.reachable ? 'reachable' : 'unreachable')
      push('Preferred API', firecrawl.preferred)
      var versions = firecrawl.versions || {}
      ;['v2', 'v1'].forEach(function (version) {
        var caps = versions[version]
        if (!caps) return
        var endpoints = caps.endpoints || {}
        var parts = Object.keys(endpoints).map(function (name) {
          var state = endpoints[name]
          return name + ': ' + (state === 'present' ? 'yes' : state)
        })
        push(version + ' endpoints', parts.join(' · '))
      })
      var formats = []
      var observed = firecrawl.formats || {}
      ;['markdown', 'html', 'links', 'summary', 'json', 'screenshot'].forEach(function (name) {
        if (observed[name] === true) formats.push(name)
      })
      push('Formats', formats.join(', '))
      push('Key', firecrawl.keyConfigured ? 'configured' : 'not set')
      if ((firecrawl.deprecations || []).length > 0) push('Notes', (firecrawl.deprecations || []).join(' '))
      if (firecrawl.error) push('Firecrawl error', firecrawl.error)
      if ((data.problems || []).length > 0) push('Config warnings', (data.problems || []).join(' '))

      return h(
        'div',
        { className: 'ws-report' },
        h('p', { className: 'ws-reportTitle' }, 'Instance report'),
        h(
          'div',
          { className: 'ws-kv' },
          rows.map(function (row) {
            return h('div', { className: 'ws-k', key: 'k-' + row[0] }, row[1])
          }),
          rows.map(function (row) {
            return h('div', { className: 'ws-v', key: 'v-' + row[0] }, row[2])
          })
        )
      )
    }

    function ConfigPage(props) {
      var form = props.form
      var ctx = props.ctx
      var snapshot = useSnapshot(form)
      var editsState = React.useState({})
      var edits = editsState[0]
      var setEdits = editsState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var messageState = React.useState('')
      var message = messageState[0]
      var setMessage = messageState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var keyState = React.useState({})
      var keyStates = keyState[0]
      var setKeyStates = keyState[1]
      var keyDraftState = React.useState({})
      var keyDrafts = keyDraftState[0]
      var setKeyDrafts = keyDraftState[1]
      var keyBusyState = React.useState({})
      var keyBusy = keyBusyState[0]
      var setKeyBusy = keyBusyState[1]
      var keyErrorState = React.useState({})
      var keyErrors = keyErrorState[0]
      var setKeyErrors = keyErrorState[1]

      var reportState = React.useState(null)
      var report = reportState[0]
      var setReport = reportState[1]
      var testingState = React.useState(false)
      var testing = testingState[0]
      var setTesting = testingState[1]

      var credentials = credentialsOf(ctx)
      var writable = snapshot && snapshot.writable === true
      var disabled = !writable || saving
      var allFields = GROUPS.reduce(function (all, group) { return all.concat(group.fields) }, [])

      function refFor(keyRefKey, fallback) {
        var draft = Object.prototype.hasOwnProperty.call(edits, keyRefKey) ? String(edits[keyRefKey]).trim() : ''
        if (draft !== '' && REF_PATTERN.test(draft)) return draft
        var saved = rawValue(snapshot, keyRefKey)
        if (typeof saved === 'string' && REF_PATTERN.test(saved.trim())) return saved.trim()
        return fallback
      }

      var searxngRef = refFor('searxngApiKeyEnv', DEFAULT_SEARXNG_KEY_REF)
      var firecrawlRef = refFor('firecrawlApiKeyEnv', DEFAULT_FIRECRAWL_KEY_REF)

      React.useEffect(function () {
        if (snapshot === null || snapshot === undefined || snapshot.status !== 'ready') return
        var cancelled = false
        var refs = [searxngRef, firecrawlRef]
        callRemote(credentials, 'describe', [refs]).then(function (result) {
          if (cancelled || !result.ok) return
          setKeyStates(result.value || {})
        })
        return function () { cancelled = true }
      }, [snapshot && snapshot.revision, searxngRef, firecrawlRef, credentials])

      function edit(key, value) {
        setEdits(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
        setMessage('')
        setError('')
      }

      function discard() {
        setEdits({})
        setMessage('')
        setError('')
      }

      async function save() {
        if (Object.keys(edits).length === 0) return
        setError('')
        setMessage('')
        var ops = buildOps(allFields, edits, snapshot, setError)
        if (ops === null) return
        setSaving(true)
        try {
          var accepted = await form.mutate(ops, snapshot.revision)
          if (accepted) {
            setEdits({})
            setMessage('Saved. Unchanged fields continue to inherit from the config file, environment, or defaults.')
          } else {
            setError('The server did not accept these values. Check the field ranges and try again.')
          }
        } catch (cause) {
          setError('Could not save: ' + errorText(cause))
        } finally {
          setSaving(false)
        }
      }

      function setKeyStateFor(ref, value) {
        setKeyStates(function (previous) {
          var next = Object.assign({}, previous)
          next[ref] = value
          return next
        })
      }

      function saveKey(ref, draft) {
        setKeyBusy(function (previous) { var next = Object.assign({}, previous); next[ref] = true; return next })
        setKeyErrors(function (previous) { var next = Object.assign({}, previous); delete next[ref]; return next })
        callRemote(credentials, 'set', [ref, draft.trim()]).then(function (result) {
          if (result.ok) {
            setKeyDrafts(function (previous) { var next = Object.assign({}, previous); delete next[ref]; return next })
            setKeyStateFor(ref, { configured: true, source: 'credentials' })
          } else {
            setKeyErrors(function (previous) { var next = Object.assign({}, previous); next[ref] = result.error; return next })
          }
        }).then(function () {
          setKeyBusy(function (previous) { var next = Object.assign({}, previous); delete next[ref]; return next })
        })
      }

      function clearKey(ref) {
        setKeyBusy(function (previous) { var next = Object.assign({}, previous); next[ref] = true; return next })
        setKeyErrors(function (previous) { var next = Object.assign({}, previous); delete next[ref]; return next })
        callRemote(credentials, 'unset', [ref]).then(function (result) {
          if (result.ok) setKeyStateFor(ref, { configured: false, source: null })
          else setKeyErrors(function (previous) { var next = Object.assign({}, previous); next[ref] = result.error; return next })
        }).then(function () {
          setKeyBusy(function (previous) { var next = Object.assign({}, previous); delete next[ref]; return next })
        })
      }

      function testServices() {
        setTesting(true)
        setReport(null)
        setError('')
        try {
          fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', [ROUTE_HEADER]: '1' },
            body: JSON.stringify({ refresh: true, probe_formats: true })
          }).then(function (response) {
            return response.text().then(function (text) {
              var data = null
              try { data = JSON.parse(text) } catch (_) {}
              if (data === null) {
                setError(response.status === 404
                  ? 'The probe route is not mounted in this deployment. Check the plugin is enabled, then reopen this page.'
                  : 'The probe returned an unexpected response (HTTP ' + response.status + ').')
                return
              }
              if (!response.ok || data.ok !== true) {
                setError(data.error || 'The probe failed (HTTP ' + response.status + ').')
                return
              }
              setReport(data)
            })
          }, function (cause) {
            setError('Could not reach the probe route: ' + errorText(cause))
          }).then(function () { setTesting(false) }, function () { setTesting(false) })
        } catch (cause) {
          setError(errorText(cause))
          setTesting(false)
        }
      }

      if (snapshot === null || snapshot === undefined || snapshot.status === 'loading') {
        return h('p', { className: 'ws-state' }, 'Loading configuration…')
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'ws-state' }, 'The configuration entry is not available. Make sure the plugin is enabled and the profile is loaded.')
      }
      if (!snapshot.value && snapshot.status !== 'ready') {
        return h('p', { className: 'ws-state' }, 'No editable configuration is available for this plugin.')
      }

      var searxngState = keyStates[searxngRef]
      var firecrawlState = keyStates[firecrawlRef]

      var groups = GROUPS.map(function (group) {
        var fields = group.fields.map(function (field) {
          return h(Field, {
            key: field.key,
            field: field,
            value: textValue(snapshot, field, edits),
            disabled: disabled,
            onEdit: edit
          })
        })

        var keyRow = null
        if (group.id === 'searxng') {
          keyRow = h(KeyRow, {
            title: 'SearXNG API key',
            refName: searxngRef,
            state: searxngState,
            available: credentials !== null,
            busy: keyBusy[searxngRef] === true,
            draft: keyDrafts[searxngRef] || '',
            error: keyErrors[searxngRef] || '',
            onDraft: function (value) { setKeyDrafts(function (previous) { var next = Object.assign({}, previous); next[searxngRef] = value; return next }) },
            onSave: function () { saveKey(searxngRef, keyDrafts[searxngRef] || '') },
            onClear: function () { clearKey(searxngRef) }
          })
        } else if (group.id === 'firecrawl') {
          keyRow = h(KeyRow, {
            title: 'Firecrawl API key',
            refName: firecrawlRef,
            state: firecrawlState,
            available: credentials !== null,
            busy: keyBusy[firecrawlRef] === true,
            draft: keyDrafts[firecrawlRef] || '',
            error: keyErrors[firecrawlRef] || '',
            onDraft: function (value) { setKeyDrafts(function (previous) { var next = Object.assign({}, previous); next[firecrawlRef] = value; return next }) },
            onSave: function () { saveKey(firecrawlRef, keyDrafts[firecrawlRef] || '') },
            onClear: function () { clearKey(firecrawlRef) }
          })
        }

        return h(
          'section',
          { className: 'ws-group', key: group.id },
          h('h3', { className: 'ws-groupTitle' }, group.title),
          h('p', { className: 'ws-note' }, group.note),
          keyRow,
          h('div', { className: 'ws-grid' }, fields)
        )
      })

      return h(
        'div',
        { className: 'ws-root' },
        h(
          'div',
          { className: 'ws-head' },
          h('h2', { className: 'ws-title' }, 'Web Search & Scrape'),
          h(
            'p',
            { className: 'ws-intro' },
            'SearXNG powers web_search and the advanced search tool; Firecrawl powers web_fetch, web_scrape, web_map and web_crawl. Saving writes only the fields you changed to this profile.'
          )
        ),
        groups,
        h(
          'div',
          { className: 'ws-actions' },
          h(
            'button',
            {
              className: 'ws-btn ws-btnPrimary',
              type: 'button',
              disabled: disabled || Object.keys(edits).length === 0,
              onClick: save
            },
            saving ? 'Saving…' : 'Save'
          ),
          h(
            'button',
            {
              className: 'ws-btn',
              type: 'button',
              disabled: disabled || Object.keys(edits).length === 0,
              onClick: discard
            },
            'Discard edits'
          ),
          h(
            'button',
            {
              className: 'ws-btn',
              type: 'button',
              disabled: testing,
              onClick: testServices
            },
            testing ? 'Testing…' : 'Test both services'
          )
        ),
        error ? h('p', { className: 'ws-msg ws-err', role: 'alert' }, error) : null,
        message ? h('p', { className: 'ws-msg ws-ok' }, message) : null,
        !writable ? h('p', { className: 'ws-state' }, 'This deployment stores settings read-only.') : null,
        report ? h(Report, { data: report }) : null,
        report === null && !testing
          ? h('p', { className: 'ws-note' }, '“Test both services” asks the host to probe the configured endpoints: SearXNG readiness and its engine list, plus every Firecrawl v1/v2 endpoint and the formats this instance can actually produce.')
          : null
      )
    }

    function apply(ctx) {
      installStyles()
      var form = ctx.configForms.get(ENTRY_ID)
      ctx.effect(function () {
        return ctx.configForms.whileServed([ENTRY_ID], function () {
          return ctx.slots.inject('plugins.row.config', function () {
            return ctx.slots.register(
              {
                name: 'plugins.row.config',
                key: ROW_KEY
              },
              function (props) { return h(ConfigPage, { form: form, ctx: ctx, view: props && props.view }) }
            )
          })
        })
      }, 'web-search-scrape: settings page')
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'remote', 'remote.credentials']
    exports.name = 'web-search-scrape'
    return module.exports
  }
})
