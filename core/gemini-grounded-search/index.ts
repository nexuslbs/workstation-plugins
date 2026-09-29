// core/web-search-gemini - the `web-search@1` PROVIDER HOST + the GEMINI
// GROUNDED SEARCH engine, in ONE row.
//
// WHY THIS PLUGIN EXISTS. The workstation roster registers the capability
// CONSUMER (`plugins/web-search-tools`: the `web_search_grounded` /
// `web_search_providers` tools) but no `web-search@1` provider host was ever loaded, so
// every grounded search answered
//   {"ok":false,"error":{"code":"missing-service","reason":"web-search.missing-service",
//    "error":"no web-search@1 provider is loaded: add a 'web-search-impl' row ..."}}
// (config/workstation.yml DECISION 1, verified raw against the running service).
//
// The missing host (`core/web-search-impl`: registry + selection + cap + spill)
// is the remaining work named by that decision. This plugin delivers the seam
// NOW for ONE engine that needs no third-party search API at all: the Google
// GEMINI model, whose native `google_search` tool performs GROUNDING server side
// and returns the sources it used (`groundingMetadata.groundingChunks`). So one
// row gives every dsh agent a working `web_search_grounded` whose answers carry real
// source URLs, and the researcher role (workstation/profiles/gemini-researcher)
// gets the capability its briefing is about.
//
// WHAT IT IS (and is not):
//   * it PROVIDES `ctx['web-search']` (definitions/web-search.ts) once, and
//     registers ONE engine with it (id `gemini`), so the seam stays swappable:
//     a future generic `core/web-search-impl` host plus a second engine plugin
//     replaces this row by CONFIG alone;
//   * it is NOT a paid search API wrapper: the answers and their sources come
//     from the Gemini API's own grounding, never from Brave/Tavily/... ;
//   * it never logs, returns or embeds a credential value: the key is resolved
//     by NAME through `ctx.credentials` at CALL time and travels in the
//     `x-goog-api-key` header only.
//
// READ-ONLY by construction: the only request this plugin issues is a
// `models/<id>:generateContent` call. No write, no browser, no local binary.

import {
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_MAX_CHARS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_COUNT,
  SEARCH_CONFIG_ROW,
  WEB_SEARCH,
  WebSearchError,
  capResults,
  ignoredFiltersOf,
  normalizeQuery,
  normalizeResults,
  resolveCount,
  type SearchFilter,
  type WebSearchAnswer,
  type WebSearchCallOptions,
  type WebSearchConfig,
  type WebSearchProvider,
  type WebSearchProviderInfo,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSelection,
  type WebSearchService,
} from '../../definitions/web-search.ts'
import { loggerOf } from '../../definitions/logger.ts'
import { credentialsOf, provideService, type ServiceContext } from '../../definitions/support.ts'

export const name = 'web-search-gemini'

/** Default credential NAME resolved through `ctx.credentials` (never a value). */
export const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'

/** Default model id. A REAL, API-accepted Gemini id (never a marketing name). */
export const DEFAULT_MODEL = 'gemini-2.5-flash'

/** Default API root of the Gemini `v1beta` REST surface. */
export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Engine id this route registers (the `engine:` value of a request). */
export const DEFAULT_ENGINE_ID = 'gemini'

/** Filters this engine really honours (Gemini grounding takes only the query). */
const SUPPORTED_FILTERS: readonly SearchFilter[] = []

/** Request filters the PROMPT can carry (reported honestly, never faked). */
const PROMPT_FILTERS: readonly SearchFilter[] = ['language', 'site']

/** Cap of the grounded answer text carried in the answer `note` (chars). */
export const MAX_NOTE_CHARS = 4000

export interface Config extends WebSearchConfig {
  /** Credential NAME of the Gemini API key (default {@link DEFAULT_API_KEY_ENV}). */
  apiKeyEnv?: string
  /** Gemini model id (default {@link DEFAULT_MODEL}). */
  model?: string
  /** API root (default {@link DEFAULT_API_BASE}); a proxy/stub may override it. */
  apiBase?: string
  /** Engine id registered with the seam (default {@link DEFAULT_ENGINE_ID}). */
  engineId?: string
  /** Send the native `google_search` grounding tool (default true). */
  grounded?: boolean
}

/** The per-call holder the engine writes the grounded answer text into. */
interface AnswerHolder {
  text?: string
  model?: string
  chunks?: number
}

/** The options a host of this plugin hands its engine (the seam's plus the holder). */
interface GeminiCallOptions extends WebSearchCallOptions {
  answer?: AnswerHolder
}

