/**
 * SMS capability - SERVICE DEFINITION.
 *
 * This module is the CONTRACT of the SMS capability (`sms@1`) and nothing
 * else: it names no carrier, no REST API, no gateway and no message-store
 * format - a PROVIDER owns all of those. It exists so the three roles of the
 * capability can evolve and be replaced independently (the same seam the
 * credentials, web, email and totp capabilities use):
 *
 * - PROVIDERS (implementations, shipped by a plugin from any repository)
 *   implement {@link SmsProvider} and register themselves with the service.
 * - CONSUMERS (tool plugins, UI plugins, operators) only ever call `ctx.sms`.
 *   A consumer never imports a provider; a provider never imports a consumer.
 *   `npm run check:seam` enforces that direction.
 *
 * What is NOT here on purpose:
 * - ACCOUNTS and CREDENTIALS. The definition knows NUMBER REFERENCES (a label
 *   such as `personal`), never a phone number value and never a secret; which
 *   numbers exist, which carrier account each one belongs to and how a backend
 *   authenticates is the provider's configuration. Credential VALUES come from
 *   the credentials capability (`ctx.credentials`) when a provider needs one.
 * - The notion of a "default" number as a value: the default is a configuration
 *   decision the provider reports through {@link SmsNumber.default}, and callers
 *   get by omitting the reference.
 * - The transport vocabulary (SID, webhook, delivery callback). A message has an
 *   opaque provider id, a sender, a recipient, a date and a body; that is all a
 *   consumer sees.
 *
 * An external provider is implementable from this module plus the docs alone
 * (`docs/PLUGIN-CONTRACT.md` section 4g): declare the capability in the plugin
 * manifest and register a descriptor implementing the contract version below.
 *
 * The `code()` (verification code extraction) and `search()` algorithms live
 * HERE, on top of `list()`/`get()`, because they are backend agnostic: a
 * provider that implements nothing but `numbers()`/`list()`/`get()` gets both
 * for free, and may override either one when its backend answers better.
 */
// This repository does NOT depend on `cordis` (the core is an EXTERNAL host for
// these plugins), so the host service base is a local STRUCTURAL shim: it
// declares the service under its name on the context and nothing more.

/** The context slice this definition uses (structural: no `cordis` dependency). */
export interface DefinitionContext {
  /** Declare a service on the context (`ctx.provide(name, value)`). */
  provide?(name: string, value: unknown): void
}

/** Structural stand-in for the host `Service` base class of a definition. */
abstract class Service {
  protected constructor(ctx: DefinitionContext, name: string) {
    ctx.provide?.(name, this)
  }
}

/** Name of the cordis service (`ctx.sms`). */
export const SMS = 'sms'

/** Contract version this definition speaks. A provider must implement it. */
export const SMS_VERSION = 1

/** Contract id including the version, e.g. `sms@1`. */
export const SMS_CONTRACT = `${SMS}@${SMS_VERSION}`

/** Default page size of a `list()` call when the caller passes no `limit`. */
export const SMS_DEFAULT_LIST_LIMIT = 10

/** Hard cap of a `list()` call, whatever the caller asks for. */
export const SMS_MAX_LIST_LIMIT = 100

/** How many of the newest messages a `code()` call scans by default. */
export const SMS_CODE_SCAN_LIMIT = 10

/**
 * Cap of a returned message BODY, in characters. An SMS is 160 characters per
 * segment, but a provider may carry long concatenated messages; a consumer
 * never needs an unbounded body, so the definition caps it and marks the cut.
 */
export const MAX_BODY_CHARS = 2000

/** Suffix appended to a body the definition/provider had to cut. */
export const TRUNCATED_MARKER = '...[truncated]'

/** Which match `code()` returns when a body carries several candidates. */
export const DEFAULT_CODE_OCCURRENCES = 1

/** Hard cap of `occurrences`, so a caller cannot ask for an unbounded scan. */
export const MAX_CODE_OCCURRENCES = 20

