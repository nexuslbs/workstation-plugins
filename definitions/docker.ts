// definitions/docker.ts - the `docker@1` SERVICE DEFINITION (container
// execution, compose capable).
//
// The contract of the container transport: ONE command string in, one bounded
// result out, executed INSIDE THE CONTAINER ONLY.
//
// SHELL-SAFETY INVARIANT (docs/SERVICES.md): the input is handed to the
// container's shell exactly once, as ONE argv element:
//
//   docker compose -p <proj> [-f <file>] [--env-file <env>] [--profile <p>] \
//     exec -T <service> sh -c <input>
//
// `execFile(argv)` (never a host shell) starts the CLI; the CLI passes the
// final element to the container's `sh -c`, which evaluates the pipes,
// redirections, quotes and globs INSIDE the container. Nothing is evaluated by
// the workbench host shell - that is why the plugin README documents `local`
// (definitions/shell.ts) as the ONLY host-executing type.
//
// UNREACHABLE TARGET: a container that cannot be reached fails with
// `unreachable`; the command NEVER falls back to the host.
//
//   - PROVIDERS implement {@link DockerService} and declare the capability
//     `{ "id": "docker", "version": 1, "provider": "<id>" }` (core/docker-impl
//     ships the provider `docker-compose-cli`).
//   - CONSUMERS (core/general-service-impl) select it by CONFIG, never by
//     import: `{ "type": "container", "params": { "engine": "docker-compose",
//     "compose": { "project_dir": "/opt/omni", "service": "toolbox" } } }`.
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

/** Name of the service (`ctx.docker`). */
export const DOCKER = 'docker'

/** Contract version this definition speaks. */
export const DOCKER_VERSION = 1

/** Contract id including the version, e.g. `docker@1`. */
export const DOCKER_CONTRACT = `${DOCKER}@${DOCKER_VERSION}`

export const DOCKER_POLICY_PROVIDE = DOCKER_CONTRACT
export const DOCKER_POLICY_REQUIRE = DOCKER_CONTRACT

export const DEFAULT_DOCKER_TIMEOUT_MS = 60_000
export const DEFAULT_DOCKER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Engines a `container` config may name. `docker-compose` is the default. */
export type DockerEngine = 'docker-compose' | 'docker'

/** The compose coordinates of a `container` config (no host paths in code). */
export interface ComposeConfig {
  /** Compose project directory (`--project-directory`); required. */
  project_dir: string
  /** Compose file, relative to `project_dir` or absolute (`-f`). */
  file?: string
  /** Env file (`--env-file`); compose defaults to `<project_dir>/.env` when absent. */
  env_file?: string
  /** Service to `exec` into (e.g. `toolbox`); required for `exec`. */
  service: string
  /** Explicit compose project name (`-p`); defaults to the project dir basename. */
  project_name?: string
  /** Compose profile(s) to activate (`--profile`). */
  profile?: string | string[]
}

/** The `docker@1` config: which container runs the command. */
export interface DockerConfig {
  /** `docker-compose` (default) runs `compose ... exec`; `docker` runs `docker run`/`exec`. */
  engine?: DockerEngine | string
  /** Compose coordinates (required with the default engine). */
  compose?: ComposeConfig
  /** Container name or id for the plain `docker` engine (`exec`). */
  container?: string
  /** Image for the plain `docker` engine (`run`); used when `container` is absent. */
  image?: string
  /** Entrypoint override of a plain `docker run`. */
  entrypoint?: string | string[]
  /** Docker network of a plain `docker run`. */
  network?: string
  /** Mounts of a plain `docker run`, verbatim `-v` values (`host:container[:mode]`). */
  mounts?: string[]
  /** docker executable (default `docker`, resolved on PATH). */
  binary?: string
  /** Per-call timeout in ms (default {@link DEFAULT_DOCKER_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Output cap in bytes (default {@link DEFAULT_DOCKER_MAX_OUTPUT_BYTES}). */
  maxOutputBytes?: number
}

/** The result of a container command: the shared {@link CommandResult} shape. */
export type DockerResult = CommandResult

export type DockerRunOptions = CommandOptions

