/**
 * The model-facing tool contract.
 *
 * Five tools, deliberately split by capability rather than by vendor endpoint:
 * - `web_search_advanced` — SearXNG filters the built-in `web_search` cannot express,
 *   with a Firecrawl search fallback;
 * - `web_scrape`          — one page or many (batch when >1), formats, structured extraction;
 * - `web_map`             — URL discovery for a site;
 * - `web_crawl`           — a site crawl with polling and resumable job ids;
 * - `web_status`          — what the two instances actually expose (v1/v2, formats, engines).
 *
 * Constraints verified against DSH's tool registry:
 *   1. `parameters` is a RAW JSON Schema, not a DSL.
 *   2. Only the enforced subset is allowed: type / oneOf / properties / required /
 *      additionalProperties / items / enum / const + annotations. Ranges, patterns and
 *      formats live in descriptions and are validated at runtime.
 */
import { resolveConfig } from './config.js';
import { resolveApiKey } from './credentials.js';
import { formatError } from './errors.js';
import { logDebug } from './log.js';
import { limitOutcome, searxngInstanceInfo, searchSearxng } from './searxng.js';
import { firecrawlSearch, mapSite, pollCrawl, scrapeUrls, startCrawl } from './firecrawl/scrape.js';
import { probeCapabilities, summarizeEndpoints } from './firecrawl/capabilities.js';
import { resolveOutputDir, resolveSessionCwd, previewText, slugForUrl, timestampSlug, writeMetadataFile, writeTextFile, validateTargetUrl } from './files.js';
import { MAX_MAP_LINKS_HARD_LIMIT, MAX_URLS_HARD_LIMIT } from './identity.js';
export const SEARCH_TOOL_NAME = 'web_search_advanced';
export const SCRAPE_TOOL_NAME = 'web_scrape';
export const MAP_TOOL_NAME = 'web_map';
export const CRAWL_TOOL_NAME = 'web_crawl';
export const STATUS_TOOL_NAME = 'web_status';
/** Every tool this plugin registers. */
export const TOOL_NAMES = [SEARCH_TOOL_NAME, SCRAPE_TOOL_NAME, MAP_TOOL_NAME, CRAWL_TOOL_NAME, STATUS_TOOL_NAME];
/* ─────────────────────────── shared helpers ─────────────────────────── */
function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asStringArray(value) {
    const array = asArray(value);
    if (array.length === 0)
        return undefined;
    const list = array.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
    return list.length === 0 ? undefined : list;
}
function asNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
function asBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    return undefined;
}
/** A bounded, human-readable list of sources. */
export function formatSources(sources) {
    return sources
        .map((source, index) => {
        const title = source.title ?? source.url;
        const date = source.publishedAt === undefined ? '' : ` (${source.publishedAt})`;
        const snippet = source.snippet === undefined ? '' : `\n   ${source.snippet}`;
        return `${index + 1}. ${title}${date}\n   ${source.url}${snippet}`;
    })
        .join('\n');
}
/** Render one scraped page, bounded. */
function renderPage(page, maxChars, index) {
    const lines = [];
    const heading = page.title === undefined ? page.url : `${page.title} — ${page.url}`;
    lines.push(`### ${index + 1}. ${heading}`);
    if (!page.ok) {
        lines.push(`Status: FAILED — ${page.error ?? 'unknown error'}`);
        return lines.join('\n');
    }
    const bits = [];
    if (page.statusCode !== undefined)
        bits.push(`HTTP ${page.statusCode}`);
    if (page.links !== undefined)
        bits.push(`${page.links.length} links`);
    if (page.json !== undefined && page.json !== null)
        bits.push('structured JSON');
    if (page.summary !== undefined)
        bits.push('summary');
    if (page.screenshotUrl !== undefined)
        bits.push(`screenshot: ${page.screenshotUrl}`);
    if (bits.length > 0)
        lines.push(bits.join(' · '));
    const body = page.markdown ?? page.html ?? page.summary;
    if (body !== undefined) {
        const preview = previewText(body, maxChars);
        lines.push('');
        lines.push(preview.text);
    }
    if (page.json !== undefined) {
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(page.json, null, 2).slice(0, maxChars));
        lines.push('```');
    }
    if (page.warning !== undefined) {
        lines.push('');
        lines.push(`Note: ${page.warning}`);
    }
    if (page.savedPath !== undefined) {
        lines.push('');
        lines.push(`Full content: ${page.savedPath}`);
    }
    return lines.join('\n');
}
/** Persist a page body when it is cut or an explicit destination was requested. */
async function persistPage(page, config, directory, explicit, writeMetadata) {
    const body = page.markdown ?? page.html ?? page.summary;
    const shouldSave = body !== undefined && (explicit || body.length > config.maxInlineChars);
    if (!shouldSave || body === undefined)
        return;
    const stem = slugForUrl(page.url);
    const extension = page.markdown !== undefined ? 'md' : page.html !== undefined ? 'html' : 'txt';
    const name = `${timestampSlug()}-${stem}.${extension}`;
    page.savedPath = await writeTextFile(directory, name, body);
    if (writeMetadata) {
        await writeMetadataFile(directory, `${timestampSlug()}-${stem}.json`, {
            url: page.url,
            title: page.title,
            statusCode: page.statusCode,
            links: page.links,
            summary: page.summary,
            json: page.json,
            metadata: page.metadata
        });
    }
}
/* ─────────────────────────── web_search_advanced ─────────────────────────── */
export const SEARCH_DESCRIPTION = [
    'Search the web through the configured self-hosted SearXNG instance, with the filters the built-in `web_search` cannot express.',
    '',
    'Use plain `web_search` for a normal lookup. Use this tool when you need engine, category, language, recency or',
    'pagination control, when you want the instance\'s own answer text, or when SearXNG is down and Firecrawl should',
    'answer instead (`source: "auto"` falls back automatically).',
    '',
    'Results are a numbered source list with title, URL and snippet. `sources` carries the same data structurally.',
    'Pass `output_path` to also write the full result to a file.'
].join('\n');
export const SEARCH_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The search query.' },
        categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'SearXNG categories, e.g. ["general"], ["news"], ["science"]. Defaults to the configured categories. `web_status` lists what the instance serves.'
        },
        engines: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict to specific SearXNG engines by name, e.g. ["braveapi","arxiv"]. Defaults to all enabled engines. `web_status` lists them.'
        },
        language: { type: 'string', description: 'Language filter such as "en", "de", "en-US". Defaults to the configured language, if any.' },
        pageno: { type: 'integer', description: 'Result page (1-based, default 1).' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results published within this window, when the engines support it.' },
        safesearch: { type: 'integer', enum: [0, 1, 2], description: 'Safe-search level: 0 off, 1 moderate, 2 strict. Defaults to the instance setting.' },
        source: {
            type: 'string',
            enum: ['auto', 'searxng', 'firecrawl'],
            description: 'Which backend answers. auto (default) tries SearXNG, then Firecrawl search when SearXNG fails.'
        },
        limit: { type: 'integer', description: 'Maximum sources to return (1-50).' },
        include_answers: { type: 'boolean', description: 'Include SearXNG answer/instant-answer text when the instance supplies it (default true).' },
        output_path: { type: 'string', description: 'Directory (or file) to also write the full result to. Relative paths resolve against the session working directory.' }
    },
    required: ['query'],
    additionalProperties: false
};
export const SEARCH_OUTPUT = {
    type: 'object',
    properties: {
        source: { type: 'string' },
        query: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
        sources: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                    snippet: { type: 'string' },
                    publishedAt: { type: 'string' }
                },
                required: ['url']
            }
        },
        text: { type: 'string' },
        file: { type: 'string' }
    },
    required: ['source', 'query', 'truncated', 'sources', 'text']
};
export function createSearchTool(pluginConfig, host) {
    return {
        name: SEARCH_TOOL_NAME,
        description: SEARCH_DESCRIPTION,
        parameters: SEARCH_PARAMETERS,
        output: {
            schema: SEARCH_OUTPUT,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return {
                    kind: 'web-search-scrape',
                    operation: 'search',
                    source: result?.source ?? 'unknown',
                    query: result?.query ?? '',
                    count: Array.isArray(result?.sources) ? result.sources.length : 0,
                    truncated: result?.truncated === true
                };
            }
        },
        timeoutMs: 60_000,
        async execute(rawArgs, exec) {
            const args = (asRecord(rawArgs) ?? {});
            const config = resolveConfig(pluginConfig);
            const query = text(args.query);
            if (query === undefined)
                throw new Error('`query` must be a non-empty string.');
            const limit = Math.min(50, Math.max(1, asNumber(args.limit) ?? 10));
            const wanted = args.source ?? 'auto';
            let source = wanted === 'firecrawl' ? 'firecrawl' : 'searxng';
            const includeAnswers = args.include_answers !== false;
            let outcome;
            try {
                if (source === 'searxng') {
                    const key = await resolveApiKey(host, config.searxngApiKeyEnv);
                    outcome = await searchSearxng(config, key?.value, {
                        query,
                        ...(asStringArray(args.categories) === undefined ? {} : { categories: asStringArray(args.categories) }),
                        ...(asStringArray(args.engines) === undefined ? {} : { engines: asStringArray(args.engines) }),
                        ...(text(args.language) === undefined ? {} : { language: text(args.language) }),
                        ...(asNumber(args.pageno) === undefined ? {} : { page: asNumber(args.pageno) }),
                        ...(args.time_range === undefined ? {} : { timeRange: args.time_range }),
                        ...(asNumber(args.safesearch) === undefined ? {} : { safeSearch: asNumber(args.safesearch) }),
                        limit
                    }, exec.signal);
                }
            }
            catch (error) {
                if (wanted !== 'auto')
                    throw new Error(formatError(error));
                logDebug('SearXNG failed; falling back to Firecrawl search', formatError(error));
                source = 'firecrawl';
            }
            if (source === 'firecrawl') {
                const key = await resolveApiKey(host, config.firecrawlApiKeyEnv);
                outcome = await firecrawlSearch(config, key?.value, { query, limit, ...(asStringArray(args.categories) === undefined ? {} : { categories: asStringArray(args.categories) }) }, exec.signal);
            }
            if (outcome === undefined)
                throw new Error('No search backend produced a result.');
            const limited = limitOutcome(outcome, limit);
            const answer = includeAnswers ? limited.content : undefined;
            const header = `${source === 'searxng' ? 'SearXNG' : 'Firecrawl'} search for "${query}" — ${limited.sources.length} source(s)${limited.truncated ? ' (truncated)' : ''}`;
            const parts = [header];
            if (answer !== undefined)
                parts.push('', answer);
            parts.push('', limited.sources.length === 0 ? 'No results found.' : formatSources(limited.sources));
            parts.push('', 'Cite the source URLs you use.');
            let textOut = parts.join('\n');
            let file;
            const explicit = text(args.output_path);
            if (explicit !== undefined) {
                const cwd = await resolveSessionCwd(host, exec);
                const directory = resolveOutputDir(explicit, config.outputDir, cwd);
                file = await writeTextFile(directory, `${timestampSlug()}-search-${slugForUrl(query)}.md`, textOut);
                textOut = `${textOut}\n\nSaved to: ${file}`;
            }
            return {
                source,
                query,
                ...(answer === undefined ? {} : { content: answer }),
                truncated: limited.truncated,
                sources: limited.sources,
                text: textOut,
                ...(file === undefined ? {} : { file })
            };
        }
    };
}
/* ─────────────────────────── web_scrape ─────────────────────────── */
export const SCRAPE_DESCRIPTION = [
    'Scrape one or more web pages with the configured self-hosted Firecrawl instance.',
    '',
    'One URL uses a single scrape; two or more use Firecrawl\'s batch scrape, so the instance runs them concurrently',
    'and the whole call waits for one job instead of running N scrapes in sequence. This is the fastest path for',
    'reading several pages at once.',
    '',
    'Formats: markdown (default), html, links, screenshot (returns an image URL), summary (needs an LLM on the instance),',
    'and json (structured extraction — pass `extract`, which is Firecrawl v2 only).',
    '',
    'Long pages are written to disk in full and previewed in the result; `save_to` forces saving for every page.'
].join('\n');
export const SCRAPE_PARAMETERS = {
    type: 'object',
    properties: {
        urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs to scrape (http/https). One URL is a single scrape; two or more use batch scrape.'
        },
        formats: {
            type: 'array',
            items: { type: 'string', enum: ['markdown', 'html', 'links', 'screenshot', 'summary', 'json'] },
            description: 'What to return per page. Defaults to the configured formats (usually ["markdown"]). "json" requires `extract`.'
        },
        extract: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'What to extract from each page.' },
                schema: { type: 'object', additionalProperties: true, description: 'JSON Schema for the extracted object.' }
            },
            required: ['prompt'],
            description: 'Structured extraction (Firecrawl v2 only): returns a JSON object per page shaped by `schema`.'
        },
        only_main_content: { type: 'boolean', description: 'Drop navigation, footers and boilerplate (default from the plugin config, usually true).' },
        include_tags: { type: 'array', items: { type: 'string' }, description: 'CSS selectors to keep (e.g. [".article-body"]).' },
        exclude_tags: { type: 'array', items: { type: 'string' }, description: 'CSS selectors to remove (e.g. ["nav","footer"]).' },
        wait_for_ms: { type: 'integer', description: 'Wait this long after load before capturing (milliseconds).' },
        proxy: { type: 'string', enum: ['auto', 'basic', 'stealth', 'enhanced'], description: 'Proxy mode for the fetch (v2 only).' },
        mobile: { type: 'boolean', description: 'Emulate a mobile device (v2 only).' },
        timeout_ms: { type: 'integer', description: 'Per-page scrape timeout handed to Firecrawl (milliseconds).' },
        save_to: { type: 'string', description: 'Directory to write every page into (relative paths resolve against the session working directory).' },
        max_chars: { type: 'integer', description: 'Inline characters per page before the rest is cut (the full body is still saved).' }
    },
    required: ['urls'],
    additionalProperties: false
};
export const SCRAPE_OUTPUT = {
    type: 'object',
    properties: {
        ok: { type: 'boolean' },
        version: { type: 'string' },
        job_id: { type: 'string' },
        timed_out: { type: 'boolean' },
        total: { type: 'integer' },
        pages: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    ok: { type: 'boolean' },
                    statusCode: { type: 'integer' },
                    title: { type: 'string' },
                    markdown: { type: 'string' },
                    html: { type: 'string' },
                    summary: { type: 'string' },
                    links: { type: 'array', items: { type: 'string' } },
                    screenshotUrl: { type: 'string' },
                    savedPath: { type: 'string' },
                    error: { type: 'string' },
                    warning: { type: 'string' }
                },
                required: ['url', 'ok']
            }
        },
        text: { type: 'string' }
    },
    required: ['ok', 'pages', 'text']
};
export function createScrapeTool(pluginConfig, host) {
    return {
        name: SCRAPE_TOOL_NAME,
        description: SCRAPE_DESCRIPTION,
        parameters: SCRAPE_PARAMETERS,
        output: {
            schema: SCRAPE_OUTPUT,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return {
                    kind: 'web-search-scrape',
                    operation: 'scrape',
                    version: result?.version ?? '',
                    jobId: result?.job_id ?? '',
                    pages: Array.isArray(result?.pages) ? result.pages.length : 0,
                    ok: result?.ok === true
                };
            }
        },
        timeoutMs: 300_000,
        async execute(rawArgs, exec) {
            const args = (asRecord(rawArgs) ?? {});
            const config = resolveConfig(pluginConfig);
            const rawUrls = asStringArray(args.urls);
            if (rawUrls === undefined)
                throw new Error('`urls` must contain at least one http(s) URL.');
            if (rawUrls.length > MAX_URLS_HARD_LIMIT) {
                throw new Error(`At most ${MAX_URLS_HARD_LIMIT} URLs are accepted in one call; split the list.`);
            }
            if (rawUrls.length > config.firecrawlMaxUrls) {
                throw new Error(`At most ${config.firecrawlMaxUrls} URLs are accepted per call (firecrawlMaxUrls). Split the list or raise the limit on the plugin page.`);
            }
            const urls = [];
            for (const candidate of rawUrls) {
                const checked = validateTargetUrl(candidate);
                if ('error' in checked)
                    throw new Error(checked.error);
                urls.push(checked.url);
            }
            const formats = asStringArray(args.formats) ?? config.firecrawlFormats;
            const extract = asRecord(args.extract);
            if (formats.includes('json') && extract === undefined) {
                throw new Error('The `json` format needs `extract` with a prompt (and optionally a schema).');
            }
            if (extract !== undefined && extract.prompt === undefined) {
                throw new Error('`extract.prompt` must be a non-empty string.');
            }
            const key = await resolveApiKey(host, config.firecrawlApiKeyEnv);
            const result = await scrapeUrls(config, key?.value, {
                urls,
                formats,
                ...(extract === undefined
                    ? {}
                    : { extract: { prompt: String(extract.prompt), ...(asRecord(extract.schema) === undefined ? {} : { schema: extract.schema }) } }),
                onlyMainContent: asBoolean(args.only_main_content) ?? config.firecrawlOnlyMainContent,
                ...(asStringArray(args.include_tags) === undefined ? {} : { includeTags: asStringArray(args.include_tags) }),
                ...(asStringArray(args.exclude_tags) === undefined ? {} : { excludeTags: asStringArray(args.exclude_tags) }),
                ...(asNumber(args.wait_for_ms) === undefined ? {} : { waitForMs: asNumber(args.wait_for_ms) }),
                ...(args.proxy === undefined ? {} : { proxy: args.proxy }),
                ...(asBoolean(args.mobile) === undefined ? {} : { mobile: asBoolean(args.mobile) }),
                ...(asNumber(args.timeout_ms) === undefined ? {} : { timeoutMs: asNumber(args.timeout_ms) })
            }, exec.signal);
            const cwd = await resolveSessionCwd(host, exec);
            const explicitSave = text(args.save_to);
            const directory = resolveOutputDir(explicitSave, config.outputDir, cwd);
            const maxChars = Math.min(config.maxInlineChars, Math.max(500, asNumber(args.max_chars) ?? config.maxInlineChars));
            for (const page of result.pages) {
                await persistPage(page, config, directory, explicitSave !== undefined, config.writeMetadata);
            }
            const header = result.timedOut === true
                ? `Batch scrape is still running (job ${result.jobId ?? '?'}, ${result.pages.length} page(s) so far). Call again with the same URLs, or raise firecrawlJobTimeoutMs.`
                : `Scraped ${result.pages.length} page(s) via Firecrawl ${result.version}.`;
            const body = result.pages.map((page, index) => renderPage(page, Math.max(500, Math.floor(maxChars / Math.max(1, result.pages.length))), index)).join('\n\n');
            return {
                ok: result.pages.every((page) => page.ok),
                version: result.version,
                ...(result.jobId === undefined ? {} : { job_id: result.jobId }),
                ...(result.timedOut === true ? { timed_out: true } : {}),
                ...(result.total === undefined ? {} : { total: result.total }),
                pages: result.pages,
                text: `${header}\n\n${body}`
            };
        }
    };
}
/* ─────────────────────────── web_map ─────────────────────────── */
export const MAP_DESCRIPTION = [
    'List the URLs of a website through the configured Firecrawl instance.',
    '',
    'Use it before scraping a documentation site or a blog so you scrape the right pages instead of guessing.',
    '`search` narrows the map to URLs matching a phrase. The inline list is bounded; the complete list is written',
    'to the session working directory when it is longer.',
    '',
    'This only discovers URLs — it does not fetch page content. Use web_scrape (or web_crawl) for that.'
].join('\n');
export const MAP_PARAMETERS = {
    type: 'object',
    properties: {
        url: { type: 'string', description: 'Site root or section URL to map.' },
        search: { type: 'string', description: 'Only return URLs relevant to this phrase (server-side filtering).' },
        limit: { type: 'integer', description: 'Maximum URLs to collect (1-1000, default 200).' },
        include_subdomains: { type: 'boolean', description: 'Include subdomains of the target host.' },
        ignore_query_parameters: { type: 'boolean', description: 'Treat URLs differing only by query string as one page.' },
        sitemap: { type: 'string', enum: ['include', 'skip', 'only'], description: 'How to use the site\'s sitemap.' }
    },
    required: ['url'],
    additionalProperties: false
};
export const MAP_OUTPUT = {
    type: 'object',
    properties: {
        url: { type: 'string' },
        total: { type: 'integer' },
        truncated: { type: 'boolean' },
        links: { type: 'array', items: { type: 'string' } },
        file: { type: 'string' },
        text: { type: 'string' }
    },
    required: ['url', 'total', 'truncated', 'links', 'text']
};
export function createMapTool(pluginConfig, host) {
    return {
        name: MAP_TOOL_NAME,
        description: MAP_DESCRIPTION,
        parameters: MAP_PARAMETERS,
        output: {
            schema: MAP_OUTPUT,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => ({
                kind: 'web-search-scrape',
                operation: 'map',
                total: value?.total ?? 0
            })
        },
        timeoutMs: 120_000,
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs) ?? {};
            const config = resolveConfig(pluginConfig);
            const target = text(args.url);
            if (target === undefined)
                throw new Error('`url` must be a non-empty http(s) URL.');
            const checked = validateTargetUrl(target);
            if ('error' in checked)
                throw new Error(checked.error);
            const limit = Math.min(MAX_MAP_LINKS_HARD_LIMIT, Math.max(1, asNumber(args.limit) ?? 200));
            const key = await resolveApiKey(host, config.firecrawlApiKeyEnv);
            const result = await mapSite(config, key?.value, {
                url: checked.url,
                ...(text(args.search) === undefined ? {} : { search: text(args.search) }),
                limit,
                ...(asBoolean(args.include_subdomains) === undefined ? {} : { includeSubdomains: asBoolean(args.include_subdomains) }),
                ...(asBoolean(args.ignore_query_parameters) === undefined ? {} : { ignoreQueryParameters: asBoolean(args.ignore_query_parameters) }),
                ...(args.sitemap === 'include' || args.sitemap === 'skip' || args.sitemap === 'only' ? { sitemap: args.sitemap } : {})
            }, exec.signal);
            const inline = result.links.slice(0, 100);
            let file;
            if (result.links.length > inline.length) {
                const cwd = await resolveSessionCwd(host, exec);
                const directory = resolveOutputDir(undefined, config.outputDir, cwd);
                file = await writeTextFile(directory, `${timestampSlug()}-map-${slugForUrl(checked.url)}.txt`, result.links.join('\n'));
            }
            const lines = [
                `Mapped ${checked.url} — ${result.links.length} URL(s) via Firecrawl ${result.version}${result.truncated ? ' (capped)' : ''}`,
                '',
                ...inline.map((link, index) => `${index + 1}. ${link}`)
            ];
            if (result.links.length > inline.length)
                lines.push('', `… ${result.links.length - inline.length} more${file === undefined ? '' : ` in ${file}`}`);
            else if (file !== undefined)
                lines.push('', `Full list: ${file}`);
            return {
                url: checked.url,
                total: result.links.length,
                truncated: result.truncated,
                links: inline,
                ...(file === undefined ? {} : { file }),
                text: lines.join('\n')
            };
        }
    };
}
/* ─────────────────────────── web_crawl ─────────────────────────── */
export const CRAWL_DESCRIPTION = [
    'Crawl a website with the configured Firecrawl instance: discover pages under a URL, scrape each one, and return them.',
    '',
    'A crawl is a job. This tool starts it and polls until it settles or the job timeout passes; when it times out you get',
    'the live `job_id`, and calling the tool again with that `job_id` resumes polling without starting a second crawl.',
    'Use `limit` to bound spend — a crawl without a limit can walk a whole site.',
    '',
    'Prefer web_map + web_scrape when you already know which pages you need: a crawl costs one scrape per page.'
].join('\n');
export const CRAWL_PARAMETERS = {
    type: 'object',
    properties: {
        url: { type: 'string', description: 'Crawl start URL.' },
        limit: { type: 'integer', description: 'Maximum pages to crawl (default 10, hard cap 500). Always set one.' },
        max_depth: { type: 'integer', description: 'Maximum link depth from the start URL.' },
        include_paths: { type: 'array', items: { type: 'string' }, description: 'Only crawl paths matching these patterns (e.g. ["/docs/.*"]).' },
        exclude_paths: { type: 'array', items: { type: 'string' }, description: 'Skip paths matching these patterns.' },
        allow_external_links: { type: 'boolean', description: 'Follow links to other domains.' },
        allow_subdomains: { type: 'boolean', description: 'Follow links into subdomains.' },
        sitemap: { type: 'string', enum: ['include', 'skip', 'only'], description: 'How to use the site\'s sitemap.' },
        ignore_query_parameters: { type: 'boolean', description: 'Treat URLs differing only by query string as one page.' },
        formats: { type: 'array', items: { type: 'string' }, description: 'Formats captured per page (default markdown).' },
        only_main_content: { type: 'boolean', description: 'Drop boilerplate from each page.' },
        delay_ms: { type: 'integer', description: 'Delay between requests, in milliseconds.' },
        max_concurrency: { type: 'integer', description: 'Maximum concurrent page fetches on the instance.' },
        timeout_ms: { type: 'integer', description: 'How long to wait for the crawl before returning its job id (milliseconds).' },
        save_to: { type: 'string', description: 'Directory to write every page into (default: session working directory when a page is long).' },
        max_chars: { type: 'integer', description: 'Inline characters per page before the rest is cut.' },
        job_id: { type: 'string', description: 'Resume polling an existing crawl instead of starting a new one.' }
    },
    required: [],
    additionalProperties: false
};
export const CRAWL_OUTPUT = {
    type: 'object',
    properties: {
        url: { type: 'string' },
        job_id: { type: 'string' },
        status: { type: 'string' },
        completed: { type: 'integer' },
        total: { type: 'integer' },
        timed_out: { type: 'boolean' },
        pages: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                    savedPath: { type: 'string' },
                    error: { type: 'string' }
                },
                required: ['url']
            }
        },
        text: { type: 'string' }
    },
    required: ['status', 'pages', 'text']
};
function coercePage(entry) {
    const metadata = asRecord(entry.metadata) ?? {};
    const url = text(metadata.sourceURL) ?? text(metadata.url) ?? text(entry.url) ?? '';
    const title = text(metadata.title) ?? text(entry.title);
    const markdown = text(entry.markdown) ?? text(entry.content);
    const statusCode = typeof metadata.statusCode === 'number' ? metadata.statusCode : undefined;
    return {
        url,
        ...(title === undefined ? {} : { title }),
        ...(markdown === undefined ? {} : { markdown }),
        ...(statusCode === undefined ? {} : { statusCode })
    };
}
export function createCrawlTool(pluginConfig, host) {
    return {
        name: CRAWL_TOOL_NAME,
        description: CRAWL_DESCRIPTION,
        parameters: CRAWL_PARAMETERS,
        output: {
            schema: CRAWL_OUTPUT,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => ({
                kind: 'web-search-scrape',
                operation: 'crawl',
                jobId: value?.job_id ?? '',
                status: value?.status ?? ''
            })
        },
        timeoutMs: 600_000,
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs) ?? {};
            const config = resolveConfig(pluginConfig);
            const key = await resolveApiKey(host, config.firecrawlApiKeyEnv);
            const timeoutMs = Math.min(config.firecrawlJobTimeoutMs, Math.max(5_000, asNumber(args.timeout_ms) ?? config.firecrawlJobTimeoutMs));
            const resumeId = text(args.job_id);
            let jobId;
            let version = config.firecrawlApiVersion === 'v1' ? 'v1' : 'v2';
            let startUrl = text(args.url) ?? '';
            if (resumeId !== undefined) {
                jobId = resumeId;
            }
            else {
                if (startUrl === '')
                    throw new Error('`url` is required unless you pass an existing `job_id`.');
                const checked = validateTargetUrl(startUrl);
                if ('error' in checked)
                    throw new Error(checked.error);
                startUrl = checked.url;
                const options = {
                    url: startUrl,
                    limit: Math.min(500, Math.max(1, asNumber(args.limit) ?? 10)),
                    onlyMainContent: asBoolean(args.only_main_content) ?? config.firecrawlOnlyMainContent,
                    ...(asNumber(args.max_depth) === undefined ? {} : { maxDepth: asNumber(args.max_depth) }),
                    ...(asStringArray(args.include_paths) === undefined ? {} : { includePaths: asStringArray(args.include_paths) }),
                    ...(asStringArray(args.exclude_paths) === undefined ? {} : { excludePaths: asStringArray(args.exclude_paths) }),
                    ...(asBoolean(args.allow_external_links) === undefined ? {} : { allowExternalLinks: asBoolean(args.allow_external_links) }),
                    ...(asBoolean(args.allow_subdomains) === undefined ? {} : { allowSubdomains: asBoolean(args.allow_subdomains) }),
                    ...(args.sitemap === 'include' || args.sitemap === 'skip' || args.sitemap === 'only' ? { sitemap: args.sitemap } : {}),
                    ...(asBoolean(args.ignore_query_parameters) === undefined ? {} : { ignoreQueryParameters: asBoolean(args.ignore_query_parameters) }),
                    ...(asNumber(args.delay_ms) === undefined ? {} : { delayMs: asNumber(args.delay_ms) }),
                    ...(asNumber(args.max_concurrency) === undefined ? {} : { maxConcurrency: asNumber(args.max_concurrency) }),
                    ...(asStringArray(args.formats) === undefined ? {} : { formats: asStringArray(args.formats) })
                };
                const started = await startCrawl(config, key?.value, options, exec.signal);
                jobId = started.jobId;
                version = started.version;
            }
            const waited = await pollCrawl(config, key?.value, jobId, { timeoutMs, ...(exec.signal === undefined ? {} : { signal: exec.signal }) });
            version = waited.version;
            const pages = waited.snapshot.pages.map((entry) => coercePage(entry));
            const cwd = await resolveSessionCwd(host, exec);
            const explicitSave = text(args.save_to);
            const directory = resolveOutputDir(explicitSave, config.outputDir, cwd);
            const maxChars = Math.min(config.maxInlineChars, Math.max(500, asNumber(args.max_chars) ?? 4_000));
            const saveDirectory = explicitSave === undefined ? undefined : `${directory}`;
            const rendered = [];
            const bodies = [];
            for (const page of pages) {
                const record = { url: page.url };
                if (page.title !== undefined)
                    record.title = page.title;
                if (page.markdown !== undefined) {
                    if (saveDirectory !== undefined || page.markdown.length > maxChars) {
                        const stem = slugForUrl(page.url);
                        record.savedPath = await writeTextFile(saveDirectory ?? `${directory}/crawl-${jobId}`, `${stem}.md`, page.markdown);
                    }
                    bodies.push(`### ${page.title === undefined ? page.url : `${page.title} — ${page.url}`}\n\n${previewText(page.markdown, maxChars).text}`);
                }
                else {
                    record.error = 'no content returned for this page';
                    bodies.push(`### ${page.url}\n\nNo content returned for this page.`);
                }
                rendered.push(record);
            }
            const status = waited.done ? 'completed' : 'running';
            const counter = `${waited.snapshot.completed ?? rendered.length}/${waited.snapshot.total ?? rendered.length}`;
            const header = waited.done
                ? `Crawl finished — ${rendered.length} page(s) via Firecrawl ${version}.`
                : `Crawl still running after ${timeoutMs}ms (${counter}). Call web_crawl again with job_id "${jobId}" to keep waiting.`;
            return {
                ...(startUrl === '' ? {} : { url: startUrl }),
                job_id: jobId,
                status,
                ...(waited.snapshot.completed === undefined ? {} : { completed: waited.snapshot.completed }),
                ...(waited.snapshot.total === undefined ? {} : { total: waited.snapshot.total }),
                ...(waited.done ? {} : { timed_out: true }),
                pages: rendered,
                text: `${header}\n\n${bodies.join('\n\n')}`.trim()
            };
        }
    };
}
/* ─────────────────────────── web_status ─────────────────────────── */
export const STATUS_DESCRIPTION = [
    'Report what the configured SearXNG and Firecrawl instances actually expose.',
    '',
    'Use it before relying on a feature: it lists the SearXNG version, categories and engines, and probes Firecrawl\'s v1 and',
    'v2 endpoints and response formats (a self-hosted instance without an LLM cannot produce `summary`; structured',
    '`json` extraction needs v2). It also says whether an API key is configured — never the key.',
    '',
    'Results are cached for ten minutes; pass `refresh: true` to re-probe now.'
].join('\n');
export const STATUS_PARAMETERS = {
    type: 'object',
    properties: {
        include: { type: 'string', enum: ['all', 'searxng', 'firecrawl'], description: 'Which service to report (default all).' },
        refresh: { type: 'boolean', description: 'Ignore the capability cache and probe both services now.' },
        probe_formats: { type: 'boolean', description: 'Also fetch a test page to prove which scrape formats work (default true; set false to skip those requests).' }
    },
    required: [],
    additionalProperties: false
};
export const STATUS_OUTPUT = {
    type: 'object',
    properties: {
        searxng: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                reachable: { type: 'boolean' },
                version: { type: 'string' },
                instanceName: { type: 'string' },
                categories: { type: 'array', items: { type: 'string' } },
                engines: { type: 'array', items: { type: 'string' } },
                keyConfigured: { type: 'boolean' },
                error: { type: 'string' }
            }
        },
        firecrawl: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                reachable: { type: 'boolean' },
                preferred: { type: 'string' },
                v1: { type: 'string' },
                v2: { type: 'string' },
                formats: { type: 'array', items: { type: 'string' } },
                deprecations: { type: 'array', items: { type: 'string' } },
                keyConfigured: { type: 'boolean' },
                error: { type: 'string' }
            }
        },
        problems: { type: 'array', items: { type: 'string' } },
        text: { type: 'string' }
    },
    required: ['text']
};
export function createStatusTool(pluginConfig, host) {
    return {
        name: STATUS_TOOL_NAME,
        description: STATUS_DESCRIPTION,
        parameters: STATUS_PARAMETERS,
        output: {
            schema: STATUS_OUTPUT,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => ({
                kind: 'web-search-scrape',
                operation: 'status'
            })
        },
        timeoutMs: 120_000,
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs) ?? {};
            const config = resolveConfig(pluginConfig);
            const include = args.include === 'searxng' || args.include === 'firecrawl' ? args.include : 'all';
            const probeFormats = args.probe_formats !== false;
            const lines = [];
            let searxng;
            if (include !== 'firecrawl') {
                const key = await resolveApiKey(host, config.searxngApiKeyEnv);
                const info = await searxngInstanceInfo(config, key?.value, exec.signal);
                searxng = {
                    url: info.url,
                    reachable: info.reachable,
                    ...(info.version === undefined ? {} : { version: info.version }),
                    ...(info.instanceName === undefined ? {} : { instanceName: info.instanceName }),
                    categories: info.categories,
                    engines: info.engines.map((engine) => engine.name),
                    keyConfigured: key !== undefined,
                    ...(info.error === undefined ? {} : { error: info.error })
                };
                lines.push('## SearXNG');
                if (!info.reachable) {
                    lines.push(`Endpoint: ${info.url || '(not configured)'}`);
                    lines.push(`Unreachable: ${info.error ?? 'no response'}`);
                }
                else {
                    lines.push(`Endpoint: ${info.url}`);
                    lines.push(`Version: ${info.version ?? 'unknown'}${info.instanceName === undefined ? '' : ` · ${info.instanceName}`}`);
                    lines.push(`API key: ${key === undefined ? 'not configured (fine for an open instance)' : `configured (${key.source})`}`);
                    lines.push(`Categories: ${info.categories.length === 0 ? '(none reported)' : info.categories.join(', ')}`);
                    lines.push(`Engines: ${info.engines.length === 0 ? '(none reported)' : info.engines.map((engine) => engine.name).join(', ')}`);
                }
                lines.push('');
            }
            let firecrawl;
            if (include !== 'searxng') {
                const key = await resolveApiKey(host, config.firecrawlApiKeyEnv);
                const caps = await probeCapabilities(config, key?.value, {
                    force: args.refresh === true,
                    probeFormats,
                    ...(exec.signal === undefined ? {} : { signal: exec.signal })
                });
                const working = Object.entries(caps.formats)
                    .filter(([name, supported]) => name !== 'notes' && supported === true)
                    .map(([name]) => name);
                firecrawl = {
                    url: caps.url,
                    reachable: caps.reachable,
                    preferred: caps.preferred,
                    v1: summarizeEndpoints(caps.versions.v1),
                    v2: summarizeEndpoints(caps.versions.v2),
                    formats: working,
                    deprecations: caps.deprecations,
                    keyConfigured: key !== undefined,
                    ...(caps.error === undefined ? {} : { error: caps.error })
                };
                lines.push('## Firecrawl');
                if (!caps.reachable) {
                    lines.push(`Endpoint: ${caps.url || '(not configured)'}`);
                    lines.push(`Unreachable: ${caps.error ?? 'no known API route answered'}`);
                }
                else {
                    lines.push(`Endpoint: ${caps.url}`);
                    lines.push(`API key: ${key === undefined ? 'not configured' : `configured (${key.source})`}`);
                    lines.push(`Preferred version: ${caps.preferred}`);
                    lines.push(`v2: ${summarizeEndpoints(caps.versions.v2)}`);
                    lines.push(`v1: ${summarizeEndpoints(caps.versions.v1)}`);
                    lines.push(`Formats: ${working.length === 0 ? '(not probed)' : working.join(', ')}`);
                    if (caps.deprecations.length > 0)
                        lines.push(`Notes: ${caps.deprecations.join(' ')}`);
                }
            }
            if (config.problems.length > 0) {
                lines.push('');
                lines.push('## Configuration warnings');
                for (const problem of config.problems)
                    lines.push(`- ${problem}`);
            }
            return {
                ...(searxng === undefined ? {} : { searxng }),
                ...(firecrawl === undefined ? {} : { firecrawl }),
                problems: config.problems,
                text: lines.join('\n')
            };
        }
    };
}
/* ─────────────────────────── registration ─────────────────────────── */
/** Register every tool against a registry; returns the number registered. */
export function registerTools(registry, pluginConfig, host) {
    registry.register(createSearchTool(pluginConfig, host));
    registry.register(createScrapeTool(pluginConfig, host));
    registry.register(createMapTool(pluginConfig, host));
    registry.register(createCrawlTool(pluginConfig, host));
    registry.register(createStatusTool(pluginConfig, host));
    return TOOL_NAMES.length;
}