/**
 * The default verification-code pattern: an OTP shape delimited by anything
 * that is not a letter/digit, either 4-8 DIGITS (`123456`) or a 6-8 character
 * ALPHANUMERIC code that carries at least one letter (`4F7K2Q`) - a bare 4-8
 * digit run is the common SMS shape, extended with the alphanumeric shapes
 * one-time codes also use (6-8 characters carrying BOTH a letter and a digit,
 * so a plain word never counts as a code). Callers override it with `pattern`.
 */
export const SMS_CODE_PATTERN =
  '(?<![A-Za-z0-9])(?:([0-9]{4,8})|(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])([A-Za-z0-9]{6,8}))(?![A-Za-z0-9])'

/**
 * A reference to a CONFIGURED number: a LABEL. It names an inbox, it never
 * carries a phone number and it never carries a credential value; an omitted
 * reference means "the provider's default number".
 */
export interface NumberRef {
  /** Number label as configured (e.g. `personal`, `work`). */
  label: string
}

/** One configured number, as the provider reports it (never a secret). */
export interface SmsNumber {
  /** Number reference label. */
  label: string
  /** The phone number (the TO number whose inbox is read), when the provider knows it. */
  number?: string
  /** True for the number a call without a reference resolves to. */
  default?: boolean
  /**
   * True when the provider holds everything it needs to read this number
   * (a resolvable credential, a usable endpoint). A number whose credential is
   * missing is a NORMAL state: the plugin stays loaded, the number is reported
   * here with `configured: false` and only a call for it fails.
   */
  configured?: boolean
  /** Provider's human description of the number/backend (never a value). */
  description?: string
}

/** `list()` options; every field is optional and bounded by the definition. */
export interface SmsListOptions {
  /** How many of the newest messages. Default {@link SMS_DEFAULT_LIST_LIMIT}, capped at {@link SMS_MAX_LIST_LIMIT}. */
  limit?: number
  /** ISO-8601 instant: only messages at/after it. */
  since?: string
  /** Only messages the backend marks unread. */
  unreadOnly?: boolean
  /** Only messages whose sender contains this (case-insensitive). */
  from?: string
}

/** One message, as `list()` reports it (a bounded body preview). */
export interface SmsSummary {
  /** Provider message id (stable enough to be passed to `get()`), e.g. a message sid. */
  id: string
  /** The sender (an E.164 number, or an alphanumeric sender id). */
  from: string
  /** The recipient number (the inbox this message arrived on). */
  to: string
  /** ISO-8601 instant (the provider normalises whatever the backend reports). */
  date: string
  /** The message text, capped at {@link MAX_BODY_CHARS}. */
  body: string
  /** Provider delivery/read status, when it reports one. */
  status?: string
  /** True when the backend reports the message as not yet read. */
  unread?: boolean
}

/** One full message: the summary plus the metadata `get()` adds. */
export interface SmsMessage extends SmsSummary {
  /** Number of SMS segments the backend reports, when it does. */
  segments?: number
  /** Direction as the backend reports it (`inbound`/`outbound`), when it does. */
  direction?: string
  /** Carrier error code/message, when the backend reports one (never a secret). */
  error?: string
  /** Media URLs the message carries (MMS), metadata only. */
  media?: string[]
}

/** `search()` options. */
export interface SmsSearchOptions {
  limit?: number
}

/** `code()` options: which message to read, and how to extract the code. */
export interface SmsCodeOptions {
  /** Read THIS message instead of scanning the newest ones. */
  id?: string
  /** Keep only messages whose sender/body contains this (case-insensitive). */
  query?: string
  /** Explicit pattern; `group 1` (or the whole match) is the code. Default {@link SMS_CODE_PATTERN}. */
  pattern?: string
  /**
   * Which candidate to return when the body carries several matches: 1 (the
   * first, the default) .. {@link MAX_CODE_OCCURRENCES}. It exists because a
   * real SMS often repeats a code ("your code is 123456, do not share 123456"),
   * or carries a date next to the code.
   */
  occurrences?: number
  /** Ignore messages older than this many seconds. */
  maxAgeSeconds?: number
}

