/**
 * Firecrawl request layer.
 *
 * A self-hosted Firecrawl may expose `/v1`, `/v2`, or both. This module owns the
 * version question:
 *   1. an explicit `firecrawlApiVersion` pins one version;
 *   2. `auto` tries v2 first and permanently falls back to v1 for that endpoint
 *      when the server answers `404 … is not a Firecrawl API endpoint`.
 *
 * The fallback is remembered per API root for the process lifetime, so one
 * missing v2 does not cost a round trip on every later call.
 *
 * It also owns the error vocabulary: the server's own `error` string is quoted
 * (it is how Firecrawl names the misconfigured field), keys are never included.
 */
import { errorBodyText, joinUrl, requestJson } from '../http.js';
import { logDebug, logWarn } from '../log.js';
/** Per-base preferred version, learned from a 404 during `auto`. */
const preferredVersion = new Map();
/** Forget every learned version preference (tests, or after a config change). */
export function resetVersionCache() {
    preferredVersion.clear();
}
/** The version to try first for this endpoint + configuration. */
export function initialVersion(config) {
    if (config.firecrawlApiVersion === 'v1')
        return 'v1';
    if (config.firecrawlApiVersion === 'v2')
        return 'v2';
    const base = config.firecrawlUrl ?? '';
    return preferredVersion.get(base) ?? 'v2';
}
/** The ordered versions a request may use. */
export function versionOrder(config) {
    const first = initialVersion(config);
    return first === 'v2' ? ['v2', 'v1'] : ['v1', 'v2'];
}
/** Remember that this endpoint speaks `version` (only meaningful in `auto`). */
export function rememberVersion(base, version) {
    if (preferredVersion.get(base) !== version) {
        preferredVersion.set(base, version);
        logDebug('Firecrawl version preference updated', { base, version });
    }
}
/** Build the path for one operation on one version. */
export function operationPath(version, operation, id) {
    switch (operation) {
        case 'scrape':
            return `/${version}/scrape`;
        case 'search':
            return `/${version}/search`;
        case 'map':
            return `/${version}/map`;
        case 'crawl':
            return `/${version}/crawl`;
        case 'batchScrape':
            return `/${version}/batch/scrape`;
        case 'extract':
            return `/${version}/extract`;
        case 'crawlStatus':
            return `/${version}/crawl/${encodeURIComponent(id ?? '')}`;
        case 'batchStatus':
            return `/${version}/batch/scrape/${encodeURIComponent(id ?? '')}`;
    }
}
/** True when a response means "this API version does not have that endpoint". */
export function isMissingEndpoint(response) {
    if (response.status !== 404)
        return false;
    return /is not a Firecrawl API endpoint/i.test(response.text) || response.text.trim() === '';
}
function authHeaders(config, key) {
    const headers = {};
    if (key !== undefined && key !== '')
        headers.authorization = `Bearer ${key}`;
    return headers;
}
/**
 * Call one operation, honoring the configured version policy.
 *
 * Returns the first response that is not a "missing endpoint" answer, together
 * with the version that produced it.
 */
export async function callFirecrawl(config, key, operation, body, options = {}, id) {
    const base = config.firecrawlUrl;
    if (base === undefined) {
        throw new Error('No Firecrawl endpoint is configured. Set one at DSH → Plugins → Web Search & Scrape, or export FIRECRAWL_URL.');
    }
    const versions = versionOrder(config);
    const method = options.method ?? 'POST';
    let last;
    for (const version of versions) {
        const path = operationPath(version, operation, id);
        const url = joinUrl(base, path);
        const payload = options.buildBody === undefined ? body : options.buildBody(version);
        const response = await requestJson(url, {
            method,
            headers: authHeaders(config, key),
            ...(method === 'POST' ? { body: payload } : {}),
            timeoutMs: options.timeoutMs ?? config.firecrawlTimeoutMs,
            retries: options.retries ?? config.firecrawlRetries,
            ...(options.retryStatuses === undefined ? {} : { retryStatuses: options.retryStatuses }),
            ...(options.signal === undefined ? {} : { signal: options.signal })
        });
        last = { response, version, path };
        if (!isMissingEndpoint(response)) {
            // A successful or meaningful answer from a non-preferred version is worth remembering.
            if (version !== initialVersion(config) && response.ok)
                rememberVersion(base, version);
            return last;
        }
        if (versions.length > 1) {
            logDebug('Firecrawl endpoint missing on this version; trying the other', { base, path, status: response.status });
        }
    }
    if (last === undefined) {
        throw new Error(`Firecrawl request for ${operation} produced no response.`);
    }
    // Neither version has the endpoint: surface the last answer (a 404) so the caller
    // can say exactly which path is missing.
    if (versions.length > 1) {
        const base0 = config.firecrawlUrl ?? '';
        logWarn(`Firecrawl exposes neither v1 nor v2 ${operation} at ${base0}.`);
    }
    return last;
}
/** Throw a caller-facing error for a non-ok response, quoting the server's reason. */
export function firecrawlError(response, operation) {
    const reason = errorBodyText(response.text);
    const detail = reason === undefined ? '' : `: ${reason}`;
    if (response.status === 401 || response.status === 403) {
        return new Error(`Firecrawl rejected the request with HTTP ${response.status}${detail}. ` +
            'Set the API key for Firecrawl on the plugin page, or export FIRECRAWL_API_KEY.');
    }
    if (response.status === 429) {
        return new Error(`Firecrawl is rate limiting this client (HTTP 429)${detail}. ` +
            'Lower concurrency or wait; the plugin already retries short rate limits.');
    }
    if (response.status === 404 && isMissingEndpoint(response)) {
        return new Error(`Firecrawl has no ${operation} endpoint on this instance (HTTP 404). ` +
            'Check the endpoint URL and the instance version; web_status reports which operations it exposes.');
    }
    if (response.status >= 500) {
        return new Error(`Firecrawl failed with HTTP ${response.status}${detail}. ` +
            'A 500 from a scrape usually means the page could not be rendered or the instance lost its browser; retry, or scrape another URL.');
    }
    return new Error(`Firecrawl ${operation} failed with HTTP ${response.status}${detail}`);
}
