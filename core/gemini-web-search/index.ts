// core/gemini-web-search - the `ctx.web` (@deepseek-ai/dsh-web) SEARCH PROVIDER
// backed by the Google GEMINI API's native `google_search` grounding.
//
// WHY THIS ROW EXISTS
// -------------------
// The harness BASE bundle mounts the web seam together with a DeepSeek search
// provider (packages/bundle/base/cordis.patch.yml):
//
//     - id: web                  name: '@deepseek-ai/dsh-web'
//       config: { searchProvider: deepseek-official, fetchProvider: http }
//     - id: web-search-deepseek  name: '@deepseek-ai/dsh-web-search-deepseek'
//       config: { apiKeyEnv: DEEPSEEK_API_KEY }
//     - id: tool-web             name: '@deepseek-ai/dsh-tool-web'   # the model-facing `web_search` tool
//
// So WITHOUT this row every dsh AGENT's own `web_search` is DeepSeek native
// search (DEEPSEEK_API_KEY). This row registers a SECOND provider in the SAME
// seam - id `gemini` - whose answers come from the Gemini model's own Google
// Search grounding. The role patch of `gemini-researcher` pins
// `web.searchProvider: gemini` FOR THAT ROLE ONLY, so no other role changes.
//
// WHAT IT IS (and is not)
// -----------------------
//   * it is a PROVIDER for the harness web capability seam: it calls
//     `ctx.web.registerSearchProvider({ id, available, search })` and nothing
//     else;
//   * it is NOT a paid search API wrapper and NOT a browser: the only request it
//     issues is `POST {apiBase}/models/{model}:generateContent` with the native
//     `tools: [{ google_search: {} }]` grounding tool - exactly the "Google
//     Search tool that Gemini models expose". The sources come from
//     `candidates[0].groundingMetadata.groundingChunks[].web`, never from
//     scraping model prose;
//   * it never logs, returns or embeds a credential VALUE: the key is resolved
//     BY NAME at CALL time through `ctx.credentials` ($DSH_HOME/.credentials.yaml)
//     with the process environment as the fallback plane, and travels only in
//     the `x-goog-api-key` header.
//
// STRUCTURAL ON PURPOSE: this repository is an EXTERNAL plugin source and no
// plugin of it imports the harness (`@deepseek-ai/*`); every host capability is
// reached structurally through `definitions/support.ts`, so this module loads
// from a plain absolute path inside the service.

import { isRecord, serviceOf, str, type CredentialsLike, type ServiceContext } from '../../definitions/support.ts'
import { loggerOf } from '../../definitions/logger.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'gemini-web-search'

/**
 * The harness web seam this provider registers into. Declared so cordis defers
 * `apply` until `ctx.web` exists; `webSeamOf` still resolves it structurally, so
 * the plugin also loads where the export is not honoured.
 */
export const inject = ['web']

/** Stable provider id this row registers with the web seam. */
export const PROVIDER_ID = 'gemini'

/** Default credential NAME resolved through `ctx.credentials` (never a value). */
export const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'

/** Default model id. A REAL, API-accepted Gemini id (never a marketing name). */
export const DEFAULT_MODEL = 'gemini-2.5-flash'

