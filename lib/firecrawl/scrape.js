/**
 * Firecrawl operations: scrape, batch scrape, map, crawl and search.
 *
 * Design notes:
 * - One URL uses `/scrape`; two or more use `/batch/scrape` so the instance does
 *   the concurrency work. That is both faster and cheaper than N sequential
 *   scrapes, and it is the reason the scrape tool takes an array.
 * - Long-running operations (batch, crawl) return a job id and are polled; a
 *   deadline returns the live job id instead of discarding the job.
 * - v2 is used when available. v1 requests omit v2-only fields so the instance
 *   does not reject them as unrecognised keys.
 */
import { callFirecrawl, firecrawlError, isMissingEndpoint } from './client.js';
import { errorBodyText, sleep } from '../http.js';
import { logDebug } from '../log.js';
import { PluginError } from '../errors.js';
function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** Build the `formats` array, folding structured extraction into a json format object. */
function buildFormats(options, version) {
    const requested = options.formats ?? ['markdown'];
    const formats = [];
    for (const format of requested) {
        if (format === 'json')
            continue;
        formats.push(format);
    }
    if (options.extract !== undefined) {
        if (version === 'v1') {
            throw new Error('Structured extraction (`extract`) needs Firecrawl v2: v1 predates the json format and rejects the options. ' +
                'Set firecrawlApiVersion to auto (or v2) on the plugin page, or scrape as markdown instead.');
        }
        formats.push({
            type: 'json',
            prompt: options.extract.prompt,
            ...(options.extract.schema === undefined ? {} : { schema: options.extract.schema })
        });
    }
    if (formats.length === 0) {
        throw new Error('Nothing to return: `json` was requested without `extract`. Pass extract.prompt (and optionally extract.schema), or request markdown/html/links.');
    }
    return formats;
}
/** Shared scrape body fields, split by what the selected version accepts. */
function scrapeBody(url, options, version) {
    const body = {
        url,
        formats: buildFormats(options, version)
    };
    if (options.onlyMainContent !== undefined)
        body.onlyMainContent = options.onlyMainContent;
    if (options.includeTags !== undefined && options.includeTags.length > 0)
        body.includeTags = options.includeTags;
    if (options.excludeTags !== undefined && options.excludeTags.length > 0)
        body.excludeTags = options.excludeTags;
    if (options.waitForMs !== undefined && options.waitForMs > 0)
        body.waitFor = options.waitForMs;
    if (options.timeoutMs !== undefined)
        body.timeout = options.timeoutMs;
    if (version === 'v2') {
        if (options.proxy !== undefined)
            body.proxy = options.proxy;
        if (options.mobile !== undefined)
            body.mobile = options.mobile;
    }
    return body;
}
/** Normalise one scraped page from either API version. */
export function parseScrapePage(data, fallbackUrl) {
    const metadata = record(data.metadata) ?? {};
    const linksRaw = data.links;
    const links = Array.isArray(linksRaw)
        ? linksRaw
            .map((entry) => (typeof entry === 'string' ? entry : text(record(entry)?.url)))
            .filter((entry) => entry !== undefined)
        : undefined;
    const jsonBody = data.json ?? data.extract;
    const title = text(metadata.title);
    const statusCode = typeof metadata.statusCode === 'number' ? metadata.statusCode : undefined;
    const markdown = text(data.markdown) ?? text(data.content);
    const html = text(data.html);
    const summary = text(data.summary);
    const screenshotUrl = text(data.screenshot);
    // Every optional field is omitted rather than set to undefined: the canonical
    // tool value is validated against its declared output schema, where a present
    // `undefined` is not the declared type.
    return {
        url: text(metadata.sourceURL) ?? text(metadata.url) ?? text(data.url) ?? fallbackUrl,
        ok: true,
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(title === undefined ? {} : { title }),
        ...(markdown === undefined ? {} : { markdown }),
        ...(html === undefined ? {} : { html }),
        ...(links === undefined || links.length === 0 ? {} : { links }),
        ...(summary === undefined ? {} : { summary }),
        ...(jsonBody === undefined ? {} : { json: jsonBody }),
        ...(screenshotUrl === undefined ? {} : { screenshotUrl }),
        metadata
    };
}
/** One page scrape. */
export async function scrapePage(config, key, url, options, signal) {
    const { response } = await callFirecrawl(config, key, 'scrape', undefined, {
        buildBody: (version) => scrapeBody(url, options, version),
        ...(signal === undefined ? {} : { signal })
    });
    if (isMissingEndpoint(response))
        throw firecrawlError(response, 'scrape');
    if (!response.ok)
        throw firecrawlError(response, 'scrape');
    const payload = record(response.json);
    const data = record(payload?.data);
    if (data === undefined) {
        throw new Error('Firecrawl returned no page data for this URL. The page may be unreachable from the instance.');
    }
    return parseScrapePage(data, url);
}
/** Poll a batch or crawl job until it settles or the deadline passes. */
export async function waitForJob(config, key, operation, id, options = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? config.firecrawlJobTimeoutMs);
    const interval = options.intervalMs ?? config.firecrawlPollIntervalMs;
    let version = config.firecrawlApiVersion === 'v1' ? 'v1' : 'v2';
    let snapshot = { status: 'running', pages: [], raw: {} };
    for (;;) {
        const call = await callFirecrawl(config, key, operation, undefined, {
            method: 'GET',
            retries: config.firecrawlRetries,
            retryStatuses: [500, 502, 503, 504],
            ...(options.signal === undefined ? {} : { signal: options.signal })
        }, id);
        version = call.version;
        const response = call.response;
        if (!response.ok)
            throw firecrawlError(response, operation);
        const body = record(response.json) ?? {};
        const rawStatus = typeof body.status === 'string' ? body.status : undefined;
        const pages = Array.isArray(body.data) ? body.data : [];
        const completed = typeof body.completed === 'number' ? body.completed : undefined;
        const total = typeof body.total === 'number' ? body.total : undefined;
        if (rawStatus === 'failed' || rawStatus === 'cancelled') {
            const reason = errorBodyText(response.text);
            throw new PluginError(`Firecrawl job ${id} ${rawStatus}${reason === undefined ? '' : `: ${reason}`}`, 'WEB_JOB_FAILED');
        }
        const settled = rawStatus === 'completed' || (rawStatus === undefined && pages.length > 0);
        snapshot = {
            status: settled ? 'completed' : 'running',
            ...(completed === undefined ? {} : { completed }),
            ...(total === undefined ? {} : { total }),
            pages,
            raw: body
        };
        if (settled)
            return { done: true, version, snapshot };
        if (Date.now() >= deadline)
            return { done: false, version, snapshot };
        logDebug('Waiting for Firecrawl job', { id, status: rawStatus, completed, total });
        await sleep(Math.min(interval, Math.max(250, deadline - Date.now())), options.signal);
    }
}
/** Scrape one or many URLs, using the batch endpoint for more than one. */
export async function scrapeUrls(config, key, options, signal) {
    const urls = options.urls;
    if (urls.length === 0)
        throw new Error('At least one URL is required.');
    if (urls.length === 1) {
        const page = await scrapePage(config, key, urls[0], options, signal);
        return { pages: [page], version: config.firecrawlApiVersion === 'v1' ? 'v1' : 'v2' };
    }
    const buildBatchBody = (version) => {
        const body = {
            urls,
            formats: buildFormats(options, version)
        };
        if (options.onlyMainContent !== undefined)
            body.onlyMainContent = options.onlyMainContent;
        if (options.includeTags !== undefined && options.includeTags.length > 0)
            body.includeTags = options.includeTags;
        if (options.excludeTags !== undefined && options.excludeTags.length > 0)
            body.excludeTags = options.excludeTags;
        if (options.waitForMs !== undefined && options.waitForMs > 0)
            body.waitFor = options.waitForMs;
        if (options.timeoutMs !== undefined)
            body.timeout = options.timeoutMs;
        if (version === 'v2' && options.proxy !== undefined)
            body.proxy = options.proxy;
        return body;
    };
    const call = await callFirecrawl(config, key, 'batchScrape', undefined, {
        buildBody: buildBatchBody,
        ...(signal === undefined ? {} : { signal })
    });
    if (!call.response.ok) {
        // A missing batch endpoint is not fatal: fall back to a bounded parallel fan-out.
        if (isMissingEndpoint(call.response)) {
            const pages = await Promise.all(urls.map((url) => scrapePage(config, key, url, options, signal).catch((error) => ({
                url,
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            }))));
            return { pages, version: config.firecrawlApiVersion === 'v1' ? 'v1' : 'v2', total: urls.length };
        }
        throw firecrawlError(call.response, 'batchScrape');
    }
    const payload = record(call.response.json) ?? {};
    const jobId = text(payload.id);
    if (jobId === undefined) {
        // Some builds answer synchronously with `data`.
        const data = Array.isArray(payload.data) ? payload.data : [];
        return {
            pages: data.map((entry) => parseScrapePage(entry, text(record(entry.metadata)?.sourceURL) ?? '')),
            version: call.version
        };
    }
    const waited = await waitForJob(config, key, 'batchStatus', jobId, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: config.firecrawlJobTimeoutMs
    });
    const pages = waited.snapshot.pages.map((entry) => parseScrapePage(entry, text(record(entry.metadata)?.sourceURL) ?? ''));
    return {
        pages,
        version: waited.version,
        jobId,
        total: waited.snapshot.total ?? urls.length,
        ...(waited.done ? {} : { timedOut: true })
    };
}
/** Discover a site's URLs. */
export async function mapSite(config, key, options, signal) {
    const body = { url: options.url };
    if (options.search !== undefined && options.search !== '')
        body.search = options.search;
    if (options.limit !== undefined)
        body.limit = options.limit;
    if (options.includeSubdomains !== undefined)
        body.includeSubdomains = options.includeSubdomains;
    if (options.ignoreQueryParameters !== undefined)
        body.ignoreQueryParameters = options.ignoreQueryParameters;
    if (options.sitemap !== undefined)
        body.sitemap = options.sitemap;
    const call = await callFirecrawl(config, key, 'map', body, {
        ...(signal === undefined ? {} : { signal })
    });
    if (!call.response.ok)
        throw firecrawlError(call.response, 'map');
    const payload = record(call.response.json) ?? {};
    const rawLinks = Array.isArray(payload.links) ? payload.links : [];
    const links = rawLinks
        .map((entry) => (typeof entry === 'string' ? entry : text(record(entry)?.url)))
        .filter((entry) => entry !== undefined);
    const cap = options.limit ?? 200;
    return {
        links: links.slice(0, cap),
        version: call.version,
        truncated: links.length > cap
    };
}
/** Start a crawl and return its job id. */
export async function startCrawl(config, key, options, signal) {
    const buildCrawlBody = (version) => {
        const scrapeOptions = {
            formats: buildFormats({ urls: [], formats: options.formats, onlyMainContent: options.onlyMainContent }, version)
        };
        if (options.onlyMainContent !== undefined)
            scrapeOptions.onlyMainContent = options.onlyMainContent;
        const body = { url: options.url, scrapeOptions };
        if (options.limit !== undefined)
            body.limit = options.limit;
        if (options.maxDepth !== undefined)
            body.maxDiscoveryDepth = options.maxDepth;
        if (options.includePaths !== undefined && options.includePaths.length > 0)
            body.includePaths = options.includePaths;
        if (options.excludePaths !== undefined && options.excludePaths.length > 0)
            body.excludePaths = options.excludePaths;
        if (options.allowExternalLinks !== undefined)
            body.allowExternalLinks = options.allowExternalLinks;
        if (options.allowSubdomains !== undefined)
            body.allowSubdomains = options.allowSubdomains;
        if (options.sitemap !== undefined)
            body.sitemap = options.sitemap;
        if (options.ignoreQueryParameters !== undefined)
            body.ignoreQueryParameters = options.ignoreQueryParameters;
        if (options.delayMs !== undefined)
            body.delay = options.delayMs;
        if (options.maxConcurrency !== undefined)
            body.maxConcurrency = options.maxConcurrency;
        return body;
    };
    const call = await callFirecrawl(config, key, 'crawl', undefined, {
        buildBody: buildCrawlBody,
        ...(signal === undefined ? {} : { signal })
    });
    if (!call.response.ok)
        throw firecrawlError(call.response, 'crawl');
    const payload = record(call.response.json) ?? {};
    const jobId = text(payload.id);
    if (jobId === undefined)
        throw new Error('Firecrawl accepted the crawl but returned no job id.');
    return { jobId, version: call.version };
}
/** Poll a crawl until it settles or the deadline passes. */
export async function pollCrawl(config, key, jobId, options = {}) {
    return waitForJob(config, key, 'crawlStatus', jobId, options);
}
/** Firecrawl search, used as the fallback search backend. */
export async function firecrawlSearch(config, key, options, signal) {
    const buildSearchBody = (version) => {
        const body = { query: options.query };
        if (options.limit !== undefined)
            body.limit = options.limit;
        // v2 accepts `sources`/`scrapeOptions`; v1 rejects unknown top-level keys.
        if (version === 'v2') {
            if (options.sources !== undefined && options.sources.length > 0)
                body.sources = options.sources;
            if (options.categories !== undefined && options.categories.length > 0)
                body.categories = options.categories;
            if (options.scrapeOptions !== undefined)
                body.scrapeOptions = options.scrapeOptions;
        }
        return body;
    };
    const call = await callFirecrawl(config, key, 'search', undefined, {
        buildBody: buildSearchBody,
        ...(signal === undefined ? {} : { signal })
    });
    if (!call.response.ok)
        throw firecrawlError(call.response, 'search');
    const payload = record(call.response.json) ?? {};
    const data = payload.data;
    const items = Array.isArray(data)
        ? data
        : Array.isArray(record(data)?.web)
            ? record(data).web
            : [];
    const sources = [];
    const seen = new Set();
    for (const item of items) {
        const url = text(item.url);
        if (url === undefined || seen.has(url))
            continue;
        seen.add(url);
        const title = text(item.title);
        const snippet = text(item.description) ?? text(item.snippet);
        const publishedAt = text(item.publishedAt) ?? text(item.published_at) ?? text(item.date);
        sources.push({
            url,
            ...(title === undefined ? {} : { title }),
            ...(snippet === undefined ? {} : { snippet }),
            ...(publishedAt === undefined ? {} : { publishedAt })
        });
    }
    return { sources, truncated: false };
}
