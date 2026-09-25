// definitions/http.ts - the `http@1` SERVICE DEFINITION (no shell at all).
//
// The contract of the HTTP transport: ONE body string in, one bounded response
// out. There is no shell, no argv and no quoting here - which is exactly why
// the `http` type of `general-service@1` is the safe one for a caller that must
// not reach a command line.
//
//   - PROVIDERS implement {@link HttpService} and declare the capability
//     `{ "id": "http", "version": 1, "provider": "<id>" }` (core/http-impl
//     ships the provider `fetch`).
//   - CONSUMERS (core/general-service-impl) select it by CONFIG, never by
//     import: `{ "type": "http", "params": { "url": "https://..." } }`.
import {
  ServiceError,
  isRecord,
  positiveInt,
  requireService,
  serviceOf,
  str,
  type ServiceContext,
} from './support.ts'

/** Name of the service (`ctx.http`). */
export const HTTP = 'http'

/** Contract version this definition speaks. */
export const HTTP_VERSION = 1

/** Contract id including the version, e.g. `http@1`. */
export const HTTP_CONTRACT = `${HTTP}@${HTTP_VERSION}`

export const HTTP_POLICY_PROVIDE = HTTP_CONTRACT
export const HTTP_POLICY_REQUIRE = HTTP_CONTRACT

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000
export const DEFAULT_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024

/** HTTP methods a `http@1` call may use. */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** The `http@1` config: which URL, with which method and headers. */
export interface HttpConfig {
  url: string
  /** Method (default `POST` - the `general-service` contract sends a body). */
  method?: HttpMethod | string
  /** Extra request headers (values may embed `${cred:NAME}` in the config file). */
  headers?: Record<string, string>
  /** Credential NAME resolved at call time and sent as `Authorization: Bearer <value>`. */
  credential?: string
  /** Per-call timeout in ms (default {@link DEFAULT_HTTP_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Response body cap in bytes (default {@link DEFAULT_HTTP_MAX_BODY_BYTES}). */
  maxBodyBytes?: number
}

/** The answer of an HTTP call (bounded body; headers flattened). */
export interface HttpResult {
  status: number
  body: string
  headers: Record<string, string>
  durationMs: number
  /** True when the byte cap cut `body`. */
  truncated?: boolean
}

/** Per-call overrides bounded by the provider's own config values. */
export interface HttpCallOptions {
  method?: HttpMethod | string
  headers?: Record<string, string>
  timeoutMs?: number
  maxBodyBytes?: number
}

/** The instance-style handle a consumer gets from `create(config)`. */
export interface HttpInstance {
  readonly contract: typeof HTTP_CONTRACT
  readonly provider: string
  call(body: string, options?: HttpCallOptions): Promise<HttpResult>
}

/** What an `http@1` provider must offer. */
export interface HttpService {
  readonly contract: typeof HTTP_CONTRACT
  readonly provider: string
  describe?(): string
  /** Calls the configured URL with `body` as the request body. */
  call(body: string, options?: HttpCallOptions): Promise<HttpResult>
  /** Instance-style: binds a config now (validated) instead of on every call. */
  create?(config: HttpConfig): HttpInstance
}

/** The normalised config a provider works with. */
export interface NormalizedHttpConfig {
  url: string
  method: string
  headers: Record<string, string>
  credential?: string
  timeoutMs: number
  maxBodyBytes: number
}

/** Validates and normalises an `http@1` config; a bad config is structured. */
export function validateHttpConfig(raw: unknown): NormalizedHttpConfig {
  if (!isRecord(raw)) {
    throw new ServiceError('invalid-config', "http: the config must be an object with a 'url'", { stage: 'http.validate' })
  }
  const config = raw as unknown as HttpConfig
  const url = str(config.url)
  if (url === undefined) {
    throw new ServiceError('invalid-config', "http: 'url' is required", { stage: 'http.validate' })
  }
  const headers: Record<string, string> = {}
  if (config.headers !== undefined) {
    if (!isRecord(config.headers)) {
      throw new ServiceError('invalid-config', "http: 'headers' must be an object of string values", { stage: 'http.validate' })
    }
    for (const [key, value] of Object.entries(config.headers)) {
      if (typeof value !== 'string') {
        throw new ServiceError('invalid-config', `http: 'headers.${key}' must be a string`, { stage: 'http.validate' })
      }
      headers[key] = value
    }
  }
  return {
    url,
    method: (str(config.method) ?? 'POST').toUpperCase(),
    headers,
    ...(str(config.credential) === undefined ? {} : { credential: str(config.credential) as string }),
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS),
    maxBodyBytes: positiveInt(config.maxBodyBytes, DEFAULT_HTTP_MAX_BODY_BYTES),
  }
}

/** The `http@1` service of this deployment, when one is loaded. */
export function serviceOfHttp(ctx: ServiceContext): HttpService | undefined {
  return serviceOf<HttpService>(ctx, HTTP)
}

/** The `http@1` service, or a structured `missing-service` error naming it. */
export function requireHttp(ctx: ServiceContext, hint?: string): HttpService {
  return requireService<HttpService>(
    ctx,
    HTTP,
    hint ?? 'the http transport is not loaded: enable a plugin providing http@1 (core/http-impl)',
  )
}
