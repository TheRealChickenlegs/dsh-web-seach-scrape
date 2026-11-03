/**
 * `WebFetchProvider` backed by Firecrawl, registered into `ctx.web`.
 *
 * `web_fetch` asks for one URL, so this uses Firecrawl's single-page scrape and
 * returns its markdown as a `text` body. A non-2xx page status is still a
 * successful retrieval: the seam's contract treats the status as part of the
 * resource, not as a provider failure.
 */
import { resolveApiKey } from './credentials.js';
import { seamError } from './errors.js';
import { hasUsableEndpoint } from './provider-search.js';
import { scrapeUrls } from './firecrawl/scrape.js';
import { FETCH_PROVIDER_ID } from './identity.js';
export class FirecrawlFetchProvider {
    id = FETCH_PROVIDER_ID;
    options;
    constructor(options) {
        this.options = options;
    }
    available() {
        return hasUsableEndpoint(this.options().config.firecrawlUrl);
    }
    async fetch(request, signal) {
        const { config, host } = this.options();
        if (config.firecrawlUrl === undefined) {
            throw await seamError('Firecrawl is not configured. Set the instance URL at DSH → Plugins → Web Search & Scrape, or export FIRECRAWL_URL.', 'WEB_PROVIDER_UNAVAILABLE');
        }
        const key = await resolveApiKey(host, config.firecrawlApiKeyEnv);
        try {
            const result = await scrapeUrls(config, key?.value, {
                urls: [request.url],
                formats: ['markdown'],
                onlyMainContent: config.firecrawlOnlyMainContent
            }, signal);
            const page = result.pages[0];
            if (page === undefined)
                throw new Error('Firecrawl returned no page.');
            if (!page.ok)
                throw new Error(page.error ?? 'Firecrawl could not scrape this URL.');
            const content = page.markdown ?? page.html ?? page.summary ?? '';
            if (content === '') {
                throw new Error('Firecrawl scraped the page but returned no readable content. ' +
                    'The page may need JavaScript rendering time, or it may be a binary resource.');
            }
            return {
                url: page.url || request.url,
                statusCode: page.statusCode ?? 200,
                body: { kind: 'text', content },
                truncated: false
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (signal?.aborted === true) {
                throw await seamError(`Firecrawl fetch aborted: ${message}`, 'WEB_ABORTED', error);
            }
            throw await seamError(`${message}\n\nThis came from the Firecrawl fetch provider. Check the Firecrawl URL and API key on the plugin page, and that the instance is running.`, 'WEB_PROVIDER_ERROR', error);
        }
    }
}
