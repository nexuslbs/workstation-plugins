// External workbench plugin: a TOTP SERVICE PROVIDER implemented entirely
// OUTSIDE the core repository (no core module is imported here; the core
// injects `ctx.totp` and this plugin only registers an implementation of the
// published contract `totp@1`, core `docs/PLUGIN-CONTRACT.md` section 4f).
//
// The manifest declares the capability, which is what makes `ctx.totp.register`
// legal:
//
//   "capabilities": [{ "id": "totp", "version": 1, "provider": "rfc6238" }]
//
// The algorithm comes from the RFCs and from nothing else:
// - RFC 4226 (HOTP) section 5.2: `K` is the shared secret, `C` the counter as an
//   8-byte big-endian integer, `HMAC(K, C)` the digest.
//   section 5.3 DYNAMIC TRUNCATION: `offset = low 4 bits of the LAST digest
//   byte`, `binary = the 31 bits starting at offset`, `HOTP = binary mod
//   10^digits` (the 31st bit is masked off so the result is never negative).
//   section 5.4: `digits` is 6 by default.
// - RFC 6238 (TOTP) section 4.2: the counter is `T = floor((now - T0) / X)`
//   with `T0 = 0` (unix epoch) and `X` the period in seconds (30 by default);
//   section 4.2 also states that a validator typically accepts +/- one time
//   step, which is why a REAL verifier can accept the previous/next code. This
//   plugin never shifts the clock: `code(label, { at })` answers for exactly the
//   second the caller named (default: now), so a boundary is the caller's
//   decision. `remainingSeconds` is the seconds left in the current step.
//   The published test vectors (appendix B, SHA1/256/512) are exercised in
//   test/totp-rfc6238.test.ts.
//
// Secrets: an entry names its key either as a `credential` (a credential NAME,
// resolved at CALL time through `ctx.credentials`, so a credential that is
// missing or empty leaves the plugin LOADED with that entry NOT CONFIGURED) or
// as a literal `secret` in base32 (a `${cred:NAME}` reference in the config row
// is expanded by the core BEFORE `apply`, the preferred form; a literal key is
// supported because the row belongs to the operator). Either way the key VALUE
// never leaves this module: it is never logged, never returned and never part of
// `entries()` - only the generated code is. The README states plainly that
// committing a real key is forbidden.
import { loggerOf } from '../../definitions/logger.ts'
import { createHmac } from 'node:crypto'

export const name = 'totp-rfc6238'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'rfc6238'

/** Contract version implemented (the core speaks `totp@1`). */
export const CONTRACT_VERSION = 1

/** RFC 6238 defaults, identical to the core definition's. */
export const DEFAULT_DIGITS = 6
export const DEFAULT_PERIOD = 30
export const DEFAULT_ALGORITHM = 'SHA1'

/** Bounds mirrored from the core definition (a provider must agree with it). */
export const MIN_DIGITS = 4
export const MAX_DIGITS = 10
export const MIN_PERIOD = 1
export const MAX_PERIOD = 3600

/** The HMAC hash functions the contract allows (RFC 6238 appendix B). */
export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512'
export const ALGORITHMS: readonly Algorithm[] = ['SHA1', 'SHA256', 'SHA512']

/** One configured entry, exactly as an operator writes it under `entries:`. */
export interface EntryConfig {
  /** Literal base32 key, OR the value a `${cred:NAME}` reference expanded to. */
  secret?: string
  /** Credential NAME (`ctx.credentials`), resolved at call time; never a value. */
  credential?: string
  /** Free metadata: who issued the key (reported by `entries()`, never a secret). */
  issuer?: string
  /** Free metadata: which account the key belongs to (reported, never a secret). */
  account?: string
  /** Code length, 4..10; default 6 (RFC 4226 section 5.4). */
  digits?: number
  /** Time step in seconds, 1..3600; default 30 (RFC 6238 section 4.2). */
  period?: number
  /** HMAC hash function; default SHA1. */
  algorithm?: string
}

export interface Config {
  /** One entry per name/label, in configuration order. */
  entries?: Record<string, EntryConfig>
}