/** Default API root of the Gemini `v1beta` REST surface. */
export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Per-call deadline of one Gemini request (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Hard ceiling of a configured per-call deadline (ms). */
export const MAX_TIMEOUT_MS = 120_000

/** Cap of the grounded answer text carried in the result `content` (chars). */
export const MAX_CONTENT_CHARS = 4_000

/** Plugin config (all optional; `apply` fills constants). */
export interface Config {
  /** Credential NAME of the Gemini API key (default {@link DEFAULT_API_KEY_ENV}). */
  apiKeyEnv?: string
  /** Gemini model id (default {@link DEFAULT_MODEL}). */
  model?: string
  /** API root (default {@link DEFAULT_API_BASE}); a proxy/stub may override it. */
  apiBase?: string
  /** Provider id registered with the seam (default {@link PROVIDER_ID}). */
  providerId?: string
  /** Send the native `google_search` grounding tool (default true). */
  grounded?: boolean
  /** Per-call deadline in ms (default {@link DEFAULT_TIMEOUT_MS}, max 120000). */
  timeoutMs?: number
}

/** What one search is asked for (the seam's request vocabulary, structurally). */
export interface WebSearchRequest {
  readonly query: string
  readonly maxResults?: number
}

/** One citeable source (the seam's source shape, structurally). */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** What one search answers with (the seam's result shape, structurally). */
export interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}

/** The provider contract of the web seam, structurally. */
export interface WebSearchProvider {
  readonly id: string
  available(): boolean
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** The one member of `ctx.web` this plugin uses. */
export interface WebSeam {
  registerSearchProvider(provider: WebSearchProvider): unknown
}

/**
 * The harness `WebError` shape, reproduced structurally: consumers branch on
 * `code`, so the codes of the seam (`WEB_PROVIDER_*`) are preserved verbatim.
 */
export class GeminiWebError extends Error {
  readonly code: string
  readonly stage: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, stage = 'gemini', details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'WebError'
    this.code = code
    this.stage = stage
    this.details = details
  }
}

/** A whole number in [min, max], or the fallback. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

/** The prompt one search is submitted as. */
export function buildPrompt(query: string): string {
  return [
    'Search the web for the query below and answer in at most 8 sentences.',
    'List the sources you used as markdown links.',
    '',
    `Query: ${query}`,
  ].join('\n')
}

/** The `generateContent` request body: the grounding tool on, temperature low. */
export function generateBody(query: string, grounded: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(query) }] }],
    generationConfig: { temperature: 0.2 },
  }
  if (grounded) body.tools = [{ google_search: {} }]
  return body
}

/** Every non-empty text part of the first candidate, joined. */
export function candidateText(payload: unknown): string {
  const candidate = (payload as { candidates?: unknown[] } | undefined)?.candidates?.[0] as
    | { content?: { parts?: unknown[] } }
    | undefined
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  return parts
    .map((part) => str((part as { text?: unknown })?.text) ?? '')
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}

/**
 * The sources of a grounded answer: one per
 * `groundingMetadata.groundingChunks[].web` entry, with the segment text
 * `groundingSupports` attributes to that chunk as the snippet (the grounded
 * span, never invented text).
 */
export function groundedSources(payload: unknown, answerText: string): WebSearchSource[] {
  const metadata = ((payload as { candidates?: unknown[] } | undefined)?.candidates?.[0] as
    | { groundingMetadata?: unknown }
    | undefined)?.groundingMetadata as Record<string, unknown> | undefined
  const chunks = Array.isArray(metadata?.groundingChunks) ? (metadata.groundingChunks as unknown[]) : []
  const supports = Array.isArray(metadata?.groundingSupports) ? (metadata.groundingSupports as unknown[]) : []
  const segmentByChunk = new Map<number, string>()
  for (const support of supports) {
    if (!isRecord(support)) continue
    const segment = isRecord(support.segment) ? support.segment : undefined
    const text = str(segment?.text)
    const indices = Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices : []
    if (text === undefined) continue
    for (const index of indices) {
      if (typeof index !== 'number' || segmentByChunk.has(index)) continue
      segmentByChunk.set(index, text)
    }
  }
  const fallbackSnippet = answerText.length > 0 ? answerText.slice(0, 400) : undefined
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const [index, chunk] of chunks.entries()) {
    const web = isRecord(chunk) && isRecord(chunk.web) ? chunk.web : undefined
    const url = str(web?.uri)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const snippet = segmentByChunk.get(index) ?? fallbackSnippet
    sources.push({
      url,
      title: str(web?.title) ?? url,
      ...snippet === undefined ? {} : { snippet },
    })
  }
  return sources
}

/**
 * The outcome of one key resolution: the value (when found) plus a SECRET-FREE
 * trail of what was attempted, so a failure names exactly which plane failed
 * without ever carrying a value.
 */
export interface KeyResolution {
  value?: string
  trail: string[]
}

/**
 * Every credentials plane this context exposes, looked up WITHOUT inject: the
 * non-strict service lookup first (the real service), then the property access
 * (which cordis gates by inject and which can answer with an unresolved
 * shadow). Duplicates are collapsed, and the labels are what the trail reports.
 */
function credentialServices(ctx: ServiceContext): Array<{ label: string; service: CredentialsLike }> {
  const found: Array<{ label: string; service: CredentialsLike }> = []
  const viaLookup = serviceOf<CredentialsLike>(ctx, 'credentials')
  if (viaLookup !== undefined && typeof viaLookup.resolve === 'function') found.push({ label: 'get', service: viaLookup })
  try {
    const direct = ctx.credentials
    if (direct !== undefined && typeof direct.resolve === 'function' && !found.some((entry) => entry.service === direct)) {
      found.push({ label: 'prop', service: direct })
    }
  } catch {
    /* inject-gated property access: the non-strict lookup is the plane that stays */
  }
  return found
}

