// External workbench plugin: an SMS SERVICE PROVIDER implemented entirely
// OUTSIDE the core repository (no core module is imported here; the core
// injects `ctx.sms` and this plugin only registers an implementation of the
// published contract `sms@1`, core `docs/PLUGIN-CONTRACT.md` section 4g).
//
// The manifest declares the capability, which is what makes `ctx.sms.register`
// legal:
//
//   "capabilities": [{ "id": "sms", "version": 1, "provider": "twilio" }]
//
// Backend: the Twilio REST API, version 2010-04-01 (the only version Twilio
// publishes for the Messages resource; it is part of every request PATH, see
// README.md "Twilio endpoints"). This provider is READ-ONLY by construction: it
// only issues `GET` requests on the Messages resource. There is no send, no
// TwiML/webhook server and no number provisioning anywhere in this file.
//
// MULTIPLE NUMBERS: the operator configures one row per LABEL
// (`numbers: { personal: {...}, work: {...} }`) and optionally names the label a
// call without an explicit reference resolves to (`defaultNumber`). Every label
// carries its OWN credential pair (accountSid + authToken), so labels may live in
// DIFFERENT Twilio accounts. The label is the only identifier that ever leaves
// this module: a phone number appears in `numbers()` (metadata, the operator
// wrote it in the config), a credential VALUE never appears in any return value,
// log line or error message.
//
// Credential resolution: `accountSid` and `authToken` may be written as a
// literal, or as the core's `${cred:NAME}` reference spelling (see
// docs/CREDENTIALS.md). A capability PROVIDER is applied in the kernel's first
// phase, before `${cred:...}` expansion, so a reference reaches this module
// UNEXPANDED and is resolved here, at CALL time, through `ctx.credentials`.
// That keeps contract rule 6: a reference that does not resolve leaves the
// plugin LOADED with that label reported `configured: false`, and only a call
// for that label fails, naming the credential NAME (never a value).
//
// Every request is BOUNDED: an explicit timeout, a bounded page size and page
// count, and a capped body length. A failure becomes a structured `sms: ...`
// error (or a `SmsNotFoundError`/`SmsNumberNotConfiguredError`-shaped one), never
// a crash and never a hang.

import { loggerOf, type LoggerServiceLike } from '../../definitions/logger.ts'
export const name = 'sms-twilio'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'twilio'

/** Contract version implemented (the core speaks `sms@1`). */
export const CONTRACT_VERSION = 1

/** The Twilio API version every request path carries. */
export const TWILIO_API_VERSION = '2010-04-01'

/** Default API origin; a row may override it (a stub server in tests, a proxy). */
export const DEFAULT_API_BASE = 'https://api.twilio.com'

/** Hard bound of a single HTTP request (milliseconds). */
export const DEFAULT_TIMEOUT_MS = 8000

/** Hard bound of the pages one `list()` call may walk. */
export const DEFAULT_MAX_PAGES = 3

/** Twilio's own maximum for the `PageSize` parameter. */
export const TWILIO_MAX_PAGE_SIZE = 100

/** Definition bounds mirrored here (a provider must agree with the contract). */
export const DEFAULT_LIST_LIMIT = 10
export const MAX_LIST_LIMIT = 100

/** Definition default body cap, mirrored (the contract may cap it lower too). */
export const MAX_BODY_CHARS = 2000

/** Definition truncation marker, mirrored. */
export const TRUNCATED_MARKER = '...[truncated]'

/** One configured number, exactly as an operator writes it under `numbers:`. */
export interface NumberConfig {
  /** The TO number whose inbox is read, E.164 (e.g. `+15551234567`). */
  number?: string
  /** Twilio Account SID, literal (`AC...`) or a `${cred:NAME}` reference. */
  accountSid?: string
  /** Twilio auth token, literal or a `${cred:NAME}` reference (never logged). */
  authToken?: string
  /** API origin for this number; defaults to {@link DEFAULT_API_BASE}. */
  apiBase?: string
  /** Free operator description (reported by `numbers()`, never a value). */
  description?: string
}

export interface Config {
  /** Label a call without a reference resolves to. */
  defaultNumber?: string
  /** One entry per label, in configuration order. */
  numbers?: Record<string, NumberConfig>
  /** Request timeout in milliseconds (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Max pages one `list()` may walk (default {@link DEFAULT_MAX_PAGES}). */
  maxPages?: number
  /** Page size asked of Twilio, capped at {@link TWILIO_MAX_PAGE_SIZE}. */
  pageSize?: number
  /** Body cap for returned messages (default {@link MAX_BODY_CHARS}). */
  maxBodyChars?: number
}