/** The extracted verification code plus the message it came from. */
export interface SmsCode {
  code: string
  /** The body the code was extracted from (bounded by {@link MAX_BODY_CHARS}). */
  body: string
  from: string
  date: string
  messageId: string
}

/** A provider declaration: which plugin claims which provider id of which contract version. */
export interface SmsProviderDeclaration {
  /** Provider id claimed (e.g. `twilio`). */
  provider: string
  /** Contract version claimed; must equal {@link SMS_VERSION}. */
  version: number
  /** Plugin that claims it (manifest name). */
  plugin: string
  /** Source id the plugin came from. */
  source: string
  /** True when the declaring plugin came from an external source. */
  external: boolean
}

/** Public view of a provider: who declared it, is it registered, is it enabled. */
export interface SmsProviderInfo {
  id: string
  contract: string
  plugin: string
  source: string
  external: boolean
  /** True when the provider is in the enabled (selection) list. */
  enabled: boolean
  /** True when a provider implementation registered for this declaration. */
  registered: boolean
  /** Provider backend description, when it offers one (never a secret). */
  describe?: string
}

/** The capability has no usable provider: nothing is enabled, or nothing registered. */
export class SmsNotConfiguredError extends Error {
  constructor(message: string) {
    super(`sms: ${message}`)
    this.name = 'SmsNotConfiguredError'
  }
}

/** The referenced number label is not configured by the answering provider. */
export class SmsUnknownNumberError extends Error {
  readonly label: string

  constructor(label: string, known: string[]) {
    super(`sms: unknown number '${label}' (configured: ${known.length ? known.join(', ') : 'none'})`)
    this.name = 'SmsUnknownNumberError'
    this.label = label
  }
}

/**
 * The number EXISTS but the provider holds no usable credential for it (an
 * unresolved reference, or a row without one). The plugin is loaded and
 * healthy; only this number cannot answer, and this error says so without a
 * value.
 */
export class SmsNumberNotConfiguredError extends Error {
  readonly label: string

  constructor(label: string, reason: string) {
    super(`sms: number '${label}' is not configured (${reason})`)
    this.name = 'SmsNumberNotConfiguredError'
    this.label = label
  }
}

/** No message matched (an id that does not exist, or no code found). */
export class SmsNotFoundError extends Error {
  constructor(message: string) {
    super(`sms: ${message}`)
    this.name = 'SmsNotFoundError'
  }
}

/** Validates and normalises a number reference. Only the LABEL appears in errors. */
export function normalizeNumberRef(ref: NumberRef | undefined): NumberRef | undefined {
  if (ref === undefined || ref === null) return undefined
  const label = (ref as { label?: unknown }).label
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error('sms: a number reference needs a non-empty label')
  }
  return { label: label.trim() }
}

/** The label of a reference, for messages (never a value). */
export function numberLabel(ref: NumberRef | undefined, fallback = '(default)'): string {
  return normalizeNumberRef(ref)?.label ?? fallback
}

/** Normalises a limit: positive integer, capped at {@link SMS_MAX_LIST_LIMIT}. */
export function normalizeSmsLimit(limit: unknown, fallback: number = SMS_DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || limit === null) return fallback
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error(`sms: 'limit' must be a number (got ${JSON.stringify(limit)})`)
  }
  const value = Math.floor(limit)
  if (value <= 0) throw new Error(`sms: 'limit' must be a positive integer (got ${String(limit)})`)
  return Math.min(value, SMS_MAX_LIST_LIMIT)
}

