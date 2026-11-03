/**
 * `WebSearchProvider` backed by SearXNG, registered into `ctx.web`.
 *
 * One search is a plain retrieval call against `{base}/search?format=json`, so
 * unlike a model-backed provider it costs no generation tokens. The provider
 * reads its options through a thunk, so a configuration edit reaches the NEXT
 * search without re-registering (registration is stable, only the values move).
 */
import { resolveApiKey } from './credentials.js'
import { seamError } from './errors.js'
import { limitOutcome, searchSearxng } from './searxng.js'
import { SEARCH_PROVIDER_ID } from './identity.js'
import type { HostContextLike, ResolvedConfig, WebSearchOutcome } from './types.js'

export interface SearchProviderOptions {
  config: ResolvedConfig
  host?: HostContextLike
}

interface SearchRequest {
  query: string
  maxResults?: number
}

/** Cheap synchronous usability check: is there a parseable http(s) endpoint? */
export function hasUsableEndpoint(url: string | undefined): boolean {
  if (url === undefined || url.trim() === '') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export class SearxngSearchProvider {
  readonly id = SEARCH_PROVIDER_ID
  private readonly options: () => SearchProviderOptions

  constructor(options: () => SearchProviderOptions) {
    this.options = options
  }

  available(): boolean {
    return hasUsableEndpoint(this.options().config.searxngUrl)
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<WebSearchOutcome> {
    const { config, host } = this.options()
    if (config.searxngUrl === undefined) {
      throw await seamError(
        'SearXNG search is not configured. Set the instance URL at DSH → Plugins → Web Search & Scrape, or export SEARXNG_URL.',
        'WEB_PROVIDER_UNAVAILABLE'
      )
    }

    const key = await resolveApiKey(host, config.searxngApiKeyEnv)
    try {
      const outcome = await searchSearxng(config, key?.value, { query: request.query }, signal)
      // The seam enforces `maxResults` itself; trimming here only avoids sending
      // an over-long source list across the wire twice.
      return limitOutcome(outcome, request.maxResults)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (signal?.aborted === true) {
        throw await seamError(`SearXNG search aborted: ${message}`, 'WEB_ABORTED', error)
      }
      throw await seamError(
        `${message}\n\nThis came from the SearXNG search provider. Check the instance URL and that the instance serves JSON (add "json" to search.formats in its settings.yml).`,
        'WEB_PROVIDER_ERROR',
        error
      )
    }
  }
}