/** An entry after validation: the shape the descriptor works with. */
export interface ResolvedEntry {
  label: string
  issuer?: string
  account?: string
  digits: number
  period: number
  algorithm: Algorithm
  secret?: string
  credential?: string
}

/**
 * What `entries()` reports: METADATA ONLY (never a key, never a code).
 * `configured` is the TRUTH about resolvability, not merely the presence of a
 * configuration field: a reference that resolves (checked when the plugin
 * loads, and again on every call) reports `true`, a literal key reports `true`,
 * and a reference that does not resolve reports `false`.
 */
export interface EntryInfo {
  label: string
  issuer?: string
  account?: string
  digits: number
  period: number
  algorithm: Algorithm
  configured: boolean
}

/** What `code()` returns (the contract's `TotpCode`). */
export interface CodeResult {
  label: string
  code: string
  digits: number
  period: number
  algorithm: Algorithm
  generatedAt: number
  remainingSeconds: number
}

/** The provider surface `ctx.totp.register` accepts (the contract's shape). */
export interface ProviderLike {
  id: string
  version: number
  describe?(): string
  entries(): EntryInfo[]
  code(label: string, options?: { at?: number }): CodeResult | Promise<CodeResult>
}

/** Credential resolution, as `ctx.credentials` offers it (never a value list). */
interface CredentialsLike {
  resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> | { value?: string } | undefined
}

/** The context surface this plugin uses (no core import, no provider registry). */
interface PluginContext {
  totp: { register(provider: ProviderLike): () => void }
  credentials?: CredentialsLike
  effect(callback: () => () => void): void
}

/**
 * The core's credential-reference spelling, `${cred:NAME}` (or
 * `${cred:SCOPE/NAME}`), as `docs/CREDENTIALS.md` defines it.
 *
 * WHY A PROVIDER SEES ONE: the kernel expands `${cred:...}` references in the
 * `plugins:` rows of the plugins it applies AFTER its capability-provider phase,
 * and a capability PROVIDER is applied in that first phase (its services must
 * exist before the consumers can be configured). A `secret: ${cred:NAME}` in a
 * provider row therefore arrives here UNEXPANDED, and this plugin resolves it
 * itself, at CALL time. That also keeps contract rule 6 (see the file header):
 * an unresolvable reference leaves the plugin LOADED with that entry NOT
 * configured, instead of failing the whole load.
 */
const CREDENTIAL_REF = /^\$\{cred:([^}]+)\}$/

/**
 * The credential NAME a configured value references, or `undefined` when the
 * value is a LITERAL key. Never returns a value this plugin produced.
 */
export function credentialRefName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = CREDENTIAL_REF.exec(value.trim())
  if (!match) return undefined
  const body = (match[1] ?? '').trim()
  return body.length === 0 ? undefined : body
}

/**
 * Splits a credential NAME into the reference `ctx.credentials.resolve` takes:
 * `NAME` stays unscoped, `SCOPE/NAME` gains a scope. A malformed scope is
 * treated as part of the name (the credentials service decides).
 */
function parseCredentialName(name: string): { name: string; scope?: string } {
  const slash = name.indexOf('/')
  if (slash <= 0 || slash === name.length - 1) return { name }
  return { name: name.slice(slash + 1), scope: name.slice(0, slash) }
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decodes a base32 key (RFC 4648 alphabet `A-Z2-7`), tolerating lower case,
 * embedded whitespace and `=` padding - the spellings an authenticator app or a
 * `otpauth://` URI may hand over. The error NEVER echoes the input (a key is not
 * error text): it names the offending character and its position only.
 */
export function decodeBase32(input: string): Buffer {
  if (typeof input !== 'string') throw new Error('totp-rfc6238: a TOTP key must be a base32 string')
  const text = input.replace(/[\s=]/g, '').toUpperCase()
  if (text.length === 0) throw new Error('totp-rfc6238: a TOTP key must not be empty')
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  for (let index = 0; index < text.length; index += 1) {
    const value = BASE32_ALPHABET.indexOf(text[index] as string)
    if (value < 0) {
      throw new Error(
        `totp-rfc6238: the key is not valid base32 (unexpected character at position ${String(index)}); ` +
          'the alphabet is A-Z2-7',
      )
    }
    accumulator = (accumulator << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 0xff)
    }
  }
  if (bytes.length === 0) throw new Error('totp-rfc6238: the key is too short to be a base32 secret')
  return Buffer.from(bytes)
}