/** Normalises `occurrences`: an integer in 1..{@link MAX_CODE_OCCURRENCES}. */
export function normalizeOccurrences(occurrences: unknown): number {
  if (occurrences === undefined || occurrences === null) return DEFAULT_CODE_OCCURRENCES
  if (typeof occurrences !== 'number' || !Number.isInteger(occurrences) || occurrences < 1 || occurrences > MAX_CODE_OCCURRENCES) {
    throw new Error(
      `sms: 'occurrences' must be an integer in 1..${MAX_CODE_OCCURRENCES} (got ${JSON.stringify(occurrences)})`,
    )
  }
  return occurrences
}

/** Caps a message body at `max` characters, marking a cut. Never returns null. */
export function capBody(body: unknown, max: number = MAX_BODY_CHARS): string {
  const text = typeof body === 'string' ? body : body === undefined || body === null ? '' : String(body)
  if (text.length <= max) return text
  return `${text.slice(0, max)}${TRUNCATED_MARKER}`
}

/**
 * The code pattern of a call as a RegExp: the caller's `pattern` when given
 * (case-insensitive), the definition default otherwise. The code is `group 1`
 * when the pattern has one, the whole match otherwise.
 */
export function smsCodePattern(pattern?: string): RegExp {
  if (pattern === undefined) return new RegExp(SMS_CODE_PATTERN, 'i')
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new Error("sms: 'pattern' must be a non-empty string")
  }
  try {
    return new RegExp(pattern, 'i')
  } catch (error) {
    throw new Error(`sms: invalid 'pattern' (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Every code candidate of `text`, in order, as `group 1` (or the whole match).
 * Bounded by {@link MAX_CODE_OCCURRENCES}: a pathological body cannot make the
 * scan unbounded. Never logs the text.
 */
export function extractCodes(text: string | undefined, pattern?: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const expression = new RegExp(smsCodePattern(pattern).source, 'gi')
  const codes: string[] = []
  for (const match of text.matchAll(expression)) {
    const code = match[1] ?? match[0]
    if (code !== undefined && code.length > 0) codes.push(code)
    if (codes.length >= MAX_CODE_OCCURRENCES) break
  }
  return codes
}

/**
 * The `occurrences`-th code of `text` (default: the first), or undefined. This
 * is the definition's own heuristic: digits-first 4-8, alphanumeric fallback,
 * overridable by `pattern` - shared by every provider that does not answer
 * natively, so the behaviour is identical behind every backend.
 */
export function extractSmsCode(text: string | undefined, pattern?: string, occurrences: unknown = DEFAULT_CODE_OCCURRENCES): string | undefined {
  return extractCodes(text, pattern)[normalizeOccurrences(occurrences) - 1]
}

/**
 * What a provider (implementation) must offer. Everything here is backend
 * agnostic: the definition does not know where a message comes from.
 * `numbers`, `list` and `get` are required; `code` and `search` are optional
 * because the definition implements both on top of the required three.
 */
export interface SmsProvider {
  /** Provider id, unique among providers (e.g. `twilio`). */
  id: string
  /** Contract version implemented; must equal {@link SMS_VERSION}. */
  version: number
  /** Optional: human readable backend description (never contains a value). */
  describe?(): string
  /** The configured numbers, in configuration order (never a secret). */
  numbers(): Promise<SmsNumber[]> | SmsNumber[]
  /**
   * The last inbound messages of one number, newest first. An unknown label
   * rejects with a {@link SmsUnknownNumberError}-shaped error and a number
   * without a usable credential with a {@link SmsNumberNotConfiguredError}-shaped
   * one; neither kills the process.
   */
  list(ref: NumberRef | undefined, options: SmsListOptions): Promise<SmsSummary[]> | SmsSummary[]
  /** One message by provider id, with its full (bounded) body. */
  get(ref: NumberRef | undefined, id: string): Promise<SmsMessage> | SmsMessage
  /** Optional: a native search the backend answers better than the definition's filter. */
  search?(ref: NumberRef | undefined, query: string, options: SmsSearchOptions): Promise<SmsSummary[]> | SmsSummary[]
  /** Optional: a native code extraction (the definition's heuristic otherwise). */
  code?(ref: NumberRef | undefined, options: SmsCodeOptions): Promise<SmsCode> | SmsCode
}

interface ProviderEntry {
  descriptor: SmsProvider
  declaration: SmsProviderDeclaration
}

/**
 * The service of the capability. The abstract part is the CONSUMER contract
 * (`numbers`, `list`, `get`, `code`, `search`); the concrete part is the
 * PROVIDER contract (declarations, registration, selection). It contains no
 * credentials and no transport.
 */
export abstract class SmsService extends Service {
  // Plain (runtime) properties, not `#private`: cordis wraps a service instance
  // in a Proxy for dependency tracking, and a Proxy breaks private-field access.
  protected declarations = new Map<string, SmsProviderDeclaration>()
  protected implementations = new Map<string, ProviderEntry>()
  protected enabledIds: string[] | undefined

  constructor(ctx: DefinitionContext, name: string = SMS) {
    super(ctx, name)
  }

  /** The configured numbers/labels, as the provider reports them (never a secret). */
  abstract numbers(): Promise<SmsNumber[]>
  /** The last inbound messages of one number (default number when omitted). */
  abstract list(ref?: NumberRef, options?: SmsListOptions): Promise<SmsSummary[]>
  /** One message by provider id. */
  abstract get(ref: NumberRef | undefined, id: string): Promise<SmsMessage>
  /** The verification code of a given message, or of the newest matching one. */
  abstract code(ref?: NumberRef, options?: SmsCodeOptions): Promise<SmsCode>
  /** Messages of one number matching a textual query. */
  abstract search(ref: NumberRef | undefined, query: string, options?: SmsSearchOptions): Promise<SmsSummary[]>

  /** Registers a provider declaration (from a manifest). */
  declare(declaration: SmsProviderDeclaration): void {
    if (!declaration.provider) throw new Error('sms: a provider declaration needs a provider id')
    if (declaration.version !== SMS_VERSION) {
      throw new Error(
        `sms: plugin '${declaration.plugin}' declares provider '${declaration.provider}' for contract version ` +
          `${declaration.version}, but this core speaks ${SMS_CONTRACT}`,
      )
    }
    const existing = this.declarations.get(declaration.provider)
    if (existing) {
      if (existing.plugin === declaration.plugin) return
      throw new Error(
        `sms: provider id '${declaration.provider}' is declared twice (by '${existing.plugin}' and ` +
          `'${declaration.plugin}'); provider ids must be unique`,
      )
    }
    this.declarations.set(declaration.provider, declaration)
  }

  /**
   * Registers a provider implementation. Refuses providers whose id or contract
   * version was not declared by a manifest, so the MANIFEST is what makes a
   * provider resolvable. Returns the disposer.
   */
  register(descriptor: SmsProvider): () => void {
    if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
      throw new Error('sms: register() needs a provider id')
    }
    if (typeof descriptor.numbers !== 'function' || typeof descriptor.list !== 'function' || typeof descriptor.get !== 'function') {
      throw new Error(`sms: provider '${descriptor.id}' must implement numbers(), list() and get()`)
    }
    const declaration = this.declarations.get(descriptor.id)
    if (!declaration) {
      throw new Error(
        `sms: provider '${descriptor.id}' is not declared; declare it in the plugin manifest: ` +
          `"capabilities": [{ "id": "${SMS}", "version": ${SMS_VERSION}, "provider": "${descriptor.id}" }]`,
      )
    }
    if (descriptor.version !== SMS_VERSION) {
      throw new Error(
        `sms: provider '${descriptor.id}' implements contract version ${descriptor.version}, ` +
          `but this core speaks ${SMS_CONTRACT}`,
      )
    }
    if (this.implementations.has(descriptor.id)) {
      throw new Error(`sms: provider '${descriptor.id}' is already registered`)
    }
    const entry: ProviderEntry = { descriptor, declaration }
    this.implementations.set(descriptor.id, entry)
    return () => {
      if (this.implementations.get(descriptor.id) === entry) this.implementations.delete(descriptor.id)
    }
  }

  /**
   * Fixes the enabled providers and their precedence order. This is the ONLY
   * place provider selection happens, and it is fed by configuration
   * (`sms.providers`).
   */
  setEnabled(ids?: readonly string[]): void {
    const requested = ids && ids.length > 0 ? [...ids] : [...this.declarations.keys()]
    const seen = new Set<string>()
    for (const id of requested) {
      if (seen.has(id)) throw new Error(`sms: provider '${id}' is listed twice in the enabled providers`)
      seen.add(id)
      if (!this.declarations.has(id)) {
        const available = [...this.declarations.keys()]
        throw new Error(
          `sms: provider '${id}' is not declared by any plugin (available: ` +
            `${available.length ? available.join(', ') : 'none'}); a provider must declare the capability in its ` +
            `manifest: "capabilities": [{ "id": "${SMS}", "version": ${SMS_VERSION}, "provider": "id" }]`,
        )
      }
    }
    // Declared but not selected providers stay registered; they never answer.
    // An empty selection means "every declared provider", so it stays DYNAMIC:
    // a provider declared after this call (a plugin loaded later) is enabled too.
    this.enabledIds = ids && ids.length > 0 ? requested : undefined
  }

  /** Enabled provider ids, in precedence order. */
  enabled(): string[] {
    return this.enabledIds ? [...this.enabledIds] : [...this.declarations.keys()]
  }

  /** Every known provider declaration, registered or not, enabled or not. */
  providers(): SmsProviderInfo[] {
    const enabled = new Set(this.enabled())
    return [...this.declarations.values()].map((declaration) => {
      const entry = this.implementations.get(declaration.provider)
      const describe = entry?.descriptor.describe?.()
      return {
        id: declaration.provider,
        contract: `${SMS}@${declaration.version}`,
        plugin: declaration.plugin,
        source: declaration.source,
        external: declaration.external,
        enabled: enabled.has(declaration.provider),
        registered: entry !== undefined,
        ...(describe === undefined ? {} : { describe }),
      }
    })
  }

  /** Registered provider lookup, for implementations of the abstract methods. */
  protected entry(id: string): SmsProvider | undefined {
    return this.implementations.get(id)?.descriptor
  }
}

