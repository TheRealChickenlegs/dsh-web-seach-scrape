/**
 * Stable plugin identity.
 *
 * Dependency-free on purpose: config, logging, HTTP, tools and the web route all
 * import this module, and none of them should create an import cycle through it.
 * Keep the version in sync with package.json — a test enforces it.
 */
/** Package id, loader entry id and settings namespace. */
export const PLUGIN_ID = 'dsh-web-search-scrape';
/** Human-readable name shown in the plugin list and documentation. */
export const PLUGIN_DISPLAY_NAME = 'Web Search & Scrape';
/** Plugin version reported in the startup line. Keep in sync with package.json. */
export const PLUGIN_VERSION = '0.1.0';
/** The id this plugin registers its search provider under (`web.searchProvider`). */
export const SEARCH_PROVIDER_ID = 'searxng';
/** The id this plugin registers its fetch provider under (`web.fetchProvider`). */
export const FETCH_PROVIDER_ID = 'firecrawl';
/** Prefix for this plugin's environment variables. */
export const ENV_PREFIX = 'DSH_WEB_SEARCH_SCRAPE';
/** Override the non-secret config file location. */
export const ENV_CONFIG = `${ENV_PREFIX}_CONFIG`;
/** Verbose logging switch. */
export const ENV_DEBUG = `${ENV_PREFIX}_DEBUG`;
/** Conventional environment fallbacks for the two endpoints. */
export const ENV_SEARXNG_URL = 'SEARXNG_URL';
export const ENV_FIRECRAWL_URL = 'FIRECRAWL_URL';
/** Default credential references, also usable as environment variable names. */
export const DEFAULT_SEARXNG_API_KEY_ENV = 'SEARXNG_API_KEY';
export const DEFAULT_FIRECRAWL_API_KEY_ENV = 'FIRECRAWL_API_KEY';
/** Same-origin probe route served by DSH's web server, when mounted. */
export const ROUTE_PREFIX = '/plugin/web-search-scrape/api';
/** Header the settings page sends; it also makes a cross-site request fail the browser preflight. */
export const ROUTE_HEADER = 'x-dsh-web-search-scrape';
/** Upper bound on URLs accepted by one scrape call. */
export const MAX_URLS_HARD_LIMIT = 200;
/** Upper bound on links returned by one map call. */
export const MAX_MAP_LINKS_HARD_LIMIT = 1000;
