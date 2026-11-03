/**
 * Plugin entry point (host side).
 *
 * Mounting: after loading this package the DSH Loader calls `apply(ctx, config)`.
 * `inject = ['tools']` guarantees the tool registry is available. No
 * `@deepseek-ai/*` host package is imported at runtime: under a link install Node
 * resolves modules from the plugin's physical path, where host packages do not
 * exist. `tools.register()` and the web seam accept plain objects, so structural
 * types are enough.
 *
 * What `apply` does, in order:
 *   1. registers the five agent tools;
 *   2. registers the SearXNG search provider and the Firecrawl fetch provider on
 *      `ctx.web` (the bundle patch pins both ids — without that, the seam would
 *      refuse to choose between them and the shipped providers);
 *   3. tells the settings service this plugin ships its own page;
 *   4. mounts the same-origin probe route used by that page.
 */
import { resolveConfig } from './config.js'
import { formatError } from './errors.js'
import { getService, resolveApiKey } from './credentials.js'
import { FETCH_PROVIDER_ID, PLUGIN_DISPLAY_NAME, PLUGIN_ID, PLUGIN_VERSION, SEARCH_PROVIDER_ID } from './identity.js'
import { logInfo, logWarn } from './log.js'
import { FirecrawlFetchProvider } from './provider-fetch.js'
import { SearxngSearchProvider, hasUsableEndpoint } from './provider-search.js'
import { registerTools, TOOL_NAMES as REGISTERED_TOOL_NAMES } from './tools.js'
import { registerProbeRoute } from './web-route.js'
import type { HostContextLike, ToolRegistryLike, WebSeamLike } from './types.js'

/** Plugin name (also the loader entry id and settings namespace). */
export const name = PLUGIN_ID

/** The tool registry service this plugin depends on. */
export const inject = ['tools']

/** Get the tool registry; returns undefined when unavailable (never take DSH down). */
function getToolRegistry(ctx: HostContextLike): ToolRegistryLike | undefined {
  const candidates: unknown[] = []
  try {
    if (typeof ctx.reflect?.get === 'function') {
      candidates.push(ctx.reflect.get('tools', false))
      candidates.push(ctx.reflect.get('tools'))
    }
  } catch {
    /* registry may not be active yet */
  }
  try {
    if (typeof ctx.get === 'function') candidates.push(ctx.get('tools'))
  } catch {
    /* same */
  }
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && typeof (candidate as ToolRegistryLike).register === 'function') {
      return candidate as ToolRegistryLike
    }
  }
  return undefined
}

/** Register both seam providers, tolerating a host that does not compose `web`. */
function registerProviders(ctx: HostContextLike, pluginConfig: unknown): void {
  if (typeof ctx.inject !== 'function') {
    logWarn('This host has no ctx.inject; web_search/web_fetch were not wired to the self-hosted backends.')
    return
  }
  try {
    ctx.inject(['web'], (webCtx) => {
      const web = (webCtx.web ?? getService<WebSeamLike>(webCtx, 'web')) as WebSeamLike | undefined
      if (web === undefined) {
        logWarn('The web service is not composed; web_search/web_fetch will not use the self-hosted backends (the plugin tools still work).')
        return
      }

      if (typeof web.registerSearchProvider === 'function') {
        try {
          web.registerSearchProvider(
            new SearxngSearchProvider(() => ({ config: resolveConfig(pluginConfig), host: webCtx }))
          )
        } catch (error) {
          logWarn(
            `Could not register the "${SEARCH_PROVIDER_ID}" search provider (another plugin may already use that id): ${formatError(error)}`
          )
        }
      } else {
        logWarn('The web service has no registerSearchProvider; web_search was not replaced.')
      }

      if (typeof web.registerFetchProvider === 'function') {
        try {
          web.registerFetchProvider(
            new FirecrawlFetchProvider(() => ({ config: resolveConfig(pluginConfig), host: webCtx }))
          )
        } catch (error) {
          logWarn(
            `Could not register the "${FETCH_PROVIDER_ID}" fetch provider (another plugin may already use that id): ${formatError(error)}`
          )
        }
      } else {
        logWarn('The web service has no registerFetchProvider; web_fetch was not replaced.')
      }
    })
  } catch (error) {
    logWarn(`Could not inject the web service: ${formatError(error)}`)
  }
}

/**
 * Plugin body.
 *
 * @param ctx    Host context
 * @param config Plugin config (the contents of `config:` in the profile, may be empty)
 */