/**
 * Resolve the Gemini key BY NAME at call time (never cached, never logged).
 *
 * The HARNESS `CredentialRef` is a BRANDED STRING (`credentialRef('NAME')`): the
 * reference IS the variable name, not an object. The structural seam of this
 * repository types it as `{ name, scope? }`, so the string form is sent first
 * (the runtime call every provider of this repository makes) and the object form
 * is attempted as a fallback for a host that takes it. The process environment
 * is the last plane.
 */
export async function resolveApiKey(ctx: ServiceContext, apiKeyEnv: string): Promise<KeyResolution> {
  const trail: string[] = []
  const services = credentialServices(ctx)
  trail.push(`credentialsService=${services.length > 0 ? services.map((entry) => entry.label).join('+') : 'absent'}`)
  trail.push(`dshHome=${process.env.DSH_HOME ?? 'unset'}`)
  for (const { label, service } of services) {
    const ctor = (service as { constructor?: { name?: string } }).constructor?.name
    trail.push(`serviceCtor=${typeof ctor === 'string' && ctor.length > 0 ? ctor : 'none'}`)
    for (const [form, ref] of [['string', apiKeyEnv], ['object', { name: apiKeyEnv }]] as Array<[string, unknown]>) {
      try {
        // The method MUST stay bound to its service: the harness provider calls
        // private members through `this`, so a detached reference throws
        // "Cannot read properties of undefined (reading 'inherited')".
        const resolved: unknown = await service.resolve(ref as unknown as { name: string; scope?: string })
        const value = str((resolved as { value?: unknown } | undefined)?.value)
        trail.push(`${label}/${form}=${value !== undefined ? 'value' : resolved === undefined ? 'no-entry' : 'no-value'}`)
        if (value !== undefined) return { value, trail }
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : String(error).slice(0, 160)
        trail.push(`${label}/${form}=error(${detail})`)
      }
    }
  }
  const ambient = str(process.env[apiKeyEnv])
  trail.push(`env=${ambient === undefined ? 'unset' : 'value'}`)
  return ambient === undefined ? { trail } : { value: ambient, trail }
}

/** The resolved options of one provider, captured at apply time. */
export interface GeminiSearchProviderOptions {
  id: string
  apiKeyEnv: string
  model: string
  apiBase: string
  grounded: boolean
  timeoutMs: number
  /** Cheap local check that a credential PLANE exists (no network, no await). */
  credentialPlane(): boolean
  /** Resolve the key for the NEXT search (credential planes, then environment). */
  resolveKey(): Promise<KeyResolution>
}

/**
 * The Gemini-grounded search provider. `available()` is a local check only; the
 * key is resolved per search, so a credential added or rotated after load is
 * picked up by the next call without a reload.
 */
export class GeminiSearchProvider implements WebSearchProvider {
  readonly id: string
  private readonly options: GeminiSearchProviderOptions

  constructor(options: GeminiSearchProviderOptions) {
    this.options = options
    this.id = options.id
  }

