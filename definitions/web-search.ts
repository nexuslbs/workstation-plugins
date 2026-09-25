// definitions/web-search.ts - the `web-search@1` capability (the SEARCH side of
// web access; page FETCH lives in the `web-page`/`web-session` consumers).
//
// WHY THIS MODULE EXISTS: workbench could fetch a KNOWN url and render it, but
// had no way to ANSWER "search the web for X" - a real gap of the thread-2535
// list (item 7: "web search provider"). This module is the CONTRACT of that
// capability: one SEARCH operation with a normalized result list, a provider
// registry with SWAPPABLE engines and a typed error vocabulary.
//
//        Engine plugins  ->  Definition  <-  Consumer
//   core/web-search-stub              plugins/web-search-tools (`web search`)
//   core/web-search-tavily            any other caller of `ctx['web-search']`
//            \        /
//        core/web-search-impl  (the SERVICE HOST: registry + selection + cap + spill)
//
// SHAPE: modelled on the DeepSeek harness `web` group (MIT, `packages/web/*`),
// whose model this module follows: ONE seam (`ctx.web.search`), a provider
// REGISTRY, availability decided by a CHEAP LOCAL check (never a network call),
// selection by configured id with an ordered fallback, and the SEAM - not the
// engine - owning the result bound. See THIRD_PARTY.md for the MIT notice.
//
// ONE DELIBERATE DIFFERENCE from a "0 results" bug report that has bitten the
// omniagent `tools/web` server: an EMPTY result list is a legitimate answer ("the
// engine answered, it found nothing"), while a MISSING/BROKEN provider is a
// CONFIGURATION GAP and MUST be a typed error naming the config row to add. The
// two are never conflated here.
//
// This module is CORDIS-FREE and imports nothing but its sibling `support.ts`:
// the provider contract is STRUCTURAL, so an engine plugin only has to export
// the object this file describes, and `npm run check:seam` keeps it that way.

import {
  ServiceError,
  isRecord,
  positiveInt,
  serviceOf,
  str,
  type ServiceContext,
  type ServiceErrorCode,
} from './support.ts'

/** Name of the cordis service (`ctx['web-search']`). */
export const WEB_SEARCH = 'web-search'

/** Contract version this definition speaks. A provider must implement it. */
export const WEB_SEARCH_VERSION = 1

/** Contract id including the version, e.g. `web-search@1`. */
export const WEB_SEARCH_CONTRACT = `${WEB_SEARCH}@${WEB_SEARCH_VERSION}`

/** Results returned when the caller/config names no count. */
export const DEFAULT_SEARCH_COUNT = 5

/** Hard ceiling of the result count a caller can ask for. */
export const MAX_SEARCH_COUNT = 20

/** Inline character cap of one search answer (the overflow goes to `spill@1`). */
export const DEFAULT_SEARCH_MAX_CHARS = 12_000

/** Per-call deadline of one engine request. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000

/** Label of the spill file a capped result set is written to. */
export const SEARCH_SPILL_LABEL = 'web-search-results'

/** The filters a request may carry (also the vocabulary `info.filters` uses). */
export const SEARCH_FILTERS = ['language', 'freshness', 'safe', 'site'] as const

/** One filter name a request may carry. */
export type SearchFilter = (typeof SEARCH_FILTERS)[number]

// ---------------------------------------------------------------------------
// Errors. Every failure of this capability is a `WebSearchError` (a
// `ServiceError` subclass) whose `reason` is machine-branchable and whose
// `details` name the config row an operator must touch.
// ---------------------------------------------------------------------------

