// definitions/support.ts - the shared runtime infrastructure of the service
// DEFINITIONS of this repository.
//
// Why this module exists: in workbench the three-role seam is
// `Provider -> Definition <- Consumer`, and the Definition is normally a core
// module (the core hosts `ctx.credentials`, `ctx.web`, `ctx.email`, `ctx.totp`
// and `ctx.sms`). This repository is an EXTERNAL plugin source and must not
// change the core, so the Definitions of the service/transport stack described
// in docs/SERVICES.md live HERE and are consumed by the provider and consumer
// plugins through ordinary relative imports. Everything they need from the host
// is expressed STRUCTURALLY in this file: no plugin of this repository imports
// `cordis` and no plugin has to know how the core is built.
//
// What a Definition gets from this module:
//   - the structured error taxonomy every service of this repository throws
//     (a caller branches on `error.code`, never on a message);
//   - the service-lookup helpers (`provideService`, `serviceOf`, `requireService`,
//     `waitForServices`) that make a provider REPLACEABLE and a consumer's
//     transport selection CONFIG DRIVEN instead of a hard injection;
//   - the shell-quoting / output-capping / display-redaction helpers the
//     transport Definitions and their providers share;
//   - the manifest POLICY gate (`assertPolicyDeclared`): a plugin that can reach
//     host execution must say so in its own manifest, and it verifies that
//     declaration at apply time.
import fs from 'node:fs'
import path from 'node:path'
import type { LoggerServiceLike } from './logger.ts'

/** A credential reference: a NAME (plus an optional scope), never a value. */
export interface CredentialRef {
  name: string
  scope?: string
}

/** The consumer-visible subset of the core `credentials@1` capability. */
export interface CredentialsLike {
  resolve(ref: CredentialRef): Promise<{ value?: string } | undefined>
}

/**
 * The structural view of the cordis context a plugin of this repository uses.
 * Only the members below are relied on (a test context implements exactly them).
 */
export interface ServiceContext {
  /** Declare a service: `ctx.provide(name, value)`. */
  provide?(name: string, value: unknown): unknown
  /** Read a service by name WITHOUT inject: `ctx.get(name, false)`. */
  get?(name: string, strict?: boolean): unknown
  /** Subscribe to a host event (used: `internal/service`). */
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  /** Register a disposer with the owning plugin fiber. */
  effect?(callback: () => () => void): unknown
  /**
   * Deferred dependency declaration: `ctx.inject(['web'], (injected) => ...)`.
   * A service named in the list may be provided LATER (a provider plugin loads
   * after the consumer), so a consumer never reads it as a bare property;
   * `injected.<name>` is the seam once cordis has it. Absent on a bare test
   * context, which hands the seam in directly instead.
   */
  inject?(deps: string[], callback: (injected: ServiceContext) => void): unknown
  /** The credentials capability, when the deployment has it. */
  credentials?: CredentialsLike
  /**
   * The logger SERVICE (`logger@1`, definitions/logger.ts). The host installs
   * it on every context (cordis ships the service), so it is normally present;
   * a plugin never calls it directly - it uses `loggerOf(ctx, name)` for
   * emitting and `mountExporter(...)` for sinking, both from that module.
   */
  logger?: LoggerServiceLike
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// The error taxonomy. Every failure of every service of this repository is a
// `ServiceError` (or a subclass), so a consumer can branch on `code` and a tool
// answer can stay structured instead of becoming a crash.
// ---------------------------------------------------------------------------

export type ServiceErrorCode =
  /** The service/plugin exists but the deployment did not configure it. */
  | 'not-configured'
  /** A service the config needs is not loaded (naming it is the whole point). */
  | 'missing-service'
  /** The config `type` is not one of the implemented types. */
  | 'unsupported-type'
  /** The config of a type is structurally invalid. */
  | 'invalid-config'
  /** The caller passed an argument the contract cannot use (bad id, empty value). */
  | 'invalid-input'
  /** The launcher process could not be started (binary missing, ...). */
  | 'spawn-failed'
  /** The command exceeded its bounded timeout and was killed. */
  | 'timeout'
  /** The command ran and exited non-zero. */
  | 'non-zero-exit'
  /** The target (host/container/URL) could not be reached. */
  | 'unreachable'
  /** The transport does not support what the call asked of it (no leak. no fallback). */
  | 'unsupported'
  /** A PROVIDER cannot honour the config it was handed (no instance API, ...). */
  | 'unsupported-provider'
  /** The backend answered with something the Definition cannot parse. */
  | 'malformed-output'
  /** A credential was required but the transport cannot deliver it safely. */
  | 'credential-unsupported'
  /** The plugin's own manifest does not declare the policy it needs to run. */
  | 'policy'

export interface ServiceErrorOptions {
  /** Where in the call chain the failure happened (e.g. `shell.run`). */
  stage?: string
  /** Structured details: `{ missing: 'docker', ... }`. Never a credential value. */
  details?: Record<string, unknown>
}

/** The one error shape every service of this repository throws. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode
  readonly stage: string
  readonly details: Record<string, unknown>

  constructor(code: ServiceErrorCode, message: string, options: ServiceErrorOptions = {}) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.stage = options.stage ?? 'service'
    this.details = options.details ?? {}
  }

  /** A JSON-safe view (what a tool answers, what a log line carries). */
  toJSON(): { error: string; code: ServiceErrorCode; stage: string; details: Record<string, unknown> } {
    return { error: this.message, code: this.code, stage: this.stage, details: this.details }
  }
}

