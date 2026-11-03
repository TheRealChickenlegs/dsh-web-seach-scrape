import { errorBodyText, requestJson } from '../http.js';
import { logDebug } from '../log.js';
/** How long a probe result is trusted. */
export const PROBE_TTL_MS = 10 * 60 * 1000;
/** A page that exists for exactly this purpose and costs the instance almost nothing. */
export const DEFAULT_PROBE_URL = 'https://example.com';
let cache;
/** Drop the cached capability picture (tests, or after the endpoint changes). */
export function resetCapabilityCache() {
    cache = undefined;
}
function cacheKey(config, hasKey) {
    return `${config.firecrawlUrl ?? ''}|${config.firecrawlApiVersion}|${hasKey ? 'key' : 'nokey'}`;
}
const ENDPOINT_OPERATIONS = [
    { name: 'scrape', path: 'scrape' },
    { name: 'search', path: 'search' },
    { name: 'map', path: 'map' },
    { name: 'crawl', path: 'crawl' },
    { name: 'batchScrape', path: 'batch/scrape' },
    { name: 'extract', path: 'extract' }
];
function classify(status, text) {
    if (status === 404 && /is not a Firecrawl API endpoint/i.test(text))
        return 'absent';
    if (status === 401 || status === 403)
        return 'unauthorized';
    if (status >= 200 && status < 500)
        return 'present';
    // A 5xx still proves the route exists; it is reported as present with a note.
    return 'present';
}
/** Probe one version's endpoint set with empty bodies. */
async function probeVersion(config, key, version, signal) {
    const base = (config.firecrawlUrl ?? '').replace(/\/+$/, '');
    const endpoints = {};
    await Promise.all(ENDPOINT_OPERATIONS.map(async (operation) => {
        const url = `${base}/${version}/${operation.path}`;
        try {
            const response = await requestJson(url, {
                method: 'POST',
                headers: key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` },
                body: {},
                timeoutMs: Math.min(config.firecrawlTimeoutMs, 20_000),
                retries: 0,
                ...(signal === undefined ? {} : { signal })
            });
            endpoints[operation.name] = classify(response.status, response.text);
        }
        catch (error) {
            if (signal?.aborted === true)
                throw error;
            endpoints[operation.name] = 'error';
        }
    }));
    const reachable = Object.values(endpoints).some((state) => state !== 'absent' && state !== 'error');
    return { reachable, endpoints };
}
/** One scrape request used to learn format support. */
async function probeFormat(config, key, version, formats, probeUrl, signal) {
    const base = (config.firecrawlUrl ?? '').replace(/\/+$/, '');
    try {
        const response = await requestJson(`${base}/${version}/scrape`, {
            method: 'POST',
            headers: key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` },
            body: { url: probeUrl, formats },
            timeoutMs: Math.min(config.firecrawlTimeoutMs, 45_000),
            retries: 0,
            ...(signal === undefined ? {} : { signal })
        });
        if (response.ok)
            return { ok: true };
        const reason = errorBodyText(response.text);
        return { ok: false, ...(reason === undefined ? {} : { note: reason }) };
    }
    catch (error) {
        return { ok: false, note: error instanceof Error ? error.message : String(error) };
    }
}
/** Probe which response formats this instance can actually produce. */
async function probeFormats(config, key, version, probeUrl, signal) {
    const formats = {};
    const notes = {};
    const basic = await probeFormat(config, key, version, ['markdown', 'html', 'links'], probeUrl, signal);
    formats.markdown = basic.ok;
    formats.html = basic.ok;
    formats.links = basic.ok;
    if (!basic.ok && basic.note !== undefined)
        notes.markdown = basic.note;
    const jsonProbe = version === 'v2'
        ? await probeFormat(config, key, version, [{ type: 'json', prompt: 'Return the page title.', schema: { type: 'object', properties: { title: { type: 'string' } } } }], probeUrl, signal)
        : await probeFormat(config, key, version, ['json'], probeUrl, signal);
    formats.json = jsonProbe.ok;
    if (!jsonProbe.ok && jsonProbe.note !== undefined)
        notes.json = jsonProbe.note;
    const summary = await probeFormat(config, key, version, ['summary'], probeUrl, signal);
    formats.summary = summary.ok;
    if (!summary.ok && summary.note !== undefined)
        notes.summary = summary.note;
    if (Object.keys(notes).length > 0)
        formats.notes = notes;
    return formats;
}
/**
 * Build the capability picture for the configured instance.
 *
 * @param config - resolved plugin config
 * @param key    - credential value, when configured (never returned)
 * @param options.force bypasses the cache; `probeFormats: false` skips the format requests
 */
export async function probeCapabilities(config, key, options = {}) {
    const base = config.firecrawlUrl;
    const hasKey = key !== undefined && key !== '';
    const key0 = cacheKey(config, hasKey);
    if (options.force !== true && cache !== undefined && cache.key === key0 && Date.now() - cache.at < PROBE_TTL_MS) {
        return cache.value;
    }
    if (base === undefined) {
        return {
            url: '',
            reachable: false,
            versions: {},
            preferred: 'v2',
            formats: {},
            deprecations: [],
            authorized: hasKey,
            probedAt: Date.now(),
            error: 'No Firecrawl endpoint is configured.'
        };
    }
    logDebug('Probing Firecrawl capabilities', { base, version: config.firecrawlApiVersion });
    const [v2, v1] = await Promise.all([
        probeVersion(config, key, 'v2', options.signal),
        probeVersion(config, key, 'v1', options.signal)
    ]);
    const deprecations = [];
    if (v2.endpoints.extract === 'present') {
        deprecations.push('/v2/extract is deprecated by Firecrawl; this plugin uses /v2/scrape with a json format instead.');
    }
    const hasScrape = (version) => version !== undefined && version.endpoints.scrape === 'present';
    let preferred;
    if (config.firecrawlApiVersion === 'v1' && hasScrape(v1))
        preferred = 'v1';
    else if (config.firecrawlApiVersion === 'v2' && hasScrape(v2))
        preferred = 'v2';
    else if (hasScrape(v2))
        preferred = 'v2';
    else if (hasScrape(v1))
        preferred = 'v1';
    else
        preferred = config.firecrawlApiVersion === 'v1' ? 'v1' : 'v2';
    let formats = {};
    if (options.probeFormats !== false && (hasScrape(v2) || hasScrape(v1))) {
        const version = hasScrape(preferred === 'v2' ? v2 : v1) ? preferred : hasScrape(v2) ? 'v2' : 'v1';
        formats = await probeFormats(config, key, version, options.probeUrl ?? DEFAULT_PROBE_URL, options.signal);
        if (formats.summary === false) {
            deprecations.push('The `summary` format is unavailable on this instance (it needs an LLM provider).');
        }
        if (formats.json === false && version === 'v1') {
            deprecations.push('Structured extraction (`json`/extract) is only available on Firecrawl v2.');
        }
    }
    const reachable = v2.reachable || v1.reachable;
    const value = {
        url: base,
        reachable,
        versions: { v1, v2 },
        preferred,
        formats,
        deprecations,
        authorized: hasKey,
        probedAt: Date.now(),
        ...(reachable
            ? {}
            : {
                error: 'The Firecrawl endpoint did not answer any known API route on v1 or v2. ' +
                    'Check the URL (it should be the API root, e.g. http://127.0.0.1:3002) and that the service is running.'
            })
    };
    cache = { key: key0, at: Date.now(), value };
    return value;
}
/** One-line summary of an endpoint map, for text output. */
export function summarizeEndpoints(version) {
    if (version === undefined)
        return 'not probed';
    if (!version.reachable)
        return 'unreachable';
    return Object.entries(version.endpoints)
        .map(([name, state]) => `${name}:${state === 'present' ? 'yes' : state}`)
        .join(' ');
}
