// plugins/web-search-tools - the CONSUMER of the web SEARCH capability
// (`web-search@1`).
//
// Three roles make up the seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/web-search.ts) - the contract, `ctx['web-search']`
//   Provider                          - the service host (`core/web-search-impl`)
//                                       plus the ENGINE plugins that register
//                                       with it (stub, tavily, ...)
//   Consumer                          - THIS plugin: the agent-facing tools.
//
// It imports the DEFINITION only, so the engine behind `web search` is a CONFIG
// choice and `npm run check:seam` enforces that direction.
//
// TWO TOOLS, on purpose:
//   * `web search` - the search itself: query + count + filters, normalized
//     results with rank/url/title/snippet/engine, caps reported (and the overflow
//     spilled) exactly like every other capped answer of this repository;
//   * `web search providers` - introspection: which engines are registered,
//     which are configured, which are USABLE and, when one is not, the credential
//     and the config row to add. This is the tool that tells an operator the
//     difference between "0 results" (a working engine) and "no engine" (a
//     configuration gap).
//
// A TYPED FAILURE IS RETURNED, NOT THROWN: `web search` answers
// `{ ok: false, error: { reason, code, details, error } }` when the capability
// fails (no engine configured, unknown engine, auth failure, rate limit, network,
// timeout), so the reason survives the tools seam (which maps a THROWN error to a
// generic `tool-failed` body) and a caller can branch on it.

import { isWebSearchError, webSearchOf, SEARCH_CONFIG_ROW } from '../../definitions/web-search.ts'
import type { WebSearchAnswer, WebSearchError, WebSearchRequest, WebSearchService } from '../../definitions/web-search.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'
import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'web-search-tools'

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
  get?(name: string, strict?: boolean): unknown
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new WebSearchErrorLike(`the '${key}' parameter must be a string`, key)
  }
  return value.length === 0 ? undefined : value
}

/** Read an optional boolean parameter. */
function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new WebSearchErrorLike(`the '${key}' parameter must be a boolean`, key)
  return value
}

/** Read an optional integer parameter. */
function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new WebSearchErrorLike(`the '${key}' parameter must be a positive integer`, key)
  }
  return value
}

/**
 * A parameter violation raised from the tool itself. The tools provider already
 * validates the declared schema before the handler runs, so this only fires for a
 * caller that bypassed it; it carries the SAME shape a capability error does.
 */
class WebSearchErrorLike extends Error {
  readonly parameter: string

  constructor(message: string, parameter: string) {
    super(message)
    this.name = 'WebSearchError'
    this.parameter = parameter
  }
}

/** The failure body of a tool answer: the typed reason, never an empty list. */
function failureBody(error: unknown): Record<string, unknown> {
  if (isWebSearchError(error)) {
    const typed: WebSearchError = error
    return { ok: false, error: { ...typed.toJSON(), hint: SEARCH_CONFIG_ROW } }
  }
  if (error instanceof WebSearchErrorLike) {
    return { ok: false, error: { error: error.message, code: 'invalid-input', stage: 'web-search-tools', reason: 'web-search.invalid-input', details: { parameter: error.parameter }, hint: SEARCH_CONFIG_ROW } }
  }
  return {
    ok: false,
    error: {
      error: error instanceof Error ? error.message : String(error),
      code: 'invalid-input',
      stage: 'web-search-tools',
      reason: 'web-search.provider-error',
      details: {},
      hint: SEARCH_CONFIG_ROW,
    },
  }
}

/** The `web-search@1` service, or a typed failure body (never a crash). */
function serviceOf(ctx: PluginContext): WebSearchService | Record<string, unknown> {
  const service = webSearchOf(ctx as never)
  if (service === undefined) {
    return {
      ok: false,
      error: {
        error: "no web-search@1 provider is loaded: add a 'web-search-impl' row to the plugins roster",
        code: 'missing-service',
        stage: 'lookup',
        reason: 'web-search.missing-service',
        details: { service: 'web-search' },
        hint: SEARCH_CONFIG_ROW,
      },
    }
  }
  return service
}

