/**
 * Minimal logging. Every line is prefixed with the plugin id; verbose detail
 * requires `DSH_WEB_SEARCH_SCRAPE_DEBUG=1`.
 *
 * Logging rules for this plugin:
 * - never pass an API key, an auth header, or a response body to a log;
 * - request-level detail is names, URLs (without query strings), statuses and timings only.
 */
import { ENV_DEBUG, PLUGIN_ID } from './identity.js';
const PREFIX = `[${PLUGIN_ID}]`;
function debugEnabled() {
    const raw = process.env[ENV_DEBUG];
    return raw === '1' || raw === 'true' || raw === 'yes';
}
/** Lifecycle information (plugin mounted, providers and tools registered) — always printed. */
export function logInfo(message) {
    console.log(`${PREFIX} ${message}`);
}
/** "Works, but you should know" situations — always printed. */
export function logWarn(message) {
    console.warn(`${PREFIX} ${message}`);
}
/** Request-level detail, only with the debug switch on. */
export function logDebug(message, detail) {
    if (!debugEnabled())
        return;
    if (detail === undefined) {
        console.log(`${PREFIX} ${message}`);
        return;
    }
    let rendered;
    try {
        rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
    catch {
        rendered = String(detail);
    }
    console.log(`${PREFIX} ${message} ${rendered}`);
}
