/**
 * TOTP capability - SERVICE DEFINITION.
 *
 * This module is the CONTRACT of the time-based one-time-password capability
 * (`totp@1`) and nothing else: it names no storage backend, no config-file
 * format, no algorithm vocabulary beyond the contract types and no code
 * generator - a PROVIDER owns all of those. It exists so the three roles of the
 * capability can evolve and be replaced independently (the same seam the
 * credentials, web and email capabilities use):
 *
 * - PROVIDERS (implementations, shipped by a plugin from any repository)
 *   implement {@link TotpProvider} and register themselves with the service.
 * - CONSUMERS (tool plugins, UI plugins, operators) only ever call `ctx.totp`.
 *   A consumer never imports a provider; a provider never imports a consumer.
 *   `npm run check:seam` enforces that direction.
 *
 * What is NOT here on purpose:
 * - SECRETS. The definition knows an entry LABEL (an operator name such as
 *   `github`), never a key. Nothing in this module can read, hold or log key
 *   material: where a key comes from (the plugin config, `${cred:NAME}`
 *   expansion, the credentials service) is the provider's business.
 * - The CODE ALGORITHM. RFC 4226 (HOTP) / RFC 6238 (TOTP), base32 decoding and
 *   the HMAC family live in a provider plugin; the contract only carries the
 *   `algorithm` NAME an entry declares (`SHA1`/`SHA256`/`SHA512`).
 *
 * An external provider is implementable from this module plus the docs alone
 * (`docs/PLUGIN-CONTRACT.md` section 4f): declare the capability in the plugin
 * manifest and register a descriptor implementing the contract version below.
 *
 * The `entries()` / `code()` pair lives HERE as the consumer contract; both are
 * abstract, because only a provider knows where the keys are.
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

/** Name of the cordis service (`ctx.totp`). */
export const TOTP = 'totp'

/** Contract version this definition speaks. A provider must implement it. */
export const TOTP_VERSION = 1

/** Contract id including the version, e.g. `totp@1`. */
export const TOTP_CONTRACT = `${TOTP}@${TOTP_VERSION}`

/** Digits of a generated code when an entry does not say otherwise. */
export const DEFAULT_DIGITS = 6

/** Period (seconds) of a step when an entry does not say otherwise. */
export const DEFAULT_PERIOD = 30

/** HMAC hash an entry uses when it does not say otherwise. */
export const DEFAULT_ALGORITHM = 'SHA1'

/** Smallest/largest accepted digit count (RFC 4226 truncation is 6-8 digits in practice). */
export const MIN_DIGITS = 4
export const MAX_DIGITS = 10

/** Smallest/largest accepted period, in seconds. */
export const MIN_PERIOD = 1
export const MAX_PERIOD = 3600

/** The HMAC hash function names an entry may declare. */
export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

/** The hash names, for validation and error messages. */
export const TOTP_ALGORITHMS: readonly TotpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

/**
 * One configured entry, as METADATA ONLY. A secret value must never appear in
 * this object, in the inventory, in a log or in an error: `label` is an operator
 * name (e.g. `github`), `issuer`/`account` are display hints, and the rest is
 * the code shape. `configured` reports whether the provider could actually
 * resolve a key for the entry (a missing key is a normal, non-fatal state: the
 * plugin stays loaded and only a `code()` call for that label fails).
 */
export interface TotpEntryInfo {
  /** Entry label as configured (e.g. `github`), unique per provider. */
  label: string
  /** Display hint: the service the code belongs to (e.g. `GitHub`). */
  issuer?: string
  /** Display hint: the account the code belongs to (e.g. `me@example.com`). */
  account?: string
  /** Code length in digits. */
  digits: number
  /** Step length in seconds. */
  period: number
  /** HMAC hash the entry uses. */
  algorithm: TotpAlgorithm
  /** True when the provider holds a usable key for this entry (never the key). */
  configured: boolean
}

