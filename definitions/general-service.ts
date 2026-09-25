// definitions/general-service.ts - the `general-service@1` SERVICE DEFINITION.
//
// ONE service that can run a command string in ANY of five transports, chosen by
// CONFIG (`type` + `params`), instead of one plugin per transport:
//
//   local          -> `shell@1`   (the ONLY host-executing type)
//   container      -> `docker@1`  (the command runs INSIDE the container)
//   ssh            -> `ssh@1`     (the command runs ON the remote machine)
//   ssh+container  -> `ssh@1` + `docker@1` (remote docker, remote container)
//   http           -> `http@1`    (no shell at all: POST the input as the body)
//
// The Definition names the types and the params of each type; it names NO
// implementation and NO vendor vocabulary beyond that. The implementation
// (core/general-service-impl) resolves the transport SERVICE by config at
// call time - never by a hard injection - so a config of type `ssh` works while
// no `docker@1` provider is loaded, and an unsupported/missing transport FAILS
// (naming the missing capability) instead of silently running on the host.
//
// INSTANCE API (what a consumer such as core/himalaya-impl uses):
//
//   const instance = general.create({ type: 'container', params: { ... } })
//   const result = await instance.call('himalaya --version')
//
// `create` VALIDATES the type at initialization: a type whose transport service
// is not loaded fails THERE (fail-to-load, before any command call).
import {
  ServiceError,
  isRecord,
  requireService,
  serviceOf,
  str,
  type CommandOptions,
  type ServiceContext,
} from './support.ts'
import { DOCKER, type DockerResult } from './docker.ts'
import { HTTP, type HttpResult } from './http.ts'
import { SHELL, type ShellResult } from './shell.ts'
import { SSH, type SshResult } from './ssh.ts'

/** Name of the service (`ctx['general-service']`). */
export const GENERAL_SERVICE = 'general-service'

/** Contract version this definition speaks. */
export const GENERAL_SERVICE_VERSION = 1

/** Contract id including the version, e.g. `general-service@1`. */
export const GENERAL_SERVICE_CONTRACT = `${GENERAL_SERVICE}@${GENERAL_SERVICE_VERSION}`

export const GENERAL_SERVICE_POLICY_PROVIDE = GENERAL_SERVICE_CONTRACT
export const GENERAL_SERVICE_POLICY_REQUIRE = GENERAL_SERVICE_CONTRACT

/** The five transport types a `general-service@1` config may name. */
export const GENERAL_SERVICE_TYPES = ['local', 'container', 'ssh', 'ssh+container', 'http'] as const

export type GeneralServiceType = (typeof GENERAL_SERVICE_TYPES)[number]

/** The transport service(s) each type requires - the config-to-service map. */
export const TRANSPORT_SERVICES: Record<GeneralServiceType, readonly string[]> = {
  local: [SHELL],
  container: [DOCKER],
  ssh: [SSH],
  'ssh+container': [SSH, DOCKER],
  http: [HTTP],
}

/** True when `value` names one of the implemented types. */
export function isGeneralServiceType(value: unknown): value is GeneralServiceType {
  return typeof value === 'string' && (GENERAL_SERVICE_TYPES as readonly string[]).includes(value)
}

/** The transport service names a type needs, or a structured `unsupported-type`. */
export function transportServicesFor(type: unknown): readonly string[] {
  if (!isGeneralServiceType(type)) {
    throw new ServiceError(
      'unsupported-type',
      `general-service: unsupported type ${JSON.stringify(type ?? null)} (expected one of ${GENERAL_SERVICE_TYPES.join(', ')})`,
      { stage: 'general-service.type', details: { type: typeof type === 'string' ? type : null } },
    )
  }
  return TRANSPORT_SERVICES[type]
}

/** The `general-service@1` config: a TYPE plus that type's own params. */
export interface GeneralServiceConfig {
  /** One of {@link GENERAL_SERVICE_TYPES}. */
  type: GeneralServiceType | string
  /** The params of that type (see docs/SERVICES.md; passed to the transport). */
  params?: Record<string, unknown>
}