/** The base32 form of raw bytes (used by tests and by the README examples). */
export function encodeBase32(bytes: Buffer): string {
  let accumulator = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(accumulator >> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(accumulator << (5 - bits)) & 0x1f]
  return out
}

/**
 * A key in diagnostic text: never the key itself, only a short redacted shape.
 * Used whenever a message has to mention a key at all.
 */
export function maskSecret(value: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, '') : ''
  if (text.length === 0) return '(empty)'
  if (text.length < 8) return '****'
  return `${text.slice(0, 2)}****${text.slice(-2)} (redacted)`
}

/** The counter as the 8-byte big-endian integer RFC 4226 section 5.2 requires. */
function counterBytes(counter: bigint): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(counter)
  return buffer
}

/** HMAC-SHA1/256/512, lower-cased for `node:crypto`. */
function hmacName(algorithm: Algorithm): string {
  return algorithm.toLowerCase()
}

/**
 * HOTP (RFC 4226 section 5.3): HMAC of the counter, dynamic truncation, modulo
 * `10^digits`, left-padded with zeros.
 */
export function hotp(secret: Buffer, counter: number | bigint, digits: number, algorithm: Algorithm): string {
  const digest = createHmac(hmacName(algorithm), secret).update(counterBytes(BigInt(counter))).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * TOTP (RFC 6238 section 4.2): the counter is `floor(at / period)`, and the
 * answer also carries the seconds left in that step. `at` is unix SECONDS - the
 * clock is used exactly as given, never shifted.
 */
export function totp(
  secret: Buffer,
  at: number,
  period: number = DEFAULT_PERIOD,
  digits: number = DEFAULT_DIGITS,
  algorithm: Algorithm = DEFAULT_ALGORITHM,
): { code: string; step: number; remainingSeconds: number } {
  const step = Math.floor(at / period)
  return {
    code: hotp(secret, step, digits, algorithm),
    step,
    remainingSeconds: period - (at % period),
  }
}

/** Validates/normalises `algorithm` against the contract's three hash functions. */
export function normalizeAlgorithm(algorithm: unknown): Algorithm {
  if (algorithm === undefined || algorithm === null) return DEFAULT_ALGORITHM
  const text = typeof algorithm === 'string' ? algorithm.trim().toUpperCase() : ''
  if (!ALGORITHMS.includes(text as Algorithm)) {
    throw new Error(`totp-rfc6238: 'algorithm' must be one of ${ALGORITHMS.join('/')} (got ${JSON.stringify(algorithm)})`)
  }
  return text as Algorithm
}

function normalizeDigits(digits: unknown): number {
  if (digits === undefined || digits === null) return DEFAULT_DIGITS
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS) {
    throw new Error(`totp-rfc6238: 'digits' must be an integer in ${MIN_DIGITS}..${MAX_DIGITS} (got ${JSON.stringify(digits)})`)
  }
  return digits
}

function normalizePeriod(period: unknown): number {
  if (period === undefined || period === null) return DEFAULT_PERIOD
  if (typeof period !== 'number' || !Number.isInteger(period) || period < MIN_PERIOD || period > MAX_PERIOD) {
    throw new Error(`totp-rfc6238: 'period' must be an integer in ${MIN_PERIOD}..${MAX_PERIOD} seconds (got ${JSON.stringify(period)})`)
  }
  return period
}