/**
 * The default implementation of the definition: it walks the ENABLED providers
 * in order and answers through the first one that is registered. The walk is
 * the definition's own logic (no backend knowledge), so providers stay
 * replaceable: swapping the enabled provider swaps the whole backend, and the
 * consumers never notice.
 */
export class Sms extends SmsService {
  /** The provider that answers: first enabled AND registered one. */
  protected answering(): SmsProvider {
    const enabled = this.enabled()
    for (const id of enabled) {
      const provider = this.entry(id)
      if (provider) return provider
    }
    const declared = enabled.length > 0 ? enabled.join(', ') : 'none'
    throw new SmsNotConfiguredError(
      `no sms provider is available (enabled: ${declared}); enable a provider plugin and configure it, ` +
        `then select it with the 'sms' section of the config (or leave that section out to use every declared provider)`,
    )
  }

  async numbers(): Promise<SmsNumber[]> {
    return await this.answering().numbers()
  }

  async list(ref?: NumberRef, options: SmsListOptions = {}): Promise<SmsSummary[]> {
    const provider = this.answering()
    const number = normalizeNumberRef(ref)
    const limit = normalizeSmsLimit(options.limit)
    const messages = await provider.list(number, { ...options, limit })
    return messages.map((message) => ({ ...message, body: capBody(message.body) }))
  }