/** The instance-style handle a consumer gets from `create(config)`. */
export interface DockerInstance {
  readonly contract: typeof DOCKER_CONTRACT
  readonly provider: string
  run(input: string, options?: DockerRunOptions): Promise<DockerResult>
}

/** What a `docker@1` provider must offer. */
export interface DockerService {
  readonly contract: typeof DOCKER_CONTRACT
  readonly provider: string
  describe?(): string
  /** Runs ONE command string inside the configured container. */
  run(input: string, options?: DockerRunOptions): Promise<DockerResult>
  /** Instance-style: binds a config now (validated) instead of on every call. */
  create?(config: DockerConfig): DockerInstance
}

/** The normalised config a provider works with. */
export interface NormalizedDockerConfig {
  engine: DockerEngine
  compose?: ComposeConfig
  container?: string
  image?: string
  entrypoint?: string[]
  network?: string
  mounts: string[]
  binary: string
  timeoutMs: number
  maxOutputBytes: number
}

/** Normalises the compose block, keeping only the keys the CLI accepts. */
export function normalizeCompose(raw: unknown): ComposeConfig {
  if (!isRecord(raw)) {
    throw new ServiceError('invalid-config', "docker: 'compose' must be an object", { stage: 'docker.validate' })
  }
  const projectDir = str(raw.project_dir)
  const service = str(raw.service)
  if (projectDir === undefined) {
    throw new ServiceError('invalid-config', "docker: 'compose.project_dir' is required", {
      stage: 'docker.validate',
    })
  }
  if (service === undefined) {
    throw new ServiceError('invalid-config', "docker: 'compose.service' is required", { stage: 'docker.validate' })
  }
  const profile = Array.isArray(raw.profile)
    ? raw.profile.filter((entry): entry is string => typeof entry === 'string')
    : str(raw.profile)
  return {
    project_dir: projectDir,
    service,
    ...(str(raw.file) === undefined ? {} : { file: str(raw.file) as string }),
    ...(str(raw.env_file) === undefined ? {} : { env_file: str(raw.env_file) as string }),
    ...(str(raw.project_name) === undefined ? {} : { project_name: str(raw.project_name) as string }),
    ...(profile === undefined ? {} : { profile }),
  }
}

/** Validates and normalises a `docker@1` config; a bad config is structured. */
export function validateDockerConfig(raw: unknown): NormalizedDockerConfig {
  if (!isRecord(raw)) {
    throw new ServiceError('invalid-config', "docker: the config must be an object with an 'engine'", {
      stage: 'docker.validate',
    })
  }
  const config = raw as unknown as DockerConfig
  const engine = (str(config.engine) ?? 'docker-compose') as DockerEngine
  if (engine !== 'docker-compose' && engine !== 'docker') {
    throw new ServiceError('invalid-config', `docker: unsupported engine '${engine}' (docker-compose | docker)`, {
      stage: 'docker.validate',
    })
  }
  const compose = engine === 'docker-compose' ? normalizeCompose(config.compose) : undefined
  const container = str(config.container)
  const image = str(config.image)
  if (engine === 'docker' && container === undefined && image === undefined) {
    throw new ServiceError('invalid-config', "docker: the 'docker' engine needs 'container' or 'image'", {
      stage: 'docker.validate',
    })
  }
  const entrypointRaw = config.entrypoint
  const entrypoint =
    typeof entrypointRaw === 'string'
      ? ['--entrypoint', entrypointRaw]
      : Array.isArray(entrypointRaw)
        ? ['--entrypoint', entrypointRaw.filter((entry) => typeof entry === 'string').join(' ')]
        : []
  return {
    engine,
    ...(compose === undefined ? {} : { compose }),
    ...(container === undefined ? {} : { container }),
    ...(image === undefined ? {} : { image }),
    ...(entrypoint.length === 0 ? {} : { entrypoint }),
    ...(str(config.network) === undefined ? {} : { network: str(config.network) as string }),
    mounts: Array.isArray(config.mounts) ? config.mounts.filter((entry) => typeof entry === 'string') : [],
    binary: str(config.binary) ?? 'docker',
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_DOCKER_TIMEOUT_MS),
    maxOutputBytes: positiveInt(config.maxOutputBytes, DEFAULT_DOCKER_MAX_OUTPUT_BYTES),
  }
}