/** One command's outcome, transport independent. */
export interface GeneralCallResult {
  /** The transport's answer: stdout, the response body (http), ... */
  output: string
  /** Exit code, or the HTTP status for the `http` type; null when killed/never started. */
  code: number | null
  /** Captured stderr, when the transport has any. */
  stderr?: string
  /** Wall-clock duration of the call. */
  durationMs: number
  /** The type that actually served the call. */
  type: GeneralServiceType
  /** True when the byte cap cut the output. */
  truncated?: boolean
  /** HTTP status (the `http` type only). */
  status?: number
  /** Response headers (the `http` type only). */
  headers?: Record<string, string>
}

/** Per-call bounds (bounded again by the transport's own config). */
export interface GeneralCallOptions extends CommandOptions {}

/** An instance bound to ONE config (the fail-fast handle consumers use). */
export interface GeneralServiceInstance {
  readonly contract: typeof GENERAL_SERVICE_CONTRACT
  readonly provider: string
  /** The type this instance was created with. */
  readonly type: GeneralServiceType
  /** Runs ONE command string through the bound transport. */
  call(input: string, options?: GeneralCallOptions): Promise<GeneralCallResult>
}

/** What a `general-service@1` provider must offer. */
export interface GeneralService {
  readonly contract: typeof GENERAL_SERVICE_CONTRACT
  /** Provider id, e.g. `config-dispatch`. */
  readonly provider: string
  describe?(): string
  /** Instance-style: binds (and validates) a config now. */
  create(config: GeneralServiceConfig): GeneralServiceInstance
  /** One-shot convenience: `create(config).call(input)`. */
  call(input: string, config: GeneralServiceConfig, options?: GeneralCallOptions): Promise<GeneralCallResult>
}

/** Validates the shape of a `general-service@1` config (type + params object). */
export function normalizeGeneralServiceConfig(raw: unknown): { type: GeneralServiceType; params: Record<string, unknown> } {
  if (!isRecord(raw)) {
    throw new ServiceError('invalid-config', "general-service: the config must be an object with a 'type'", {
      stage: 'general-service.validate',
    })
  }
  const type = str(raw.type)
  if (type === undefined) {
    throw new ServiceError('invalid-config', "general-service: 'type' is required", {
      stage: 'general-service.validate',
    })
  }
  const services = transportServicesFor(type)
  if (raw.params !== undefined && !isRecord(raw.params)) {
    throw new ServiceError('invalid-config', "general-service: 'params' must be an object", {
      stage: 'general-service.validate',
    })
  }
  void services
  return { type: type as GeneralServiceType, params: (raw.params ?? {}) as Record<string, unknown> }
}

/** Maps a transport command result (shell/ssh/docker) to the shared shape. */
export function generalResultFromCommand(
  result: ShellResult | SshResult | DockerResult,
  type: GeneralServiceType,
): GeneralCallResult {
  return {
    output: result.output,
    code: result.code,
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    durationMs: result.durationMs,
    type,
    ...(result.truncated === true ? { truncated: true } : {}),
  }
}

/** Maps an `http@1` answer to the shared shape (body -> output, status -> code). */
export function generalResultFromHttp(result: HttpResult, type: GeneralServiceType = 'http'): GeneralCallResult {
  return {
    output: result.body,
    code: result.status,
    durationMs: result.durationMs,
    type,
    status: result.status,
    headers: result.headers,
    ...(result.truncated === true ? { truncated: true } : {}),
  }
}

/** The `general-service@1` service of this deployment, when one is loaded. */
export function serviceOfGeneralService(ctx: ServiceContext): GeneralService | undefined {
  return serviceOf<GeneralService>(ctx, GENERAL_SERVICE)
}

/** The `general-service@1` service, or a structured `missing-service` error. */
export function requireGeneralService(ctx: ServiceContext, hint?: string): GeneralService {
  return requireService<GeneralService>(
    ctx,
    GENERAL_SERVICE,
    hint ??
      'the general service is not loaded: enable core/general-service-impl (a plugin providing general-service@1)',
  )
}
