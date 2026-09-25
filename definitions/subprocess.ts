// definitions/subprocess.ts - the LOCAL COMMAND EXECUTION capability (`subprocess@1`).
//
// WHY THIS MODULE EXISTS: workbench can already run a command THROUGH a transport
// (`general-service@1`: container / ssh / http / the opt-in local `shell@1`), but
// there is no seam for the most basic act of running a bounded LOCAL process and
// getting a structured answer about it. `subprocess@1` is that seam:
//
//        Provider  ->  Definition  <-  Consumer
//   core/subprocess-local            plugins/subprocess-tools
//   (node:child_process, setsid)     (the `subprocess run` named tool)
//
// It differs from `shell@1` on purpose, and the difference is the SAFETY MODEL:
//
//   * `shell@1` takes ONE COMMAND STRING and hands it to a shell
//     (`<shell> -c <input>`), because a transport's job is to carry an operator's
//     command line to a TARGET machine;
//   * `subprocess@1` takes an ARGV ARRAY and starts it DIRECTLY - no host shell,
//     no word splitting, no globbing, no expansion, exactly like `execFile` in
//     `lib/process.ts`. A caller that really wants a shell asks for it with
//     `shell: true`, and then the command string is ONE `/bin/sh -c <command>`
//     invocation, never a host-side re-splitting of the argv array.
//
// SHAPE: modelled on the DeepSeek harness `subprocess` group (MIT,
// `packages/subprocess/*`), whose model this module follows: argv + cwd + explicit
// env overrides + a deadline + a termination grace, bounded/streamed output, and
// termination of the WHOLE managed process range (a child that spawns a child is
// not leaked). What workbench deliberately does NOT take from DSH: the terminal
// sessions, the remote subprocess transports and the model-facing rendering.
// See THIRD_PARTY.md for the MIT notice.
//
// CORDIS-FREE: the plan/validation/ref-resolution helpers of this module are PURE
// functions, and every process and every file lives in the provider.

import {
  ServiceError,
  type ServiceErrorCode,
  credentialsOf,
  isRecord,
  positiveInt,
  serviceOf,
  str,
  type ServiceContext,
} from './support.ts'
import type { SpillRef } from './spill.ts'

/** Name of the cordis service (`ctx.subprocess`). */
export const SUBPROCESS = 'subprocess'

/** Contract version this definition speaks. A provider must implement it. */
export const SUBPROCESS_VERSION = 1

/** Contract id including the version, e.g. `subprocess@1`. */
export const SUBPROCESS_CONTRACT = `${SUBPROCESS}@${SUBPROCESS_VERSION}`

/** Default deadline of one call (30 s). */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000

/** Hard ceiling of a caller-supplied deadline (10 min): a call is ALWAYS bounded. */
export const MAX_SUBPROCESS_TIMEOUT_MS = 10 * 60_000

/** Default inline output cap, applied to stdout and stderr separately (256 KiB). */
export const DEFAULT_SUBPROCESS_MAX_OUTPUT_BYTES = 256 * 1024

/** Hard ceiling of the inline cap (1 MiB); more than that belongs in a spill file. */
export const MAX_SUBPROCESS_MAX_OUTPUT_BYTES = 1024 * 1024

/** Extra bytes the runner keeps BEYOND the inline cap so spill loses nothing (4 MiB). */
export const DEFAULT_SUBPROCESS_OVERFLOW_BYTES = 4 * 1024 * 1024

/** Default grace between SIGTERM and SIGKILL when a process is stopped (500 ms). */
export const DEFAULT_SUBPROCESS_GRACE_MS = 500

/** An environment value that is really a CREDENTIAL reference: `${cred:NAME}`. */
const CRED_REF = /^\$\{cred:([A-Za-z0-9_.:-]+)\}$/

/** An environment value that is really a reference to a variable: `${env:NAME}`. */
const ENV_REF = /^\$\{env:([A-Za-z0-9_]+)\}$/

