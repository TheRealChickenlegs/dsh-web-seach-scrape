# Web Search & Scrape for DeepSeek Harness

Self-hosted web access for [DSH](https://github.com/deepseek-ai/deepseek-harness): point
`web_search` at your own **SearXNG** and `web_fetch` at your own **Firecrawl**, then add the
scrape, batch, map, crawl and diagnostics tools the built-in pair cannot express.

Everything runs against endpoints you choose. There is no vendor account, no bundled API key,
and a search costs no model turn — SearXNG answers with structured JSON.

## What it does

Two layers, because DSH exposes two different surfaces:

| Layer | Effect |
|---|---|
| **The `ctx.web` seam** | `web_search` (the tool the model already has) is served by SearXNG; `web_fetch` is served by Firecrawl. Existing prompts, cards and citations keep working. |
| **Five plugin tools** | `web_search_advanced`, `web_scrape`, `web_map`, `web_crawl`, `web_status` — the parts of the two services the seam's one-query/one-URL contract cannot reach: category/engine/language filters, multi-URL batch scraping, structured extraction, site maps and resumable crawls. |

```
web_search ─────► SearXNG   /search?format=json
web_search_advanced ─► SearXNG (with filters)  ─fallback─► Firecrawl /search
web_fetch  ─────► Firecrawl /v2/scrape (markdown)
web_scrape ─────► Firecrawl /v2/scrape  or  /v2/batch/scrape (2+ URLs)
web_map    ─────► Firecrawl /v2/map
web_crawl  ─────► Firecrawl /v2/crawl + job polling
web_status ─────► SearXNG /config + Firecrawl v1/v2 capability probe
```

Firecrawl's **v1 and v2 endpoints are both probed**. `auto` (the default) prefers v2, falls back
to v1 for an operation the instance does not expose, and remembers the answer for the process.
`web_status` reports the full matrix, including which response formats actually work — a
self-hosted instance without an LLM provider, for example, cannot produce `summary`.

## Requirements

- DeepSeek Harness **0.2.0-rc.1 or newer** (the `ctx.web` seam and the volatile-config settings service).
- Node.js **20 or newer**.
- A **SearXNG** instance with the JSON API enabled:

  ```yaml
  # settings.yml
  search:
    formats:
      - html
      - json
  ```

- A **Firecrawl** instance. Self-hosted `http://127.0.0.1:3002` is the default; the hosted
  `https://api.firecrawl.dev` works too (it accepts a `fc-…` key).

Neither service has to require an API key. If yours does, the key is entered on the plugin page
and stored by DSH's credentials service — never in the profile.

## Install

### From the plugin manager (recommended)

DSH → **Plugins** → **Add plugin** → enter the package name:

```text
dsh-web-search-scrape
```

Or add the bundle from a local checkout while developing:

```bash
# in the plugin checkout
npm install && npm run build
```

then add the absolute directory of this package in the plugin manager.

### From the registry

```bash
npm install dsh-web-search-scrape
```

The package ships its compiled `lib/`, so no TypeScript toolchain is needed to use it.

## Configure

Open DSH → **Plugins** → **Web Search & Scrape** → **Configure**. Every field is optional and
blank means "inherit", so you only fill in what differs from the defaults.

1. **SearXNG instance URL** — e.g. `http://192.168.10.10:8080`.
2. **Firecrawl instance URL** — e.g. `http://192.168.10.10:3002`.
3. **API keys**, if your instances need them: paste into the key box for that service and press
   *Save key*. The value goes straight to DSH's credential store (`~/.dsh/.credentials.yaml`,
   mode 0600); the page never reads it back, and only the reference name is written to the profile.
4. Press **Test both services** — the host probes both endpoints and shows the SearXNG version,
   engine list and categories, plus the Firecrawl v1/v2 endpoint matrix and working formats.
5. Press **Save** for the options you changed.

Saving writes only the changed fields into the active profile's Cordis patch, so the config file
and environment layers keep applying to everything else.

### Headless / no UI

```bash
export SEARXNG_URL=http://192.168.10.10:8080
export FIRECRAWL_URL=http://192.168.10.10:3002
export SEARXNG_API_KEY=...      # only if the instance requires one
export FIRECRAWL_API_KEY=...    # only if the instance requires one
```

