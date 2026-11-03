/**
 * Editable Cordis config schema for the plugin page.
 *
 * Every field is optional and volatile:
 * - optional, so an unset field falls through to the config file, environment and defaults;
 * - volatile, so the Settings form can write it into the active profile and DSH can update
 *   the running plugin without a remount.
 *
 * No defaults live here on purpose: a schema default would become a plugin-config value and
 * silently override the lower-priority config file and environment layers.
 *
 * SECURITY: there is no API-key field. `searxngApiKeyEnv` / `firecrawlApiKeyEnv` are the
 * *names* of credentials (also usable as environment variable names); values live in the DSH
 * credentials store and never in the profile.
 */
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  // ── Search: SearXNG ────────────────────────────────────────────────────────
  searxngUrl: Schema.string().volatile(),
  searxngApiKeyEnv: Schema.string().volatile(),
  searxngAuthHeader: Schema.string().volatile(),
  searxngAuthPrefix: Schema.string().volatile(),
  searxngCategories: Schema.array(Schema.string()).volatile(),
  searxngEngines: Schema.array(Schema.string()).volatile(),
  searxngLanguage: Schema.string().volatile(),
  searxngSafeSearch: Schema.number().volatile(),
  searxngTimeRange: Schema.string().volatile(),
  searxngTimeoutMs: Schema.number().volatile(),
  searxngMaxSnippetChars: Schema.number().volatile(),

  // ── Scrape: Firecrawl ──────────────────────────────────────────────────────
  firecrawlUrl: Schema.string().volatile(),
  firecrawlApiKeyEnv: Schema.string().volatile(),
  firecrawlApiVersion: Schema.string().volatile(),
  firecrawlFormats: Schema.array(Schema.string()).volatile(),
  firecrawlOnlyMainContent: Schema.boolean().volatile(),
  firecrawlProxy: Schema.string().volatile(),
  firecrawlTimeoutMs: Schema.number().volatile(),
  firecrawlJobTimeoutMs: Schema.number().volatile(),
  firecrawlPollIntervalMs: Schema.number().volatile(),
  firecrawlMaxUrls: Schema.number().volatile(),
  firecrawlRetries: Schema.number().volatile(),

  // ── Output ─────────────────────────────────────────────────────────────────
  outputDir: Schema.string().volatile(),
  maxInlineChars: Schema.number().volatile(),
  writeMetadata: Schema.boolean().volatile()
})
