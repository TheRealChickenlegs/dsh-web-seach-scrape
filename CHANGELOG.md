# Changelog

All notable changes to this project are documented here.

## 0.1.0 — 2026-11-03

First release.

### Added

- **SearXNG as the `web_search` backend.** A `ctx.web` search provider (`id: searxng`) issues
  `GET /search?format=json` against the configured instance, so a search costs no model turn.
  Filters: categories, engines, language, page, time range, safe search, snippet cap.
- **Firecrawl as the `web_fetch` backend.** A `ctx.web` fetch provider (`id: firecrawl`) scrapes
  one URL and returns its markdown as a `text` body, keeping the harness's own card and
  truncation behaviour.
- **`web_search_advanced`** — the SearXNG filters above are exposed to the model, with
  `source: auto` fallback to Firecrawl search when SearXNG is unavailable.
- **`web_scrape`** — one page via `/scrape`, two or more via `/batch/scrape` with job polling, so
  multi-URL scraping uses the instance's concurrency instead of N sequential calls. Formats:
  markdown, html, links, screenshot, summary, json; `extract` adds structured extraction.
- **`web_map`** and **`web_crawl`** — URL discovery and a polled crawl that returns its live
  `job_id` on timeout so the job can be resumed instead of lost.
- **`web_status`** — probes SearXNG `/config` and Firecrawl **v1 and v2** endpoint matrices,
  working formats and deprecations, cached for ten minutes.
- **Plugin page** with per-field writes (only changed fields are saved), API keys stored through
  DSH's credentials service, and a "Test both services" button backed by an authenticated
  same-origin probe route.
- **`auto` API version**: prefer v2, fall back per operation to v1, and remember the answer for
  the process.
- Layered configuration (plugin config → file → environment → defaults), including
  `SEARXNG_URL`/`FIRECRAWL_URL`, with invalid values reported rather than fatal.
- CI (Ubuntu + Windows, Node 20/22), tag-driven GitHub Release and npm publication with
  provenance, and the committed-build guard (`git diff --exit-code -- lib`).

### Verified against

- SearXNG `2026.10.16+ff8f5ddcc` (JSON enabled; engines `braveapi`, `arxiv`, `google scholar`,
  `pubmed`, `semantic scholar`).
- A self-hosted Firecrawl exposing `/v1` and `/v2` for scrape, search, map, crawl and batch,
  with `/v2/extract` deprecated and `summary` unavailable without an LLM provider.
