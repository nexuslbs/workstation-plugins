/**
 * Credentials capability - SERVICE DEFINITION in the DSH shape.
 *
 * The deepseek-harness ships its own credentials service
 * (`@deepseek-ai/dsh-credentials-local`, registered as `ctx.credentials`), so
 * this repository does NOT provide a provider backend for it: the file below
 * carries the CONSUMER contract (the types/schemas a plugin of this repository
 * relies on) and the structural view of the harness service, exactly like the
 * other definitions of this repository are cordis-free and structural.
 *
 *   Provider (the harness)  ->  Definition  <-  Consumer (a plugin here)
 *
 * The harness service resolves credential NAMEs at call time:
 *
 *   const resolution = await ctx.credentials.resolve({ name: 'TWILIO_AUTH_TOKEN' })
 *   // resolution = { value: '...', source: 'file' } | undefined
 *
 * There is NO `${cred:NAME}` kernel expansion in the harness: a config value
 * that names a credential is a NAME and is resolved through `ctx.credentials`
 * by the plugin that needs it, never by string substitution before `apply`.
 */

/** Name of the service the host injects (`ctx.credentials`). */
export const CREDENTIALS = 'credentials'

/** Contract version this definition speaks. A provider must implement it. */
export const CREDENTIALS_VERSION = 1

/** Contract id including the version, e.g. `credentials@1`. */
export const CREDENTIALS_CONTRACT = `${CREDENTIALS}@${CREDENTIALS_VERSION}`

/** A reference to a credential. It names a credential, it never carries a value. */
export interface CredentialRef {
  /** Credential name, e.g. `deploy-token`. Never a value. */
  name: string
  /** Optional scope/namespace; only providers that support scopes use it. */
  scope?: string
}

/** The credential key the harness record store addresses (`readRecord`). */
export type CredentialKey = string

/** A successful resolution: the value plus where it came from. */
export interface ResolvedCredential {
  /** The credential value. Callers must not log, echo or persist it. */
  value: string
  /** Where the value came from (e.g. `file`, `env`, `store`). */
  source?: string
}

/** One stored credential record, as the harness record store reports it. */
export interface CredentialRecord {
  /** The record key (a NAME, never a value). */
  key: CredentialKey
  /** The credential value. Callers must not log, echo or persist it. */
  value?: string
  /** Record metadata (never contains a value). */
  [field: string]: unknown
}

/** Reference label used in messages: `name` or `scope/name`. Never a value. */
export function refLabel(ref: CredentialRef): string {
  return ref.scope ? `${ref.scope}/${ref.name}` : ref.name
}

/** Validates a reference; only names appear in errors, never values. */
export function assertRef(ref: CredentialRef): void {
  if (!ref || typeof ref.name !== 'string' || ref.name.length === 0) {
    throw new Error('credentials: a credential reference needs a non-empty name')
  }
  if (ref.scope !== undefined && (typeof ref.scope !== 'string' || ref.scope.length === 0)) {
    throw new Error(`credentials: the scope of '${ref.name}' must be a non-empty string`)
  }
}

/** Parses a reference spec: `NAME` or `SCOPE/NAME` (names only, never values). */
export function parseCredentialRef(spec: string): CredentialRef {
  const body = spec.trim()
  if (body.length === 0) throw new Error('credentials: an empty credential reference is not allowed')
  const separator = body.indexOf('/')
  if (separator < 0) return { name: body }
  const scope = body.slice(0, separator).trim()
  const name = body.slice(separator + 1).trim()
  if (scope.length === 0 || name.length === 0) {
    throw new Error(`credentials: malformed reference '${spec}' (expected NAME or SCOPE/NAME)`)
  }
  return { scope, name }
}

/**
 * The CONSUMER slice of the harness credentials capability: what a plugin of
 * this repository calls. `resolve` returns the first value the harness can
 * answer for the NAME; `readRecord` reads one stored record by key. A
 * deployment without the capability is a `credential-unsupported` error at
 * call time, never a load failure.
 */
export interface CredentialsLike {
  /** Resolves a reference through the harness providers (first answering wins). */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  /** Reads one stored credential record by key (names only, never values). */
  readRecord?(key: CredentialKey): Promise<CredentialRecord | undefined>
  /** Credential NAMEs the deployment can answer (names only). */
  list?(): Promise<string[]>
}

/** The full service shape the HARNESS injects as `ctx.credentials`. */
export interface CredentialsService extends CredentialsLike {
  /** What each enabled provider did for a reference (no values). */
  explain?(ref: CredentialRef): Promise<unknown>
  /** Enabled provider ids, in precedence order. */
  enabled?(): string[]
}

/**
 * The slice of the HOSTING context a consumer plugin needs. Structural on
 * purpose: this repository never imports the harness's cordis, so the plugin
 * is usable with any host that honours the published contract (the harness
 * injects `credentials`).
 */
export interface CredentialsContext {
  credentials?: CredentialsLike
  get?(name: string, strict?: boolean): unknown
  [key: string]: unknown
}