  async get(ref: NumberRef | undefined, id: string): Promise<SmsMessage> {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error("sms: get() needs a non-empty message 'id'")
    const message = await this.answering().get(normalizeNumberRef(ref), id.trim())
    return { ...message, body: capBody(message.body) }
  }

  async search(ref: NumberRef | undefined, query: string, options: SmsSearchOptions = {}): Promise<SmsSummary[]> {
    if (typeof query !== 'string' || query.trim().length === 0) throw new Error("sms: search() needs a non-empty 'query'")
    const provider = this.answering()
    const number = normalizeNumberRef(ref)
    const limit = normalizeSmsLimit(options.limit)
    if (provider.search) {
      const found = await provider.search(number, query.trim(), { ...options, limit })
      return found.map((message) => ({ ...message, body: capBody(message.body) }))
    }
    // Backend-agnostic fallback: filter the newest messages on the sender and
    // the body, the two fields a text query can mean. A provider with a native
    // search answers better.
    const needle = query.trim().toLowerCase()
    const messages = await provider.list(number, { limit: SMS_MAX_LIST_LIMIT })
    return messages
      .filter((message) => message.from.toLowerCase().includes(needle) || message.body.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((message) => ({ ...message, body: capBody(message.body) }))
  }

  /**
   * Verification code extraction. A provider that implements `code()` answers
   * natively; otherwise this backend-agnostic algorithm runs here: read the
   * newest messages (`id` short-circuits the scan), skip those older than
   * `maxAgeSeconds`, keep those matching `query` on sender/body, then read each
   * message and return the `occurrences`-th code found, with its message and
   * envelope. The returned code is never logged by the definition.
   */
  async code(ref: NumberRef | undefined, options: SmsCodeOptions = {}): Promise<SmsCode> {
    const provider = this.answering()
    const number = normalizeNumberRef(ref)
    if (provider.code) return await provider.code(number, options)

    const pattern = options.pattern
    const occurrences = normalizeOccurrences(options.occurrences)
    const since =
      typeof options.maxAgeSeconds === 'number' && Number.isFinite(options.maxAgeSeconds) && options.maxAgeSeconds > 0
        ? new Date(Date.now() - Math.floor(options.maxAgeSeconds) * 1000).toISOString()
        : undefined
    const listOptions: SmsListOptions = {
      limit: SMS_CODE_SCAN_LIMIT,
      ...(since === undefined ? {} : { since }),
      ...(options.query === undefined ? {} : { from: options.query }),
    }

    let candidates: SmsSummary[]
    if (options.id !== undefined && options.id.trim().length > 0) {
      candidates = [await provider.get(number, options.id.trim())]
    } else {
      candidates = await provider.list(number, listOptions)
      const needle = options.query?.trim().toLowerCase()
      if (needle !== undefined && needle.length > 0) {
        // `query` means "sender OR body contains", so a provider that ignored
        // the `from` option is filtered again here.
        candidates = candidates.filter(
          (message) => message.from.toLowerCase().includes(needle) || message.body.toLowerCase().includes(needle),
        )
      }
    }

    for (const candidate of candidates) {
      // The envelope body may be a preview: read the message itself through the
      // definition's own `get()` contract before extracting.
      const message = await provider.get(number, candidate.id)
      const code = extractSmsCode(message.body, pattern, occurrences) ?? extractSmsCode(candidate.body, pattern, occurrences)
      if (code !== undefined) {
        return { code, body: capBody(message.body), from: message.from, date: message.date, messageId: message.id }
      }
    }
    throw new SmsNotFoundError(
      `no code found in ${String(candidates.length)} message(s) of ${numberLabel(number)} ` +
        `(pattern ${pattern ?? SMS_CODE_PATTERN}, occurrence ${String(occurrences)}); ` +
        `pass an explicit 'pattern', more 'occurrences' or a wider 'maxAgeSeconds'`,
    )
  }
}

/**
 * Typed handle for every consumer/provider module: `ctx.sms`. Consumers
 * import the DEFINITION (never a provider) and get full typing from this.
 */
/** The structural context slice a consumer uses to reach the service. */
export interface SmsContext {
  sms: SmsService
}