/** Options of a `code()` call. */
export interface TotpCodeOptions {
  /**
   * Unix seconds to generate the code FOR. It exists for deterministic tests
   * and boundary checks; omitted (or undefined) means "now". The value is
   * floored to a whole second and never silently shifted by the definition or
   * by a provider: the step is `floor(at / period)`, exactly as RFC 6238 says.
   */
  at?: number
}

/** One generated code. Contains no key material, only the derived code. */
export interface TotpCode {
  /** Entry label the code was generated for. */
  label: string
  /** The current code, zero padded to `digits`. */
  code: string
  digits: number
  period: number
  algorithm: TotpAlgorithm
  /** The unix second the code was generated for. */
  generatedAt: number
  /**
   * Seconds left until the step rolls over: `period - (generatedAt % period)`.
   * It is ALWAYS in `1..period` (a value of `period` means the step just
   * started). A verifier typically accepts +/-1 step of clock skew
   * (RFC 6238 section 5.2); the generator never shifts the clock itself.
   */
  remainingSeconds: number
}

/** A provider declaration: which plugin claims which provider id of which contract version. */
export interface TotpProviderDeclaration {
  /** Provider id claimed (e.g. `rfc6238`). */
  provider: string
  /** Contract version claimed; must equal {@link TOTP_VERSION}. */
  version: number
  /** Plugin that claims it (manifest name). */
  plugin: string
  /** Source id the plugin came from. */
  source: string
  /** True when the declaring plugin came from an external source. */
  external: boolean
}

/** Public view of a provider: who declared it, is it registered, is it enabled. */
export interface TotpProviderInfo {
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
export class TotpNotConfiguredError extends Error {
  constructor(message: string) {
    super(`totp: ${message}`)
    this.name = 'TotpNotConfiguredError'
  }
}

/** The referenced entry label does not exist in the answering provider. */
export class TotpUnknownEntryError extends Error {
  readonly label: string

  constructor(label: string, known: string[]) {
    super(`totp: unknown entry '${label}' (configured: ${known.length ? known.join(', ') : 'none'})`)
    this.name = 'TotpUnknownEntryError'
    this.label = label
  }
}

/**
 * The entry EXISTS but the provider holds no usable key for it (an unresolved
 * credential, or a row without a key). The plugin is loaded and healthy; only
 * this entry cannot answer, and this error says so without a value.
 */
export class TotpEntryNotConfiguredError extends Error {
  readonly label: string

  constructor(label: string, reason: string) {
    super(`totp: entry '${label}' is not configured (${reason})`)
    this.name = 'TotpEntryNotConfiguredError'
    this.label = label
  }
}

/** Validates an entry label: a non-empty string, trimmed. Never a secret. */
export function normalizeEntryLabel(label: unknown): string {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error("totp: an entry 'label' must be a non-empty string")
  }
  return label.trim()
}

/**
 * Validates and normalises `at`: unix SECONDS, a non-negative whole number.
 * Fractional seconds are floored (the RFC works on whole seconds); everything
 * else is rejected instead of being coerced.
 */
export function normalizeAt(at: unknown, now: number = Date.now()): number {
  if (at === undefined || at === null) return Math.floor(now / 1000)
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new Error(`totp: 'at' must be a number of unix seconds (got ${JSON.stringify(at)})`)
  }
  const seconds = Math.floor(at)
  if (seconds < 0) throw new Error(`totp: 'at' must not be negative (got ${String(at)})`)
  return seconds
}

/** Validates an entry's `digits`; defaults to {@link DEFAULT_DIGITS}. */
export function normalizeDigits(digits: unknown): number {
  if (digits === undefined || digits === null) return DEFAULT_DIGITS
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS) {
    throw new Error(`totp: 'digits' must be an integer in ${MIN_DIGITS}..${MAX_DIGITS} (got ${JSON.stringify(digits)})`)
  }
  return digits
}