/** One optional metadata field: a trimmed non-empty string, or `undefined`. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Validates the `entries` row of the config into the entries this plugin serves. */
export function normalizeEntries(config: Config = {}): ResolvedEntry[] {
  const row = config.entries
  if (row === undefined || row === null) return []
  if (typeof row !== 'object' || Array.isArray(row)) {
    throw new Error("totp-rfc6238: 'entries' must be a map of label -> entry, e.g. entries: { github: { credential: TOTP_GITHUB_KEY } }")
  }
  const entries: ResolvedEntry[] = []
  const seen = new Set<string>()
  for (const [rawLabel, rawEntry] of Object.entries(row as Record<string, unknown>)) {
    const label = rawLabel.trim()
    if (label.length === 0) throw new Error('totp-rfc6238: an entry label must be a non-empty string')
    if (seen.has(label)) throw new Error(`totp-rfc6238: the entry label '${label}' is declared twice`)
    seen.add(label)
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`totp-rfc6238: the entry '${label}' must be a map, e.g. { credential: NAME } or { secret: BASE32 }`)
    }
    const entry = rawEntry as EntryConfig
    const secret = optionalText(entry.secret)
    const credential = optionalText(entry.credential)
    entries.push({
      label,
      ...(optionalText(entry.issuer) === undefined ? {} : { issuer: optionalText(entry.issuer) as string }),
      ...(optionalText(entry.account) === undefined ? {} : { account: optionalText(entry.account) as string }),
      digits: normalizeDigits(entry.digits),
      period: normalizePeriod(entry.period),
      algorithm: normalizeAlgorithm(entry.algorithm),
      ...(secret === undefined ? {} : { secret }),
      ...(credential === undefined ? {} : { credential }),
    })
  }
  return entries
}

/** ONE entry plus the runtime state the plugin tracks for it. */
export interface RuntimeEntry {
  entry: ResolvedEntry
  /** The credential NAME this entry's key comes from, when it is a reference. */
  reference?: string
  /** TRUE only when a real key is available (literal, or a resolved reference). */
  configured: boolean
  /** Why the key is unavailable; NEVER a key, only a name/mask. */
  reason?: string
}

/** The credential NAME an entry's key comes from, or `undefined` for a literal. */
export function referenceOf(entry: ResolvedEntry): string | undefined {
  if (entry.credential !== undefined) return entry.credential
  return entry.secret === undefined ? undefined : credentialRefName(entry.secret)
}

/** The metadata of one entry (never a secret). */
function infoOf(runtime: RuntimeEntry): EntryInfo {
  const entry = runtime.entry
  return {
    label: entry.label,
    ...(entry.issuer === undefined ? {} : { issuer: entry.issuer }),
    ...(entry.account === undefined ? {} : { account: entry.account }),
    digits: entry.digits,
    period: entry.period,
    algorithm: entry.algorithm,
    configured: runtime.configured,
  }
}

/**
 * A structured "unknown entry" error: the same shape the core definition's
 * `TotpUnknownEntryError` carries (this plugin cannot import the core class, so
 * it reproduces name + label + known so a caller can branch on either).
 */
export function unknownEntryError(label: string, known: string[]): Error {
  const error = new Error(`totp: unknown entry '${label}' (configured: ${known.length ? known.join(', ') : 'none'})`)
  error.name = 'TotpUnknownEntryError'
  return Object.assign(error, { label, known })
}

/**
 * A structured "entry not configured" error (the core's
 * `TotpEntryNotConfiguredError` shape). It never carries a key: an unusable key
 * is reported with {@link maskSecret} or by naming the credential.
 */
export function notConfiguredError(label: string, reason: string): Error {
  const error = new Error(`totp: entry '${label}' is not configured: ${reason}`)
  error.name = 'TotpEntryNotConfiguredError'
  return Object.assign(error, { label, reason })
}

/**
 * The plugin entrypoint. Contract rule 6: a MISSING `entries` row is not a
 * failure - the plugin loads, reports NOT CONFIGURED and registers nothing. An
 * entry whose key cannot be resolved keeps the plugin loaded too and reports
 * `configured: false`; only a call for THAT entry fails.
 *
 * `apply` is ASYNC because a credential REFERENCE is resolved once while
 * loading, so `entries()` reports resolvability truthfully instead of merely
 * echoing the configuration. It never throws on a missing credential: a failed
 * resolution is logged (credential NAME only, never a value) and the entry is
 * marked not configured.
 */