/** The reasons a call of this capability can fail (branch on `reason`). */
export type WebSearchErrorReason =
  /** The caller passed something the contract cannot use (empty query, ...). */
  | 'web-search.invalid-input'
  /** No `web-search@1` provider plugin is loaded at all. */
  | 'web-search.missing-service'
  /** No engine is configured AND none could be selected: a CONFIG GAP. */
  | 'web-search.not-configured'
  /** The caller named an engine that is not registered. */
  | 'web-search.provider-unknown'
  /** The selected engine exists but cannot run (missing credential, off, ...). */
  | 'web-search.provider-unavailable'
  /** No engine was configured and several are usable: pick one explicitly. */
  | 'web-search.ambiguous'
  /** Two engines tried to register the same id. */
  | 'web-search.duplicate-provider'
  /** The engine rejected the credential (HTTP 401/403). */
  | 'web-search.auth-failed'
  /** The engine is rate limiting this deployment (HTTP 429). */
  | 'web-search.rate-limited'
  /** The engine could not be reached (DNS, TLS, connection refused, ...). */
  | 'web-search.network'
  /** The engine did not answer within the deadline. */
  | 'web-search.timeout'
  /** The engine answered something this contract cannot parse. */
  | 'web-search.bad-response'
  /** The engine failed for a reason of its own (non-2xx it did not name). */
  | 'web-search.provider-error'
  /** The result set had to be spilled and `spill@1` refused/failed. */
  | 'web-search.spill-failed'
  /** The call was cancelled by the caller. */
  | 'web-search.cancelled'

export interface WebSearchErrorOptions {
  stage?: string
  details?: Record<string, unknown>
  /** The `ServiceError.code` reported alongside `reason` (default: derived from `reason`). */
  code?: ServiceErrorCode
}

/**
 * The `ServiceError.code` a reason reports when the caller names none: `reason` is
 * the PRECISE discriminator a caller branches on, the code is the coarse transport
 * taxonomy of `definitions/support.ts` (which has no value for a rejected
 * credential or a rate limit, so those map to the closest one it has).
 */
const REASON_CODES: Partial<Record<WebSearchErrorReason, ServiceErrorCode>> = {
  'web-search.not-configured': 'not-configured',
  'web-search.missing-service': 'missing-service',
  'web-search.provider-unavailable': 'not-configured',
  'web-search.ambiguous': 'invalid-config',
  'web-search.duplicate-provider': 'invalid-config',
  'web-search.auth-failed': 'credential-unsupported',
  'web-search.network': 'unreachable',
  'web-search.timeout': 'timeout',
  'web-search.bad-response': 'malformed-output',
}

/** The one error shape this capability throws. */
export class WebSearchError extends ServiceError {
  readonly reason: WebSearchErrorReason

  constructor(reason: WebSearchErrorReason, message: string, options: WebSearchErrorOptions = {}) {
    super(options.code ?? REASON_CODES[reason] ?? 'invalid-input', message, {
      stage: options.stage ?? 'web-search',
      details: { reason, ...options.details },
    })
    this.name = 'WebSearchError'
    this.reason = reason
  }

  /** A JSON-safe view (what a tool answer carries, never a credential value). */
  override toJSON(): {
    error: string
    code: ServiceErrorCode
    stage: string
    reason: WebSearchErrorReason
    details: Record<string, unknown>
  } {
    return { error: this.message, code: this.code, stage: this.stage, reason: this.reason, details: this.details }
  }
}