export function apply(ctx: HostContextLike, config?: unknown): void {
  const tools = getToolRegistry(ctx)
  if (tools === undefined) {
    logWarn('Cannot obtain the tools service; the web search/scrape tools were not registered (check the plugin dependencies in the profile).')
    return
  }

  registerTools(tools, config, ctx)
  registerProviders(ctx, config)

  // The plugin page is custom, so tell DSH's settings service not to add an
  // auto-generated form for this entry. The child is optional: the tools keep
  // working on hosts that do not compose the settings service.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        try {
          const settings = (settingsCtx as { settings?: { configure?: (options: { auto: boolean }, fiber: unknown) => void } }).settings
          settings?.configure?.({ auto: false }, ctx.fiber)
        } catch {
          /* an older settings service may not support the policy; the page still works */
        }
      })
    } catch {
      /* optional service */
    }
  }

  // Same-origin probe for the settings page ("Test both services"). Best effort:
  // a headless composition without a web server simply has no page to serve.
  registerProbeRoute(ctx, config)

  const resolved = resolveConfig(config)
  logInfo(
    `${PLUGIN_DISPLAY_NAME} v${PLUGIN_VERSION} ready. ` +
      `Search: ${resolved.searxngUrl ?? 'not configured'} (provider ${SEARCH_PROVIDER_ID}). ` +
      `Scrape: ${resolved.firecrawlUrl ?? 'not configured'} (provider ${FETCH_PROVIDER_ID}, API ${resolved.firecrawlApiVersion}). ` +
      `Tools: ${REGISTERED_TOOL_NAMES.join(', ')}.`
  )
  for (const problem of resolved.problems) logWarn(problem)
  if (!hasUsableEndpoint(resolved.searxngUrl) || !hasUsableEndpoint(resolved.firecrawlUrl)) {
    logInfo('One or both endpoints are not configured yet. Set them at DSH → Plugins → Plugins → Web Search & Scrape.')
  }
}

/* ─────────────── Re-exports for local tests (unit-testable without starting DSH) ─────────────── */
export { Config } from './config-schema.js'
export {
  API_VERSIONS,
  CREDENTIAL_REF_PATTERN,
  DEFAULTS,
  PROXY_MODES,
  SAFE_SEARCH_LEVELS,
  SCRAPE_FORMATS,
  TIME_RANGES,
  configFilePath,
  configFromEnv,
  normalizeEndpoint,
  readConfigFile,
  resolveConfig,
  unwrapVolatile
} from './config.js'
export {
  DEFAULT_FIRECRAWL_API_KEY_ENV,
  DEFAULT_SEARXNG_API_KEY_ENV,
  ENV_DEBUG,
  ENV_PREFIX,
  FETCH_PROVIDER_ID,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_ID,
  PLUGIN_VERSION,
  ROUTE_HEADER,
  ROUTE_PREFIX,
  SEARCH_PROVIDER_ID
} from './identity.js'
export { PluginError, errorCode, formatError, seamError } from './errors.js'
export { describeApiKey, getService, redactDeep, redactSecrets, resolveApiKey } from './credentials.js'
export { authHeaders, errorBodyText, joinUrl, requestJson, withTimeout } from './http.js'
export { limitOutcome, mapSearxngResponse, searchSearxng, searxngInstanceInfo } from './searxng.js'
export {
  callFirecrawl,
  firecrawlError,
  initialVersion,
  isMissingEndpoint,
  operationPath,
  rememberVersion,
  resetVersionCache,
  versionOrder
} from './firecrawl/client.js'
export { DEFAULT_PROBE_URL, PROBE_TTL_MS, probeCapabilities, resetCapabilityCache, summarizeEndpoints } from './firecrawl/capabilities.js'
export { firecrawlSearch, mapSite, parseScrapePage, pollCrawl, scrapePage, scrapeUrls, startCrawl, waitForJob } from './firecrawl/scrape.js'
export { FirecrawlFetchProvider } from './provider-fetch.js'
export { hasUsableEndpoint, SearxngSearchProvider } from './provider-search.js'
export { previewText, resolveCwd, resolveOutputDir, resolveSessionCwd, sanitizeComponent, slugForUrl, timestampSlug, uniquePath, validateTargetUrl, writeMetadataFile, writeTextFile } from './files.js'
export {
  CRAWL_DESCRIPTION,
  CRAWL_OUTPUT,
  CRAWL_PARAMETERS,
  CRAWL_TOOL_NAME,
  MAP_DESCRIPTION,
  MAP_OUTPUT,
  MAP_PARAMETERS,
  MAP_TOOL_NAME,
  SCRAPE_DESCRIPTION,
  SCRAPE_OUTPUT,
  SCRAPE_PARAMETERS,
  SCRAPE_TOOL_NAME,
  SEARCH_DESCRIPTION,
  SEARCH_OUTPUT,
  SEARCH_PARAMETERS,
  SEARCH_TOOL_NAME,
  STATUS_DESCRIPTION,
  STATUS_OUTPUT,
  STATUS_PARAMETERS,
  STATUS_TOOL_NAME,
  TOOL_NAMES,
  createCrawlTool,
  createMapTool,
  createScrapeTool,
  createSearchTool,
  createStatusTool,
  formatSources,
  registerTools
} from './tools.js'
export { createProbeRouteHandler, registerProbeRoute } from './web-route.js'
export type {
  CrawlPageResult,
  FirecrawlCapabilities,
  FirecrawlVersionCapabilities,
  FormatSupport,
  HostContextLike,
  ResolvedConfig,
  ScrapePageResult,
  SearxngInstanceInfo,
  WebFetchOutcome,
  WebSearchOutcome,
  WebSource
} from './types.js'
