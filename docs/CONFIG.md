# Configuration reference

Every key is optional. A blank value means "inherit", which is what lets the layers stack:

**plugin config → config file → environment → built-in defaults** (highest wins).

Plugin config is the `config:` of the `dsh-web-search-scrape` row in the active profile, written
by the plugin page. The config file is `~/.dsh-web-search-scrape/config.json`. The environment
layer also honours the ecosystem names `SEARXNG_URL` and `FIRECRAWL_URL`.

Invalid values never stop the plugin from loading: the bad value is replaced with the default and
reported in the startup log and by `web_status` (`problems`).

## Search — SearXNG

| Key | Default | Environment | Meaning |
|---|---|---|---|
| `searxngUrl` | `http://127.0.0.1:8080` | `SEARXNG_URL`, `DSH_WEB_SEARCH_SCRAPE_SEARXNG_URL` | Instance root. `/search` and `/config` are appended. Must be http(s), with no credentials, query or fragment. |
| `searxngApiKeyEnv` | `SEARXNG_API_KEY` | `…_SEARXNG_API_KEY_ENV` | **Name** of the credential (or environment variable) holding the key. Not the key. |
| `searxngAuthHeader` | `Authorization` | `…_SEARXNG_AUTH_HEADER` | Header the key is sent in. Empty string sends no auth header. |
| `searxngAuthPrefix` | `Bearer ` | `…_SEARXNG_AUTH_PREFIX` | Prefix before the key. Empty string sends the bare value. |
| `searxngCategories` | `["general"]` | `…_SEARXNG_CATEGORIES` (comma-separated) | Default `categories=` filter. `[]` sends none (instance default). |
| `searxngEngines` | `[]` | `…_SEARXNG_ENGINES` (comma-separated) | Default `engines=` filter. Empty uses every enabled engine. |
| `searxngLanguage` | unset | `…_SEARXNG_LANGUAGE` | Default language filter, e.g. `en`, `de`, `en-US`. |
| `searxngSafeSearch` | unset | `…_SEARXNG_SAFESEARCH` | `0` off, `1` moderate, `2` strict. |
| `searxngTimeRange` | unset | `…_SEARXNG_TIME_RANGE` | `day`, `week`, `month`, `year`. |
| `searxngTimeoutMs` | `15000` | `…_SEARXNG_TIMEOUT_MS` | One search request (1000-120000). |
| `searxngMaxSnippetChars` | `500` | `…_SEARXNG_MAX_SNIPPET_CHARS` | Per-source snippet cap (0-5000). `0` disables the cap. |

`web_status` lists the categories and engines the instance actually serves, so these filters can
be filled in from observation rather than memory.

## Scrape — Firecrawl

| Key | Default | Environment | Meaning |
|---|---|---|---|
| `firecrawlUrl` | `http://127.0.0.1:3002` | `FIRECRAWL_URL`, `…_FIRECRAWL_URL` | API root (the address that answers `/v2/scrape`). `/v1` and `/v2` are both probed. |
| `firecrawlApiKeyEnv` | `FIRECRAWL_API_KEY` | `…_FIRECRAWL_API_KEY_ENV` | **Name** of the credential holding the key. |
| `firecrawlApiVersion` | `auto` | `…_FIRECRAWL_API_VERSION` | `auto` (prefer v2, fall back per operation), `v1`, or `v2`. |
| `firecrawlFormats` | `["markdown"]` | `…_FIRECRAWL_FORMATS` (comma-separated) | Default formats: `markdown`, `html`, `links`, `screenshot`, `summary`, `json`. |
| `firecrawlOnlyMainContent` | `true` | `…_FIRECRAWL_ONLY_MAIN_CONTENT` | Drop navigation, footers and boilerplate. |
| `firecrawlProxy` | unset | `…_FIRECRAWL_PROXY` | `auto`, `basic`, `stealth`, `enhanced`. Sent on v2 requests only. |
| `firecrawlTimeoutMs` | `60000` | `…_FIRECRAWL_TIMEOUT_MS` | One Firecrawl HTTP request (1000-300000). |
| `firecrawlJobTimeoutMs` | `600000` | `…_FIRECRAWL_JOB_TIMEOUT_MS` | How long a batch scrape or crawl may run before the tool returns its live job id (5000-3600000). |
| `firecrawlPollIntervalMs` | `1500` | `…_FIRECRAWL_POLL_INTERVAL_MS` | Job poll interval (250-30000). |
| `firecrawlMaxUrls` | `50` | `…_FIRECRAWL_MAX_URLS` | Upper bound on `web_scrape` URLs in one call (1-200). |
| `firecrawlRetries` | `2` | `…_FIRECRAWL_RETRIES` | Retries for `429` and transient network failures (0-5). |

## Output

| Key | Default | Environment | Meaning |
|---|---|---|---|
| `outputDir` | session working directory | `…_OUTPUT_DIR` | Where oversized scrapes and crawl pages are written. `~` is expanded; relative paths resolve against the session directory. |
| `maxInlineChars` | `20000` | `…_MAX_INLINE_CHARS` | How much of one page is returned to the model before the rest is cut and saved (500-500000). |
| `writeMetadata` | `true` | `…_WRITE_METADATA` | Write a JSON sidecar next to each saved page. |

## API keys

Keys are not configuration values. The page writes them to DSH's credential service; the host
resolves them per request by reference name and falls back to the environment. Both services
treat the key as optional — a self-hosted instance that enforces nothing needs none, and the
request simply omits the auth header.

To use a **different** environment variable, change `searxngApiKeyEnv` / `firecrawlApiKeyEnv`
to that variable's name (uppercase letters, digits and underscores).

## Environment prefix

All plugin-specific variables start with `DSH_WEB_SEARCH_SCRAPE_`:

| Variable | Purpose |
|---|---|
| `DSH_WEB_SEARCH_SCRAPE_CONFIG` | Path to the config file (overrides `~/.dsh-web-search-scrape/config.json`). |
| `DSH_WEB_SEARCH_SCRAPE_DEBUG` | `1` enables request-level logging (URLs, statuses, timings; never keys or bodies). |

## Examples

Minimal, both services on localhost with no auth:

```json
{}
```

Two remote instances with keys:

```bash
export SEARXNG_URL=http://192.168.10.10:8080
export FIRECRAWL_URL=http://192.168.10.10:3002
export SEARXNG_API_KEY=sk_none_needed
export FIRECRAWL_API_KEY=sk_none_needed
```

Research-oriented defaults:

```json
{
  "searxngCategories": ["general", "science"],
  "searxngEngines": ["braveapi", "arxiv"],
  "firecrawlFormats": ["markdown", "links"],
  "firecrawlOnlyMainContent": true,
  "maxInlineChars": 60000
}
```