or write `~/.dsh-web-search-scrape/config.json`:

```json
{
  "searxngUrl": "http://192.168.10.10:8080",
  "firecrawlUrl": "http://192.168.10.10:3002",
  "firecrawlApiVersion": "auto",
  "firecrawlFormats": ["markdown", "links"],
  "maxInlineChars": 20000
}
```

Priority is **plugin config → config file → environment → defaults**. See
[docs/CONFIG.md](docs/CONFIG.md) for every key.

## What changes in the composition

The bundle patch pins both providers on the `web` row:

```yaml
- id: web
  config:
    searchProvider: searxng
    fetchProvider: firecrawl
```

This is not politeness. The seam auto-selects only when exactly one registered provider is
usable, and the shipped DeepSeek search provider and plain-HTTP fetch provider always report
usable — adding this plugin without pinning would make every search and fetch fail with
`WEB_PROVIDER_AMBIGUOUS`.

**To roll back**, remove the *bundle* (Plugins → Web Search & Scrape → Remove), not just the
row. A disabled row leaves the `web` override in place, pinning `searxng`/`firecrawl` while
neither provider registers.

## Tools

| Tool | Use it for |
|---|---|
| `web_search_advanced` | SearXNG search with `categories`, `engines`, `language`, `pageno`, `time_range`, `safesearch`, an optional answer, and `source: auto` fallback to Firecrawl. |
| `web_scrape` | One page or many. Two or more URLs use Firecrawl **batch scrape** (the instance runs them concurrently) instead of N sequential calls. Formats: markdown, html, links, screenshot, summary, json. `extract` adds structured extraction (v2). |
| `web_map` | List a site's URLs (optionally filtered by `search`) before scraping. |
| `web_crawl` | Crawl a site with limits, path filters and polling. A timeout returns the live `job_id`; call again with it to resume. |
| `web_status` | What both instances actually expose: SearXNG engines/version; Firecrawl v1/v2 endpoints, preferred version, working formats, deprecations. |

Full parameter and output reference: [docs/TOOLS.md](docs/TOOLS.md).

## Security model

- API keys live in DSH's credential store or the environment, resolved per request. They are
  never written to the plugin config, logged, returned to the browser, or included in a tool
  result.
- API requests refuse redirects, require bare `http(s)` roots without embedded credentials, and
  read response bodies under a byte cap.
- The settings page's probe route is owner-authenticated, requires JSON + a custom header, caps
  the request body, and only ever talks to the endpoints already in your config.
- Scraped pages are untrusted external data. The plugin does not block private-address targets:
  self-hosting against internal documentation is the point.

Details: [docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `SearXNG returned "text/html" instead of JSON` | `json` is missing from `search.formats` in the instance's `settings.yml`. |
| `WEB_PROVIDER_AMBIGUOUS` | Another search/fetch plugin is registered and the `web` row does not pin one. Restate `searchProvider`/`fetchProvider` in the layer that wins. |
| `web_fetch` fails but `web_search` works | The Firecrawl endpoint is wrong or the instance is down — run `web_status`. |
| `summary` format returns HTTP 500 | Firecrawl's `summary` needs an LLM provider on the instance. Use `markdown`, or `extract`. |
| `Structured extraction needs Firecrawl v2` | The instance only exposes v1. Set `firecrawlApiVersion` to `auto`/`v2`, or scrape as markdown. |
| Crawl returns `timed_out: true` | The job is still running. Call `web_crawl` again with the returned `job_id`, or raise `firecrawlJobTimeoutMs`. |
| `401`/`403` from either service | Set that service's API key on the plugin page, or export `SEARXNG_API_KEY` / `FIRECRAWL_API_KEY`. |

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc + copy the browser bundle into lib/
npm test             # node:test against local fake SearXNG/Firecrawl servers
```

`lib/` is committed on purpose so users need no TypeScript; CI fails if it drifts from `src/`.
The browser half (`src/client.js`) is plain JS served directly by DSH's module loader — no
bundler, no React copy.

See [docs/RELEASING.md](docs/RELEASING.md) for the tag-driven release and npm publication.

## License

MIT — see [LICENSE](LICENSE).