/** True when the value is the service (and not a failure body). */
function isService(value: WebSearchService | Record<string, unknown>): value is WebSearchService {
  return typeof (value as WebSearchService).search === 'function'
}

export function apply(ctx: PluginContext): void {
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'web search',
      description:
        'Searches the web through the engine the deployment configured and returns NORMALIZED results (rank, title, url, snippet, published, engine) plus the answer metadata (engine, took_ms, count, truncated, spill_path, ignored_filters). An engine that is missing or broken answers a TYPED error naming the config row to add, never an empty list; a capped result set is reported with truncated=true and written to a spill file that `spill read` pages back.',
      parameters: {
        query: { type: 'string', required: true, description: 'what to search for (non-empty)' },
        count: { type: 'integer', description: 'how many results to return (default from the config, capped by maxCount)' },
        language: { type: 'string', description: 'language hint, e.g. en (only for engines that declare it; otherwise reported in ignored_filters)' },
        freshness: { type: 'string', description: 'freshness window: day | week | month | year, a day count like 7, or a duration like 7d' },
        safe: { type: 'boolean', description: 'safe-search hint (only for engines that declare it)' },
        site: { type: 'string', description: 'restrict the search to one site/domain, e.g. docs.example.com' },
        engine: { type: 'string', description: 'force ONE engine id, e.g. stub or tavily (default: the configured engine + fallback chain)' },
      },
      execute: async (params) => {
        const service = serviceOf(ctx)
        if (!isService(service)) return service
        // EVERYTHING runs inside the try: a parameter violation is a TYPED answer,
        // not a throw (the tools provider turns a throw into a generic `tool-failed`
        // body and the reason would be lost).
        try {
          const request: WebSearchRequest = { query: String(params.query ?? '') }
          const count = optionalInteger(params, 'count')
          if (count !== undefined) request.count = count
          const language = optionalString(params, 'language')
          if (language !== undefined) request.language = language
          const freshness = optionalString(params, 'freshness')
          if (freshness !== undefined) request.freshness = freshness
          const safe = optionalBoolean(params, 'safe')
          if (safe !== undefined) request.safe = safe
          const site = optionalString(params, 'site')
          if (site !== undefined) request.site = site
          const engine = optionalString(params, 'engine')
          if (engine !== undefined) request.engine = engine

          const answer: WebSearchAnswer = await service.search(request)
          // Published in BOTH shapes on purpose: the definition's field names
          // (`tookMs`, `spillPath`, `ignoredFilters`) and the flat tool metadata the
          // tool schema promises (`took_ms`, `spill_path`, `ignored_filters`), so a
          // caller never has to guess which one the tool answers.
          return {
            ok: true,
            ...answer,
            took_ms: answer.tookMs,
            ignored_filters: answer.ignoredFilters,
            ...(answer.spillPath === undefined ? {} : { spill_path: answer.spillPath }),
          }
        } catch (error) {
          return failureBody(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'web search providers',
      description:
        'Lists the registered web-search engines with their configured/available state and the reason an engine cannot run (missing credential, disabled engine), plus the selection in effect (default engine, fallback chain, count/maxChars caps). Use it to tell a CONFIGURATION GAP from a query that legitimately found nothing.',
      parameters: {},
      execute: async () => {
        const service = serviceOf(ctx)
        if (!isService(service)) return service
        try {
          const providers = await service.providers()
          return {
            ok: true,
            selection: service.selection(),
            providers,
            usable: providers.filter((info) => info.available).map((info) => info.id),
            configured: providers.filter((info) => info.configured).map((info) => info.id),
            config_row: SEARCH_CONFIG_ROW,
          }
        } catch (error) {
          return failureBody(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )
}

export default { name, inject: ['tools'], apply }
