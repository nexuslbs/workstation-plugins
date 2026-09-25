// core/browser-use-impl - the `browser-use@1` SERVICE HOST (provider `registry`).
//
// It owns the SEAM of the browser-use capability and nothing browser-specific:
//
//   Provider plugins (THIS plugin)  ->  Definition  <-  Consumer
//   registry/host                        definitions/browser-use.ts  plugins/browser-use-tools
//        ^
//        | registers itself (ctx['browser-use'].register)
//   PROVIDER plugins: core/browser-use-playwright, a future stub/cdp driver, ...
//
// What lives here (and nowhere else, so every provider stays small):
//   * the PROVIDER REGISTRY: one entry per registered provider, duplicate ids
//     rejected (`browser-use.duplicate-provider`);
//   * the SELECTION policy (the DSH `packages/browser-use/browser-use` model:
//     "a deployment can enable one browser-use provider at a time", MIT): an
//     explicit provider id wins; else the configured default, then the ordered
//     fallback chain; with NOTHING configured exactly one USABLE provider is
//     taken and several usable ones are an `ambiguous` error - selection is
//     decided at CALL time, never at load time, so it cannot depend on plugin
//     order;
//   * the SEAM BOUNDS: the call deadline, the navigation/interaction budgets,
//     the snapshot node cap, the text cap and the screenshot BYTE cap (the
//     answer is a FILE PATH, never unbounded base64). The seam, not the provider,
//     owns them, so a provider cannot widen what reaches a caller: an oversized
//     image is a typed `browser-use.oversized` error naming the real size and the
//     cap, never a silent drop;
//   * the TYPED DELEGATION: a provider that does not implement an action is a
//     `browser-use.not-implemented` error naming the exact half (`tabs`), never a
//     silent no-op and never a fabricated answer (requirement 3);
//   * the REQUEST VALIDATION: every field a caller passes is checked HERE (a ref
//     shape, a URL scheme, an enum), so a bad request is `browser-use.invalid-input`
//     before a browser is touched;
//   * the RECIPE read-through (requirement 5): when the deployment loads a
//     `web-recipe@1` service, `extract` consults it for the page's domain; a
//     missing recipe NEVER breaks the call (it is reported as `consulted: false`
//     or `used: false`);
//   * the SANDBOX extension point (requirement 6): when the deployment loads a
//     `sandbox@1` provider, every call that reaches the NETWORK is checked FIRST
//     and a DENY becomes `browser-use.sandbox-denied`. No sandbox provider = no
//     change.
//
// No provider module is imported: a provider plugin only has to export the object
// `definitions/browser-use.ts` describes, and `npm run check:seam` enforces that
// direction. Browsers are the provider's business, so the manifest declares
// `"execution": "none"`.

import type { LoggerServiceLike } from '../../definitions/logger.ts'
import { assertPolicyDeclared, isRecord, provideService, str, type ServiceContext } from '../../definitions/support.ts'
import {
  BROWSER_USE,
  BROWSER_USE_CONFIG_ROW,
  BROWSER_USE_CONTRACT,
  BrowserUseError,
  browserUseSandbox,
  DEFAULT_MAX_SNAPSHOT_NODES,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SCREENSHOT_MAX_BYTES,
  DEFAULT_SESSION_TIMEOUT_MS,
  EXTRACT_MODES,
  ACT_KINDS,
  FRAME_ACTIONS,
  MOUSE_ACTIONS,
  MOUSE_BUTTONS,
  MOUSE_ORIGINS,
  normalizeViewport,
  notImplemented,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireRef,
  requireText,
  requireUrl,
  resolveBrowserUseBounds,
  SCREENSHOT_FORMATS,
  STATE_MODES,
  TAB_ACTIONS,
  TARGETED_ACT_KINDS,
  WAIT_STATES,
  WAIT_UNTIL,
} from '../../definitions/browser-use.ts'
import type {
  BrowserActRequest,
  BrowserCapabilityReport,
  BrowserEvaluateRequest,
  BrowserExtractAnswer,
  BrowserExtractRequest,
  BrowserFrameTarget,
  BrowserFramesAnswer,
  BrowserFramesRequest,
  BrowserMouseAnswer,
  BrowserMouseRequest,
  BrowserNavigateRequest,
  BrowserObserveRequest,
  BrowserProviderInfo,
  BrowserScreenshotRequest,
  BrowserSelection,
  BrowserSessionInfo,
  BrowserSessionSpec,
  BrowserSnapshotRequest,
  BrowserStateRequest,
  BrowserTabRequest,
  BrowserUseCallOptions,
  BrowserUseConfig,
  BrowserUseProvider,
  BrowserUseService,
  BrowserWaitRequest,
} from '../../definitions/browser-use.ts'

export const name = 'browser-use-impl'

/** The provider id this host registers under (a service host, not a browser). */
export const providerId = 'registry'

/** The bounds and the selection policy of the host, once normalized. */
export interface NormalizedBrowserUseConfig extends BrowserUseCallOptions {
  provider?: string
  fallback: string[]
  defaultSession: string
  observeLimit: number
}

/** Reads + bounds the config (a bad value falls back, it never throws at load). */
export function validateBrowserUseConfig(config: BrowserUseConfig = {}): NormalizedBrowserUseConfig {
  const provider = str(config.provider)
  const fallback = Array.isArray(config.fallback)
    ? config.fallback.map((value) => str(value)).filter((value): value is string => value !== undefined)
    : []
  return {
    ...(provider === undefined ? {} : { provider }),
    fallback,
    defaultSession: str(config.defaultSession) ?? 'default',
    observeLimit: requirePositiveInt(config.observeLimit ?? 20, 'observeLimit', 500),
    ...resolveBrowserUseBounds(config),
  }
}

