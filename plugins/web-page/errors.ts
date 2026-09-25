// Structured error envelope of the `web-page` plugin.
//
// Every failure a caller can hit has a CODE that names it (timeout, dns, tls,
// non-2xx, extractor empty, ...). The code is part of the ERROR MESSAGE, because
// that is what the tools seam surfaces: `POST /api/tools/<name>` answers
// `500 { "error": { "kind": "tool-failed", "message": ... } }` (core
// `src/tools/http.ts`), and the process keeps serving the other tools. The
// object also carries the code/url/detail as fields, so an in-process caller
// reads them without parsing the text.
export type PageErrorCode =
  | 'invalid_input'
  | 'browser_unavailable'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'http_status'
  | 'connection'
  | 'extract_empty'
  | 'cache'
  // The RECIPE read-through: a recipe-driven read that cannot be honoured. The
  // caller sees why and (by policy) falls back to the plain render path.
  | 'recipe_missing_api'
  | 'recipe_credential_missing'
  | 'recipe_failed'
  | 'internal'

export interface PageErrorOptions {
  /** The URL the failure belongs to (never a credential value). */
  url?: string
  /** The recipe DOMAIN the failure belongs to, when no URL is at hand (never a credential). */
  domain?: string
  /** The underlying transport/browser text, kept verbatim for diagnosis. */
  detail?: string
  /** Whether calling again can plausibly succeed (a 404 is not retryable). */
  retryable?: boolean
  /** What the operator can do about it (a NAME, never a value). */
  hint?: string
}

/** One named, structured failure of the page reader. */
export class PageError extends Error {
  readonly code: PageErrorCode
  readonly url: string | undefined
  readonly domain: string | undefined
  readonly detail: string | undefined
  readonly retryable: boolean
  readonly hint: string | undefined
  /** The `message` argument, WITHOUT the formatted `[url] (detail)` suffix. */
  private readonly rawMessage: string

  constructor(code: PageErrorCode, message: string, options: PageErrorOptions = {}) {
    const where = options.url === undefined ? (options.domain === undefined ? '' : ` [${options.domain}]`) : ` [${options.url}]`
    const why = options.detail === undefined || options.detail.length === 0 ? '' : ` (${truncate(options.detail, 300)})`
    super(`web-page: ${code}: ${message}${where}${why}`)
    this.name = 'PageError'
    this.code = code
    this.url = options.url
    this.domain = options.domain
    this.detail = options.detail
    this.retryable = options.retryable ?? false
    this.hint = options.hint
    this.rawMessage = message
  }

  /**
   * A COPY of this failure with every `pattern` scrubbed from its diagnostic
   * fields (message, url, detail). The plugin applies this at the boundary where
   * a failure leaves a tool, so a string the operator declared secret (a token a
   * browser error text happens to quote) never reaches a caller.
   */
  withRedaction(patterns: readonly string[]): PageError {
    if (patterns.length === 0) return this
    const scrub = (text: string): string => redactText(text, patterns)
    return new PageError(this.code, scrub(this.rawMessage), {
      ...(this.url === undefined ? {} : { url: scrub(this.url) }),
      ...(this.detail === undefined ? {} : { detail: scrub(this.detail) }),
      retryable: this.retryable,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    })
  }

  /** The JSON shape an in-process caller or a test can assert on. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      url: this.url,
      detail: this.detail,
      retryable: this.retryable,
      hint: this.hint,
    }
  }
}

/**
 * Replace every occurrence of each configured pattern with `[redacted]`.
 *
 * Plain text matching (never a regex), case sensitive, deterministic: blank
 * patterns are ignored, and a text with no match is returned unchanged. This is
 * what the `redact` config row feeds (plugin diagnostics and error messages).
 */
export function redactText(text: string, patterns: readonly string[]): string {
  let out = text
  for (const pattern of patterns) {
    const needle = typeof pattern === 'string' ? pattern.trim() : ''
    if (needle.length === 0) continue
    if (!out.includes(needle)) continue
    out = out.split(needle).join('[redacted]')
  }
  return out
}

/** A short single-line form of any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** The message of any thrown value (never a value: callers pass browser text). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `true` when the text names a browser navigation timeout. */
export function isTimeout(text: string): boolean {
  return /timeout|timed out/i.test(text)
}

/**
 * Map a browser/navigation failure to a CODE. The mapping is text based because
 * that is all chromium exposes (net::ERR_* strings in the error message).
 */
export function codeForBrowserFailure(text: string): PageErrorCode {
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|EAI_AGAIN|ENOTFOUND/i.test(text)) return 'dns'
  if (/ERR_CERT|ERR_SSL|CERT_|self.signed|SSL/i.test(text)) return 'tls'
  if (/ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ECONNREFUSED|ECONNRESET/i.test(text)) return 'connection'
  if (isTimeout(text)) return 'timeout'
  if (/net::ERR_/.test(text)) return 'connection'
  return 'internal'
}

/** Wrap a browser/navigation failure into a named {@link PageError}. */
export function browserFailure(error: unknown, url: string, timeoutMs: number, redact: readonly string[] = []): PageError {
  const text = redactText(messageOf(error), redact)
  const code = codeForBrowserFailure(text)
  if (code === 'timeout') {
    return new PageError('timeout', `the page did not finish loading within ${String(timeoutMs)}ms`, {
      url,
      detail: text,
      retryable: true,
      hint: 'raise navigationTimeoutMs/actionTimeoutMs or try again later',
    })
  }
  if (code === 'dns') {
    return new PageError('dns', 'the host name could not be resolved', { url, detail: text, hint: 'check the URL/host and DNS' })
  }
  if (code === 'tls') {
    return new PageError('tls', 'the TLS/HTTPS handshake failed', { url, detail: text, hint: 'check the certificate of the target' })
  }
  if (code === 'connection') {
    return new PageError('connection', 'the browser could not reach the target', { url, detail: text, retryable: true })
  }
  return new PageError('internal', 'the browser reported a failure', { url, detail: text })
}

/** Hard truncation for diagnostics (never a value). */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}