/** A number reference: a LABEL, never a value (the contract's `NumberRef`). */
export interface NumberRef {
  label: string
}

/** One configured number as the capability reports it (never a secret). */
export interface SmsNumberInfo {
  label: string
  number?: string
  default?: boolean
  configured?: boolean
  description?: string
}

export interface SmsListOptions {
  limit?: number
  since?: string
  unreadOnly?: boolean
  from?: string
}

export interface SmsSummaryInfo {
  id: string
  from: string
  to: string
  date: string
  body: string
  status?: string
  unread?: boolean
}

export interface SmsMessageInfo extends SmsSummaryInfo {
  segments?: number
  direction?: string
  error?: string
  media?: string[]
}

/** The provider surface `ctx.sms.register` accepts (the contract's shape). */
export interface ProviderLike {
  id: string
  version: number
  describe?(): string
  numbers(): SmsNumberInfo[] | Promise<SmsNumberInfo[]>
  list(ref: NumberRef | undefined, options: SmsListOptions): SmsSummaryInfo[] | Promise<SmsSummaryInfo[]>
  get(ref: NumberRef | undefined, id: string): SmsMessageInfo | Promise<SmsMessageInfo>
}

/** Credential resolution, as `ctx.credentials` offers it (never a value list). */
interface CredentialsLike {
  resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> | { value?: string } | undefined
}

/** The context surface this plugin uses (no core import, no provider registry). */
interface PluginContext {
  sms: { register(provider: ProviderLike): () => void }
  credentials?: CredentialsLike
  effect(callback: () => () => void): void
  /** The logger SERVICE the core hosts (definitions/logger.ts, docs/LOGGING.md). */
  logger?: LoggerServiceLike
}

/**
 * The core's credential-reference spelling, `${cred:NAME}` (or
 * `${cred:SCOPE/NAME}`), as `docs/CREDENTIALS.md` defines it. A provider row is
 * applied before the kernel expands references, so this plugin resolves the ones
 * it finds itself.
 */
const CREDENTIAL_REF = /^\$\{cred:([^}]+)\}$/

/** The credential NAME a configured value references, or `undefined` for a literal. */
export function credentialRefName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = CREDENTIAL_REF.exec(value.trim())
  if (!match) return undefined
  const body = (match[1] ?? '').trim()
  return body.length === 0 ? undefined : body
}

/**
 * The credential NAME an `authToken` value references: `${cred:NAME}` (the core's
 * spelling) or a BARE NAME, which is how the dev config writes it so that a
 * missing credential leaves the plugin LOADED (not configured) instead of
 * aborting the boot - the core expands `${cred:NAME}` before the plugins load and
 * an unresolvable one is fatal. A LITERAL token is never accepted here: a secret
 * is never inlined in a config file, it lives in the credentials store.
 * `undefined` means "not a usable credential reference".
 */
export function credentialNameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const match = CREDENTIAL_REF.exec(trimmed)
  if (match !== null) {
    const name = match[1]?.trim()
    return name !== undefined && name.length > 0 ? name : undefined
  }
  if (trimmed.includes('${')) return undefined
  return trimmed
}

/** Splits a credential NAME into the reference `ctx.credentials.resolve` takes. */
function parseCredentialName(credential: string): { name: string; scope?: string } {
  const slash = credential.indexOf('/')
  if (slash <= 0 || slash === credential.length - 1) return { name: credential }
  return { name: credential.slice(slash + 1), scope: credential.slice(0, slash) }
}

/** A credential NAME or a literal account SID, redacted for diagnostics. */
export function maskValue(value: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return '(empty)'
  if (text.length <= 6) return '**** (redacted)'
  return `${text.slice(0, 4)}**** (redacted)`
}

/** Caps a body at `max` characters, marking a cut (the contract's rule). */
export function capBody(body: unknown, max: number = MAX_BODY_CHARS): string {
  const text = typeof body === 'string' ? body : body === undefined || body === null ? '' : String(body)
  if (text.length <= max) return text
  return `${text.slice(0, max)}${TRUNCATED_MARKER}`
}

/** A positive integer within [1, `max`], or `fallback`. */
export function clampInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Math.min(fallback, max)
  const rounded = Math.floor(value)
  if (rounded <= 0) return Math.min(fallback, max)
  return Math.min(rounded, max)
}

