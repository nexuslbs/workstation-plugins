// `web-page` x `web-recipe`: the READ-THROUGH consumer seam.
//
// The recipe store is a separate plugin (plugins/web-recipe) that PROVIDES the
// service `web-recipe` (`ctx.provide`). This module is the consumer side: it
// looks the service up by NAME at call time, never imports the recipe plugin,
// and reports the outcome of every recipe-driven read back to the store
// (`markVerified`) so freshness/confidence decay follows REAL reads.
//
// Contract (what this consumer relies on, nothing more):
//   lookup(urlOrDomain) -> { domain, recipe, usable, reason? } | undefined
//   record(discovery)   -> { status: 'recorded' | 'skipped' | 'refused', ... }
//   markVerified(domain, ok, detail?) -> Recipe | undefined
//
// A deployment without the recipe plugin simply never resolves the service:
// every read takes the normal render path and the record gate stays silent.
//
// Precedence: an explicit CALLER parameter always beats a stored recipe. A
// recipe fills in what the caller did not specify (the API endpoint to call,
// the selectors to extract with) - it never overrides an argument.
import { PageError } from './errors.ts'

/** The `recipes:` block of the web-page config, already resolved. */
export interface RecipeConfig {
  /** Consult a stored recipe for the domain first (default true). */
  enabled: boolean
  /** RECORD a discovered read path when no recipe exists (default false). */
  record: boolean
  /** Provenance value written on a recorded recipe (`sourceThread`). */
  sourceThread?: string
}

/** One `recipe.save` caller is allowed to write: only the fields used here. */
export interface RecipeSelectorLike {
  name: string
  form: string
  selector: string
  description?: string
}

export interface RecipeApiLike {
  name: string
  url: string
  method?: string
  params?: Record<string, string>
  headers?: Record<string, string>
  credential?: string
  credentialHeader?: string
  jsonPath?: string
  sampleShape?: string
  notes?: string
}

export interface RecipeReadPathLike {
  kind: 'api' | 'render'
  url: string
  api?: string
  jsonPath?: string
  selectors?: string[]
  waitFor?: string
  notes?: string
}

export interface RecipeLike {
  domain: string
  schemaVersion: number
  disabled?: boolean
  readPath?: RecipeReadPathLike
  selectors?: RecipeSelectorLike[]
  apis?: RecipeApiLike[]
  quirks?: string
  provenance?: { confidence?: number; lastVerifiedAt?: string }
}

export interface RecipeLookupLike {
  domain: string
  recipe: RecipeLike
  usable: boolean
  reason?: string
}

export interface RecordResultLike {
  status: string
  reason?: string
}

/** The consumer-visible subset of the `web-recipe@1` service. */
export interface RecipeServiceLike {
  readonly contract: string
  lookup(urlOrDomain: string): Promise<RecipeLookupLike | undefined>
  record(discovery: Record<string, unknown>): Promise<RecordResultLike>
  markVerified(domain: string, ok: boolean, detail?: string): Promise<unknown>
}

/** The service tag this consumer is compatible with. */
export const RECIPE_CONTRACT = 'web-recipe@1'

/** The `recipes:` config block, defaulted (never throws). */
export function resolveRecipeConfig(raw: unknown): RecipeConfig {
  const block = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const sourceThread = typeof block.sourceThread === 'string' && block.sourceThread.trim().length > 0 ? block.sourceThread.trim() : undefined
  const config: RecipeConfig = { enabled: block.enabled !== false, record: block.record === true }
  if (sourceThread !== undefined) config.sourceThread = sourceThread
  return config
}

/**
 * The provided service, if the recipe plugin is loaded. Reads the cordis
 * service by name (a provided service is reachable as `ctx['web-recipe']`), and
 * refuses a foreign shape: an incompatible contract means the normal path.
 */
export function recipeServiceOf(ctx: unknown): RecipeServiceLike | undefined {
  const holder = ctx as { 'web-recipe'?: unknown } | undefined
  const candidate = holder?.['web-recipe']
  if (candidate === null || typeof candidate !== 'object') return undefined
  const service = candidate as RecipeServiceLike
  if (service.contract !== RECIPE_CONTRACT) return undefined
  if (typeof service.lookup !== 'function' || typeof service.record !== 'function' || typeof service.markVerified !== 'function') return undefined
  return service
}

/** The `apis[]` entry a recipe's read path names (or its only entry). */
export function apiOf(recipe: RecipeLike): RecipeApiLike | undefined {
  const apis = recipe.apis ?? []
  if (apis.length === 0) return undefined
  const readPath = recipe.readPath
  if (readPath === undefined || readPath.kind !== 'api') return undefined
  if (readPath.api !== undefined) {
    const named = apis.find((api) => api.name === readPath.api)
    if (named !== undefined) return named
  }
  if (readPath.url !== undefined) {
    const byUrl = apis.find((api) => api.url === readPath.url)
    if (byUrl !== undefined) return byUrl
  }
  return apis.length === 1 ? apis[0] : undefined
}