/** The reasons a call of this capability can fail (branch on `reason`). */
export type SubprocessErrorReason =
  /** The caller passed something the contract cannot use. */
  | 'subprocess.invalid-input'
  /** The executable could not be started (missing binary, bad cwd, EACCES). */
  | 'subprocess.spawn-failed'
  /** A shell was requested but the deployment does not allow one. */
  | 'subprocess.shell-disabled'
  /** A credential/env reference could not be resolved. */
  | 'subprocess.reference-unresolved'
  /** The sandbox handle present in the context refused the command. */
  | 'subprocess.sandbox-denied'
  /** The deployment's own manifest/config forbids what the call asked. */
  | 'subprocess.policy'

export interface SubprocessErrorOptions {
  stage?: string
  details?: Record<string, unknown>
}

/** The one error shape this capability throws (a `ServiceError` subclass). */
export class SubprocessError extends ServiceError {
  readonly reason: SubprocessErrorReason

  constructor(reason: SubprocessErrorReason, message: string, options: SubprocessErrorOptions = {}) {
    super('invalid-input', message, { stage: options.stage ?? 'subprocess', details: { reason, ...options.details } })
    this.name = 'SubprocessError'
    this.reason = reason
  }

  /** A JSON-safe view (what a tool answers, what a log line carries). */
  override toJSON(): {
    error: string
    code: ServiceErrorCode
    stage: string
    reason: SubprocessErrorReason
    details: Record<string, unknown>
  } {
    return { error: this.message, code: this.code, stage: this.stage, reason: this.reason, details: this.details }
  }
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

/** One live output chunk handed to the optional `onStdout`/`onStderr` callbacks. */
export interface SubprocessChunk {
  /** Which stream the bytes came from. */
  stream: 'stdout' | 'stderr'
  /** The decoded chunk (a provider may split on any boundary). */
  text: string
  /** Bytes of this chunk. */
  bytes: number
  /** Bytes seen on this stream SO FAR (the caller's running total). */
  totalBytes: number
}

/** The body of a `run` call. */
export interface SubprocessRunInput {
  /**
   * The command as an ARGV ARRAY (preferred): `["git", "status", "--short"]`.
   * It is started DIRECTLY - no shell, no splitting, no globbing.
   */
  argv?: readonly string[]
  /**
   * The command as ONE STRING. It is only accepted together with
   * `shell: true`; without it the call fails (`subprocess.invalid-input`),
   * because a string cannot be safely split by the workbench host.
   */
  command?: string
  /** Explicit shell escape hatch: run `<shell> -c <command>` (default false). */
  shell?: boolean
  /** Shell binary used when `shell: true` (default `/bin/sh`). */
  shellBinary?: string
  /** Working directory of the child (must exist). */
  cwd?: string
  /** LITERAL environment overrides for the child (never logged). */
  env?: Record<string, string>
  /**
   * Environment entries resolved through the credentials/process environment:
   * a value of the form `${cred:NAME}` is resolved by the `credentials@1`
   * capability, `${env:NAME}` from the process environment, anything else is
   * LITERAL. The resolved VALUE never appears in a log, an error or a result.
   */
  envRefs?: Record<string, string>
  /** Text written to the child's stdin (then closed). */
  stdin?: string
  /** Per-call deadline in ms (default from the provider config, hard-max 10 min). */
  timeoutMs?: number
  /** Inline byte cap of stdout/stderr (default from the provider config). */
  maxOutputBytes?: number
  /** Live output sink; it is called with bounded chunks, never with the whole output. */
  onStdout?: (chunk: SubprocessChunk) => void
  onStderr?: (chunk: SubprocessChunk) => void
  /** Spill output beyond the cap instead of only truncating (default true). */
  spill?: boolean
  /** Short label used for the spill file name (default `subprocess-stdout`). */
  label?: string
}

/** The structured answer of a `run` call (a non-zero exit is a NORMAL result). */
export interface SubprocessResult {
  /** The argv actually started (the shell argv when `shell: true`). */
  argv: string[]
  /** Display form of the command (credential values masked). */
  display: string
  /** True when the command went through a shell. */
  shell: boolean
  cwd: string
  /** Exit code, or null when the process was killed / never started. */
  exitCode: number | null
  /** Termination signal, when the process did not exit on its own. */
  signal: string | null
  /** stdout inside the cap (complete unless `truncated`). */
  stdout: string
  /** stderr inside the cap (complete unless `truncated`). */
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  durationMs: number
  /** True when the deadline expired and the process group was killed. */
  timedOut: boolean
  /** True when the process was killed (timeout or an explicit stop). */
  killed: boolean
  /** True when a cap cut `stdout`/`stderr` (see `spill` for the full bytes). */
  truncated: boolean
  /** Where the bytes beyond the cap were written (`spill@1` seam). */
  spill?: SpillRef
  /** Human note: the exit, the timeout, and where the full output lives. */
  note: string
}

/** The policy a provider reports (never a secret). */
export interface SubprocessPolicy {
  /** Default deadline in ms. */
  timeoutMs: number
  /** Hard ceiling of a caller-supplied deadline. */
  maxTimeoutMs: number
  /** Default inline byte cap. */
  maxOutputBytes: number
  /** Bytes kept beyond the cap for the spill handoff. */
  overflowBytes: number
  /** Grace between SIGTERM and SIGKILL. */
  graceMs: number
  /** Whether this deployment allows `shell: true`. */
  shellAllowed: boolean
  /** Working directory used when a call names none. */
  cwd: string
}

/**
 * The capability a consumer reaches as `ctx.subprocess`. `run` is bounded on
 * every axis (deadline, output, process range); it never streams the whole
 * output into memory and never leaves an orphan behind.
 */
export interface SubprocessService {
  run(input: SubprocessRunInput): Promise<SubprocessResult>
  /** The policy in effect (defaults, caps, shell permission, cwd). */
  policy(): SubprocessPolicy
}

/**
 * The OPTIONAL sandbox extension point (requirement R11). A `sandbox@1` provider
 * is NOT a dependency of this capability: when one is loaded the provider asks it
 * about the command BEFORE starting it, and a refusal is a structured
 * `subprocess.sandbox-denied` error. The shape is structural on purpose, so the
 * sandbox task can land later without touching this module.
 */
export interface SubprocessSandboxLike {
  /** Called with the planned command; `false`/a reason refuses the call. */
  checkCommand?(plan: { argv: readonly string[]; shell: boolean; cwd: string }):
    | { allowed: boolean; reason?: string }
    | Promise<{ allowed: boolean; reason?: string }>
    | undefined
}

// ---------------------------------------------------------------------------
// Config + pure planning helpers (no process, no filesystem).
// ---------------------------------------------------------------------------

/** The config of a subprocess provider. */
export interface SubprocessConfig {
  /** Default working directory (default: the process cwd). */
  cwd?: string
  /** Default deadline in ms (default 30 s). */
  timeoutMs?: number
  /** Default inline byte cap (default 256 KiB, hard max 1 MiB). */
  maxOutputBytes?: number
  /** Bytes kept beyond the cap for the spill handoff (default 4 MiB). */
  overflowBytes?: number
  /** Grace between SIGTERM and SIGKILL (default 500 ms). */
  graceMs?: number
  /** Whether `shell: true` is allowed at all (default true). */
  allowShell?: boolean
  /** Shell binary used for `shell: true` (default `/bin/sh`). */
  shellBinary?: string
  /** Default spill label (default `subprocess-stdout`). */
  spillLabel?: string
  /** Extra environment every call inherits (values are never logged). */
  env?: Record<string, string>
  /** Whether output beyond the cap is spilled (default true). */
  spill?: boolean
}

/** The normalised policy of a provider (defaults folded in, caps applied). */
export interface NormalizedSubprocessConfig extends SubprocessPolicy {
  shellBinary: string
  env: Record<string, string>
  spill: boolean
  spillLabel: string
}

/** Folds defaults and caps into a provider config; `cwd` defaults to the process cwd. */
export function normalizeSubprocessConfig(config: SubprocessConfig = {}, processCwd = process.cwd()): NormalizedSubprocessConfig {
  const maxTimeoutMs = MAX_SUBPROCESS_TIMEOUT_MS
  const timeoutMs = positiveInt(config.timeoutMs, DEFAULT_SUBPROCESS_TIMEOUT_MS, maxTimeoutMs)
  return {
    cwd: str(config.cwd) ?? processCwd,
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes: positiveInt(config.maxOutputBytes, DEFAULT_SUBPROCESS_MAX_OUTPUT_BYTES, MAX_SUBPROCESS_MAX_OUTPUT_BYTES),
    overflowBytes: positiveInt(config.overflowBytes, DEFAULT_SUBPROCESS_OVERFLOW_BYTES),
    graceMs: positiveInt(config.graceMs, DEFAULT_SUBPROCESS_GRACE_MS),
    shellAllowed: config.allowShell !== false,
    shellBinary: str(config.shellBinary) ?? '/bin/sh',
    spill: config.spill !== false,
    spillLabel: str(config.spillLabel) ?? 'subprocess-stdout',
    env: { ...(config.env ?? {}) },
  }
}

/** The plan of one call: what the provider is about to start. */
export interface SubprocessPlan {
  argv: string[]
  shell: boolean
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  env: Record<string, string>
  envRefs: Record<string, string>
  stdin?: string
  spill: boolean
  label: string
}

/**
 * Validates a call against a provider policy and produces its PLAN, as a PURE
 * function: the argv/command rules, the shell escape hatch, the deadline and the
 * caps. Everything that is not I/O about a call is decided here, so the rules are
 * unit-testable without starting a process.
 */
export function planSubprocess(input: SubprocessRunInput, config: NormalizedSubprocessConfig): SubprocessPlan {
  const argv = Array.isArray(input.argv) ? input.argv.map((entry) => (typeof entry === 'string' ? entry : '')) : undefined
  const command = str(input.command)
  const wantsShell = input.shell === true

  if (argv !== undefined && command !== undefined) {
    throw new SubprocessError('subprocess.invalid-input', 'pass EITHER argv OR command, never both', {
      stage: 'subprocess.plan',
    })
  }
  if (argv !== undefined && (argv.length === 0 || argv.some((entry) => entry.length === 0))) {
    throw new SubprocessError('subprocess.invalid-input', 'argv must be a non-empty array of non-empty strings', {
      stage: 'subprocess.plan',
    })
  }
  if (argv !== undefined && wantsShell) {
    throw new SubprocessError('subprocess.invalid-input', 'shell: true is for the command STRING form; an argv array is started directly', {
      stage: 'subprocess.plan',
    })
  }
  if (command === undefined && argv === undefined) {
    throw new SubprocessError('subprocess.invalid-input', 'a run call needs an argv array (preferred) or a command string with shell: true', {
      stage: 'subprocess.plan',
    })
  }
  if (command !== undefined && !wantsShell) {
    throw new SubprocessError(
      'subprocess.invalid-input',
      'a command STRING requires an explicit shell: true (the workbench host never splits a string into an argv); prefer an argv array',
      { stage: 'subprocess.plan', details: { hint: 'argv: ["git","status"]' } },
    )
  }
  if (wantsShell && !config.shellAllowed) {
    throw new SubprocessError('subprocess.shell-disabled', 'this deployment does not allow shell execution (allowShell: false)', {
      stage: 'subprocess.plan',
    })
  }

  const plannedArgv = wantsShell ? [config.shellBinary, '-c', command as string] : [...(argv as string[])]
  const timeoutMs = positiveInt(input.timeoutMs, config.timeoutMs, config.maxTimeoutMs)
  const maxOutputBytes = positiveInt(input.maxOutputBytes, config.maxOutputBytes, MAX_SUBPROCESS_MAX_OUTPUT_BYTES)
  const cwd = str(input.cwd) ?? config.cwd

  return {
    argv: plannedArgv,
    shell: wantsShell,
    cwd,
    timeoutMs,
    maxOutputBytes,
    env: { ...config.env, ...(isRecord(input.env) ? (input.env as Record<string, string>) : {}) },
    envRefs: isRecord(input.envRefs) ? (input.envRefs as Record<string, string>) : {},
    ...(typeof input.stdin === 'string' ? { stdin: input.stdin } : {}),
    spill: input.spill !== false && config.spill,
    label: str(input.label) ?? config.spillLabel,
  }
}

/** What a reference string means. */
export type EnvRefKind = 'credential' | 'environment' | 'literal'

/** Classifies an `envRefs` value (pure): `${cred:NAME}`, `${env:NAME}` or literal. */
export function classifyEnvRef(value: string): { kind: EnvRefKind; name?: string } {
  const credential = CRED_REF.exec(value)
  if (credential !== null) return { kind: 'credential', name: credential[1] }
  const environment = ENV_REF.exec(value)
  if (environment !== null) return { kind: 'environment', name: environment[1] }
  return { kind: 'literal' }
}

/**
 * Resolves `envRefs` into concrete environment values. A `${cred:NAME}` goes
 * through the `credentials@1` capability (so no secret is ever written into a
 * config file), `${env:NAME}` reads the process environment, a literal is used
 * as-is. An unresolvable reference is a structured error NAMING the reference -
 * never its value.
 */
export async function resolveEnvRefs(
  ctx: ServiceContext,
  refs: Record<string, string>,
  environment: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const [key, raw] of Object.entries(refs)) {
    const classified = classifyEnvRef(raw)
    if (classified.kind === 'literal') {
      resolved[key] = raw
      continue
    }
    if (classified.kind === 'environment') {
      const value = environment[classified.name as string]
      if (value === undefined) {
        throw new SubprocessError('subprocess.reference-unresolved', `the environment variable ${classified.name} of envRefs.${key} is not set`, {
          stage: 'subprocess.references',
          details: { key, reference: 'env' },
        })
      }
      resolved[key] = value
      continue
    }
    const credentials = credentialsOf(ctx)
    if (credentials === undefined) {
      throw new SubprocessError(
        'subprocess.reference-unresolved',
        `envRefs.${key} needs the credentials capability ('\${cred:...}'), which is not loaded`,
        { stage: 'subprocess.references', details: { key, reference: 'credential' } },
      )
    }
    const answer = await credentials.resolve({ name: classified.name as string })
    if (answer === undefined || typeof answer.value !== 'string') {
      throw new SubprocessError('subprocess.reference-unresolved', `the credential ${classified.name} of envRefs.${key} could not be resolved`, {
        stage: 'subprocess.references',
        details: { key, reference: 'credential' },
      })
    }
    resolved[key] = answer.value
  }
  return resolved
}