/** The contract limit rule: default 10, hard cap 100. */
export function normalizeLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIST_LIMIT
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error(`sms: 'limit' must be a number (got ${JSON.stringify(limit)})`)
  }
  const value = Math.floor(limit)
  if (value <= 0) throw new Error(`sms: 'limit' must be a positive integer (got ${String(limit)})`)
  return Math.min(value, MAX_LIST_LIMIT)
}

/** An ISO-8601 instant from the RFC-2822 date Twilio reports, or '' when absent. */
export function isoDate(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return ''
  const milliseconds = Date.parse(value)
  if (Number.isNaN(milliseconds)) return ''
  return new Date(milliseconds).toISOString()
}

/** The label a reference names, or '' when it is omitted. */
export function refLabel(ref: NumberRef | undefined): string {
  if (ref === undefined || ref === null) return ''
  const label = (ref as { label?: unknown }).label
  if (typeof label !== 'string') return ''
  return label.trim()
}

/** Structured "unknown number" error (the contract's `SmsUnknownNumberError` shape). */
export function unknownNumberError(label: string, known: string[]): Error {
  const error = new Error(`sms: unknown number '${label}' (configured: ${known.length ? known.join(', ') : 'none'})`)
  error.name = 'SmsUnknownNumberError'
  return Object.assign(error, { label, known })
}

/** Structured "number not configured" error (never carries a value). */
export function notConfiguredError(label: string, reason: string): Error {
  const error = new Error(`sms: number '${label}' is not configured (${reason})`)
  error.name = 'SmsNumberNotConfiguredError'
  return Object.assign(error, { label, reason })
}

/** Structured "no such message" error (the contract's `SmsNotFoundError` shape). */
export function notFoundError(message: string): Error {
  const error = new Error(`sms: ${message}`)
  error.name = 'SmsNotFoundError'
  return error
}

/** Structured backend error: an HTTP status, never a request header or a credential. */
export function backendError(label: string, status: number, detail: string): Error {
  const error = new Error(`sms: number '${label}': the sms backend answered HTTP ${String(status)}${detail ? ` (${detail})` : ''}`)
  error.name = 'SmsBackendError'
  return Object.assign(error, { label, status })
}

/** Readable text of anything thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One configured number after validation. */
export interface ResolvedNumber {
  label: string
  number?: string
  accountSid?: string
  authToken?: string
  apiBase: string
  description?: string
}

/** Validates the `numbers` row: a malformed row is REPORTED, never thrown here. */
export function normalizeNumbers(config: Config): ResolvedNumber[] {
  const rows = config.numbers ?? {}
  const resolved: ResolvedNumber[] = []
  for (const [rawLabel, row] of Object.entries(rows)) {
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : ''
    if (label.length === 0) continue
    const value = (row ?? {}) as NumberConfig
    resolved.push({
      label,
      ...(typeof value.number === 'string' && value.number.trim().length > 0 ? { number: value.number.trim() } : {}),
      ...(typeof value.accountSid === 'string' && value.accountSid.trim().length > 0 ? { accountSid: value.accountSid.trim() } : {}),
      ...(typeof value.authToken === 'string' && value.authToken.trim().length > 0 ? { authToken: value.authToken.trim() } : {}),
      apiBase: (typeof value.apiBase === 'string' && value.apiBase.trim().length > 0 ? value.apiBase.trim() : DEFAULT_API_BASE).replace(/\/+$/, ''),
      ...(typeof value.description === 'string' && value.description.trim().length > 0 ? { description: value.description.trim() } : {}),
    })
  }
  return resolved
}

/** The runtime state of one number: its row plus why it may not be usable. */
export interface RuntimeNumber {
  entry: ResolvedNumber
  /** True when every part of the row is present AND its references resolve. */
  configured: boolean
  /** The credential NAMES this row references (never values). */
  references: string[]
  /** Why the number is not usable; never a value. */
  reason?: string
}

/**
 * The parts of a row that could be credential references, as NAMES.
 * `accountSid` is normally a literal (`AC...`), but a reference is allowed.
 */
function referencesOf(entry: ResolvedNumber): string[] {
  const names: string[] = []
  const sid = credentialRefName(entry.accountSid)
  if (sid !== undefined) names.push(sid)
  // `authToken` is ALWAYS a credential reference: a NAME or `${cred:NAME}`.
  const token = credentialNameOf(entry.authToken)
  if (token !== undefined) names.push(token)
  return names
}

