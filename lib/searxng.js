/**
 * SearXNG client.
 *
 * One search is a plain retrieval call against `{base}/search?format=json` — the
 * instance does the metasearch, the harness pays no model turn. `{base}/config`
 * reports the engines, categories and locale set the instance actually serves,
 * which is what the settings page and `web_status` show.
 */
import { errorBodyText, joinUrl, requestJson } from './http.js';
import { logDebug } from './log.js';
/** Cap on one snippet when the operator leaves the setting unset. */
const DEFAULT_SNIPPET_CHARS = 500;
function text(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/** Truncate without splitting a surrogate pair. */
function cap(value, maxChars) {
    if (maxChars <= 0 || value.length <= maxChars)
        return value;
    const cut = value.slice(0, maxChars);
    const last = cut.charCodeAt(cut.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
/** Map one instance response to the harness's normalised result. */
export function mapSearxngResponse(body, maxSnippetChars = DEFAULT_SNIPPET_CHARS) {
    const rawResults = Array.isArray(body.results) ? body.results : [];
    const sources = [];
    const seen = new Set();
    for (const result of rawResults) {
        const url = text(result?.url);
        if (url === undefined || seen.has(url))
            continue;
        seen.add(url);
        const title = text(result?.title);
        const snippet = text(result?.content);
        const publishedAt = text(result?.publishedDate) ?? text(result?.pubdate);
        sources.push({
            url,
            ...(title === undefined ? {} : { title }),
            ...(snippet === undefined ? {} : { snippet: cap(snippet, maxSnippetChars) }),
            ...(publishedAt === undefined ? {} : { publishedAt })
        });
    }
    // `answers[]` is the only instance-generated prose worth surfacing as an answer.
    const answers = Array.isArray(body.answers)
        ? body.answers.map((entry) => text(entry)).filter((entry) => entry !== undefined)
        : [];
    return {
        ...(answers.length === 0 ? {} : { content: answers.join('\n') }),
        sources,
        truncated: false
    };
}
/** Cut a mapped outcome down to `limit`, reporting whether anything was dropped. */
export function limitOutcome(outcome, limit) {
    if (limit === undefined || limit <= 0 || outcome.sources.length <= limit)
        return outcome;
    return { ...outcome, sources: outcome.sources.slice(0, limit), truncated: true };
}
/** The instance's own reason for refusing a request, when it gave one. */
function instanceError(response) {
    const reason = errorBodyText(response.text);
    if (response.status === 403) {
        return (`SearXNG refused the request with HTTP 403${reason === undefined ? '' : `: ${reason}`}. ` +
            'A public instance often blocks programmatic access; run your own instance or allow this client.');
    }
    if (response.status === 429) {
        return `SearXNG is rate limiting this client (HTTP 429)${reason === undefined ? '' : `: ${reason}`}.`;
    }
    return `SearXNG search failed with HTTP ${response.status}${reason === undefined ? '' : `: ${reason}`}`;
}
/**
 * Run one search.
 *
 * @param config resolved plugin config (endpoint, auth, defaults)
 * @param key    API key value, when one is configured
 * @param options per-call filters; unset filters fall back to the configured defaults
 */
export async function searchSearxng(config, key, options, signal) {
    const base = config.searxngUrl;
    if (base === undefined) {
        throw new Error('No SearXNG endpoint is configured. Set one at DSH → Plugins → Web Search & Scrape, or export SEARXNG_URL.');
    }
    const url = new URL(joinUrl(base, 'search'));
    url.searchParams.set('q', options.query);
    url.searchParams.set('format', 'json');
    const categories = options.categories ?? config.searxngCategories;
    const engines = options.engines ?? config.searxngEngines;
    if (categories.length > 0)
        url.searchParams.set('categories', categories.join(','));
    if (engines.length > 0)
        url.searchParams.set('engines', engines.join(','));
    const language = options.language ?? config.searxngLanguage;
    if (language !== undefined && language !== '')
        url.searchParams.set('language', language);
    const timeRange = options.timeRange ?? config.searxngTimeRange;
    if (timeRange !== undefined)
        url.searchParams.set('time_range', timeRange);
    const safeSearch = options.safeSearch ?? config.searxngSafeSearch;
    if (safeSearch !== undefined)
        url.searchParams.set('safesearch', String(safeSearch));
    if (options.page !== undefined && options.page > 1)
        url.searchParams.set('pageno', String(Math.round(options.page)));
    const headers = {};
    if (key !== undefined && key !== '' && config.searxngAuthHeader !== '') {
        headers[config.searxngAuthHeader] = `${config.searxngAuthPrefix}${key}`;
    }
    logDebug('SearXNG search', { endpoint: base, categories, engines, language, timeRange, safeSearch });
    const response = await requestJson(url.toString(), {
        method: 'GET',
        headers,
        timeoutMs: config.searxngTimeoutMs,
        ...(signal === undefined ? {} : { signal })
    });
    if (!response.ok)
        throw new Error(instanceError(response));
    if (!response.contentType.includes('json') || response.json === undefined) {
        throw new Error(`SearXNG returned "${response.contentType || 'no content-type'}" instead of JSON. ` +
            'Add "json" to search.formats in the instance settings.yml.');
    }
    return mapSearxngResponse(response.json, options.maxSnippetChars ?? config.searxngMaxSnippetChars);
}
/** Read `/config`: version, engines, categories and locales of the instance. */
export async function searxngInstanceInfo(config, key, signal) {
    const base = config.searxngUrl;
    const empty = { url: base ?? '', reachable: false, categories: [], engines: [], locales: [] };
    if (base === undefined) {
        return { ...empty, error: 'No SearXNG endpoint is configured.' };
    }
    const headers = {};
    if (key !== undefined && key !== '' && config.searxngAuthHeader !== '') {
        headers[config.searxngAuthHeader] = `${config.searxngAuthPrefix}${key}`;
    }
    try {
        const response = await requestJson(joinUrl(base, 'config'), {
            method: 'GET',
            headers,
            timeoutMs: config.searxngTimeoutMs,
            ...(signal === undefined ? {} : { signal })
        });
        if (!response.ok)
            return { ...empty, error: instanceError(response) };
        const body = (response.json ?? {});
        const categoriesRaw = body.categories;
        const categories = Array.isArray(categoriesRaw)
            ? categoriesRaw.filter((entry) => typeof entry === 'string')
            : categoriesRaw !== null && typeof categoriesRaw === 'object'
                ? Object.keys(categoriesRaw)
                : [];
        const enginesRaw = Array.isArray(body.engines) ? body.engines : [];
        const engines = enginesRaw
            .map((entry) => {
            const name = typeof entry.name === 'string' ? entry.name : undefined;
            if (name === undefined)
                return undefined;
            const engineCategories = Array.isArray(entry.categories)
                ? entry.categories.filter((value) => typeof value === 'string')
                : [];
            return { name, categories: engineCategories, enabled: entry.enabled !== false };
        })
            .filter((entry) => entry !== undefined);
        const localesRaw = body.locales;
        const locales = localesRaw !== null && typeof localesRaw === 'object' ? Object.keys(localesRaw) : [];
        return {
            url: base,
            reachable: true,
            version: typeof body.version === 'string' ? body.version : undefined,
            instanceName: typeof body.instance_name === 'string' ? body.instance_name : undefined,
            defaultLocale: typeof body.default_locale === 'string' ? body.default_locale : undefined,
            safeSearch: typeof body.safe_search === 'number' ? body.safe_search : undefined,
            categories,
            engines,
            locales
        };
    }
    catch (error) {
        return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
}
