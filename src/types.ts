/**
 * Shared types. Structural on purpose: this plugin imports no `@deepseek-ai/*`
 * host package at runtime, so every seam it touches is described by shape.
 */

/** The subset of a Cordis host context this plugin uses. */
export interface HostContextLike {
  reflect?: { get?: (key: string, strict?: boolean) => unknown }
  get?: (key: string) => unknown
  inject?: (services: string[], callback: (context: HostContextLike) => unknown) => unknown
  effect?: (callback: () => unknown, label?: string) => unknown
  fiber?: unknown
  settings?: { configure?: (options: { auto: boolean }, fiber: unknown) => void }
  web?: WebSeamLike
  credentials?: CredentialServiceLike
  webServer?: WebServerLike
  connection?: ConnectionLike
}

/** The `ctx.web` registry surface. */
export interface WebSeamLike {
  registerSearchProvider?: (provider: unknown) => unknown
  registerFetchProvider?: (provider: unknown) => unknown
}

/** The credential seam. */
export interface CredentialServiceLike {
  resolve?: (ref: string) => Promise<{ value?: unknown; source?: unknown } | undefined>
  describe?: (ref: string) => Promise<{ configured?: boolean; source?: unknown } | undefined>
}

/** The browser HTTP carrier seam. */
export interface WebServerLike {
  register?: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: HttpRequestLike, response: HttpResponseLike) => unknown
  }) => () => void
}

/** The connection seam, used to authenticate the probe route. */
export interface ConnectionLike {
  requestRejection?: (request: HttpRequestLike) => number | undefined
}

export interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>
}

export interface HttpResponseLike {
  statusCode: number
  setHeader: (name: string, value: string) => unknown
  end: (body?: string | Buffer) => unknown
}

/** The execution surface a tool receives. */
export interface ToolExecLike {
  signal?: AbortSignal
  agent?: unknown
  [key: string]: unknown
}

/** The tool registry surface. */
export interface ToolRegistryLike {
  register: (definition: unknown) => unknown
}

/** Resolved, validated configuration for one operation. */
export interface ResolvedConfig {
  searxngUrl: string | undefined
  searxngApiKeyEnv: string
  searxngAuthHeader: string
  searxngAuthPrefix: string
  searxngCategories: string[]
  searxngEngines: string[]
  searxngLanguage: string | undefined
  searxngSafeSearch: 0 | 1 | 2 | undefined
  searxngTimeRange: 'day' | 'week' | 'month' | 'year' | undefined
  searxngTimeoutMs: number
  searxngMaxSnippetChars: number

  firecrawlUrl: string | undefined
  firecrawlApiKeyEnv: string
  firecrawlApiVersion: 'auto' | 'v1' | 'v2'
  firecrawlFormats: string[]
  firecrawlOnlyMainContent: boolean
  firecrawlProxy: 'auto' | 'basic' | 'stealth' | 'enhanced' | undefined
  firecrawlTimeoutMs: number
  firecrawlJobTimeoutMs: number
  firecrawlPollIntervalMs: number
  firecrawlMaxUrls: number
  firecrawlRetries: number

  outputDir: string | undefined
  maxInlineChars: number
  writeMetadata: boolean

  /** Human-readable notes about rejected values; never fatal. */
  problems: string[]
}

/** One normalised search source. */
export interface WebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** The harness's normalised search result. */
export interface WebSearchOutcome {
  content?: string
  sources: WebSource[]
  truncated: boolean
}

/** The harness's normalised fetch result. */
export interface WebFetchOutcome {
  url: string
  statusCode: number
  body: { kind: 'html' | 'text'; content: string }
  truncated: boolean
}

/** Per-version endpoint availability reported by the probe. */
export interface FirecrawlVersionCapabilities {
  /** True when the API root answered at all. */
  reachable: boolean
  /** Endpoint name → present/absent/unavailable interpretation. */
  endpoints: Record<string, EndpointState>
  /** Error text when the version could not be probed. */
  error?: string
}

export type EndpointState = 'present' | 'absent' | 'unauthorized' | 'error'

/** Format support observed on a real page fetch. */
export interface FormatSupport {
  markdown?: boolean
  html?: boolean
  links?: boolean
  summary?: boolean
  json?: boolean
  screenshot?: boolean
  /** Server-provided reason when a format failed. */
  notes?: Record<string, string>
}

/** The full capability picture for one Firecrawl instance. */
export interface FirecrawlCapabilities {
  url: string
  reachable: boolean
  versions: { v1?: FirecrawlVersionCapabilities; v2?: FirecrawlVersionCapabilities }
  /** The version requests will actually use. */
  preferred: 'v1' | 'v2'
  formats: FormatSupport
  deprecations: string[]
  /** True when a key was available while probing (never the key itself). */
  authorized: boolean
  probedAt: number
  error?: string
}

/** SearXNG instance facts from `/config`. */
export interface SearxngInstanceInfo {
  url: string
  reachable: boolean
  version?: string
  instanceName?: string
  defaultLocale?: string
  safeSearch?: number
  categories: string[]
  engines: Array<{ name: string; categories: string[]; enabled: boolean }>
  locales: string[]
  error?: string
}

/** One scraped page. */
export interface ScrapePageResult {
  url: string
  ok: boolean
  statusCode?: number
  title?: string
  markdown?: string
  html?: string
  links?: string[]
  summary?: string
  json?: unknown
  screenshotUrl?: string
  metadata?: Record<string, unknown>
  savedPath?: string
  truncated?: boolean
  error?: string
}

/** One crawl page. */
export interface CrawlPageResult {
  url: string
  statusCode?: number
  title?: string
  markdown?: string
  savedPath?: string
  error?: string
}