/** True when a registered provider says it can run. */
function isAvailable(provider: BrowserUseProvider): boolean {
  try {
    return provider.available() !== false
  } catch {
    // A provider whose availability probe throws is NOT usable: reporting it as
    // usable would turn a broken provider into a confusing call-time failure.
    return false
  }
}

/** Why a registered provider cannot run, without trusting a thrown message. */
function reasonOf(provider: BrowserUseProvider): string | undefined {
  try {
    return str(provider.unavailableReason?.())
  } catch {
    return 'the provider availability probe threw'
  }
}

/** The engine report of a provider, never a throw (a broken report is reported). */
function engineOf(provider: BrowserUseProvider) {
  try {
    const engine = provider.engine()
    if (isRecord(engine) && typeof engine.engine === 'string') return engine
  } catch {
    /* fall through to the honest default */
  }
  return {
    engine: 'unknown',
    headless: true,
    source: `the provider '${provider.id}' did not report an engine`,
    available: false,
    requirement: `the provider '${provider.id}' must report its engine through engine()`,
  }
}

/**
 * Calls a provider method that may be ABSENT: an absent half is the typed
 * `browser-use.not-implemented` (naming the method), never a silent success, and
 * anything else the provider throws is wrapped without losing its type.
 */
async function invoke<T>(provider: BrowserUseProvider, method: string, what: string, args: unknown[]): Promise<T> {
  const fn = (provider as unknown as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw notImplemented(what, { provider: provider.id, missing: method })
  try {
    return (await (fn as (...values: unknown[]) => T | Promise<T>).apply(provider, args)) as T
  } catch (error) {
    if (error instanceof BrowserUseError) throw error
    throw new BrowserUseError(
      'browser-use.provider-failed',
      `the browser-use provider '${provider.id}' failed the '${what}' call: ${error instanceof Error ? error.message : String(error)}`,
      { stage: 'provider', details: { provider: provider.id, action: what } },
    )
  }
}

/** The `ctx` a host needs. */
interface PluginContext extends ServiceContext {
  effect?(callback: () => () => void): unknown
  logger?: LoggerServiceLike
}

/**
 * The `web-recipe@1` service as THIS host uses it (a STRUCTURAL lookup, no
 * import: the recipe store is a consumer plugin and the seam forbids a provider
 * from importing it). Only the two halves `extract` needs are declared.
 */
export interface BrowserUseRecipeLike {
  readonly contract?: string
  lookup(urlOrDomain: string): Promise<
    | {
        domain: string
        usable: boolean
        reason?: string
        recipe?: {
          domain?: string
          readPath?: { kind?: string; url?: string; selectors?: string[] }
          selectors?: { name?: string; form?: string; selector?: string }[]
        }
      }
    | undefined
  >
  record(discovery: Record<string, unknown>): Promise<{ status?: string; file?: string; reason?: string } | undefined>
}

/** The `web-recipe@1` service of the deployment, when it has one. */
export function browserUseRecipe(ctx: ServiceContext): BrowserUseRecipeLike | undefined {
  const service = (ctx.get?.('web-recipe', false) ?? undefined) as BrowserUseRecipeLike | undefined
  if (service === undefined || typeof service.lookup !== 'function') return undefined
  return service
}

/** What the recipe read-through produced for one `extract`. */
interface RecipeOutcome {
  recipe: NonNullable<BrowserExtractAnswer['recipe']>
  /** The selector a stored recipe wants the extraction scoped to. */
  scope?: string
}

/** The recipe of a URL, when the deployment has a store (never a throw). */
async function recipeFor(ctx: ServiceContext, url: string, useRecipe: boolean): Promise<RecipeOutcome> {
  const none: RecipeOutcome = { recipe: { consulted: false, used: false } }
  if (!useRecipe) return none
  const service = browserUseRecipe(ctx)
  if (service === undefined) return none
  try {
    const found = await service.lookup(url)
    if (found === undefined) {
      // Consulted, nothing stored: the caller may record what it discovers.
      return { recipe: { consulted: true, used: false, domain: domainOfUrl(url), note: 'no recipe is stored for this domain' } }
    }
    const domain = found.domain
    if (!found.usable) {
      return { recipe: { consulted: true, used: false, domain, note: found.reason ?? 'the stored recipe is not usable right now' } }
    }
    const recipe = found.recipe
    const scope = recipe?.readPath?.selectors?.[0] ?? recipe?.selectors?.[0]?.selector
    if (scope === undefined) {
      return { recipe: { consulted: true, used: false, domain, note: 'the stored recipe names no render selector to scope the extraction' } }
    }
    return { recipe: { consulted: true, used: true, domain, path: scope, note: 'the extraction selector comes from the stored recipe' }, scope }
  } catch (error) {
    // A recipe store that fails NEVER breaks a browser call (requirement 5).
    return {
      recipe: {
        consulted: true,
        used: false,
        domain: domainOfUrl(url),
        note: `the recipe lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

/** The domain key of a URL (`github.com`, `localhost:8080`), or undefined. */
export function domainOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.port.length > 0 ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return undefined
  }
}

/**
 * Builds the `browser-use@1` service. Exported separately from `apply` on
 * purpose: the tests drive the SEAM (registry, selection, caps, validation, typed
 * errors) with a FAKE provider and no cordis context at all.
 */
export function createBrowserUseService(
  ctx: ServiceContext,
  config: BrowserUseConfig = {},
  logger?: { warn?: (message: string) => void },
): BrowserUseService {
  const bounds = validateBrowserUseConfig(config)
  const registry = new Map<string, BrowserUseProvider>()
  let lastSelected: string | undefined

  /** The number of live sessions a provider holds (never a throw). */
  const sessionsOf = (provider: BrowserUseProvider): number => {
    try {
      return provider.sessions().length
    } catch {
      return 0
    }
  }

  /** The provider a call must go to, or a typed error explaining why none can. */
  const select = (requested?: string): BrowserUseProvider => {
    const named = str(requested)
    if (named !== undefined) {
      const provider = registry.get(named)
      if (provider === undefined) {
        throw new BrowserUseError(
          'browser-use.unknown-provider',
          `no browser-use provider is registered under the id '${named}' (registered: ${[...registry.keys()].join(', ') || 'none'})`,
          {
            stage: 'selection',
            details: { requested: named, registered: [...registry.keys()], configRow: BROWSER_USE_CONFIG_ROW },
          },
        )
      }
      if (!isAvailable(provider)) {
        throw new BrowserUseError(
          'browser-use.provider-unavailable',
          `the browser-use provider '${named}' is not available: ${reasonOf(provider) ?? 'no reason reported'}`,
          { stage: 'selection', details: { provider: named, reason: reasonOf(provider), configRow: BROWSER_USE_CONFIG_ROW } },
        )
      }
      lastSelected = named
      return provider
    }
    // The PREFERENCE LIST: the configured provider first, then the fallback chain.
    const preferred: string[] = [...(bounds.provider === undefined ? [] : [bounds.provider]), ...bounds.fallback]
    for (const [index, id] of preferred.entries()) {
      const candidate = registry.get(id)
      if (candidate === undefined || !isAvailable(candidate)) continue
      if (index > 0) {
        logger?.warn?.(
          `browser-use-impl: provider '${preferred[0]!}' is not usable; falling back to '${id}' (config ${BROWSER_USE_CONFIG_ROW})`,
        )
      }
      lastSelected = id
      return candidate
    }
    if (preferred.length > 0) {
      // A preference was NAMED and IS registered, but unusable: report the
      // provider and ITS OWN reason (which carries the install requirement),
      // never a generic "no provider".
      const blocked = preferred.find((id) => registry.has(id))
      if (blocked !== undefined) {
        const provider = registry.get(blocked)!
        throw new BrowserUseError(
          'browser-use.provider-unavailable',
          `the browser-use provider '${blocked}' is not available: ${reasonOf(provider) ?? 'no reason reported'}`,
          {
            stage: 'selection',
            details: { provider: blocked, reason: reasonOf(provider), engine: engineOf(provider), registered: [...registry.keys()], configRow: BROWSER_USE_CONFIG_ROW },
          },
        )
      }
    }
    if (bounds.provider !== undefined) {
      throw new BrowserUseError(
        'browser-use.no-provider',
        `the configured browser-use provider '${bounds.provider}' is not registered and no fallback provider is registered (fallback: ${bounds.fallback.join(', ') || 'none'})`,
        {
          stage: 'selection',
          details: { provider: bounds.provider, fallback: bounds.fallback, registered: [...registry.keys()], configRow: BROWSER_USE_CONFIG_ROW },
        },
      )
    }
    const usable = [...registry.values()].filter(isAvailable)
    if (usable.length === 1) {
      lastSelected = usable[0]!.id
      return usable[0]!
    }
    if (usable.length === 0) {
      throw new BrowserUseError(
        'browser-use.no-provider',
        registry.size === 0
          ? 'no browser-use provider is registered at all: add a provider plugin (e.g. browser-use-playwright) to the plugins roster'
          : `none of the registered browser-use providers is available (${[...registry.values()]
              .map((provider) => `${provider.id}: ${reasonOf(provider) ?? 'unavailable'}`)
              .join('; ')})`,
        { stage: 'selection', details: { registered: [...registry.keys()], configRow: BROWSER_USE_CONFIG_ROW } },
      )
    }
    throw new BrowserUseError(
      'browser-use.ambiguous',
      `several browser-use providers are usable (${usable.map((provider) => provider.id).join(', ')}) and the config names none: set one explicitly`,
      { stage: 'selection', details: { usable: usable.map((provider) => provider.id), configRow: BROWSER_USE_CONFIG_ROW } },
    )
  }

  /** The call options the seam hands a provider (the seam owns the bounds). */
  const callOptions = (extra: Partial<BrowserUseCallOptions> = {}): BrowserUseCallOptions => ({
    timeoutMs: bounds.timeoutMs,
    navigationTimeoutMs: bounds.navigationTimeoutMs,
    actionTimeoutMs: bounds.actionTimeoutMs,
    maxSnapshotNodes: bounds.maxSnapshotNodes,
    maxTextChars: bounds.maxTextChars,
    maxImageBytes: bounds.maxImageBytes,
    screenshotDir: bounds.screenshotDir,
    storageStateDir: bounds.storageStateDir,
    maxSessions: bounds.maxSessions,
    ...extra,
  })

  /**
   * The sandbox gate (extension point, requirement 6): a `sandbox@1` provider is
   * asked BEFORE a call that reaches the network. A DENY - or a sandbox that
   * cannot answer at all - is a typed refusal, never a silently allowed call.
   */
  const guard = async (what: string, url?: string): Promise<void> => {
    const sandbox = browserUseSandbox(ctx)
    if (sandbox === undefined) return
    let verdict: unknown
    try {
      verdict = await Promise.resolve(sandbox.check({ resource: 'browser-use', command: { argv: [what, url ?? ''] } }))
    } catch (error) {
      throw new BrowserUseError(
        'browser-use.sandbox-denied',
        `the sandbox could not evaluate the '${what}' call: ${error instanceof Error ? error.message : String(error)}`,
        { stage: 'sandbox', details: { action: what, resource: 'browser-use', url } },
      )
    }
    if (isRecord(verdict) && verdict.allowed === false) {
      throw new BrowserUseError(
        'browser-use.sandbox-denied',
        `the sandbox refused the '${what}' call: ${str(verdict.reason) ?? 'no reason reported'}`,
        { stage: 'sandbox', details: { action: what, resource: 'browser-use', url, verdict: verdict as Record<string, unknown> } },
      )
    }
  }

  /** The session id a call acts on (a named one, else the configured default). */
  const sessionOf = (name: unknown): string => {
    const raw = name === undefined || name === null ? bounds.defaultSession : requireText(name, 'session', 128)
    return raw
  }

  /** Rejects a parameter the selected request does not read (a typo is an error). */
  const rejectUnknown = (value: unknown, allowed: readonly string[], field: string): void => {
    if (!isRecord(value)) return
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
    if (unknown.length > 0) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'${field}' does not read ${unknown.map((key) => `'${key}'`).join(', ')} (accepted: ${allowed.join(', ')})`,
        { stage: 'request', details: { field, unknown } },
      )
    }
  }

  /** Stamps the provider identity on a live-session report. */
  const stamp = (provider: BrowserUseProvider, info: BrowserSessionInfo): BrowserSessionInfo => ({
    ...info,
    provider: provider.id,
  })

  /** Validates a `snapshot` request (a selector, a node cap, the text flag). */
  const snapshotRequest = (request: BrowserSnapshotRequest = {}): BrowserSnapshotRequest => {
    rejectUnknown(request, ['selector', 'includeText', 'maxNodes', 'frame'], 'snapshot')
    const out: BrowserSnapshotRequest = {}
    if (request.selector !== undefined) out.selector = requireText(request.selector, 'selector', 4_096)
    if (request.includeText !== undefined) out.includeText = request.includeText === true
    if (request.maxNodes !== undefined) out.maxNodes = requirePositiveInt(request.maxNodes, 'maxNodes', 5_000)
    if (request.frame !== undefined) out.frame = frameTargetParam(request.frame, 'frame')
    return out
  }

  /** A finite number (a coordinate may be negative or fractional). */
  const finiteNumber = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be a finite number`, {
        stage: 'request',
        details: { field },
      })
    }
    return value
  }

  /**
   * Validates the target of a FRAME-scoped call: one of `frameId` (the id
   * `frames` reported), `selector` (the frame element in the parent), `url`,
   * `name` or `index`. An empty object is a typo, not "the main frame": the
   * ABSENCE of `frame` means the main frame.
   */
  const frameTargetParam = (value: unknown, field: string): BrowserFrameTarget => {
    if (!isRecord(value)) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'${field}' must be an object naming a frame (frameId, selector, url, name or index)`,
        { stage: 'request', details: { field } },
      )
    }
    rejectUnknown(value, ['frameId', 'selector', 'url', 'name', 'index'], field)
    const out: BrowserFrameTarget = {}
    if (value.frameId !== undefined) out.frameId = requireText(value.frameId, `${field}.frameId`, 512)
    if (value.selector !== undefined) out.selector = requireText(value.selector, `${field}.selector`, 4_096)
    if (value.url !== undefined) out.url = requireText(value.url, `${field}.url`, 4_096)
    if (value.name !== undefined) out.name = requireText(value.name, `${field}.name`, 512)
    if (value.index !== undefined) out.index = requireNonNegativeInt(value.index, `${field}.index`, 10_000)
    if (Object.keys(out).length === 0) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'${field}' names no frame: pass frameId, selector, url, name or index (omit '${field}' to mean the main frame)`,
        { stage: 'request', details: { field } },
      )
    }
    return out
  }

  /** Validates a `frames` request: the action and (for `select`) the target. */
  const framesRequest = (request: BrowserFramesRequest = {}): BrowserFramesRequest => {
    rejectUnknown(request, ['frameAction', 'action', 'frame', 'maxFrames'], 'frames')
    const out: BrowserFramesRequest = {
      frameAction: requireEnum(request.frameAction ?? request.action, FRAME_ACTIONS, 'frameAction', 'list'),
    }
    if (request.frame !== undefined) out.frame = frameTargetParam(request.frame, 'frame')
    if (request.maxFrames !== undefined) out.maxFrames = requirePositiveInt(request.maxFrames, 'maxFrames', 500)
    if (out.frameAction === 'select' && out.frame === undefined) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        "'frameAction: select' needs a 'frame' target (frameId, selector, url, name or index)",
        { stage: 'request', details: { frameAction: out.frameAction } },
      )
    }
    return out
  }

  /** Validates a `mouse` request: the gesture and the coordinates it needs. */
  const mouseRequest = (request: BrowserMouseRequest = {}): BrowserMouseRequest => {
    rejectUnknown(
      request,
      ['mouseAction', 'action', 'x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'button', 'clickCount', 'steps', 'relativeTo', 'frame'],
      'mouse',
    )
    const out: BrowserMouseRequest = {
      mouseAction: requireEnum(request.mouseAction ?? request.action, MOUSE_ACTIONS, 'mouseAction', 'click'),
    }
    if (request.x !== undefined) out.x = finiteNumber(request.x, 'x')
    if (request.y !== undefined) out.y = finiteNumber(request.y, 'y')
    if (request.toX !== undefined) out.toX = finiteNumber(request.toX, 'toX')
    if (request.toY !== undefined) out.toY = finiteNumber(request.toY, 'toY')
    if (request.deltaX !== undefined) out.deltaX = finiteNumber(request.deltaX, 'deltaX')
    if (request.deltaY !== undefined) out.deltaY = finiteNumber(request.deltaY, 'deltaY')
    if (request.button !== undefined) out.button = requireEnum(request.button, MOUSE_BUTTONS, 'button', 'left')
    if (request.clickCount !== undefined) out.clickCount = requirePositiveInt(request.clickCount, 'clickCount', 10)
    if (request.steps !== undefined) out.steps = requirePositiveInt(request.steps, 'steps', 200)
    if (request.relativeTo !== undefined) out.relativeTo = requireEnum(request.relativeTo, MOUSE_ORIGINS, 'relativeTo', 'page')
    if (request.frame !== undefined) out.frame = frameTargetParam(request.frame, 'frame')
    const action = out.mouseAction ?? 'click'
    const pointy = action !== 'wheel'
    if (pointy && (out.x === undefined || out.y === undefined)) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'mouseAction: ${action}' needs 'x' and 'y' (the point in the viewport; a widget unreachable by selector is driven at coordinates)`,
        { stage: 'request', details: { mouseAction: action } },
      )
    }
    if (action === 'drag' && (out.toX === undefined || out.toY === undefined)) {
      throw new BrowserUseError('browser-use.invalid-input', "'mouseAction: drag' needs 'toX' and 'toY' (the destination)", {
        stage: 'request',
        details: { mouseAction: action },
      })
    }
    if (action === 'wheel' && out.deltaX === undefined && out.deltaY === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', "'mouseAction: wheel' needs 'deltaX' and/or 'deltaY'", {
        stage: 'request',
        details: { mouseAction: action },
      })
    }
    return out
  }

  /** Validates an `act` request: the kind, the target and the per-kind payload. */
  const actRequest = (request: BrowserActRequest): BrowserActRequest => {
    if (!isRecord(request)) {
      throw new BrowserUseError('browser-use.invalid-input', "'act' needs a request object with a 'kind'", { stage: 'request' })
    }
    rejectUnknown(
      request,
      ['kind', 'ref', 'selector', 'value', 'byLabel', 'key', 'files', 'direction', 'amount', 'state', 'checked', 'timeoutMs', 'settle', 'snapshot', 'frame'],
      'act',
    )
    const kind = requireEnum(request.kind, ACT_KINDS, 'kind')
    const out: BrowserActRequest = { kind }
    if (request.ref !== undefined) out.ref = requireRef(request.ref)
    if (request.selector !== undefined) out.selector = requireText(request.selector, 'selector', 4_096)
    if (TARGETED_ACT_KINDS.includes(kind) && out.ref === undefined && out.selector === undefined) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'kind: ${kind}' needs a target: pass the 'ref' of a snapshot node or a 'selector'`,
        { stage: 'request', details: { kind } },
      )
    }
    if (request.value !== undefined) out.value = requireText(request.value, 'value', 100_000)
    if (request.byLabel !== undefined) out.byLabel = request.byLabel === true
    if (request.key !== undefined) out.key = requireText(request.key, 'key', 128)
    if (request.files !== undefined) {
      if (!Array.isArray(request.files) || request.files.some((file) => typeof file !== 'string')) {
        throw new BrowserUseError('browser-use.invalid-input', "'files' must be an array of file paths", { stage: 'request' })
      }
      out.files = request.files.map((file) => requireText(file, 'files[]', 4_096))
    }
    if (request.direction !== undefined) out.direction = requireEnum(request.direction, ['up', 'down', 'left', 'right'] as const, 'direction')
    if (request.amount !== undefined) out.amount = requirePositiveInt(request.amount, 'amount', 200_000)
    if (request.state !== undefined) out.state = requireEnum(request.state, WAIT_STATES, 'state')
    if (request.checked !== undefined) out.checked = request.checked !== false
    if (request.timeoutMs !== undefined) out.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 600_000)
    if (request.settle !== undefined) out.settle = request.settle !== false
    if (request.snapshot !== undefined) out.snapshot = request.snapshot === true
    if (request.frame !== undefined) out.frame = frameTargetParam(request.frame, 'frame')
    if ((kind === 'type' || kind === 'fill') && out.value === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `'kind: ${kind}' needs a 'value' to write`, { stage: 'request', details: { kind } })
    }
    if (kind === 'select' && out.value === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', "'kind: select' needs a 'value' (the option value)", { stage: 'request' })
    }
    if (kind === 'upload' && (out.files === undefined || out.files.length === 0)) {
      throw new BrowserUseError('browser-use.invalid-input', "'kind: upload' needs a non-empty 'files' array", { stage: 'request' })
    }
    return out
  }

  const service: BrowserUseService = {
    contract: BROWSER_USE_CONTRACT,
    get providerId() {
      return lastSelected ?? ''
    },

    register(provider: BrowserUseProvider): () => void {
      const id = str(provider?.id)
      if (id === undefined) {
        throw new BrowserUseError('browser-use.invalid-input', 'a browser-use provider must carry a non-empty id', {
          stage: 'register',
        })
      }
      if (registry.has(id)) {
        throw new BrowserUseError('browser-use.duplicate-provider', `a browser-use provider is already registered under '${id}'`, {
          stage: 'register',
          details: { provider: id, registered: [...registry.keys()] },
        })
      }
      registry.set(id, provider)
      return () => {
        if (registry.get(id) === provider) registry.delete(id)
      }
    },

    providers(): BrowserProviderInfo[] {
      return [...registry.values()].map((provider) => {
        const reason = reasonOf(provider)
        return {
          id: provider.id,
          configured: bounds.provider === provider.id,
          available: isAvailable(provider),
          ...(reason === undefined ? {} : { reason }),
          engine: engineOf(provider),
          sessions: sessionsOf(provider),
        }
      })
    },

    selection(): BrowserSelection {
      const selected = lastSelected ?? bounds.provider ?? (registry.size === 1 ? [...registry.keys()][0] : undefined)
      const usable = [...registry.values()].filter(isAvailable).map((provider) => provider.id)
      return {
        ...(bounds.provider === undefined ? {} : { provider: bounds.provider }),
        fallback: bounds.fallback,
        ...(selected === undefined || !usable.includes(selected) ? {} : { selected }),
        ...(registry.size === 0
          ? { reason: 'no browser-use provider is registered at all' }
          : usable.length === 0
            ? { reason: 'no registered browser-use provider is available' }
            : {}),
        configRow: BROWSER_USE_CONFIG_ROW,
      }
    },

    async capabilities(provider?: string): Promise<BrowserCapabilityReport> {
      const selected = select(provider)
      const report = await invoke<ReturnType<BrowserUseProvider['capabilities']>>(selected, 'capabilities', 'capabilities', [])
      return {
        provider: selected.id,
        engine: engineOf(selected),
        capabilities: { ...report, provider: selected.id },
        configRow: BROWSER_USE_CONFIG_ROW,
      }
    },

    sessions(): (BrowserSessionInfo & { owner: string })[] {
      const out: (BrowserSessionInfo & { owner: string })[] = []
      for (const provider of registry.values()) {
        try {
          for (const info of provider.sessions()) out.push({ ...info, owner: provider.id })
        } catch {
          // A provider that cannot report its sessions is not a reason to fail
          // the diagnostics call (its absence is visible above).
        }
      }
      return out
    },

    async open(spec: BrowserSessionSpec = {}, provider?: string): Promise<BrowserSessionInfo> {
      const selected = select(provider)
      const input: BrowserSessionSpec = { session: sessionOf(spec.session) }
      if (spec.headless !== undefined) input.headless = spec.headless === true
      const viewport = normalizeViewport(spec.viewport)
      if (viewport !== undefined) input.viewport = viewport
      if (spec.userAgent !== undefined) input.userAgent = requireText(spec.userAgent, 'userAgent', 1_024)
      if (spec.locale !== undefined) input.locale = requireText(spec.locale, 'locale', 64)
      if (spec.timezoneId !== undefined) input.timezoneId = requireText(spec.timezoneId, 'timezoneId', 64)
      if (spec.stateMode !== undefined) input.stateMode = requireEnum(spec.stateMode, STATE_MODES, 'stateMode', 'reuse')
      if (spec.storageState !== undefined) input.storageState = spec.storageState
      if (spec.storageStateFile !== undefined) input.storageStateFile = requireText(spec.storageStateFile, 'storageStateFile', 4_096)
      if (spec.downloadDir !== undefined) input.downloadDir = requireText(spec.downloadDir, 'downloadDir', 4_096)
      if (spec.args !== undefined) {
        if (!Array.isArray(spec.args)) {
          throw new BrowserUseError('browser-use.invalid-input', "'args' must be an array of strings", { stage: 'request' })
        }
        input.args = spec.args.map((arg) => requireText(arg, 'args[]', 4_096))
      }
      if (spec.proxy !== undefined) {
        const server = requireUrl(spec.proxy.server, 'proxy.server')
        input.proxy = { server }
        if (spec.proxy.username !== undefined) input.proxy.username = requireText(spec.proxy.username, 'proxy.username', 256)
        if (spec.proxy.credential !== undefined) input.proxy.credential = requireText(spec.proxy.credential, 'proxy.credential', 256)
      }
      const info = await invoke<BrowserSessionInfo>(selected, 'openSession', 'open', [input, callOptions()])
      if (!isRecord(info) || str(info.id) === undefined) {
        throw new BrowserUseError('browser-use.malformed-output', `the provider '${selected.id}' did not answer a session with an id`, {
          stage: 'provider',
          details: { provider: selected.id },
        })
      }
      return stamp(selected, info)
    },

    async close(session: string, provider?: string): Promise<BrowserSessionInfo> {
      const selected = select(provider)
      const id = sessionOf(session)
      const info = await invoke<BrowserSessionInfo>(selected, 'closeSession', 'close', [id, callOptions()])
      if (!isRecord(info) || str(info.id) === undefined) {
        throw new BrowserUseError('browser-use.malformed-output', `the provider '${selected.id}' did not answer the closed session`, {
          stage: 'provider',
          details: { provider: selected.id, session: id },
        })
      }
      return stamp(selected, info)
    },

    async navigate(session: string, request: BrowserNavigateRequest, provider?): Promise<Awaited<ReturnType<BrowserUseProvider['navigate']>>> {
      const selected = select(provider)
      const id = sessionOf(session)
      if (!isRecord(request)) {
        throw new BrowserUseError('browser-use.invalid-input', "'navigate' needs a request object with a 'url'", { stage: 'request' })
      }
      const input: BrowserNavigateRequest = { url: requireUrl(request.url) }
      if (request.waitUntil !== undefined) input.waitUntil = requireEnum(request.waitUntil, WAIT_UNTIL, 'waitUntil', 'load')
      if (request.timeoutMs !== undefined) input.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 600_000)
      if (request.allowHttpError !== undefined) input.allowHttpError = request.allowHttpError === true
      await guard('navigate', input.url)
      return await invoke(selected, 'navigate', 'navigate', [id, input, callOptions()])
    },

    async snapshot(session: string, request: BrowserSnapshotRequest = {}, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      return await invoke<Awaited<ReturnType<BrowserUseProvider['snapshot']>>>(
        selected,
        'snapshot',
        'snapshot',
        [id, snapshotRequest(request), callOptions()],
      )
    },

    async act(session: string, request: BrowserActRequest, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      const input = actRequest(request)
      // Only a navigation-shaped act reaches the network; the others act on the
      // page the session is already on (the sandbox was consulted for its URL).
      if (input.kind === 'waitFor') await guard('act.waitFor', input.value)
      return await invoke<Awaited<ReturnType<BrowserUseProvider['act']>>>(selected, 'act', `act.${input.kind}`, [
        id,
        input,
        callOptions(),
      ])
    },

    async evaluate(session: string, request: BrowserEvaluateRequest, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      if (!isRecord(request)) {
        throw new BrowserUseError('browser-use.invalid-input', "'evaluate' needs a request object with an 'expression'", { stage: 'request' })
      }
      const input: BrowserEvaluateRequest = { expression: requireText(request.expression, 'expression', 100_000) }
      if (request.args !== undefined) input.args = Array.isArray(request.args) ? request.args : [request.args]
      if (request.awaitPromise !== undefined) input.awaitPromise = request.awaitPromise !== false
      if (request.maxChars !== undefined) input.maxChars = requirePositiveInt(request.maxChars, 'maxChars', bounds.maxTextChars)
      return await invoke<Awaited<ReturnType<BrowserUseProvider['evaluate']>>>(selected, 'evaluate', 'evaluate', [
        id,
        input,
        callOptions(),
      ])
    },

    async extract(session: string, request: BrowserExtractRequest = {}, provider?): Promise<BrowserExtractAnswer> {
      const selected = select(provider)
      const id = sessionOf(session)
      rejectUnknown(
        request,
        ['mode', 'selector', 'ref', 'maxChars', 'attributes', 'index', 'expression', 'useRecipe', 'frame'],
        'extract',
      )
      const input: BrowserExtractRequest = { mode: requireEnum(request.mode, EXTRACT_MODES, 'mode', 'text') }
      if (request.selector !== undefined) input.selector = requireText(request.selector, 'selector', 4_096)
      if (request.ref !== undefined) input.ref = requireRef(request.ref)
      if (request.maxChars !== undefined) input.maxChars = requirePositiveInt(request.maxChars, 'maxChars', bounds.maxTextChars)
      if (request.attributes !== undefined) {
        if (!Array.isArray(request.attributes)) {
          throw new BrowserUseError('browser-use.invalid-input', "'attributes' must be an array of attribute names", { stage: 'request' })
        }
        input.attributes = request.attributes.map((attribute) => requireText(attribute, 'attributes[]', 128))
      }
      if (request.index !== undefined) input.index = requireNonNegativeInt(request.index, 'index', 1_000)
      if (request.expression !== undefined) input.expression = requireText(request.expression, 'expression', 100_000)
      if (request.frame !== undefined) input.frame = frameTargetParam(request.frame, 'frame')
      const useRecipe = request.useRecipe !== false
      input.useRecipe = useRecipe
      await guard('extract')
      const answer = await invoke<BrowserExtractAnswer>(selected, 'extract', 'extract', [id, input, callOptions()])
      const url = str(answer?.url) ?? ''
      const outcome = await recipeFor(ctx, url, useRecipe)
      const merged: BrowserExtractAnswer = { ...answer, recipe: outcome.recipe }
      // The seam owns the text cap as well: a provider cannot widen what a caller
      // receives (the cap is reported instead of a silent drop).
      const max = input.maxChars ?? bounds.maxTextChars
      if (typeof merged.text === 'string' && merged.text.length > max) {
        merged.text = merged.text.slice(0, max)
        merged.truncated = true
      }
      merged.chars = typeof merged.text === 'string' ? merged.text.length : (merged.chars ?? 0)
      return merged
    },

    async screenshot(session: string, request: BrowserScreenshotRequest = {}, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      rejectUnknown(request, ['fullPage', 'selector', 'ref', 'format', 'quality', 'path', 'label', 'maxBytes'], 'screenshot')
      const input: BrowserScreenshotRequest = {}
      if (request.fullPage !== undefined) input.fullPage = request.fullPage === true
      if (request.selector !== undefined) input.selector = requireText(request.selector, 'selector', 4_096)
      if (request.ref !== undefined) input.ref = requireRef(request.ref)
      if (request.format !== undefined) input.format = requireEnum(request.format, SCREENSHOT_FORMATS, 'format', 'png')
      if (request.quality !== undefined) input.quality = requirePositiveInt(request.quality, 'quality', 100)
      if (request.path !== undefined) input.path = requireText(request.path, 'path', 4_096)
      if (request.label !== undefined) input.label = requireText(request.label, 'label', 64)
      const cap = requirePositiveInt(request.maxBytes ?? bounds.maxImageBytes, 'maxBytes', bounds.maxImageBytes)
      input.maxBytes = cap
      const answer = await invoke<Awaited<ReturnType<BrowserUseProvider['screenshot']>>>(
        selected,
        'screenshot',
        'screenshot',
        [id, input, callOptions({ maxImageBytes: cap })],
      )
      const bytes = typeof answer?.bytes === 'number' ? answer.bytes : Number.NaN
      if (!Number.isFinite(bytes) || bytes < 0) {
        throw new BrowserUseError('browser-use.malformed-output', `the provider '${selected.id}' did not report the size of the written image`, {
          stage: 'provider',
          details: { provider: selected.id },
        })
      }
      if (bytes > cap) {
        throw new BrowserUseError(
          'browser-use.oversized',
          `the screenshot is ${bytes} bytes, above the ${cap} cap of this call (raise 'maxBytes' or 'plugins.browser-use-impl.maxImageBytes')`,
          { stage: 'screenshot', details: { bytes, cap, path: answer.path, fullPage: answer.fullPage } },
        )
      }
      return answer
    },

    async tabs(session: string, request: BrowserTabRequest = {}, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      rejectUnknown(request, ['action', 'index', 'url', 'navigate', 'timeoutMs'], 'tabs')
      const input: BrowserTabRequest = { action: requireEnum(request.action, TAB_ACTIONS, 'tabAction', 'list') }
      if (request.index !== undefined) input.index = requireNonNegativeInt(request.index, 'index', 1_000)
      if (request.url !== undefined) input.url = requireUrl(request.url, 'url')
      if (request.navigate !== undefined) input.navigate = request.navigate !== false
      if (request.timeoutMs !== undefined) input.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 600_000)
      if (input.action === 'switch' || input.action === 'close') {
        if (input.index === undefined) {
          throw new BrowserUseError('browser-use.invalid-input', `'tabAction: ${input.action}' needs the 'index' of the tab`, {
            stage: 'request',
            details: { tabAction: input.action },
          })
        }
      }
      if (input.action === 'new' && input.url !== undefined) await guard('tabs.new', input.url)
      return await invoke<Awaited<ReturnType<BrowserUseProvider['tabs']>>>(selected, 'tabs', `tabs.${input.action}`, [
        id,
        input,
        callOptions(),
      ])
    },

    async wait(session: string, request: BrowserWaitRequest = {}, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      rejectUnknown(request, ['ms', 'ref', 'selector', 'frame', 'state', 'urlContains', 'text', 'networkIdle', 'timeoutMs'], 'wait')
      const input: BrowserWaitRequest = {}
      if (request.ms !== undefined) input.ms = requireNonNegativeInt(request.ms, 'ms', 600_000)
      if (request.ref !== undefined) input.ref = requireRef(request.ref)
      if (request.frame !== undefined) input.frame = frameTargetParam(request.frame, 'frame')
      if (request.selector !== undefined) input.selector = requireText(request.selector, 'selector', 4_096)
      if (request.state !== undefined) input.state = requireEnum(request.state, WAIT_STATES, 'state', 'visible')
      if (request.urlContains !== undefined) input.urlContains = requireText(request.urlContains, 'urlContains', 4_096)
      if (request.text !== undefined) input.text = requireText(request.text, 'text', 100_000)
      if (request.networkIdle !== undefined) input.networkIdle = request.networkIdle === true
      if (request.timeoutMs !== undefined) input.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 600_000)
      if (Object.keys(input).length === 0) {
        throw new BrowserUseError('browser-use.invalid-input', "'wait' needs at least one condition or 'ms'", { stage: 'request' })
      }
      return await invoke<Awaited<ReturnType<BrowserUseProvider['wait']>>>(selected, 'wait', 'wait', [
        id,
        input,
        callOptions(),
      ])
    },

    async observe(session: string, request: BrowserObserveRequest = {}, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      rejectUnknown(request, ['limit', 'filter'], 'observe')
      const input: BrowserObserveRequest = { limit: requirePositiveInt(request.limit ?? bounds.observeLimit, 'limit', 500) }
      if (request.filter !== undefined) input.filter = requireText(request.filter, 'filter', 1_024)
      return await invoke<Awaited<ReturnType<BrowserUseProvider['observe']>>>(selected, 'observe', 'observe', [
        id,
        input,
        callOptions(),
      ])
    },

    async state(session: string, request: BrowserStateRequest = {}, provider?) {
      const selected = select(provider)
      const id = sessionOf(session)
      rejectUnknown(request, ['action', 'path'], 'state')
      const input: BrowserStateRequest = { action: requireEnum(request.action, ['save', 'read', 'clear'] as const, 'stateAction', 'save') }
      if (request.path !== undefined) input.path = requireText(request.path, 'path', 4_096)
      return await invoke<Awaited<ReturnType<BrowserUseProvider['state']>>>(selected, 'state', `state.${input.action}`, [
        id,
        input,
        callOptions(),
      ])
    },

    /**
     * The frame tree + frame targeting. A provider without the optional half is
     * the typed `browser-use.not-implemented` naming 'frames' (never a silent
     * empty answer), so a caller can branch on the reason.
     */
    async frames(session: string, request: BrowserFramesRequest = {}, provider?: string): Promise<BrowserFramesAnswer> {
      const selected = select(provider)
      const id = sessionOf(session)
      const input = framesRequest(request)
      return await invoke<BrowserFramesAnswer>(selected, 'frames', 'frames', [id, input, callOptions()])
    },

    async mouse(session: string, request: BrowserMouseRequest = {}, provider?: string): Promise<BrowserMouseAnswer> {
      const selected = select(provider)
      const id = sessionOf(session)
      const input = mouseRequest(request)
      return await invoke<BrowserMouseAnswer>(selected, 'mouse', `mouse.${input.mouseAction ?? 'click'}`, [
        id,
        input,
        callOptions(),
      ])
    },

  }

  return service
}

/** Registers the `browser-use@1` service on the host context. */
export function apply(ctx: PluginContext, config: BrowserUseConfig = {}): void {
  // The plugin only provides the seam (no browser, no process of its own), so its
  // manifest must declare `execution: none` and the policy of the capability.
  assertPolicyDeclared(import.meta.url, { execution: 'none', capabilities: [BROWSER_USE] })
  const logger = {
    warn: (message: string): void => {
      const sink = (ctx.logger as { warn?: (message: string, ...args: unknown[]) => void } | undefined)?.warn
      if (typeof sink === 'function') sink.call(ctx.logger, message, 'browser-use-impl')
    },
  }
  const service = createBrowserUseService(ctx, config, logger)
  provideService(ctx, BROWSER_USE, service)
}

/** The defaults this host applies when the config names nothing (documented). */
export const DEFAULTS = {
  maxSessions: DEFAULT_MAX_SESSIONS,
  maxSnapshotNodes: DEFAULT_MAX_SNAPSHOT_NODES,
  maxImageBytes: DEFAULT_SCREENSHOT_MAX_BYTES,
  timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
} as const

export default { name, inject: [], apply }