export async function apply(ctx: PluginContext, config: Config = {}): Promise<void> {
  const entries = normalizeEntries(config)
  if (entries.length === 0) {
    loggerOf(ctx, name).error(
      "not configured (no 'entries' in plugins.totp-rfc6238) - provider 'rfc6238' is declared by the " +
        "manifest and registers nothing; add at least one entry, e.g. entries: { github: { credential: TOTP_GITHUB_KEY } }",
    )
    return
  }

  const runtimes: RuntimeEntry[] = entries.map((entry) => {
    const reference = referenceOf(entry)
    const hasKey = reference !== undefined || entry.secret !== undefined
    return {
      entry,
      ...(reference === undefined ? {} : { reference }),
      // An entry with NEITHER a credential NOR a literal key is not configured:
      // it loads (the plugin stays loaded) but only a call for it fails.
      configured: hasKey && reference === undefined,
    }
  })

  /**
   * The key of one entry as bytes. A REFERENCE is resolved through
   * `ctx.credentials` at CALL time (a credential that appears after load starts
   * working, and one that is missing never affects another entry); a literal base32
   * key is decoded directly. Every failure names the credential NAME or a MASKED
   * key - never a value.
   */
  const keyOf = async (runtime: RuntimeEntry): Promise<Buffer> => {
    const { entry, reference } = runtime
    if (reference !== undefined) {
      const credentials = ctx.credentials
      if (!credentials) {
        throw notConfiguredError(
          entry.label,
          `credential '${reference}' cannot be resolved (the credentials capability is not available)`,
        )
      }
      const resolution = await credentials.resolve(parseCredentialName(reference))
      const value = resolution?.value
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw notConfiguredError(entry.label, `credential '${reference}' did not resolve to a value`)
      }
      try {
        return decodeBase32(value)
      } catch (error) {
        throw notConfiguredError(
          entry.label,
          `credential '${reference}' is not a base32 key (${messageOf(error)})`,
        )
      }
    }
    if (entry.secret === undefined) {
      throw notConfiguredError(entry.label, "the entry declares neither a 'credential' nor a 'secret'")
    }
    const secret = entry.secret
    try {
      return decodeBase32(secret)
    } catch (error) {
      throw notConfiguredError(
        entry.label,
        `the configured key ${maskSecret(secret)} is not a base32 key (${messageOf(error)})`,
      )
    }
  }

  // Best-effort resolution while loading: `entries()` then tells the truth about
  // every entry instead of repeating its configuration.
  for (const runtime of runtimes) {
    if (runtime.reference === undefined) continue
    try {
      await keyOf(runtime)
      runtime.configured = true
    } catch (error) {
      runtime.reason = messageOf(error)
      loggerOf(ctx, name).error(runtime.reason)
    }
  }

  ctx.effect(() =>
    ctx.totp.register({
      id: providerId,
      version: CONTRACT_VERSION,
      describe: () =>
        `RFC 6238 TOTP over HMAC (${ALGORITHMS.join('/')}), ${String(runtimes.filter((runtime) => runtime.configured).length)}/${String(runtimes.length)} entr${runtimes.length === 1 ? 'y' : 'ies'} configured: ${runtimes.map((runtime) => runtime.entry.label).join(', ')}`,
      entries: () => runtimes.map(infoOf),
      code: async (label: string, options: { at?: number } = {}): Promise<CodeResult> => {
        const name = typeof label === 'string' ? label.trim() : ''
        const runtime = runtimes.find((candidate) => candidate.entry.label === name)
        if (!runtime) throw unknownEntryError(name, runtimes.map((candidate) => candidate.entry.label))
        const entry = runtime.entry
        const key = await keyOf(runtime)
        runtime.configured = true
        delete runtime.reason
        const at = options.at ?? Math.floor(Date.now() / 1000)
        const { code, remainingSeconds } = totp(key, at, entry.period, entry.digits, entry.algorithm)
        return {
          label: entry.label,
          code,
          digits: entry.digits,
          period: entry.period,
          algorithm: entry.algorithm,
          generatedAt: at,
          remainingSeconds,
        }
      },
    }),
  )
}

/** Readable text of anything thrown (never contains a key). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// `credentials` is INJECTED (and required) because the provider resolves the
// credential references of its own rows: without the declaration cordis refuses
// the `ctx.credentials` access outright ("cannot get property credentials without
// inject"). The core always registers the credentials service.
export default { name, inject: ['totp', 'credentials'], apply }
