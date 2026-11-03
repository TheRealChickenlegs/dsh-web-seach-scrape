/**
 * Error vocabulary.
 *
 * Provider-visible failures carry a stable `code` so a caller (or the seam) can
 * route on it. The harness's own `WebError` lives in `@deepseek-ai/dsh-web`,
 * which a link-installed plugin cannot resolve — so it is loaded lazily and a
 * structurally equivalent local error is used when it is absent. Nothing here
 * ever includes a key, an auth header, or a full response body.
 */

/** Machine-routable error codes this plugin emits. */
export type PluginErrorCode =
  | 'WEB_PROVIDER_ERROR'
  | 'WEB_PROVIDER_UNAVAILABLE'
  | 'WEB_ABORTED'
  | 'WEB_BAD_REQUEST'
  | 'WEB_NOT_CONFIGURED'
  | 'WEB_JOB_FAILED'
  | 'WEB_JOB_TIMEOUT'
  | 'WEB_UNSUPPORTED'
  | 'WEB_TOO_LARGE'

/** A coded error. `name` stays `Error` inside the harness; consumers read `code`. */
export class PluginError extends Error {
  readonly code: PluginErrorCode

  constructor(message: string, code: PluginErrorCode = 'WEB_PROVIDER_ERROR', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

interface WebErrorConstructor {
  new (message: string, code: string, options?: { cause?: unknown }): Error
}

let ctorPromise: Promise<WebErrorConstructor | undefined> | undefined

/**
 * Resolve the harness's WebError once. A missing package is expected under a
 * link install, so the failure is cached rather than retried per call.
 */
function loadWebError(): Promise<WebErrorConstructor | undefined> {
  if (ctorPromise === undefined) {
    // The specifier is held in a variable so TypeScript does not try to resolve
    // a host package that is not a dependency of this one.
    const specifier = '@deepseek-ai/dsh-web'
    ctorPromise = import(specifier)
      .then((module: { WebError?: unknown }) =>
        typeof module.WebError === 'function' ? (module.WebError as WebErrorConstructor) : undefined
      )
      .catch(() => undefined)
  }
  return ctorPromise
}

/**
 * Build the error to throw from an async provider method: the harness's
 * `WebError` when resolvable, otherwise the local equivalent.
 */
export async function seamError(
  message: string,
  code: PluginErrorCode = 'WEB_PROVIDER_ERROR',
  cause?: unknown
): Promise<Error> {
  const Ctor = await loadWebError()
  if (Ctor !== undefined) {
    try {
      return new Ctor(message, code, cause === undefined ? undefined : { cause })
    } catch {
      /* fall through to the local error */
    }
  }
  return new PluginError(message, code, cause === undefined ? undefined : { cause })
}

/** Read a message without trusting the thrown value's shape. */
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Read a stable code from a thrown value, when it has one. */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** True when the caller (not the deadline) aborted the operation. */
export function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError'
}