/** Read a non-empty string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** A whole number in [min, max], or the fallback. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

/** The prompt one search is submitted as (filters become explicit instructions). */
export function buildPrompt(request: WebSearchRequest): string {
  const parts = [
    'Search the web for the query below and answer in at most 8 sentences.',
    'List the sources you used as markdown links.',
    '',
    `Query: ${normalizeQuery(request.query)}`,
  ]
  if (str(request.site) !== undefined) parts.push(`Restrict the search to the site: ${String(request.site)}`)
  if (str(request.language) !== undefined) parts.push(`Answer in this language: ${String(request.language)}`)
  return parts.join('\n')
}

/** The `generateContent` request body: the grounding tool on, temperature low. */
export function generateBody(request: WebSearchRequest, grounded: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(request) }] }],
    generationConfig: { temperature: 0.2 },
  }
  if (grounded) body.tools = [{ google_search: {} }]
  return body
}

/** Every non-empty text part of the first candidate, joined. */
function candidateText(payload: unknown): string {
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
 * The sources of a grounded answer as raw engine hits: one hit per
 * `groundingChunks[].web` entry, with the segment text `groundingSupports`
 * attributes to that chunk as the snippet (the grounded span, not invented text).
 */
export function groundedHits(payload: unknown, answerText: string): Array<Record<string, unknown>> {
  const metadata = ((payload as { candidates?: unknown[] } | undefined)?.candidates?.[0] as
    | { groundingMetadata?: unknown }
    | undefined)?.groundingMetadata as Record<string, unknown> | undefined
  const chunks = Array.isArray(metadata?.groundingChunks) ? (metadata.groundingChunks as unknown[]) : []
  const supports = Array.isArray(metadata?.groundingSupports) ? (metadata.groundingSupports as unknown[]) : []
  const segmentByChunk = new Map<number, string>()
  for (const support of supports) {
    const entry = support as { segment?: { text?: unknown }; groundingChunkIndices?: unknown }
    const text = str(entry.segment?.text)
    const indices = Array.isArray(entry.groundingChunkIndices) ? entry.groundingChunkIndices : []
    if (text === undefined) continue
    for (const index of indices) {
      if (typeof index !== 'number' || segmentByChunk.has(index)) continue
      segmentByChunk.set(index, text)
    }
  }
  const fallbackSnippet = answerText.length > 0 ? answerText.slice(0, 400) : ''
  const hits: Array<Record<string, unknown>> = []
  for (const [index, chunk] of chunks.entries()) {
    const web = (chunk as { web?: unknown })?.web as { uri?: unknown; title?: unknown } | undefined
    const url = str(web?.uri)
    if (url === undefined) continue
    const title = str(web?.title) ?? url
    const snippet = segmentByChunk.get(index) ?? fallbackSnippet
    hits.push({ title, url, snippet, engine: DEFAULT_ENGINE_ID })
  }
  return hits
}

/** The typed reason for a non-2xx Gemini answer. */
export function reasonForStatus(status: number): 'web-search.auth-failed' | 'web-search.rate-limited' | 'web-search.provider-error' {
  if (status === 401 || status === 403) return 'web-search.auth-failed'
  if (status === 429) return 'web-search.rate-limited'
  return 'web-search.provider-error'
}

export function apply(ctx: ServiceContext, config: Config = {}): void {
  const log = loggerOf(ctx, name)
  const apiKeyEnv = str(config.apiKeyEnv) ?? DEFAULT_API_KEY_ENV
  const model = str(config.model) ?? DEFAULT_MODEL
  const apiBase = (str(config.apiBase) ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const engineId = str(config.engineId) ?? DEFAULT_ENGINE_ID
  const grounded = config.grounded !== false
  const defaultCount = boundedInt(config.count, DEFAULT_SEARCH_COUNT, 1, MAX_SEARCH_COUNT)
  const maxCount = boundedInt(config.maxCount, MAX_SEARCH_COUNT, 1, MAX_SEARCH_COUNT)
  const maxChars = boundedInt(config.maxChars, DEFAULT_SEARCH_MAX_CHARS, 256, 4_000_000)
  const timeoutMs = boundedInt(config.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 1000, 120_000)
  const spill = config.spill === true
  const fallback = Array.isArray(config.fallback) ? config.fallback.filter((id): id is string => typeof id === 'string') : []
  const configuredProvider = str(config.provider)

  /** Why the engine cannot run right now (the exact failure, for `web_search_providers`). */
  let lastReason = `the Gemini API key is not configured: add the credential ${apiKeyEnv} to the harness credential store (${SEARCH_CONFIG_ROW})`

  /**
   * Resolve the Gemini key BY NAME at call time (never cached, never logged).
   *
   * The harness `CredentialRef` is a BRANDED STRING (`credentialRef(value:
   * string)`), not an object: the reference IS the environment-variable name.
   * The structural `CredentialsLike` of `definitions/support.ts` types it as
   * `{ name, scope? }`, so the name is passed the way every provider of this
   * repository passes it (a string) and the declared shape is satisfied by a
   * cast - the same runtime call the email/sms/totp providers make.
   *
   * `lastReason` carries the OBSERVED reason (service missing vs reference
   * unresolved) so `web_search_providers` never guesses. It never carries a
   * value: only the names of the fields the store answered with.
   */
  const resolveKey = async (): Promise<string | undefined> => {
    const credentials = credentialsOf(ctx)
    if (credentials === undefined) {
      lastReason = `the credentials service is not reachable from this plugin context (ctx.get is ${typeof ctx.get})`
      return undefined
    }
    const resolved = await credentials.resolve(apiKeyEnv as unknown as { name: string; scope?: string })
    const value = str((resolved as { value?: unknown } | undefined)?.value)
    if (value === undefined) {
      lastReason = resolved === undefined
        ? `the credential ${apiKeyEnv} is not present in the harness credential store (${SEARCH_CONFIG_ROW})`
        : `the credential ${apiKeyEnv} resolved without a usable value (fields: ${Object.keys(resolved as object).join(', ')})`
      return undefined
    }
    lastReason = ''
    return value
  }

  const gemini: WebSearchProvider & { answer: (request: WebSearchRequest, options: GeminiCallOptions) => Promise<ReadonlyArray<Record<string, unknown>>> } = {
    id: engineId,
    engine: engineId,
    filters: SUPPORTED_FILTERS,
    available: async () => (await resolveKey()) !== undefined,
    unavailableReason: () => lastReason,
    search: (request, options) => gemini.answer(request, options as GeminiCallOptions),
    answer: async (request, options) => {
      const key = await resolveKey()
      if (key === undefined) {
        throw new WebSearchError(
          'web-search.provider-unavailable',
          `the Gemini API key is not configured: add the credential ${apiKeyEnv} to the harness credential store`,
          { stage: 'gemini', details: { credential: apiKeyEnv, model } },
        )
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      const onAbort = (): void => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      let response: Response
      try {
        response = await fetch(`${apiBase}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(generateBody(request, grounded)),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new WebSearchError('web-search.timeout', `the Gemini request did not answer within ${options.timeoutMs} ms`, {
            stage: 'gemini',
            details: { model, timeoutMs: options.timeoutMs },
          })
        }
        throw new WebSearchError('web-search.network', `the Gemini API could not be reached: ${error instanceof Error ? error.message : String(error)}`, {
          stage: 'gemini',
          details: { model, apiBase },
        })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 400)
        const reason = reasonForStatus(response.status)
        throw new WebSearchError(reason, `Gemini ${model} answered HTTP ${response.status}: ${detail}`, {
          stage: 'gemini',
          details: { model, status: response.status },
        })
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new WebSearchError('web-search.bad-response', `the Gemini answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, {
          stage: 'gemini',
          details: { model },
        })
      }
      const text = candidateText(payload)
      const hits = groundedHits(payload, text)
      if (options.answer !== undefined) {
        options.answer.text = text
        options.answer.model = model
        options.answer.chunks = hits.length
      }
      log.info?.(`gemini grounded search: model=${model} chunks=${hits.length} textChars=${text.length}`)
      return hits
    },
  }

  const registry = new Map<string, WebSearchProvider>()
  const disposed = registry.set(gemini.id, gemini)

  const selection = (): WebSearchSelection => ({
    ...configuredProvider === undefined ? {} : { provider: configuredProvider },
    fallback,
    count: defaultCount,
    maxCount,
    maxChars,
    spill,
    timeoutMs,
  })

  /** The engine that answers one request (configured id, else the only usable one). */
  const select = async (request: WebSearchRequest): Promise<WebSearchProvider> => {
    const named = str(request.engine)
    if (named !== undefined) {
      const provider = registry.get(named)
      if (provider === undefined) {
        throw new WebSearchError('web-search.provider-unknown', `no engine '${named}' is registered (registered: ${[...registry.keys()].join(', ') || 'none'})`, {
          stage: 'select',
          details: { engine: named, registered: [...registry.keys()] },
        })
      }
      return provider
    }
    const ordered = [configuredProvider, ...fallback].filter((id): id is string => id !== undefined)
    for (const id of ordered) {
      const provider = registry.get(id)
      if (provider !== undefined && (await provider.available())) return provider
    }
    const usable: WebSearchProvider[] = []
    for (const provider of registry.values()) {
      if (await provider.available()) usable.push(provider)
    }
    if (usable.length === 1) return usable[0] as WebSearchProvider
    if (usable.length === 0) {
      throw new WebSearchError('web-search.not-configured', `no search engine can run: ${SEARCH_CONFIG_ROW}`, {
        stage: 'select',
        details: { registered: [...registry.keys()], configured: configuredProvider ?? null },
      })
    }
    throw new WebSearchError('web-search.ambiguous', `${usable.length} engines are usable; name one with 'provider' or with engine: in the request`, {
      stage: 'select',
      details: { usable: usable.map((provider) => provider.id) },
    })
  }

  const service: WebSearchService = {
    search: async (request: WebSearchRequest): Promise<WebSearchAnswer> => {
      const query = normalizeQuery(request.query)
      const provider = await select(request)
      if (!(await provider.available())) {
        const reason = provider.unavailableReason?.() ?? 'the engine is not configured'
        throw new WebSearchError('web-search.provider-unavailable', reason, {
          stage: 'select',
          details: { engine: provider.id },
        })
      }
      const count = resolveCount(request.count, defaultCount, maxCount)
      const holder: AnswerHolder = {}
      const started = Date.now()
      const raws = await provider.search({ ...request, query }, { count, timeoutMs, answer: holder } as GeminiCallOptions)
      const tookMs = Date.now() - started
      const engineName = provider.engine ?? provider.id
      const { results, dropped } = normalizeResults(raws, engineName, count)
      const capped = capResults(results, maxChars)
      const ignored = ignoredFiltersOf({ ...request, query }, provider)
      const noteParts: string[] = []
      if (holder.text !== undefined && holder.text.length > 0) {
        noteParts.push(`grounded answer (Gemini ${holder.model ?? model}, google_search): ${holder.text.slice(0, MAX_NOTE_CHARS)}`)
      }
      if (results.length === 0) noteParts.push('the engine answered, it returned no source URL for this query')
      const answer: WebSearchAnswer = {
        query,
        provider: provider.id,
        engine: engineName,
        stub: provider.stub === true,
        count: capped.results.length,
        tookMs,
        results: capped.results,
        truncated: capped.truncated,
        maxChars,
        ignoredFilters: ignored,
        dropped: dropped + (capped.truncated ? results.length - capped.results.length : 0),
        ...noteParts.length === 0 ? {} : { note: noteParts.join(' | ') },
      }
      return answer
    },
    providers: async (): Promise<WebSearchProviderInfo[]> => {
      const infos: WebSearchProviderInfo[] = []
      for (const provider of registry.values()) {
        const available = await provider.available()
        infos.push({
          id: provider.id,
          engine: provider.engine ?? provider.id,
          stub: provider.stub === true,
          filters: [...(provider.filters ?? [])],
          configured: provider.id === configuredProvider || fallback.includes(provider.id) || (configuredProvider === undefined && registry.size === 1),
          available,
          ...available ? {} : { reason: provider.unavailableReason?.() ?? 'the engine is not configured' },
        })
      }
      return infos
    },
    register: (provider: WebSearchProvider): (() => void) => {
      if (registry.has(provider.id) && registry.get(provider.id) !== provider) {
        throw new WebSearchError('web-search.duplicate-provider', `engine '${provider.id}' is already registered`, {
          stage: 'register',
          details: { engine: provider.id },
        })
      }
      registry.set(provider.id, provider)
      return () => {
        if (registry.get(provider.id) === provider) registry.delete(provider.id)
      }
    },
    selection,
  }

  provideService(ctx, WEB_SEARCH, service)
  ctx.effect?.(() => () => {
    disposed.delete(gemini.id)
  })
  log.info?.(`web-search@1 provider hosted: engine=${engineId} model=${model} grounded=${grounded} credential=${apiKeyEnv}`)
}

/** The engine registered at apply time (a test or a host may reuse the factory). */
export { PROMPT_FILTERS, SUPPORTED_FILTERS, type AnswerHolder, type GeminiCallOptions, type WebSearchResult }