/** Validates an entry's `period` in seconds; defaults to {@link DEFAULT_PERIOD}. */
export function normalizePeriod(period: unknown): number {
  if (period === undefined || period === null) return DEFAULT_PERIOD
  if (typeof period !== 'number' || !Number.isInteger(period) || period < MIN_PERIOD || period > MAX_PERIOD) {
    throw new Error(`totp: 'period' must be an integer in ${MIN_PERIOD}..${MAX_PERIOD} seconds (got ${JSON.stringify(period)})`)
  }
  return period
}

/** Validates an entry's `algorithm`; defaults to {@link DEFAULT_ALGORITHM}. */
export function normalizeAlgorithm(algorithm: unknown): TotpAlgorithm {
  if (algorithm === undefined || algorithm === null) return DEFAULT_ALGORITHM
  const text = typeof algorithm === 'string' ? algorithm.trim().toUpperCase() : ''
  if (!TOTP_ALGORITHMS.includes(text as TotpAlgorithm)) {
    throw new Error(`totp: 'algorithm' must be one of ${TOTP_ALGORITHMS.join('/')} (got ${JSON.stringify(algorithm)})`)
  }
  return text as TotpAlgorithm
}

/**
 * The step an instant falls into, and the seconds left in it: `step =
 * floor(at / period)`, `remaining = period - (at % period)` (always 1..period).
 * Shared by every implementation so the boundary behaviour is identical.
 */
export function stepAt(at: number, period: number): { step: number; remainingSeconds: number } {
  const step = Math.floor(at / period)
  return { step, remainingSeconds: period - (at % period) }
}

/**
 * What a provider (implementation) must offer. Everything here is backend
 * agnostic: the definition does not know where an entry's key comes from, and
 * the provider never returns it.
 */
export interface TotpProvider {
  /** Provider id, unique among providers (e.g. `rfc6238`). */
  id: string
  /** Contract version implemented; must equal {@link TOTP_VERSION}. */
  version: number
  /** Optional: human readable backend description (never contains a secret). */
  describe?(): string
  /** The configured entries, in configuration order, METADATA ONLY. */
  entries(): Promise<TotpEntryInfo[]> | TotpEntryInfo[]
  /**
   * The current code of one entry. An unknown label rejects with a
   * {@link TotpUnknownEntryError}-shaped error and an entry without a usable
   * key with a {@link TotpEntryNotConfiguredError}-shaped one; neither kills
   * the process.
   */
  code(label: string, options?: TotpCodeOptions): Promise<TotpCode> | TotpCode
}

interface ProviderEntry {
  descriptor: TotpProvider
  declaration: TotpProviderDeclaration
}

/**
 * The service of the capability. The abstract part is the CONSUMER contract
 * (`entries`, `code`); the concrete part is the PROVIDER contract
 * (declarations, registration, selection). It contains no key handling.
 */
export abstract class TotpService extends Service {
  // Plain (runtime) properties, not `#private`: cordis wraps a service instance
  // in a Proxy for dependency tracking, and a Proxy breaks private-field access.
  protected declarations = new Map<string, TotpProviderDeclaration>()
  protected implementations = new Map<string, ProviderEntry>()
  protected enabledIds: string[] | undefined

  constructor(ctx: DefinitionContext, name: string = TOTP) {
    super(ctx, name)
  }

  /** The configured entries, METADATA ONLY (never a key, never a code). */
  abstract entries(): Promise<TotpEntryInfo[]>
  /** The current code of one entry; `at` (unix seconds) makes it deterministic. */
  abstract code(label: string, options?: TotpCodeOptions): Promise<TotpCode>