/** The Twilio error `message`/`code` only: never an echo of our own request. */
function backendDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const body = payload as { code?: unknown; message?: unknown }
  const parts: string[] = []
  if (typeof body.code === 'number' || typeof body.code === 'string') parts.push(`code ${String(body.code)}`)
  if (typeof body.message === 'string' && body.message.trim().length > 0) parts.push(body.message.trim().slice(0, 200))
  return parts.join(': ')
}

/**
 * The plugin entrypoint. Contract rule 6: a MISSING `numbers` row is not a
 * failure - the plugin loads, reports NOT CONFIGURED and registers nothing. A
 * row whose reference does not resolve keeps the plugin loaded too and is
 * reported `configured: false`; only a call for THAT label fails.
 *
 * `apply` is ASYNC because the references are resolved once while loading, so
 * `numbers()` reports resolvability truthfully instead of echoing the config.
 * It never throws on a missing credential: the failure is logged by NAME and the
 * number is marked not configured.
 */
export async function apply(ctx: PluginContext, config: Config = {}): Promise<void> {
  const entries = normalizeNumbers(config)
  if (entries.length === 0) {
    loggerOf(ctx, name).error(
      "not configured (no 'numbers' in plugins.sms-twilio) - provider 'twilio' is declared by the " +
        "manifest and registers nothing; add at least one number, e.g. " +
        'numbers: { personal: { number: "+15551234567", accountSid: ACxxxx, authToken: ${cred:TWILIO_PERSONAL_TOKEN} } }',
    )
    return
  }

  const defaultLabel = typeof config.defaultNumber === 'string' && config.defaultNumber.trim().length > 0 ? config.defaultNumber.trim() : undefined
  const timeoutMs = clampInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000)
  const maxPages = clampInteger(config.maxPages, DEFAULT_MAX_PAGES, 10)
  const pageSize = clampInteger(config.pageSize, TWILIO_MAX_PAGE_SIZE, TWILIO_MAX_PAGE_SIZE)
  const maxBodyChars = clampInteger(config.maxBodyChars, MAX_BODY_CHARS, MAX_BODY_CHARS)

  const runtimes: RuntimeNumber[] = entries.map((entry) => {
    const references = referencesOf(entry)
    const missing: string[] = []
    if (entry.number === undefined) missing.push("'number'")
    if (entry.accountSid === undefined) missing.push("'accountSid'")
    if (entry.authToken === undefined) missing.push("'authToken'")
    const complete = missing.length === 0
    return {
      entry,
      references,
      // A reference can only be checked once resolved, below.
      configured: complete && references.length === 0,
      ...(complete ? {} : { reason: `the row declares no ${missing.join(', no ')}` }),
    }
  })

  /**
   * One configured value (a literal, or the value a `${cred:NAME}` reference
   * resolves to). Every failure names the credential NAME or a MASKED literal -
   * never a value - so a diagnostic can never leak a token.
   */
  const valueOf = async (runtime: RuntimeNumber, name: 'number' | 'accountSid' | 'authToken'): Promise<string> => {
    const raw = runtime.entry[name]
    if (raw === undefined) throw notConfiguredError(runtime.entry.label, `the row declares no '${name}'`)
    // `authToken` is ALWAYS a credential reference (a NAME or `${cred:NAME}`): a
    // secret is never inlined in the config. The other parts are literals unless
    // they carry a `${cred:NAME}` reference of their own.
    const reference = name === 'authToken' ? credentialNameOf(raw) : credentialRefName(raw)
    if (reference === undefined) {
      if (raw.includes('${')) {
        throw notConfiguredError(runtime.entry.label, `'${name}' is not a usable ${'${cred:NAME}'} reference`)
      }
      if (name === 'authToken') {
        throw notConfiguredError(
          runtime.entry.label,
          "'authToken' must be a credential NAME or a ${cred:NAME} reference (a literal token is never inlined)",
        )
      }
      return raw
    }
    const credentials = ctx.credentials
    if (!credentials) {
      throw notConfiguredError(runtime.entry.label, `credential '${reference}' cannot be resolved (the credentials capability is not available)`)
    }
    const resolution = await credentials.resolve(parseCredentialName(reference))
    const value = resolution?.value
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw notConfiguredError(runtime.entry.label, `credential '${reference}' did not resolve to a value`)
    }
    return value.trim()
  }

  /** Every part of a row, resolved; throws a structured error when unusable. */
  const connectionOf = async (runtime: RuntimeNumber): Promise<{ number: string; accountSid: string; authToken: string; apiBase: string }> => {
    const number = await valueOf(runtime, 'number')
    const accountSid = await valueOf(runtime, 'accountSid')
    const authToken = await valueOf(runtime, 'authToken')
    return { number, accountSid, authToken, apiBase: runtime.entry.apiBase }
  }

  /** The number a reference names (the default one when omitted), or a structured error. */
  const targetOf = (ref: NumberRef | undefined): RuntimeNumber => {
    const known = runtimes.map((runtime) => runtime.entry.label)
    const label = refLabel(ref)
    if (label.length > 0) {
      const match = runtimes.find((runtime) => runtime.entry.label === label)
      if (!match) throw unknownNumberError(label, known)
      return match
    }
    const fallback = (defaultLabel !== undefined ? runtimes.find((runtime) => runtime.entry.label === defaultLabel) : undefined) ?? runtimes[0]
    if (!fallback) throw unknownNumberError('(default)', known)
    return fallback
  }

  /**
   * One BOUNDED `GET` on the Twilio API. `path` is either a resource path
   * (`/2010-04-01/Accounts/{Sid}/Messages.json`) or the `next_page_uri` Twilio
   * returns, which already carries its own query string.
   */
  const request = async (runtime: RuntimeNumber, path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> => {
    const connection = await connectionOf(runtime)
    const relative = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${connection.apiBase}${relative}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const authorization = `Basic ${Buffer.from(`${connection.accountSid}:${connection.authToken}`).toString('base64')}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? `timed out after ${String(timeoutMs)}ms` : messageOf(error)
      throw backendError(runtime.entry.label, 0, `the request failed (${reason})`)
    }
    const text = await response.text().catch(() => '')
    let payload: unknown
    try {
      payload = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      payload = undefined
    }
    if (!response.ok) throw backendError(runtime.entry.label, response.status, backendDetail(payload))
    if (!payload || typeof payload !== 'object') {
      throw backendError(runtime.entry.label, response.status, 'the answer was not JSON')
    }
    return payload as Record<string, unknown>
  }

  /** One raw Twilio message resource as the contract's summary (bounded body). */
  const toSummary = (runtime: RuntimeNumber, raw: Record<string, unknown>): SmsSummaryInfo => {
    const status = typeof raw.status === 'string' ? raw.status : undefined
    return {
      id: typeof raw.sid === 'string' ? raw.sid : String(raw.sid ?? ''),
      from: typeof raw.from === 'string' ? raw.from : '',
      to: typeof raw.to === 'string' ? raw.to : (runtime.entry.number ?? ''),
      date: isoDate(raw.date_created) || isoDate(raw.date_sent),
      body: capBody(raw.body, maxBodyChars),
      ...(status === undefined ? {} : { status }),
      // Twilio keeps no read/unread flag on a message: the inbound final status
      // ('received') is the closest thing to "not marked read" (README).
      ...(status === undefined ? {} : { unread: status === 'received' }),
    }
  }

  /** One raw Twilio message resource as the contract's full message. */
  const toMessage = (runtime: RuntimeNumber, raw: Record<string, unknown>): SmsMessageInfo => ({
    ...toSummary(runtime, raw),
    ...(typeof raw.num_segments === 'number' || typeof raw.num_segments === 'string'
      ? { segments: Number(raw.num_segments) }
      : {}),
    ...(typeof raw.direction === 'string' ? { direction: raw.direction } : {}),
    ...(typeof raw.error_message === 'string' && raw.error_message.length > 0 ? { error: raw.error_message } : {}),
    ...(typeof raw.num_media === 'string' || typeof raw.num_media === 'number'
      ? Number(raw.num_media) > 0
        ? { media: [] }
        : {}
      : {}),
  })

  /** The Messages collection path of one number's account. */
  const messagesPath = (accountSid: string): string => `/${TWILIO_API_VERSION}/Accounts/${accountSid}/Messages.json`

  /** The single-message path of one number's account. */
  const messagePath = (accountSid: string, sid: string): string => `/${TWILIO_API_VERSION}/Accounts/${accountSid}/Messages/${sid}.json`

  // Best-effort resolution while loading: `numbers()` then tells the truth about
  // every label instead of repeating its configuration.
  for (const runtime of runtimes) {
    if (!runtime.configured && runtime.reason !== undefined) continue
    try {
      await connectionOf(runtime)
      runtime.configured = true
      delete runtime.reason
    } catch (error) {
      runtime.configured = false
      runtime.reason = messageOf(error)
      loggerOf(ctx, name).error(runtime.reason)
    }
  }

  ctx.effect(() =>
    ctx.sms.register({
      id: providerId,
      version: CONTRACT_VERSION,
      describe: () =>
        `Twilio REST API ${TWILIO_API_VERSION} (read-only Messages), ${String(runtimes.filter((runtime) => runtime.configured).length)}/${String(runtimes.length)} number(s) configured: ${runtimes.map((runtime) => runtime.entry.label).join(', ')}${defaultLabel === undefined ? '' : ` (default: ${defaultLabel})`}`,
      numbers: () =>
        runtimes.map((runtime) => ({
          label: runtime.entry.label,
          ...(runtime.entry.number === undefined ? {} : { number: runtime.entry.number }),
          default: (defaultLabel !== undefined ? runtime.entry.label === defaultLabel : runtimes[0] === runtime) || undefined,
          configured: runtime.configured,
          ...(runtime.entry.description === undefined ? {} : { description: runtime.entry.description }),
        })),
      list: async (ref: NumberRef | undefined, options: SmsListOptions = {}): Promise<SmsSummaryInfo[]> => {
        const runtime = targetOf(ref)
        const limit = normalizeLimit(options.limit)
        const connection = await connectionOf(runtime)
        const collected: SmsSummaryInfo[] = []
        let path = messagesPath(connection.accountSid)
        let query: Record<string, string> = { To: connection.number, PageSize: String(Math.min(pageSize, limit)) }
        for (let page = 0; page < maxPages && collected.length < limit; page += 1) {
          const payload = await request(runtime, path, query)
          const messages = Array.isArray(payload.messages) ? (payload.messages as Record<string, unknown>[]) : []
          for (const raw of messages) collected.push(toSummary(runtime, raw))
          const next = typeof payload.next_page_uri === 'string' ? payload.next_page_uri : undefined
          if (next === undefined || next.length === 0 || collected.length >= limit) break
          // `next_page_uri` carries its own query string (PageSize included).
          path = next
          query = {}
        }
        return filterMessages(collected, options).slice(0, limit)
      },
      get: async (ref: NumberRef | undefined, id: string): Promise<SmsMessageInfo> => {
        const runtime = targetOf(ref)
        const sid = typeof id === 'string' ? id.trim() : ''
        if (sid.length === 0) throw new Error("sms: get() needs a non-empty message 'id'")
        const connection = await connectionOf(runtime)
        try {
          const payload = await request(runtime, messagePath(connection.accountSid, sid))
          return toMessage(runtime, payload)
        } catch (error) {
          const status = (error as { status?: unknown }).status
          if (status === 404) {
            throw notFoundError(`message '${sid}' was not found on number '${runtime.entry.label}' (the backend answered HTTP 404)`)
          }
          throw error
        }
      },
    }),
  )
}

/**
 * Applies the contract's `list()` filters to messages the backend answered,
 * newest first. `since` and `from` are the definition's own semantics (an ISO
 * instant, a case-insensitive sender substring); `unreadOnly` keeps the messages
 * the backend reports as not marked read (see {@link apply}).
 */
export function filterMessages(messages: SmsSummaryInfo[], options: SmsListOptions = {}): SmsSummaryInfo[] {
  let filtered = messages
  const since = typeof options.since === 'string' && options.since.trim().length > 0 ? Date.parse(options.since.trim()) : undefined
  if (since !== undefined && !Number.isNaN(since)) {
    filtered = filtered.filter((message) => {
      const date = Date.parse(message.date)
      return !Number.isNaN(date) && date >= since
    })
  }
  if (options.unreadOnly === true) filtered = filtered.filter((message) => message.unread === true)
  const from = typeof options.from === 'string' && options.from.trim().length > 0 ? options.from.trim().toLowerCase() : undefined
  if (from !== undefined) filtered = filtered.filter((message) => message.from.toLowerCase().includes(from))
  return filtered
}

// `credentials` is INJECTED (and required) because the provider resolves the
// credential references of its own rows: without the declaration cordis refuses
// the `ctx.credentials` access outright. The core always registers it.
export default { name, inject: ['sms', 'credentials'], apply }
