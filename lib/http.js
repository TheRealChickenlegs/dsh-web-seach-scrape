/**
 * Small, deliberately conservative HTTP layer.
 *
 * Safety properties:
 * - API calls never follow redirects (`redirect: 'error'`), so an Authorization
 *   header cannot be bounced to another host.
 * - Every response body is read with a hard byte cap.
 * - A timeout is a resource backstop; the caller's abort signal is always honoured
 *   and reported as an abort rather than a timeout.
 * - Error messages carry the server's own message (truncated) but never request
 *   headers or the key.
 */
import { PluginError, formatError, isAbortError } from './errors.js';
import { logDebug } from './log.js';
/** JSON responses above this size are treated as a broken/misbehaving endpoint. */
export const DEFAULT_JSON_LIMIT = 32 * 1024 * 1024;
/** How much of a non-JSON error body is quoted back to a caller. */
const ERROR_BODY_MAX_CHARS = 400;
/** Combine an optional caller signal with a deadline. */
export function withTimeout(signal, ms) {
    const controller = new AbortController();
    let fired = false;
    const onAbort = () => {
        controller.abort(signal?.reason);
    };
    if (signal !== undefined) {
        if (signal.aborted)
            controller.abort(signal.reason);
        else
            signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        fired = true;
        controller.abort(new Error('timeout'));
    }, ms);
    if (typeof timer.unref === 'function')
        timer.unref();
    return {
        signal: controller.signal,
        timedOut: () => fired,
        clear: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    };
}
/** Join an API root and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
/** Sleep that settles early when the caller aborts. */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new PluginError('Operation aborted', 'WEB_ABORTED', { cause: signal.reason }));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        // NOT unref'd: this timer is awaited foreground work (a job poll). Unref'd, a
        // short-lived process would drain the event loop and exit mid-wait.
        const onAbort = () => {
            clearTimeout(timer);
            reject(new PluginError('Operation aborted', 'WEB_ABORTED', { cause: signal?.reason }));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** Build the `Authorization` (or configured) header for a service. */
export function authHeaders(key, headerName, prefix) {
    if (key === undefined || key === '' || headerName === '')
        return {};
    const value = prefix === '' ? key : `${prefix}${key}`;
    return { [headerName]: value };
}
/** Read a response body with a hard byte cap, honouring the response stream. */
async function readBounded(response, maxBytes) {
    if (response.body === null)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value === undefined)
                continue;
            total += value.byteLength;
            if (total > maxBytes) {
                chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))));
                throw new PluginError(`Response body exceeded ${maxBytes} bytes`, 'WEB_TOO_LARGE');
            }
            chunks.push(value);
        }
    }
    finally {
        try {
            await reader.cancel();
        }
        catch {
            /* a cancelled stream may already be closed */
        }
    }
    const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
}
/** Quote the server's own reason from an error body, bounded and single-line. */
export function errorBodyText(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
            const record = parsed;
            const candidates = [record.error, record.message, record.detail];
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.trim() !== '') {
                    return candidate.trim().slice(0, ERROR_BODY_MAX_CHARS);
                }
            }
        }
    }
    catch {
        /* not JSON; fall through to the raw text */
    }
    return trimmed.replace(/\s+/g, ' ').slice(0, ERROR_BODY_MAX_CHARS);
}
function retryAfterMs(response) {
    const raw = response.headers.get('retry-after');
    if (raw === null)
        return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0)
        return undefined;
    // Only honour a short hint; a long one is the caller's business, not a reason to hang.
    return seconds > 10 ? undefined : Math.round(seconds * 1000);
}
/**
 * One JSON request with bounded retries on 429 and network failures.
 *
 * A non-2xx response is returned, not thrown: the caller decides which statuses
 * are meaningful (Firecrawl's `404` means "this API version has no such
 * endpoint", which is a capability answer, not a failure).
 */
export async function requestJson(url, options) {
    const method = options.method ?? 'GET';
    const maxBytes = options.maxBytes ?? DEFAULT_JSON_LIMIT;
    const retries = options.retries ?? 0;
    const retryStatuses = new Set([429, ...(options.retryStatuses ?? [])]);
    const retryBaseMs = options.retryBaseMs ?? 250;
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    let bodyText;
    if (options.body !== undefined) {
        bodyText = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
    }
    for (let attempt = 0;; attempt += 1) {
        const timeout = withTimeout(options.signal, options.timeoutMs);
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: bodyText,
                redirect: 'error',
                signal: timeout.signal
            });
        }
        catch (error) {
            timeout.clear();
            if (options.signal?.aborted === true || isAbortError(error)) {
                throw new PluginError(`${method} ${url} aborted`, 'WEB_ABORTED', { cause: options.signal?.reason });
            }
            if (timeout.timedOut()) {
                throw new PluginError(`${method} ${url} timed out after ${options.timeoutMs}ms`, 'WEB_PROVIDER_ERROR');
            }
            if (attempt < retries) {
                await sleep(retryBaseMs * 2 ** attempt, options.signal);
                continue;
            }
            throw new PluginError(`${method} ${url} failed: ${formatError(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
        try {
            const text = await readBounded(response, maxBytes);
            const contentType = response.headers.get('content-type') ?? '';
            let json;
            if (text.trim() !== '') {
                try {
                    json = JSON.parse(text);
                }
                catch {
                    json = undefined;
                }
            }
            const result = {
                status: response.status,
                ok: response.ok,
                url,
                contentType,
                json,
                text
            };
            if (!response.ok && retryStatuses.has(response.status) && attempt < retries) {
                const hinted = retryAfterMs(response);
                logDebug('Retrying a rate-limited request', { url, status: response.status, attempt });
                await sleep(hinted ?? retryBaseMs * 2 ** attempt, options.signal);
                continue;
            }
            return result;
        }
        finally {
            timeout.clear();
        }
    }
}