  /** Registers a provider declaration (from a manifest). */
  declare(declaration: TotpProviderDeclaration): void {
    if (!declaration.provider) throw new Error('totp: a provider declaration needs a provider id')
    if (declaration.version !== TOTP_VERSION) {
      throw new Error(
        `totp: plugin '${declaration.plugin}' declares provider '${declaration.provider}' for contract version ` +
          `${declaration.version}, but this core speaks ${TOTP_CONTRACT}`,
      )
    }
    const existing = this.declarations.get(declaration.provider)
    if (existing) {
      if (existing.plugin === declaration.plugin) return
      throw new Error(
        `totp: provider id '${declaration.provider}' is declared twice (by '${existing.plugin}' and ` +
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
  register(descriptor: TotpProvider): () => void {
    if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
      throw new Error('totp: register() needs a provider id')
    }
    if (typeof descriptor.entries !== 'function' || typeof descriptor.code !== 'function') {
      throw new Error(`totp: provider '${descriptor.id}' must implement entries() and code()`)
    }
    const declaration = this.declarations.get(descriptor.id)
    if (!declaration) {
      throw new Error(
        `totp: provider '${descriptor.id}' is not declared; declare it in the plugin manifest: ` +
          `"capabilities": [{ "id": "${TOTP}", "version": ${TOTP_VERSION}, "provider": "${descriptor.id}" }]`,
      )
    }
    if (descriptor.version !== TOTP_VERSION) {
      throw new Error(
        `totp: provider '${descriptor.id}' implements contract version ${descriptor.version}, ` +
          `but this core speaks ${TOTP_CONTRACT}`,
      )
    }
    if (this.implementations.has(descriptor.id)) {
      throw new Error(`totp: provider '${descriptor.id}' is already registered`)
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
   * (`totp.providers`).
   */
  setEnabled(ids?: readonly string[]): void {
    const requested = ids && ids.length > 0 ? [...ids] : [...this.declarations.keys()]
    const seen = new Set<string>()
    for (const id of requested) {
      if (seen.has(id)) throw new Error(`totp: provider '${id}' is listed twice in the enabled providers`)
      seen.add(id)
      if (!this.declarations.has(id)) {
        const available = [...this.declarations.keys()]
        throw new Error(
          `totp: provider '${id}' is not declared by any plugin (available: ` +
            `${available.length ? available.join(', ') : 'none'}); a provider must declare the capability in its ` +
            `manifest: "capabilities": [{ "id": "${TOTP}", "version": ${TOTP_VERSION}, "provider": "id" }]`,
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
  providers(): TotpProviderInfo[] {
    const enabled = new Set(this.enabled())
    return [...this.declarations.values()].map((declaration) => {
      const entry = this.implementations.get(declaration.provider)
      const describe = entry?.descriptor.describe?.()
      return {
        id: declaration.provider,
        contract: `${TOTP}@${declaration.version}`,
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
  protected entry(id: string): TotpProvider | undefined {
    return this.implementations.get(id)?.descriptor
  }
}

/**
 * The default implementation of the definition: it walks the ENABLED providers
 * in order and answers through the first one that is registered. The walk is
 * the definition's own logic (no key handling), so providers stay replaceable:
 * swapping the enabled provider swaps the whole backend and the consumers never
 * notice.
 */
export class Totp extends TotpService {
  /** The provider that answers: first enabled AND registered one. */
  protected answering(): TotpProvider {
    const enabled = this.enabled()
    for (const id of enabled) {
      const provider = this.entry(id)
      if (provider) return provider
    }
    const declared = enabled.length > 0 ? enabled.join(', ') : 'none'
    throw new TotpNotConfiguredError(
      `no totp provider is available (enabled: ${declared}); enable a provider plugin and configure it, ` +
        `then select it with the 'totp' section of the config (or leave that section out to use every declared provider)`,
    )
  }

  async entries(): Promise<TotpEntryInfo[]> {
    return await this.answering().entries()
  }

  async code(label: string, options: TotpCodeOptions = {}): Promise<TotpCode> {
    const name = normalizeEntryLabel(label)
    const at = normalizeAt(options.at)
    const result = await this.answering().code(name, { at })
    if (!result || typeof result.code !== 'string' || result.code.length === 0) {
      throw new Error(`totp: provider '${this.enabled().join(', ') || 'none'}' returned no code for '${name}'`)
    }
    return result
  }
}

/**
 * Typed handle for every consumer/provider module: `ctx.totp`. Consumers
 * import the DEFINITION (never a provider) and get full typing from this.
 */
/** The structural context slice a consumer uses to reach the service. */
export interface TotpContext {
  totp: TotpService
}