/** The CSS scopes a `render` recipe contributes (the forms the extractor knows). */
export function cssSelectorsOf(recipe: RecipeLike): string[] | undefined {
  const fromPath = (recipe.readPath?.selectors ?? []).filter((selector) => typeof selector === 'string' && selector.trim().length > 0)
  const fromEntries = (recipe.selectors ?? [])
    .filter((entry) => entry.form === 'css' && typeof entry.selector === 'string' && entry.selector.trim().length > 0)
    .map((entry) => entry.selector)
  const all = [...new Set([...fromPath, ...fromEntries].map((selector) => selector.trim()))]
  return all.length === 0 ? undefined : all
}

/** The `selectors[]` entries a discovery writes back (CSS is all we can see). */
export function recipeSelectorEntries(selectors: string[] | undefined): RecipeSelectorLike[] | undefined {
  if (selectors === undefined || selectors.length === 0) return undefined
  return selectors.map((selector, index) => ({ name: `scope${String(index + 1)}`, form: 'css', selector }))
}

/** Replace `{name}` placeholders in a URL/template from a params map. */
export function renderTemplate(template: string, params: Record<string, string> = {}): string {
  let out = template
  for (const [key, value] of Object.entries(params)) out = out.split(`{${key}}`).join(encodeURIComponent(value))
  return out
}

/** Resolve a dotted/indexed path (`data.items[0].title`) inside a payload. */
export function resolveJsonPath(value: unknown, jsonPath: string): unknown {
  let current: unknown = value
  const parts = jsonPath.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter((part) => part.length > 0)
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const DEFAULT_API_TIMEOUT_MS = 10000

export interface ApiReadOptions {
  /** Test seam: a fetch replacement. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Resolve a credential NAME to its value at call time (never logged). */
  resolveCredential?: (name: string) => Promise<string | undefined>
  /** Caller-supplied template params (win over the recipe's defaults). */
  params?: Record<string, string>
}

export interface ApiReadResult {
  api: RecipeApiLike
  /**
   * The credential NAME the recipe names but the deployment could not resolve.
   * The read still happens WITHOUT that header (a public endpoint answers, a
   * protected one 401s and the caller falls back) - a recipe naming an optional
   * credential must not make a domain unreadable.
   */
  credentialMissing?: string
  url: string
  method: string
  status: number
  contentType: string
  text: string
  /** The parsed body, when it is JSON. */
  json?: unknown
  /** `jsonPath` applied to the body (or the body itself). */
  data?: unknown
  chars: number
}

/**
 * Read a recipe's discovered API endpoint: one HTTP request, no browser, no
 * HTML parse. A non-2xx answer or a transport failure throws a `PageError`
 * (`recipe_failed`) which the caller reports to the store and then IGNORES by
 * falling back to the normal render path - a stale recipe never poisons a read.
 */
export async function readViaApi(recipe: RecipeLike, options: ApiReadOptions = {}): Promise<ApiReadResult> {
  const api = apiOf(recipe)
  if (api === undefined) throw new PageError('recipe_missing_api', 'the recipe names no API endpoint to read', { domain: recipe.domain })
  const params = { ...(api.params ?? {}), ...(options.params ?? {}) }
  if (api.params !== undefined) {
    for (const [key, value] of Object.entries(api.params)) {
      if (!(key in params) || params[key] === undefined) params[key] = renderTemplate(value, params)
    }
  }
  const url = renderTemplate(renderTemplate(api.url, params), params)
  const method = (api.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...(api.headers ?? {}) }
  let credentialMissing: string | undefined
  if (api.credential !== undefined && options.resolveCredential !== undefined) {
    let value: string | undefined
    try {
      value = await options.resolveCredential(api.credential)
    } catch {
      value = undefined
    }
    if (value === undefined) credentialMissing = api.credential
    else headers[api.credentialHeader ?? 'authorization'] = value
  } else if (api.credential !== undefined) {
    credentialMissing = api.credential
  }
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  let text: string
  try {
    const init: RequestInit = { method, headers, redirect: 'follow', signal: controller.signal }
    if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(params)
    response = await fetchImpl(url, init)
    text = await response.text()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PageError('recipe_failed', `the recipe's API endpoint did not answer: ${detail}`, {
      url,
      domain: recipe.domain,
      ...(credentialMissing === undefined ? {} : { credentialMissing }),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new PageError('recipe_failed', `the recipe's API endpoint answered HTTP ${String(response.status)}`, {
      url,
      domain: recipe.domain,
      ...(credentialMissing === undefined ? {} : { credentialMissing }),
      hint:
        credentialMissing === undefined
          ? 'the endpoint may have moved: re-verify the recipe and record the new path'
          : `the endpoint may need the credential '${credentialMissing}', which did not resolve in this deployment`,
    })
  }
  const contentType = response.headers.get('content-type') ?? ''
  let json: unknown
  if (contentType.includes('json') || looksLikeJson(text)) {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  const jsonPath = recipe.readPath?.jsonPath ?? api.jsonPath
  const data = json === undefined ? undefined : jsonPath === undefined ? json : resolveJsonPath(json, jsonPath)
  const result: ApiReadResult = { api, url, method, status: response.status, contentType, text, chars: text.length }
  if (credentialMissing !== undefined) result.credentialMissing = credentialMissing
  if (json !== undefined) result.json = json
  if (data !== undefined) result.data = data
  return result
}

function looksLikeJson(text: string): boolean {
  const head = text.trimStart()[0]
  return head === '{' || head === '['
}