/** The error text of anything thrown, without ever inspecting its content. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Wraps anything thrown into a {@link ServiceError} with the given default code. */
export function asServiceError(error: unknown, code: ServiceErrorCode, stage: string): ServiceError {
  if (error instanceof ServiceError) return error
  return new ServiceError(code, messageOf(error), { stage })
}

// ---------------------------------------------------------------------------
// Service lookup. A provider REPLACES another by config alone, so a consumer
// resolves the service by NAME at call time instead of hard-injecting it.
// ---------------------------------------------------------------------------

/** Declares `value` as the service `name` on the host context. */
export function provideService(ctx: ServiceContext, name: string, value: unknown): void {
  if (typeof ctx.provide !== 'function') {
    throw new ServiceError('missing-service', `the host context cannot provide '${name}' (ctx.provide is missing)`, {
      stage: 'provide',
      details: { service: name },
    })
  }
  ctx.provide(name, value)
}

/**
 * The service `name`, when the deployment has it. Uses the host's non-strict
 * lookup (`ctx.get(name, false)`), so asking for a service that is NOT loaded is
 * a normal answer (`undefined`) and never an inject deadlock: that is what makes
 * a config of type `ssh` work while no docker transport is loaded.
 */
export function serviceOf<T>(ctx: ServiceContext, name: string): T | undefined {
  if (typeof ctx.get !== 'function') return undefined
  return (ctx.get(name, false) as T | undefined) ?? undefined
}

/**
 * The credentials capability of the deployment, or undefined. It is looked up
 * TWICE on purpose: a property access (`ctx.credentials`) is gated by the
 * host's inject rule, so a plugin that does not declare it may throw - in that
 * case the non-strict lookup (`ctx.get('credentials', false)`) still answers.
 * Credential access is always OPTIONAL here: a deployment without the
 * capability is a `credential-unsupported` error at call time, never a load
 * failure.
 */
export function credentialsOf(ctx: ServiceContext): CredentialsLike | undefined {
  try {
    const direct = ctx.credentials
    if (direct !== undefined && typeof direct.resolve === 'function') return direct
  } catch {
    /* inject-gated property access: fall through to the non-strict lookup */
  }
  const viaLookup = serviceOf<CredentialsLike>(ctx, 'credentials')
  return viaLookup !== undefined && typeof viaLookup.resolve === 'function' ? viaLookup : undefined
}

/** The service `name`, or a structured `missing-service` error naming it. */
export function requireService<T>(ctx: ServiceContext, name: string, hint?: string): T {
  const service = serviceOf<T>(ctx, name)
  if (service === undefined) {
    throw new ServiceError('missing-service', `service '${name}' is not loaded${hint === undefined ? '' : ` (${hint})`}`, {
      stage: 'lookup',
      details: { service: name },
    })
  }
  return service
}

export interface WaitOptions {
  /** Hard bound in ms (default 1500). The wait NEVER hangs. */
  timeoutMs?: number
  /** Fallback poll interval in ms (default 100); an `internal/service` event wakes it earlier. */
  pollMs?: number
}

export interface WaitReport {
  /** The waited-for names that are loaded now. */
  loaded: string[]
  /** The waited-for names that never appeared within the bound. */
  missing: string[]
  /** True when the bound was reached with `missing` non-empty. */
  timedOut: boolean
}

/**
 * SOFT, BOUNDED "load after": resolves as soon as every name is loaded, or when
 * the bound expires (then the missing ones are reported, never thrown). This is
 * an ORDERING HINT, not a dependency: a plugin that uses it still loads when
 * some of the services never load at all.
 */
export async function waitForServices(
  ctx: ServiceContext,
  names: readonly string[],
  options: WaitOptions = {},
): Promise<WaitReport> {
  const timeoutMs = options.timeoutMs ?? 1500
  const pollMs = options.pollMs ?? 100
  const pending = new Set(names)
  const reportOf = (): WaitReport => {
    const loaded: string[] = []
    const missing: string[] = []
    for (const name of names) {
      if (serviceOf(ctx, name) === undefined) missing.push(name)
      else loaded.push(name)
    }
    return { loaded, missing, timedOut: missing.length > 0 }
  }
  const immediately = reportOf()
  if (immediately.missing.length === 0) return immediately

  await new Promise<void>((resolve) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    const finish = (): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      if (interval !== undefined) clearInterval(interval)
      resolve()
    }
    const check = (): void => {
      for (const name of [...pending]) if (serviceOf(ctx, name) !== undefined) pending.delete(name)
      if (pending.size === 0) finish()
    }
    ctx.on?.('internal/service', check)
    // NOT unref'd on purpose: an unref'd timer lets the event loop drain while
    // boot is still awaiting a service that is about to be provided, and Node
    // then aborts the whole process with "unsettled top-level await"
    // (exit code 13) instead of performing the BOUNDED wait below.
    interval = setInterval(check, pollMs)
    timer = setTimeout(finish, timeoutMs)
    check()
  })
  return reportOf()
}