/**
 * The display form of a plan: the argv joined, with every resolved reference
 * value masked. What a log line and a result carry - NEVER the raw secrets.
 */
export function displayCommand(argv: readonly string[], secrets: readonly string[] = []): string {
  const known = secrets.filter((value) => value.length > 0)
  return argv
    .map((arg) => {
      let shown = arg
      for (const secret of known) shown = shown.split(secret).join('***')
      return shown
    })
    .join(' ')
}

/** The human note of a result (exit, timeout, spill location). */
export function describeResult(result: Omit<SubprocessResult, 'note'>): string {
  if (result.timedOut) {
    return `timed out; the process group was killed${result.spill === undefined ? '' : `; output so far: ${result.spill.path}`}`
  }
  const exit = result.exitCode === null ? `signal ${result.signal ?? 'unknown'}` : `exit ${result.exitCode}`
  const spill = result.spill === undefined ? '' : `; full output: ${result.spill.path}`
  const cut = result.truncated && result.spill === undefined ? ' (output cut at the cap; no spill@1 provider is loaded)' : ''
  return `${exit} in ${result.durationMs}ms${cut}${spill}`
}

/** Structural lookup of the local-execution capability (`ctx.subprocess`). */
export function subprocessOf(ctx: ServiceContext): SubprocessService | undefined {
  return serviceOf<SubprocessService>(ctx, SUBPROCESS)
}

/** The local-execution capability, or a structured error naming the missing provider. */
export function requireSubprocess(ctx: ServiceContext): SubprocessService {
  const service = subprocessOf(ctx)
  if (service === undefined) {
    throw new SubprocessError(
      'subprocess.invalid-input',
      'no subprocess@1 provider is loaded: enable a provider plugin (core/subprocess-local) in the roster',
      { stage: 'subprocess.lookup' },
    )
  }
  return service
}

/** The optional sandbox handle of the deployment, when a `sandbox@1` provider is loaded. */
export function sandboxOf(ctx: ServiceContext): SubprocessSandboxLike | undefined {
  return serviceOf<SubprocessSandboxLike>(ctx, 'sandbox')
}