  available(): boolean {
    const options = this.options
    return (options.credentialPlane() || str(process.env[options.apiKeyEnv]) !== undefined)
      && URL.canParse(options.apiBase)
      && options.model.length > 0
      && options.timeoutMs > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.options
    const query = str(request.query)
    if (query === undefined) {
      throw new GeminiWebError('WEB_PROVIDER_ERROR', 'a Gemini grounded search needs a non-empty query', 'query', { provider: options.id })
    }
    if (signal?.aborted === true) throw abortError()
    const resolution = await options.resolveKey()
    if (resolution.value === undefined) {
      throw new GeminiWebError(
        'WEB_PROVIDER_CREDENTIAL_MISSING',
        `the Gemini web-search provider (id ${options.id}) has no API key for "${options.apiKeyEnv}": `
        + 'store it in the harness credential store ($DSH_HOME/.credentials.yaml refs) or export it in the '
        + 'launching environment. Search uses the provider route credential; it is NOT read from any config file. '
        + `[resolution: ${resolution.trail.join('; ')}]`,
        'credential',
        { provider: options.id, credential: options.apiKeyEnv },
      )
    }
    const key = resolution.value

    const controller = new AbortController()
    /** Re-read the caller signal: a function body is outside any narrowing. */
    const callerAborted = (): boolean => signal !== undefined && signal.aborted
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const endpoint = `${options.apiBase}/models/${encodeURIComponent(options.model)}:generateContent`
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(generateBody(query, options.grounded)),
        signal: controller.signal,
      })
    } catch (error) {
      if (callerAborted()) throw abortError()
      if (controller.signal.aborted) {
        throw new GeminiWebError(
          'WEB_PROVIDER_ERROR',
          `the Gemini request did not answer within ${options.timeoutMs} ms`,
          'gemini',
          { provider: options.id, model: options.model, timeoutMs: options.timeoutMs },
        )
      }
      throw new GeminiWebError(
        'WEB_PROVIDER_ERROR',
        `the Gemini API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        'gemini',
        { provider: options.id, model: options.model, apiBase: options.apiBase },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 400)
      throw new GeminiWebError(
        'WEB_PROVIDER_ERROR',
        `Gemini ${options.model} answered HTTP ${response.status}: ${detail}`,
        'gemini',
        { provider: options.id, model: options.model, status: response.status },
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new GeminiWebError(
        'WEB_PROVIDER_ERROR',
        `the Gemini answer was not JSON: ${error instanceof Error ? error.message : String(error)}`,
        'gemini',
        { provider: options.id, model: options.model },
      )
    }

    const text = candidateText(payload)
    const sources = groundedSources(payload, text)
    if (sources.length === 0 && text.length === 0) {
      throw new GeminiWebError(
        'WEB_PROVIDER_ERROR',
        `Gemini ${options.model} returned neither a grounded answer nor any grounding source for this query`,
        'gemini',
        { provider: options.id, model: options.model },
      )
    }
    return {
      ...text.length === 0 ? {} : { content: text.slice(0, MAX_CONTENT_CHARS) },
      sources,
      truncated: false,
    }
  }
}

/** The seam's cancellation error, structurally. */
function abortError(): GeminiWebError {
  return new GeminiWebError('WEB_ABORTED', 'the Gemini grounded search was aborted by its caller', 'abort')
}

/** The `ctx.web` seam of this context, or undefined (never throws). */
export function webSeamOf(ctx: ServiceContext): WebSeam | undefined {
  try {
    const direct = ctx.web
    if (isRecord(direct) && typeof direct.registerSearchProvider === 'function') return direct as unknown as WebSeam
  } catch {
    /* inject-gated property access: fall through to the non-strict lookup */
  }
  const viaLookup = serviceOf<WebSeam>(ctx, 'web')
  return viaLookup !== undefined && typeof viaLookup.registerSearchProvider === 'function' ? viaLookup : undefined
}

/** Register the Gemini grounded search provider with `ctx.web`. */
export function apply(ctx: ServiceContext, config: Config = {}): void {
  const log = loggerOf(ctx, name)
  const apiKeyEnv = str(config.apiKeyEnv) ?? DEFAULT_API_KEY_ENV
  const model = str(config.model) ?? DEFAULT_MODEL
  const apiBase = (str(config.apiBase) ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const providerId = str(config.providerId) ?? PROVIDER_ID
  const grounded = config.grounded !== false
  const timeoutMs = boundedInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS)

  const provider = new GeminiSearchProvider({
    id: providerId,
    apiKeyEnv,
    model,
    apiBase,
    grounded,
    timeoutMs,
    credentialPlane: () => credentialServices(ctx).length > 0 || str(process.env[apiKeyEnv]) !== undefined,
    resolveKey: () => resolveApiKey(ctx, apiKeyEnv),
  })

  const register = (seam: WebSeam | undefined): void => {
    if (seam === undefined) {
      throw new GeminiWebError(
        'missing-service',
        `the harness web seam (ctx.web) is not reachable from this plugin context, so the '${providerId}' search provider cannot be registered`,
        'register',
        { provider: providerId, service: 'web' },
      )
    }
    seam.registerSearchProvider(provider)
    log.info(
      `ctx.web provider registered: id=${providerId} model=${model} grounded=${grounded} credential=${apiKeyEnv}`,
    )
  }

  const seam = webSeamOf(ctx)
  if (seam !== undefined) {
    register(seam)
    return
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['web'], (injected) => register(webSeamOf(injected)))
    return
  }
  register(undefined)
}
