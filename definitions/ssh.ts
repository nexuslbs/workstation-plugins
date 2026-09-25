// definitions/ssh.ts - the `ssh@1` SERVICE DEFINITION (REMOTE execution).
//
// The contract of the SSH transport: ONE command string in, one bounded result
// out, executed ON THE REMOTE MACHINE ONLY.
//
// SHELL-SAFETY INVARIANT (docs/SERVICES.md): the input is handed to the REMOTE
// shell exactly once. The launcher argv is
//
//   ssh <options...> <host> "sh -c '<input, single-quoted>'"
//
// The last element is ONE argument; ssh passes it to the remote login shell,
// which parses the quoting and runs `sh -c <input>` there. The workbench HOST
// shell never evaluates the input (no host-side `sh -c`, no `shell: true`).
// A command whose target is unreachable FAILS: it never runs on the host.
//
//   - PROVIDERS implement {@link SshService} and declare the capability
//     `{ "id": "ssh", "version": 1, "provider": "<id>" }` (core/ssh-impl
//     ships the provider `ssh-cli`).
//   - CONSUMERS (core/general-service-impl) select it by CONFIG, never by
//     import: `{ "type": "ssh", "params": { "host": "user@host:22" } }`.
import {
  ServiceError,
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

/** Name of the service (`ctx.ssh`). */
export const SSH = 'ssh'

/** Contract version this definition speaks. */
export const SSH_VERSION = 1

/** Contract id including the version, e.g. `ssh@1`. */
export const SSH_CONTRACT = `${SSH}@${SSH_VERSION}`

export const SSH_POLICY_PROVIDE = SSH_CONTRACT
export const SSH_POLICY_REQUIRE = SSH_CONTRACT

export const DEFAULT_SSH_TIMEOUT_MS = 30_000
export const DEFAULT_SSH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** The `ssh@1` config: which machine, and how to reach it. */
export interface SshConfig {
  /** `host` or `user@host` or `user@host:port` (the portable inline form). */
  host: string
  /** Credential NAME whose VALUE is a private key (never a path, never a value). */
  privateKeyName?: string
  /** Optional ssh config file (`-F <path>`) used for aliases/options. */
  configFilePath?: string
  /** ssh executable (default `ssh`, resolved on PATH). */
  binary?: string
  /** Per-call timeout in ms (default {@link DEFAULT_SSH_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Output cap in bytes (default {@link DEFAULT_SSH_MAX_OUTPUT_BYTES}). */
  maxOutputBytes?: number
  /** Extra ssh options, verbatim argv entries (e.g. `-o`, `StrictHostKeyChecking=no`). */
  options?: string[]
}

/** The result of a remote command: the shared {@link CommandResult} shape. */
export type SshResult = CommandResult

export type SshRunOptions = CommandOptions

/** The instance-style handle a consumer gets from `create(config)`. */
export interface SshInstance {
  readonly contract: typeof SSH_CONTRACT
  readonly provider: string
  run(input: string, options?: SshRunOptions): Promise<SshResult>
}

/** What an `ssh@1` provider must offer. */
export interface SshService {
  readonly contract: typeof SSH_CONTRACT
  readonly provider: string
  describe?(): string
  /** Runs ONE command string on the remote machine. */
  run(input: string, options?: SshRunOptions): Promise<SshResult>
  /** Instance-style: binds a config now (validated) instead of on every call. */
  create?(config: SshConfig): SshInstance
}

/** The normalised config a provider works with. */
export interface NormalizedSshConfig {
  /** `[user@]host` as ssh expects it (the port moved into `-p`). */
  target: string
  port?: number
  privateKeyName?: string
  configFilePath?: string
  binary: string
  timeoutMs: number
  maxOutputBytes: number
  options: string[]
}

/**
 * Splits the inline `[user@]host[:port]` form. The port is validated as a
 * number (an injected value must never reach ssh's argv unvalidated).
 */
export function parseSshTarget(value: string): { target: string; port?: number } {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new ServiceError('invalid-config', 'ssh: the host must not be empty', { stage: 'ssh.validate' })
  }
  const match = /^(?<target>[^/\s:]+(?::[^/\s:]*)?):(?<port>\d+)$/.exec(trimmed)
  if (!match?.groups) return { target: trimmed }
  const port = Number.parseInt(match.groups.port as string, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServiceError('invalid-config', `ssh: invalid port in host '${trimmed}'`, { stage: 'ssh.validate' })
  }
  return { target: match.groups.target as string, port }
}

