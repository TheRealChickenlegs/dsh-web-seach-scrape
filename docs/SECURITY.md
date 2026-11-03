# Security model

## 1. Credential storage

API keys are never configuration values. The plugin page sends a key once to DSH's credential
service (`ctx.remote.credentials.set`), which stores it under `$DSH_HOME/.credentials.yaml`
(mode 0600). The plugin writes only the credential's **reference name** into the profile.

At request time the host resolves the reference through `ctx.credentials.resolve(ref)` and falls
back to `process.env[ref]`. Two consequences:

- the browser never receives a key — the page shows "configured"/"not set", not the value;
- a headless deployment needs no file edits, only `SEARXNG_API_KEY` / `FIRECRAWL_API_KEY`.

A key is optional for both services. When none is configured, the request omits the auth header;
the instance's own `401`/`403` is the signal that one is needed.

## 2. Key egress

A key is sent to exactly one destination: the endpoint configured for that service, at the
configured path (`/search`, `/config`, `/v1|v2/…`). There is no discovery request, no telemetry,
and no default endpoint other than the two localhost defaults.

- API calls use `redirect: 'error'`, so an `Authorization` header cannot be bounced to another
  host.
- A configured endpoint must be a bare `http(s)` origin+path: embedded credentials, a query
  string or a fragment are rejected at config resolution.
- Error text is scrubbed of both known key values and of header echoes
  (`Authorization: …`, `api-key: …`) before it reaches a model, a log or the browser.

## 3. Untrusted content

Search results, scraped pages and extracted JSON are untrusted external data. The harness's
`web_search`/`web_fetch` already label provider output as such; the plugin tools return page
content as plain text, and the model is instructed to cite sources rather than execute anything
found there.

The plugin does not try to sanitize page content — Firecrawl returns markdown, and the model is
the consumer.

## 4. Request limits

| Bound | Value |
|---|---|
| Response body (JSON) | 32 MiB |
| Probe route request body | 16 KiB |
| URLs per `web_scrape` call | `firecrawlMaxUrls` (default 50, hard cap 200) |
| Links returned by `web_map` | 100 inline, full list to disk |
| Inline characters per page | `maxInlineChars` (default 20 000; the rest is written to disk) |
| Crawl pages | `limit` (hard cap 500) |

A timeout is a resource backstop; the caller's cancellation signal always wins and is reported as
`WEB_ABORTED`, not as a timeout.

## 5. The probe route

`POST /plugin/web-search-scrape/api/probe` exists so the settings page can test both services
without holding a key or hitting CORS. It is deliberately narrow:

- **Authentication**: `connection.requestRejection` — the same owner check DSH applies to `/api`.
  Without that service the route is loopback-only.
- **CSRF fence**: requires `content-type: application/json` and `x-dsh-web-search-scrape: 1`, so a
  cross-site page would need a successful CORS preflight, which the route never grants.
- **No arbitrary targets**: the handler reads the endpoint and key from the resolved config. The
  request body can only ask for a refresh and whether to probe formats.
- **Bounded**: 16 KiB request cap, `no-store` responses, redacted error text.

## 6. What this plugin does not protect against

- **Malicious instances.** A SearXNG or Firecrawl you point at can return anything, including
  prompt-injection content. Treat it like any other web source.
- **Private-address targets.** `web_scrape`/`web_crawl` accept internal URLs by design: this
  plugin exists to reach self-hosted and intranet services. Firecrawl does the fetching, so the
  harness itself does not become an SSRF proxy — but the Firecrawl instance can reach whatever it
  can route to.
- **Secrets inside scraped pages.** A page can contain credentials; the plugin returns it
  verbatim, because redacting unknown secrets is guesswork.
- **Provider logging.** Your SearXNG/Firecrawl instances may log the URLs and queries sent to
  them. That is outside this plugin.

## Reporting

Open an issue at
<https://github.com/TheRealChickenlegs/dsh-web-seach-scrape/issues> without pasting keys, tokens
or private URLs.