/** The container's shell: `sh` is the portable floor of any image. */
export const CONTAINER_SHELL = 'sh'

/**
 * The in-container argv that evaluates the caller's string ONCE, INSIDE the
 * container: `sh -c <input>`. The input is handed over RAW because it is already
 * a single argv element of the container's shell; quoting it here would make the
 * container's `sh` execute one quoted word instead of the caller's command.
 */
export function containerCommandArgv(input: string): string[] {
  return [CONTAINER_SHELL, '-c', input]
}

/**
 * The launcher argv of a CONTAINER command, as a PURE function of (config,
 * input): `docker compose ... exec -T <service> sh -c <input>`. The input is ONE
 * argv element: `execFile` hands it to the docker CLI verbatim and the target
 * container's shell evaluates it - the workbench host shell never sees it.
 */
export function planContainer(config: NormalizedDockerConfig, input: string): { argv: string[]; display: string } {
  return planDockerCommand(config, containerCommandArgv(input))
}

/**
 * The launcher argv that runs an ALREADY-BUILT container argv slice (typically
 * `['sh','-c',input]`). `ssh+container` uses it through
 * {@link planRemoteDocker}, which shell-quotes every element so the REMOTE shell
 * rebuilds exactly this argv before starting the docker CLI there.
 */
export function planDockerCommand(
  config: NormalizedDockerConfig,
  command: readonly string[],
): { argv: string[]; display: string } {
  const argv: string[] = []
  if (config.engine === 'docker-compose') {
    const compose = config.compose as ComposeConfig
    argv.push('compose', '--project-directory', compose.project_dir)
    if (compose.project_name !== undefined) argv.push('-p', compose.project_name)
    if (compose.file !== undefined) argv.push('-f', compose.file)
    if (compose.env_file !== undefined) argv.push('--env-file', compose.env_file)
    for (const profile of typeof compose.profile === 'string' ? [compose.profile] : (compose.profile ?? [])) {
      argv.push('--profile', profile)
    }
    argv.push('exec', '-T', compose.service, ...command)
  } else if (config.container !== undefined) {
    // `-i` and NOT `-T`: plain `docker exec` has no `-T` flag (that is a
    // `docker compose exec` flag), so `docker exec -T` made the CLI fail with
    // exit 125 before the command ever ran.
    argv.push('exec', '-i', config.container, ...command)
  } else {
    argv.push('run', '--rm', '-i')
    for (const mount of config.mounts ?? []) argv.push('-v', mount)
    if (config.network !== undefined) argv.push('--network', config.network)
    argv.push(...(config.entrypoint ?? []))
    argv.push(config.image as string, ...command)
  }
  const full = [config.binary, ...argv]
  return { argv: full, display: redactLauncher(full) }
}

/**
 * The display form of a docker launcher: everything through the executable is
 * shown, so an operator can see WHERE a command runs (this is the safety
 * evidence of the README/tests).
 */
function redactLauncher(argv: readonly string[]): string {
  return argv.map((entry) => shellQuote(entry)).join(' ')
}

/**
 * The launcher argv of a container command, as the REMOTE machine receives it
 * (one single command string); used by the `ssh+container` type. Every argv
 * element is single-quoted, so the remote shell rebuilds exactly the argv of
 * {@link planContainer} - including the container's `-c` argument, which becomes
 * the quoted caller string the container's `sh` then evaluates.
 */
export function planRemoteDocker(config: NormalizedDockerConfig, input: string): string {
  const { argv } = planContainer(config, input)
  return argv.map((entry) => shellQuote(entry)).join(' ')
}

/** The `docker@1` service of this deployment, when one is loaded. */
export function serviceOfDocker(ctx: ServiceContext): DockerService | undefined {
  return serviceOf<DockerService>(ctx, DOCKER)
}

/** The `docker@1` service, or a structured `missing-service` error naming it. */
export function requireDocker(ctx: ServiceContext, hint?: string): DockerService {
  return requireService<DockerService>(
    ctx,
    DOCKER,
    hint ?? 'the container transport is not loaded: enable a plugin providing docker@1 (core/docker-impl)',
  )
}