/** Narrows anything thrown by this capability to its typed form. */
export function isWebSearchError(value: unknown): value is WebSearchError {
  return value instanceof WebSearchError
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

/**
 * One SEARCH request. Everything but `query` is optional and every filter is
 * passed to the engine as-is: an engine that does not support one says so in its
 * `filters` list and the answer reports it under `ignoredFilters` - a filter is
 * never silently pretended to have applied.
 */
export interface WebSearchRequest {
  /** What to search for (required, non-empty). */
  query: string
  /** How many results to return (default {@link DEFAULT_SEARCH_COUNT}, max {@link MAX_SEARCH_COUNT}). */
  count?: number
  /** Language hint, e.g. `en`, `de` (only for engines that declare it). */
  language?: string
  /** Freshness window: `day`/`week`/`month`/`year`, a day count, or a duration like `7d`. */
  freshness?: string | number
  /** Safe-search hint (only for engines that declare it). */
  safe?: boolean
  /** Restrict to one site/domain, e.g. `docs.example.com`. */
  site?: string
  /** Force ONE engine id (overrides the configured default + fallback chain). */
  engine?: string
}

/** One result as an ENGINE reports it (before ranking/annotation). */
export interface WebSearchHit {
  title: string
  url: string
  snippet: string
  /** Publication date the engine reported, verbatim (never invented here). */
  published?: string
}

/** What the seam hands an engine for one call. */
export interface WebSearchCallOptions {
  /** Results the seam will keep after ranking (a hint: ask the engine for at least this many). */
  count: number
  /** Bounded deadline of the call in ms. */
  timeoutMs: number
  /** Aborted when the deadline expires or the caller cancels. */
  signal?: AbortSignal
}

/**
 * A SEARCH ENGINE plugin. One plugin = one engine; it registers itself with the
 * service host (`ctx['web-search'].register(provider)`), so the active engine is
 * a CONFIG choice and the caller never imports an engine module.
 */
export interface WebSearchProvider {
  /** Stable id used in the config and in `engine:` of a request, e.g. `tavily`. */
  id: string
  /** Engine name reported in every result (`engine` field); defaults to `id`. */
  engine?: string
  /** True for the offline fixture engine(s): the answer metadata says so. */
  stub?: boolean
  /** The request filters this engine actually honours (see {@link SEARCH_FILTERS}). */
  filters?: readonly SearchFilter[]
  /**
   * A CHEAP, LOCAL availability check (is the credential present? is the base
   * url set?): never a network call, so `web search providers` stays fast and
   * cannot hang on an unreachable engine.
   */
  available(): boolean | Promise<boolean>
  /** Why the engine cannot run (names the credential/config row to fix). */
  unavailableReason?(): string | undefined
  /**
   * Runs the search. It returns RAW hits (title/url/snippet, engine-specific
   * extras allowed as records); the seam normalizes them into
   * {@link WebSearchResult}s and ranks them. It throws a {@link WebSearchError}
   * with the right reason on failure; an engine that found nothing returns [].
   */
  search(request: WebSearchRequest, options: WebSearchCallOptions): Promise<readonly unknown[]>
}

/** One normalized result (this is what a caller consumes). */
export interface WebSearchResult {
  /** 1-based position in the ranked list. */
  rank: number
  title: string
  url: string
  snippet: string
  /** Publication date as the engine reported it, when it reported one. */
  published?: string
  /** Engine that produced this result (never dropped, never faked). */
  engine: string
}

/** What an engine looks like in the `web search providers` introspection. */
export interface WebSearchProviderInfo {
  id: string
  engine: string
  stub: boolean
  filters: SearchFilter[]
  /** True when this engine is the configured default or in the fallback chain. */
  configured: boolean
  /** The engine's local availability verdict. */
  available: boolean
  /** Why it is unavailable (the credential/config row to add). */
  reason?: string
}

/** The selection in effect (never a credential value). */
export interface WebSearchSelection {
  /** The configured default engine id, when one is configured. */
  provider?: string
  /** The ordered fallback chain consulted after the default. */
  fallback: string[]
  count: number
  maxCount: number
  maxChars: number
  spill: boolean
  timeoutMs: number
}

/** The answer of one search call. */
export interface WebSearchAnswer {
  query: string
  /** The engine id that answered. */
  provider: string
  /** The engine name carried by every result. */
  engine: string
  /** True when a fixture/stub engine answered (never hidden from the caller). */
  stub: boolean
  /** Results returned inline. */
  count: number
  /** Wall-clock duration of the engine call in ms. */
  tookMs: number
  results: WebSearchResult[]
  /** True when the inline answer is not the whole result set (see `spillPath`). */
  truncated: boolean
  /** The inline character cap in effect. */
  maxChars: number
  /** Requested filters the engine does not honour (honesty, never dropped). */
  ignoredFilters: SearchFilter[]
  /** Results the engine returned that the count/char cap did not include. */
  dropped: number
  /** Where the FULL result set was written (only when it really was written). */
  spillPath?: string
  /** SHA-256 of the spilled payload. */
  spillSha256?: string
  /** Bytes of the spilled payload. */
  spillBytes?: number
  /** Human note: why the answer is capped, or which engine answered. */
  note?: string
}

/**
 * The capability a consumer reaches as `ctx['web-search']`: search through the
 * selected engine, introspect the registry, and (as an engine plugin) register.
 */
export interface WebSearchService {
  /** Searches through the selected engine (default or configured fallback chain). */
  search(request: WebSearchRequest): Promise<WebSearchAnswer>
  /** The registered engines with their configured/available state. */
  providers(): Promise<WebSearchProviderInfo[]>
  /** Registers an engine; the returned disposer unregisters it (plugin unload). */
  register(provider: WebSearchProvider): () => void
  /** The selection in effect. */
  selection(): WebSearchSelection
}

/** The config of the service host (`core/web-search-impl`). */
export interface WebSearchConfig {
  /** Default engine id; absent: choose among the usable ones. */
  provider?: string
  /** Ordered fallback chain consulted when the default cannot run. */
  fallback?: readonly string[]
  /** Default result count of a call that names none. */
  count?: number
  /** Hard ceiling of a caller-supplied count (default {@link MAX_SEARCH_COUNT}). */
  maxCount?: number
  /** Inline character cap of one answer (default {@link DEFAULT_SEARCH_MAX_CHARS}). */
  maxChars?: number
  /** Hand the overflow of the cap to `spill@1` (default true). */
  spill?: boolean
  /** Per-call deadline in ms (default {@link DEFAULT_SEARCH_TIMEOUT_MS}). */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// PURE helpers (no I/O: unit-testable with no engine, no network, no disk).
// ---------------------------------------------------------------------------

/** The config row an operator must edit to configure a search engine. */
export const SEARCH_CONFIG_ROW = 'config.yml -> plugins.web-search-impl: { provider: <engine id>, fallback: [<engine id>, ...] }'

/** A credential NAME that names an engine's key, e.g. `TAVILY_API_KEY`. */
export function credentialNameOf(value: unknown, fallback: string): string {
  return str(value) ?? fallback
}

/** A request query: trimmed, non-empty, else `web-search.invalid-input`. */
export function normalizeQuery(value: unknown): string {
  const query = str(value)
  if (query === undefined) {
    throw new WebSearchError('web-search.invalid-input', 'the search query is required and must be a non-empty string', {
      stage: 'web-search',
      details: { parameter: 'query' },
    })
  }
  return query
}

/** The result count of a call: caller value, else config default, never above `max`. */
export function resolveCount(value: unknown, fallback: number, max: number): number {
  const requested = positiveInt(value, fallback, max)
  return Math.max(1, requested)
}

/**
 * A freshness hint as a DAY count: `7`, `'7'`, `'7d'`, `'day'`, `'week'`,
 * `'month'`, `'year'` (also `d/w/m/y`). `undefined` when the caller passed
 * nothing usable, so an engine can report the filter as ignored.
 */
export function freshnessToDays(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  const raw = str(value)?.toLowerCase()
  if (raw === undefined) return undefined
  const named: Record<string, number> = { day: 1, days: 1, d: 1, week: 7, weeks: 7, w: 7, month: 30, months: 30, m: 30, year: 365, years: 365, y: 365 }
  if (named[raw] !== undefined) return named[raw]
  const match = /^(\d+)\s*([dwmy])?$/.exec(raw)
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = match[2]
  if (unit === undefined) return amount
  return amount * (named[unit] ?? 1)
}

/** The requested filters of a request, in the published vocabulary order. */
export function requestedFilters(request: WebSearchRequest): SearchFilter[] {
  const filters: SearchFilter[] = []
  if (str(request.language) !== undefined) filters.push('language')
  if (str(request.freshness) !== undefined || typeof request.freshness === 'number') filters.push('freshness')
  if (typeof request.safe === 'boolean') filters.push('safe')
  if (str(request.site) !== undefined) filters.push('site')
  return filters
}

/** The requested filters the engine does NOT honour (never silently dropped). */
export function ignoredFiltersOf(request: WebSearchRequest, provider: WebSearchProvider): SearchFilter[] {
  const supported = new Set<string>(provider.filters ?? [])
  return requestedFilters(request).filter((filter) => !supported.has(filter))
}

/** A usable http(s) url, or undefined. */
function searchUrl(value: unknown): string | undefined {
  const raw = str(value)
  if (raw === undefined) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

/** One engine hit as a normalized result, or a reason it was rejected. */
function normalizeHit(raw: unknown, engine: string, rank: number): WebSearchResult | 'no-url' | 'no-title' {
  if (!isRecord(raw)) return 'no-url'
  const url = searchUrl(raw.url ?? raw.link ?? raw.href)
  if (url === undefined) return 'no-url'
  const title = str(raw.title ?? raw.name ?? raw.heading)
  if (title === undefined) return 'no-title'
  const snippet = str(raw.snippet ?? raw.content ?? raw.description ?? raw.text) ?? ''
  const published = str(raw.published ?? raw.published_date ?? raw.publishedDate ?? raw.date ?? raw.pubDate)
  return {
    rank,
    title,
    url,
    snippet,
    ...(published === undefined ? {} : { published }),
    engine,
  }
}

/**
 * Normalizes + ranks raw engine hits. Drops entries without a usable url/title
 * (counted in `dropped`) and returns at most `limit` results. The ranking is the
 * engine's own ORDER (an engine that scores its hits must sort them itself:
 * re-scoring a vendor payload here would be invented authority).
 */
export function normalizeResults(
  raws: readonly unknown[],
  engine: string,
  limit: number,
): { results: WebSearchResult[]; dropped: number; skipped: number } {
  const results: WebSearchResult[] = []
  let skipped = 0
  for (const raw of raws) {
    if (results.length >= limit) break
    const normalized = normalizeHit(raw, engine, results.length + 1)
    if (typeof normalized === 'string') {
      skipped += 1
      continue
    }
    results.push(normalized)
  }
  return { results, dropped: Math.max(0, raws.length - results.length - skipped), skipped }
}

/** The durable payload of a capped answer: the WHOLE result set, JSON. */
export function searchSpillPayload(answer: Pick<WebSearchAnswer, 'query' | 'provider' | 'engine' | 'tookMs'>, all: readonly WebSearchResult[]): string {
  return (
    JSON.stringify(
      {
        query: answer.query,
        provider: answer.provider,
        engine: answer.engine,
        tookMs: answer.tookMs,
        count: all.length,
        results: all,
        spilledAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * The INLINE window of a result set: as many ranked results as fit in `maxChars`
 * (at least one, so a tiny cap still answers). `truncated` is true when the
 * window is not the whole list; the caller decides what to do with the rest
 * (this capability hands it to `spill@1`).
 */
export function capResults(
  results: readonly WebSearchResult[],
  maxChars: number,
): { results: WebSearchResult[]; truncated: boolean } {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Number.POSITIVE_INFINITY
  const kept: WebSearchResult[] = []
  for (const result of results) {
    const candidate = [...kept, result]
    if (kept.length > 0 && JSON.stringify(candidate).length > budget) return { results: kept, truncated: true }
    if (kept.length === 0 && JSON.stringify(candidate).length > budget) return { results: candidate, truncated: results.length > 1 }
    kept.push(result)
  }
  return { results: kept, truncated: false }
}

// ---------------------------------------------------------------------------
// Service lookup: the consumer resolves the capability by NAME at call time.
// ---------------------------------------------------------------------------

/** The `web-search@1` service, when the deployment loaded a provider plugin. */
export function webSearchOf(ctx: ServiceContext): WebSearchService | undefined {
  const service = serviceOf<WebSearchService>(ctx, WEB_SEARCH)
  return service !== undefined && typeof service.search === 'function' ? service : undefined
}

/** The `web-search@1` service, or a structured error naming the config row. */
export function requireWebSearch(ctx: ServiceContext): WebSearchService {
  const service = webSearchOf(ctx)
  if (service === undefined) {
    throw new WebSearchError(
      'web-search.missing-service',
      `no web-search@1 provider is loaded: add a 'web-search-impl' row to the plugins roster (${SEARCH_CONFIG_ROW})`,
      { stage: 'lookup', code: 'missing-service', details: { service: WEB_SEARCH } },
    )
  }
  return service
}
