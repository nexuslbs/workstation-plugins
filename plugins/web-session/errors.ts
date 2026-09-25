// Structured error envelope of the `session` tool.
//
// Every expected failure has a CODE that names its cause (unknown site, missing
// or expired session, a bad selector, a blocked origin, a timeout, a failed
// login, a step that did not apply ...). A `SessionError` never escapes the
// tool: the handler catches it and returns the structured envelope
// `{ status: 'error', error: { code, message, ... } }`, so a caller always gets
// a machine-readable answer and the workbench process keeps serving every other
// tool. Only a SCHEMA violation (a missing/invalid `action`, an unknown
// parameter) is answered by the core's own tools seam with HTTP 400 and a
// `violations` list - see plugins/web-session/README.md.
//
// The message format reuses the page reader's convention
// (`web-page: <code>: ...`): `<plugin>: <code>: <message> [site] (detail)`.
import { codeForBrowserFailure, messageOf, redactText, truncate } from '../web-page/errors.ts'

export type SessionErrorCode =
  | 'invalid_input'
  | 'unknown_site'
  | 'session_missing'
  | 'session_expired'
  | 'login_failed'
  | 'bad_selector'
  | 'no_match'
  | 'step_failed'
  | 'timeout'
  | 'blocked_origin'
  | 'api_failed'
  | 'http_status'
  | 'browser_unavailable'
  | 'dns'
  | 'tls'
  | 'connection'
  | 'budget'
  | 'internal'

export interface SessionErrorOptions {
  /** The session label the failure belongs to (never a credential value). */
  site?: string
  /** The URL the failure belongs to (never a credential value). */
  url?: string
  /** The `act` step that failed, as a readable label (e.g. `click #save`). */
  step?: string
  /** The selector that failed, verbatim (it is config/caller input, not a secret). */
  selector?: string
  /** The underlying browser/transport text, kept verbatim for diagnosis. */
  detail?: string
  /** Whether calling again can plausibly succeed. */
  retryable?: boolean
  /** What the operator/caller can do about it (a NAME, never a value). */
  hint?: string
}

/** One named, structured failure of the session tool. */
export class SessionError extends Error {
  readonly code: SessionErrorCode
  readonly site: string | undefined
  readonly url: string | undefined
  readonly step: string | undefined
  readonly selector: string | undefined
  readonly detail: string | undefined
  readonly retryable: boolean
  readonly hint: string | undefined
  /** The `message` argument, WITHOUT the formatted `[site] (detail)` suffix. */
  private readonly rawMessage: string

  constructor(code: SessionErrorCode, message: string, options: SessionErrorOptions = {}) {
    const where = options.site === undefined ? '' : ` [${options.site}]`
    const why = options.detail === undefined || options.detail.length === 0 ? '' : ` (${truncate(options.detail, 300)})`
    super(`web-session: ${code}: ${message}${where}${why}`)
    this.name = 'SessionError'
    this.code = code
    this.site = options.site
    this.url = options.url
    this.step = options.step
    this.selector = options.selector
    this.detail = options.detail
    this.retryable = options.retryable ?? false
    this.hint = options.hint
    this.rawMessage = message
  }

  /** A COPY with every configured `redact` pattern scrubbed from the message. */
  withRedaction(patterns: readonly string[]): SessionError {
    if (patterns.length === 0) return this
    const scrub = (text: string): string => redactText(text, patterns)
    return new SessionError(this.code, scrub(this.rawMessage), {
      ...(this.site === undefined ? {} : { site: scrub(this.site) }),
      ...(this.url === undefined ? {} : { url: scrub(this.url) }),
      ...(this.step === undefined ? {} : { step: scrub(this.step) }),
      ...(this.selector === undefined ? {} : { selector: scrub(this.selector) }),
      ...(this.detail === undefined ? {} : { detail: scrub(this.detail) }),
      retryable: this.retryable,
      ...(this.hint === undefined ? {} : { hint: scrub(this.hint) }),
    })
  }

  /** The machine-readable body the tool returns (never a credential value). */
  toEnvelope(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.site === undefined ? {} : { site: this.site }),
      ...(this.url === undefined ? {} : { url: this.url }),
      ...(this.step === undefined ? {} : { step: this.step }),
      ...(this.selector === undefined ? {} : { selector: this.selector }),
      retryable: this.retryable,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    }
  }
}

/** Map a browser/transport text onto a session error code (same rules as web-page). */
export function transportCode(text: string): SessionErrorCode {
  const code = codeForBrowserFailure(text)
  if (code === 'dns' || code === 'tls' || code === 'connection' || code === 'timeout' || code === 'http_status' || code === 'browser_unavailable') {
    return code
  }
  return 'internal'
}

/** Wrap an unknown thrown value into a named {@link SessionError}. */
export function asSessionError(error: unknown, context: SessionErrorOptions & { message: string; code?: SessionErrorCode }): SessionError {
  if (error instanceof SessionError) return error
  const text = messageOf(error)
  const code = context.code ?? transportCode(text)
  return new SessionError(code, context.message, { ...context, detail: text, ...(code === 'timeout' ? { retryable: true } : {}) })
}

/** The structured envelope of any thrown value (the tool's single exit point). */
export function envelopeOf(error: unknown, redact: readonly string[] = []): Record<string, unknown> {
  if (error instanceof SessionError) {
    const scrubbed = error.withRedaction(redact)
    return { status: 'error', error: scrubbed.toEnvelope() }
  }
  const text = redactText(messageOf(error), redact)
  return {
    status: 'error',
    error: { code: 'internal', message: `web-session: internal: ${text}`, retryable: false },
  }
}
