// definitions/shell.ts - the `shell@1` SERVICE DEFINITION (LOCAL execution).
//
// This is the contract of the LOCAL transport: the only transport of this
// repository that runs a command ON THE WORKBENCH HOST. It is deliberately
// narrow and deliberately loud about that fact:
//
//   - PROVIDERS implement {@link ShellService} and declare the capability
//     `{ "id": "shell", "version": 1, "provider": "<id>" }` in their manifest
//     (core/shell-impl ships the provider `local-bash`).
//   - CONSUMERS (core/general-service-impl) select it by CONFIG, never by
//     import: `{ "type": "local", "params": { "shell": "bash" } }`.
//
// RULE (docs/SERVICES.md, "Execution policy"): a plugin that can reach this
// service must declare `"execution": "host"` plus
// `"policies": { "shell": { "provide": "shell@1", "require": "shell@1" } }` in
// its own manifest and verify it at apply time
// ({@link assertPolicyDeclared}); otherwise it must not load.
import {
  ServiceError,
  capText,
  isRecord,
  positiveInt,
  requireService,
  serviceOf,
  shellQuote,
  str,
  type CommandOptions,
  type CommandResult,
  type ServiceContext,
} from './support.ts'

/** Name of the service (`ctx.shell`). */
export const SHELL = 'shell'

/** Contract version this definition speaks. */
export const SHELL_VERSION = 1

/** Contract id including the version, e.g. `shell@1`. */
export const SHELL_CONTRACT = `${SHELL}@${SHELL_VERSION}`

/** The policy a provider of this contract declares in its manifest. */
export const SHELL_POLICY_PROVIDE = SHELL_CONTRACT

/** The policy a consumer declares to accept a provider of this contract. */
export const SHELL_POLICY_REQUIRE = SHELL_CONTRACT

/** Default per-call timeout and output cap (bytes) of a local command. */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Supported local shells. `sh` is the portable floor, `bash` the default. */
export type ShellName = 'bash' | 'sh' | 'zsh'

/** The `shell@1` config: where and how a local command runs. */
export interface ShellConfig {
  /** Shell to run the command with (default `bash`). */
  shell?: ShellName | string
  /** Absolute path of the shell binary (overrides `shell`, e.g. `/bin/bash`). */
  binary?: string
  /** Working directory of the command (default: the host process' own). */
  cwd?: string
  /** Per-call timeout in ms (default {@link DEFAULT_SHELL_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Output cap in bytes (default {@link DEFAULT_SHELL_MAX_OUTPUT_BYTES}). */
  maxOutputBytes?: number
  /** Extra environment for the child (values never logged; config-carried). */
  env?: Record<string, string>
}

/** The result of a local command: the shared {@link CommandResult} shape. */
export type ShellResult = CommandResult

/** What a caller may override per call (bounded by the provider's own caps). */
export type ShellRunOptions = CommandOptions

/** The instance-style handle a consumer gets from `create(config)`. */
export interface ShellInstance {
  readonly contract: typeof SHELL_CONTRACT
  readonly provider: string
  /** Runs ONE command string through the target shell. */
  run(input: string, options?: ShellRunOptions): Promise<ShellResult>
}

/** What a `shell@1` provider must offer. */
export interface ShellService {
  readonly contract: typeof SHELL_CONTRACT
  /** Provider id, e.g. `local-bash`. */
  readonly provider: string
  /** Human readable backend description (never a value). */
  describe?(): string
  /** Runs ONE command string through the configured local shell. */
  run(input: string, options?: ShellRunOptions): Promise<ShellResult>
  /** Instance-style: binds a config now (validated) instead of on every call. */
  create?(config: ShellConfig): ShellInstance
}

/** The normalised config a provider works with. */
export interface NormalizedShellConfig {
  binary: string
  cwd?: string
  timeoutMs: number
  maxOutputBytes: number
  env: Record<string, string>
}

const SHELL_BINARIES: Record<string, string> = { bash: '/bin/bash', sh: '/bin/sh', zsh: '/bin/zsh' }

/** The shell binary a config names (absolute `binary` wins). */
export function shellBinary(config: ShellConfig = {}): string {
  const binary = str(config.binary)
  if (binary !== undefined) return binary
  const shell = str(config.shell) ?? 'bash'
  return SHELL_BINARIES[shell] ?? shell
}

/** Validates and normalises a `shell@1` config; a bad config is structured. */
export function validateShellConfig(raw: unknown): NormalizedShellConfig {
  if (raw !== undefined && !isRecord(raw)) {
    throw new ServiceError('invalid-config', 'shell: the config must be an object', { stage: 'shell.validate' })
  }
  const config = (raw ?? {}) as ShellConfig
  const env: Record<string, string> = {}
  if (config.env !== undefined) {
    if (!isRecord(config.env)) {
      throw new ServiceError('invalid-config', "shell: 'env' must be an object of string values", {
        stage: 'shell.validate',
      })
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== 'string') {
        throw new ServiceError('invalid-config', `shell: 'env.${key}' must be a string`, { stage: 'shell.validate' })
      }
      env[key] = value
    }
  }
  return {
    binary: shellBinary(config),
    ...(str(config.cwd) === undefined ? {} : { cwd: str(config.cwd) as string }),
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_SHELL_TIMEOUT_MS),
    maxOutputBytes: positiveInt(config.maxOutputBytes, DEFAULT_SHELL_MAX_OUTPUT_BYTES),
    env,
  }
}

/**
 * The launcher argv of a LOCAL command, as a PURE function of (config, input).
 * Exported so the argv a provider builds can be asserted (and shown as safety
 * evidence) without executing anything.
 *
 * LOCAL EXECUTION IS THE POINT OF THIS TRANSPORT: the host shell evaluates
 * `input` exactly once (`<shell> -c <input>`) - that is why `local` is
 * documented as the only host-executing type.
 */
export function planLocal(config: ShellConfig, input: string): { argv: string[]; display: string } {
  const binary = shellBinary(config)
  const argv = [binary, '-c', input]
  return { argv, display: `${shellQuote(binary)} -c ${shellQuote(input)}` }
}

/** The `shell@1` service of this deployment, when one is loaded. */
export function serviceOfShell(ctx: ServiceContext): ShellService | undefined {
  return serviceOf<ShellService>(ctx, SHELL)
}

/** The `shell@1` service, or a structured `missing-service` error naming it. */
export function requireShell(ctx: ServiceContext, hint?: string): ShellService {
  return requireService<ShellService>(
    ctx,
    SHELL,
    hint ?? 'the local transport is not loaded: enable a plugin providing shell@1 (core/shell-impl)',
  )
}

/** Caps a local result's output+stderr at `maxBytes` (shared by providers). */
export function capShellResult(result: ShellResult, maxBytes: number): ShellResult {
  const output = capText(result.output, maxBytes)
  const stderr = result.stderr === undefined ? undefined : capText(result.stderr, maxBytes)
  return {
    ...result,
    output: output.text,
    ...(stderr === undefined ? {} : { stderr: stderr.text }),
    ...(output.truncated || stderr?.truncated === true ? { truncated: true } : {}),
  }
}