// ---------------------------------------------------------------------------
// Shell-safety and display helpers, shared by the transport Definitions.
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escaping: the result is a single shell WORD that the shell
 * expands back to `value` verbatim, whatever it contains (spaces, quotes, `$`,
 * backticks, pipes, newlines). This is the ONLY way a caller-supplied string
 * reaches a shell in this repository.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/** One command's bounded result, as every transport returns it. */
export interface CommandResult {
  /** Captured stdout (bounded; see `truncated`). */
  output: string
  /** Exit code, or null when the process was killed (timeout) or never started. */
  code: number | null
  /** Captured stderr, when the transport has any (bounded the same way). */
  stderr?: string
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number
  /** True when the byte cap cut the output: the answer is INCOMPLETE on purpose. */
  truncated?: boolean
}

/** Per-call bounds a transport honours (defaults come from its config). */
export interface CommandOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  cwd?: string
  /** Extra environment for the CHILD process (local shell only; values never logged). */
  env?: Record<string, string>
}

/** Caps `text` at `maxBytes` (UTF-8), reporting whether it was cut. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text, truncated: false }
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, truncated: false }
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/**
 * The display form of a launcher argv: values listed in `secrets` are masked.
 * Used for logs and for the safety evidence; NEVER log the raw argv of a call
 * that carries a resolved credential.
 */
export function redactArgv(argv: readonly string[], secrets: readonly (string | undefined)[] = []): string {
  const known = secrets.filter((value): value is string => typeof value === 'string' && value.length > 0)
  return argv
    .map((arg) => {
      let shown = arg
      for (const secret of known) shown = shown.split(secret).join('***')
      return shown
    })
    .join(' ')
}

/** Positive integer or the fallback (bounded by `max` when given). */
export function positiveInt(value: unknown, fallback: number, max?: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  const floored = Math.floor(number)
  return max === undefined ? floored : Math.min(floored, max)
}

/** A trimmed non-empty string, or undefined. */
export function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A shallow record guard. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// The manifest POLICY gate.
//
// A plugin that can execute on the workbench HOST (directly or through a
// service) must DECLARE that in its own manifest, and it verifies the
// declaration at apply time: without it the plugin refuses to load instead of
// silently running commands on the host. See docs/SERVICES.md, "Execution
// policy".
// ---------------------------------------------------------------------------

/** How far from the workbench host a plugin's commands can reach. */
export type ExecutionClass = 'host' | 'remote' | 'none'

export interface ExecutionPolicy {
  /** The execution class the plugin claims. */
  execution: ExecutionClass
  /**
   * Capability names whose `provide`/`require` policy the manifest must
   * declare, e.g. `['shell']` for a plugin that can reach the host shell.
   */
  capabilities: readonly string[]
}

interface ManifestShape {
  name?: string
  execution?: string
  policies?: Record<string, { provide?: unknown; require?: unknown }>
}

/** Reads the plugin manifest that sits next to `moduleUrl` (the entry module). */
export function readSiblingManifest(moduleUrl: string): ManifestShape {
  const dir = path.dirname(new URL(moduleUrl).pathname)
  const file = path.join(dir, 'workbench.plugin.json')
  if (!fs.existsSync(file)) {
    throw new ServiceError('policy', `plugin manifest not found next to the entry module: ${file}`, { stage: 'manifest' })
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestShape
}

/**
 * Enforces the execution policy of the CALLING plugin (its own manifest),
 * returning it when it is declared. Called from `apply()`, so a plugin that
 * reaches host execution without declaring the policy FAILS TO LOAD.
 */
export function assertPolicyDeclared(moduleUrl: string, expected: ExecutionPolicy): ManifestShape {
  const manifest = readSiblingManifest(moduleUrl)
  if (manifest.execution !== expected.execution) {
    throw new ServiceError(
      'policy',
      `the plugin manifest must declare "execution": "${expected.execution}" (found ${JSON.stringify(manifest.execution ?? null)}); ` +
        'a plugin that can execute commands must state where they run before it is loaded',
      { stage: 'manifest', details: { plugin: manifest.name, execution: expected.execution } },
    )
  }
  for (const capability of expected.capabilities) {
    const policy = manifest.policies?.[capability]
    const provide = str(policy?.provide)
    const require = str(policy?.require)
    if (provide === undefined || require === undefined) {
      throw new ServiceError(
        'policy',
        `the plugin manifest must declare "policies": { "${capability}": { "provide": "<contract>", "require": "<contract>" } }; ` +
          'the plugin only loads when a policy requiring the provider contract is in effect',
        { stage: 'manifest', details: { plugin: manifest.name, capability } },
      )
    }
  }
  return manifest
}
