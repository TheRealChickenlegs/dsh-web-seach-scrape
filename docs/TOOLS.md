# Tool reference

Five tools are registered. `web_search` and `web_fetch` are **not** re-registered: they are the
harness's own tools, now served by SearXNG and Firecrawl through `ctx.web`.

Common behaviour:

- `output_path` / `save_to` write the complete result to disk; the returned text is a bounded
  preview so a long page cannot flood the context.
- Every tool honours the caller's cancellation signal.
- Errors are returned as text the model can act on: which service, which status, which setting
  to check.

---

## `web_search_advanced`

Search through SearXNG with the filters `web_search` cannot express. When `source` is `auto` and
SearXNG fails, the same query is answered by Firecrawl search instead.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string (required) | — | The search query. |
| `categories` | string[] | configured | SearXNG categories, e.g. `["news"]`. `web_status` lists them. |
| `engines` | string[] | configured | Restrict to named engines, e.g. `["braveapi","arxiv"]`. |
| `language` | string | configured | `en`, `de`, `en-US`, … |
| `pageno` | integer | `1` | Result page. |
| `time_range` | `day\|week\|month\|year` | configured | Publication-date window. |
| `safesearch` | `0\|1\|2` | instance | Safe-search level. |
| `source` | `auto\|searxng\|firecrawl` | `auto` | Backend choice / fallback policy. |
| `limit` | integer | `10` | Maximum sources (1-50). |
| `include_answers` | boolean | `true` | Include SearXNG's answer text. |
| `output_path` | string | — | Also write the full result here. |

Output: `source`, `query`, `content?`, `truncated`, `sources[]` (`url`, `title`, `snippet`,
`publishedAt`), `text`, `file?`.

---

## `web_scrape`

Scrape one or many pages.

- **1 URL** → `POST /v2/scrape`.
- **2+ URLs** → `POST /v2/batch/scrape`, then poll the job. The instance runs the pages
  concurrently; the call waits once instead of N times. A missing batch endpoint falls back to a
  bounded parallel fan-out.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `urls` | string[] (required) | — | http/https URLs. |
| `formats` | enum[] | configured | `markdown`, `html`, `links`, `screenshot`, `summary`, `json`. |
| `extract` | `{prompt, schema?}` | — | Structured extraction. Requires the `json` format and Firecrawl **v2**. |
| `only_main_content` | boolean | configured | Drop boilerplate. |
| `include_tags` | string[] | — | CSS selectors to keep. |
| `exclude_tags` | string[] | — | CSS selectors to remove. |
| `wait_for_ms` | integer | — | Wait after load before capture. |
| `proxy` | `auto\|basic\|stealth\|enhanced` | configured | v2 only. |
| `mobile` | boolean | — | v2 only. |
| `timeout_ms` | integer | configured | Per-page scrape timeout. |
| `save_to` | string | — | Directory to write every page into. |
| `max_chars` | integer | `maxInlineChars` | Inline characters per page. |

Output: `ok`, `version`, `job_id?`, `timed_out?`, `total?`, `pages[]` (`url`, `ok`, `statusCode`,
`title`, `markdown`, `html`, `links`, `summary`, `screenshotUrl`, `savedPath?`, `error?`,
`warning?`), `text`.

`warning` carries Firecrawl's own note when a requested format produced nothing — most often a
`json` extraction on an instance without an LLM provider, which answers HTTP 200 with `json: null`
and a warning instead of failing the whole scrape.

A batch job that outlives `firecrawlJobTimeoutMs` returns `timed_out: true` with the live
`job_id` and whatever pages completed.

---

## `web_map`

List a site's URLs.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string (required) | — | Root or section to map. |
| `search` | string | — | Only URLs relevant to this phrase (server-side). |
| `limit` | integer | `200` | Maximum URLs (1-1000). |
| `include_subdomains` | boolean | — | Include subdomains. |
| `ignore_query_parameters` | boolean | — | Collapse URLs differing only by query string. |
| `sitemap` | `include\|skip\|only` | — | Sitemap policy. |

Output: `url`, `total`, `truncated`, `links[]` (first 100 inline), `file?` (the complete list),
`text`.

---

## `web_crawl`

Crawl a site with page content, as a polled job.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | — | Start URL. Required unless `job_id` is given. |
| `job_id` | string | — | Resume polling an existing crawl instead of starting one. |
| `limit` | integer | `10` | Maximum pages (1-500). Always set one. |
| `max_depth` | integer | server | Maximum link depth. |
| `include_paths` / `exclude_paths` | string[] | — | Path patterns. |
| `allow_external_links` / `allow_subdomains` | boolean | — | Link-following policy. |
| `sitemap` | `include\|skip\|only` | — | Sitemap policy. |
| `ignore_query_parameters` | boolean | — | Collapse query variants. |
| `formats` | string[] | `["markdown"]` | Formats captured per page. |
| `only_main_content` | boolean | configured | Drop boilerplate. |
| `delay_ms` / `max_concurrency` | integer | server | Politeness and parallelism. |
| `timeout_ms` | integer | `firecrawlJobTimeoutMs` | How long to wait before returning the job id. |
| `save_to` | string | — | Directory to write each page into. |
| `max_chars` | integer | `4000` | Inline characters per page. |

Output: `url?`, `job_id`, `status`, `completed?`, `total?`, `timed_out?`, `pages[]` (`url`,
`title`, `savedPath?`, `error?`), `text`.

---

## `web_status`

Report what the two instances actually provide.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `include` | `all\|searxng\|firecrawl` | `all` | Which service to report. |
| `refresh` | boolean | `false` | Ignore the 10-minute capability cache. |
| `probe_formats` | boolean | `true` | Fetch a test page to prove which formats work. |

What it probes:

- **SearXNG** — `GET /config`: version, instance name, categories, engines (with `enabled`),
  locales.
- **Firecrawl** — for **v1 and v2** separately, `POST <endpoint> {}` for `scrape`, `search`,
  `map`, `crawl`, `batch/scrape`, `extract`: a validation error proves the route exists, a
  `404 … is not a Firecrawl API endpoint` proves it does not, `401/403` proves it exists but
  needs a key. Then one real scrape of `https://example.com` for `markdown`/`html`/`links`, and
  separate probes for `json` and `summary`, recording the server's own reason when one fails.

Output: `searxng?`, `firecrawl?`, `problems`, `text`. Bugs in the configuration (a bad URL, an
unknown format, an invalid enum) appear under `problems` rather than being silent.

---

## Why `web_search` and `web_fetch` are not duplicated

Registering a tool with an existing name collides with the harness's own registration. Instead
the plugin registers a **search provider** (`searxng`) and a **fetch provider** (`firecrawl`) on
`ctx.web`, and the bundle patch selects them:

```yaml
- id: web
  config:
    searchProvider: searxng
    fetchProvider: firecrawl
```

The result: `web_search` keeps its upstream schema, its prompt guidance and its result card, but
its answers now come from your SearXNG; `web_fetch` keeps its HTML-to-markdown rendering and
truncation behaviour, but retrieves through your Firecrawl.