/** Validates and normalises an `ssh@1` config; a bad config is structured. */
export function validateSshConfig(raw: unknown): NormalizedSshConfig {
  if (!isRecord(raw)) {
    throw new ServiceError('invalid-config', 'ssh: the config must be an object with a `host`', { stage: 'ssh.validate' })
  }
  const config = raw as unknown as SshConfig
  const host = str(config.host)
  if (host === undefined) {
    throw new ServiceError('invalid-config', "ssh: 'host' is required", { stage: 'ssh.validate' })
  }
  const { target, port } = parseSshTarget(host)
  const options = Array.isArray(config.options) ? config.options.filter((entry) => typeof entry === 'string') : []
  return {
    target,
    ...(port === undefined ? {} : { port }),
    ...(str(config.privateKeyName) === undefined ? {} : { privateKeyName: str(config.privateKeyName) as string }),
    ...(str(config.configFilePath) === undefined ? {} : { configFilePath: str(config.configFilePath) as string }),
    binary: str(config.binary) ?? 'ssh',
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_SSH_TIMEOUT_MS),
    maxOutputBytes: positiveInt(config.maxOutputBytes, DEFAULT_SSH_MAX_OUTPUT_BYTES),
    options,
  }
}

/** The ssh option prefix (`-F`, `-p`, `-i`, extra options) as an argv slice. */
export function sshOptionArgv(config: NormalizedSshConfig, keyPath?: string): string[] {
  const argv: string[] = []
  if (config.configFilePath !== undefined) argv.push('-F', config.configFilePath)
  if (config.port !== undefined) argv.push('-p', String(config.port))
  if (keyPath !== undefined) argv.push('-i', keyPath)
  argv.push(...config.options)
  return argv
}

/**
 * The launcher argv of a REMOTE command, as a PURE function of (config, input).
 * The remote command is ONE argument: `sh -c <single-quoted input>`.
 */
export function planSsh(config: NormalizedSshConfig, input: string, keyPath?: string): { argv: string[]; display: string } {
  const remote = planRemoteCommand(input)
  return planSshCommand(config, remote, keyPath)
}

/**
 * Wraps ANY already-safely-quoted remote command string into an ssh argv. Used
 * by the `ssh+container` type, whose remote command is the docker launcher
 * built in the target machine (definitions/docker.ts).
 */
export function planSshCommand(
  config: NormalizedSshConfig,
  remoteCommand: string,
  keyPath?: string,
): { argv: string[]; display: string } {
  const argv = [config.binary, ...sshOptionArgv(config, keyPath), config.target, remoteCommand]
  const shown = argv.map((entry) => (entry === remoteCommand ? `"${entry}"` : shellQuote(entry))).join(' ')
  return { argv, display: shown }
}

/** The remote command string that runs `input` through the remote `sh` once. */
export function planRemoteCommand(input: string): string {
  return `sh -c ${shellQuote(input)}`
}

/** The `ssh@1` service of this deployment, when one is loaded. */
export function serviceOfSsh(ctx: ServiceContext): SshService | undefined {
  return serviceOf<SshService>(ctx, SSH)
}

/** The `ssh@1` service, or a structured `missing-service` error naming it. */
export function requireSsh(ctx: ServiceContext, hint?: string): SshService {
  return requireService<SshService>(
    ctx,
    SSH,
    hint ?? 'the ssh transport is not loaded: enable a plugin providing ssh@1 (core/ssh-impl)',
  )
}
