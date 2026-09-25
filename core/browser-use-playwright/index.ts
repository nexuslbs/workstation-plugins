// core/browser-use-playwright - the PLAYWRIGHT PROVIDER of the `browser-use@1`
// seam.
//
// It is the REAL half of the capability: the host (`core/browser-use-impl`)
// owns the registry/selection/bounds, this plugin owns a chromium and the
// sessions a caller drives. It registers itself on `ctx['browser-use']` through
// the ordinary provider contract, so a deployment swaps it by editing one config
// row (`plugins.browser-use-impl: { provider: playwright }`).
//
// REUSE (no second browser stack): the chromium process comes from the SHARED
// launcher of the repository (`shared/browser.ts`, refcounted), so
// `web-page`, `web-session` and this provider never launch competing browsers -
// the module has no manifest and is a SHARED internal module, which is why a
// provider may import it (scripts/check-seam.ts rule 4: a provider imports its
// own directory, the definitions and the SHARED modules, never a consumer
// plugin). Storage state uses the SAME convention as `web-session`
// (`<stateDir>/<session>.json`, reuse on open, persist on close), so a session
// established through one of them can be continued through the other.
//
// WHAT IT ADDS OVER `web-session`: a session is a live BROWSER CONTEXT with
// tabs, a compact SNAPSHOT with STABLE refs (`e12`) a caller acts on in a later
// call, the full interaction vocabulary (click/type/fill/select/hover/scroll/
// press/upload/check/focus/waitFor/back/forward/reload), `evaluate`, readable
// `extract` (text/markdown/html/table/attributes/links/json), FILE screenshots,
// tab management, storage-state read/write and a network/download observer.
//
// HONESTY (requirement 3): every answer carries the PROVIDER and the ENGINE that
// produced it; a deployment WITHOUT a chromium fails `open` with the typed
// `browser-use.no-browser` error naming the exact prerequisite (the config
// `executablePath` or the playwright browser cache) - never a silent fallback to
// an HTTP fetch that pretends to be a browser.
//
// TEARDOWN (requirement 7 of the task): every browser context, listener and
// timer is released through the cordis `effect()` disposer at unload, so a
// reconcile/unload leaves no chromium process and no profile directory behind.
import dns from 'node:dns'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Browser, BrowserContext, CDPSession, Download, Frame, Page, Locator, Response } from 'playwright-core'
import {
  BROWSER_USE,
  BROWSER_USE_VERSION,
  BrowserUseError,
  ACT_KINDS,
  EXTRACT_MODES,
  FRAME_ACTIONS,
  SCROLL_DIRECTIONS,
  TAB_ACTIONS,
  WAIT_STATES,
  WAIT_UNTIL,
  browserUseOf,
  isBrowserUseError,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireRef,
  requireText,
  slugOf,
  type BrowserActAnswer,
  type BrowserActRequest,
  type BrowserEngineInfo,
  type BrowserEvaluateAnswer,
  type BrowserEvaluateRequest,
  type BrowserExtractAnswer,
  type BrowserExtractRequest,
  type BrowserFrameInfo,
  type BrowserFramesAnswer,
  type BrowserFramesRequest,
  type BrowserFrameTarget,
  type BrowserMouseAnswer,
  type BrowserMouseRequest,
  type BrowserNavigateAnswer,
  type BrowserNavigateRequest,
  type BrowserObserveAnswer,
  type BrowserObserveRequest,
  type BrowserProviderCapabilities,
  type BrowserRawAction,
  type BrowserRawLoad,
  type BrowserRawObservation,
  type BrowserRefRetry,
  type BrowserScreenshotAnswer,
  type BrowserScreenshotRequest,
  type BrowserSessionInfo,
  type BrowserSessionSpec,
  type BrowserSnapshot,
  type BrowserSnapshotNode,
  type BrowserSnapshotRequest,
  type BrowserStateAnswer,
  type BrowserStateRequest,
  type BrowserTabAnswer,
  type BrowserTabRequest,
  type BrowserUseCallOptions,
  type BrowserUseProvider,
  type BrowserWaitAnswer,
  type BrowserWaitRequest,
} from '../../definitions/browser-use.ts'
import { assertPolicyDeclared, credentialsOf, isRecord, messageOf, serviceOf, str, type ServiceContext } from '../../definitions/support.ts'
import { GENERAL_SERVICE } from '../../definitions/general-service.ts'
import { acquireSharedBrowser, releaseSharedBrowser, sharedBrowserVersion } from '../../shared/browser.ts'
import {
  boundInt,
  browserBinary,
  browserRequirement,
  endpointRequirement,
  playwrightCoreAvailable,
  resolveProviderConfig,
  safeSessionId,
  sessionStateFile,
  type BrowserUsePlaywrightConfig,
  type ResolvedBrowserService,
  type ResolvedProviderConfig,
} from './config.ts'
import { DEFAULT_ATTRIBUTES, extractInPage, snapshotInPage, type ExtractPayload } from './extract.ts'
import {
  LoadRecorder,
  captureRawLoad,
  driveMouse,
  enumerateFrames,
  rawNavigation,
  resolveFrameTarget,
  type FrameBinding,
} from './frames.ts'

export const name = 'browser-use-playwright'
/** The provider id this plugin registers on the seam. */
export const providerId = 'playwright'
/** The attribute a snapshot stamps on every node it reports (the ref carrier). */
export const REF_ATTRIBUTE = 'data-wb-ref'
/** The engine family this provider drives (reported by `engine()`). */
export const ENGINE = 'chromium'

/** One observed network request (bounded; never a body, never a header). */
interface RequestRecord {
  method: string
  url: string
  status?: number
  resourceType?: string
  contentType?: string
}

/** One observed download (the PATH is what a caller uses). */
interface DownloadRecord {
  url: string
  suggestedFilename: string
  path?: string
  bytes?: number
  state?: string
}

/** One live browser session (a context + its tabs). */
interface LiveSession {
  id: string
  context: BrowserContext
  /** The index of the tab every action uses, in `context.pages()` order. */
  active: number
  stateFile: string
  stateReused: boolean
  downloadDir: string
  requests: RequestRecord[]
  downloads: DownloadRecord[]
  /** ref -> the snapshot id it was minted in. */
  refs: Map<string, string>
  /** page/FRAME -> the snapshot id of its LAST snapshot (older refs are stale). */
  snapshots: Map<Page | Frame, string>
  /**
   * page/FRAME -> the NODES of its last snapshot. The ref retry of `act` re-resolves a
   * stale ref by the ROLE + NAME of the node it was minted for, so the provider
   * keeps what a ref POINTED AT, not only that it existed. A FRAME is a key as
   * well: a snapshot taken INSIDE an iframe mints refs that only that frame can
   * resolve (scanning the main document for them would find nothing).
   */
  nodes: Map<Page | Frame, BrowserSnapshotNode[]>
  /** frameId -> the live binding of the last `frames` call (so a frameId round-trips). */
  frameBindings: Map<string, FrameBinding>
  /** The frame every call targets by default (`undefined` = the main frame). */
  selectedFrameId?: string
  /** The page-level CDP session (created lazily: only the frame tree needs it). */
  cdp?: CDPSession
  /** The raw-transcript recorder of the ACTIVE page (created lazily per page). */
  recorder?: LoadRecorder
  /** The last title read (the `sessions()` report is synchronous). */
  lastTitle: string
  openedAt: number
  lastUsedAt: number
  /** Listener removals, run when the session closes. */
  disposers: (() => void)[]
}

/** The plugin context a provider needs (structural: no `cordis` import here). */
interface PluginContext extends Omit<ServiceContext, 'logger'> {
  effect?: (fn: () => (() => void) | void) => unknown
  logger?: { warn?: (message: string, ...args: unknown[]) => void }
  inject?: (deps: string[], callback: (injected: ServiceContext) => void) => unknown
}

/** The first line of a message (a provider must not paste a whole stack trace). */
function firstLine(message: string): string {
  const line = message.split('\n')[0] ?? message
  return line.length > 300 ? `${line.slice(0, 300)}...` : line
}

/** A PLAYWRIGHT failure mapped onto the typed taxonomy of the seam. */
function mapError(error: unknown, stage: string, fallback: BrowserUseError['reason'], details: Record<string, unknown> = {}): BrowserUseError {
  if (isBrowserUseError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/Timeout \d+ms exceeded|timeout .*exceeded|Target closed/i.test(message)) {
    return new BrowserUseError('browser-use.timeout', `${stage}: ${firstLine(message)}`, { stage, details })
  }
  if (/net::ERR|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_SSL|ERR_ABORTED|NS_ERROR/i.test(message)) {
    return new BrowserUseError('browser-use.navigation-failed', `${stage}: ${firstLine(message)}`, { stage, details })
  }
  if (/Execution context was destroyed|Target page, context or browser has been closed/i.test(message)) {
    return new BrowserUseError('browser-use.stale-ref', `${stage}: ${firstLine(message)}`, { stage, details })
  }
  return new BrowserUseError(fallback, `${stage}: ${firstLine(message)}`, { stage, details })
}

/** True when the message reads like a launch failure of a missing/broken binary. */
function looksLikeMissingBrowser(message: string): boolean {
  return /Executable doesn't exist|Failed to launch|browserType\.launch|No such file or directory|cannot find|ENOENT/i.test(message)
}

/**
 * The `act` kinds that NEED a target. `press`, `scroll` and `waitFor` accept one
 * OPTIONALLY (a key to the focused element, a scroll of the page itself), which
 * is why they are not in this list.
 */
const TARGETED_ACT_KINDS: readonly string[] = ['click', 'type', 'fill', 'select', 'hover', 'upload', 'check', 'focus']
/**
 * The element an interaction targets, plus what the caller is told about it: the
 * ref/selector it resolved through and whether it came from the CURRENT
 * snapshot's ref table.
 */
interface ResolvedTarget {
  locator: Locator
  /** The snapshot ref the target was resolved through. */
  ref?: string
  /** The selector that resolved (a ref resolves to its attribute selector). */
  selector?: string
  /** True when the target came from the current snapshot's ref table. */
  resolved: boolean
}

/** The role+name a ref was minted for: the identity a stale ref is re-found by. */
interface RefShape {
  tag: string
  role?: string
  name?: string
  /** An input's TYPE is part of what the control IS (a text box is not a password box). */
  inputType?: string
}

/** The in-page evidence a `timeout` on a resolved control is explained with. */
interface TargetDiagnosis {
  present: boolean
  tag?: string
  disabled?: boolean
  covered?: boolean
  covering?: string
  width?: number
  height?: number
  visible?: boolean
  pointerEvents?: string
}

/** True for the typed `stale-ref` (a ref of an older snapshot, or a gone element). */
function isStaleRef(error: unknown): boolean {
  return isBrowserUseError(error) && error.reason === 'browser-use.stale-ref'
}

/** True when a failure looks like the engine giving up on the interaction budget. */
function isTimeoutLike(error: unknown): boolean {
  if (isBrowserUseError(error)) return error.reason === 'browser-use.timeout'
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  return name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(message)
}

/**
 * The ref of the node that carries the SAME role+name as `shape`. That match is
 * an IDENTITY (the accessible name of a control), never a position: a node whose
 * name merely CONTAINS the old one is not taken.
 */
function matchRef(nodes: BrowserSnapshotNode[], shape: RefShape): string | undefined {
  if (shape.name === undefined) return undefined
  const exact = nodes.find((node) => node.role === shape.role && node.name === shape.name)
  if (exact !== undefined) return exact.ref
  return nodes.find((node) => node.tag === shape.tag && node.name === shape.name)?.ref
}

/**
 * The ref of the ONLY node of the same SHAPE (tag + role) as the stale one. A
 * control with no accessible NAME (an unnamed textbox) cannot be re-found by
 * role+name, so a UNIQUE shape match is used as the identity - an ambiguous one
 * is NOT taken, because that would be a silent click at a guessed position.
 */
function matchRefByShape(nodes: BrowserSnapshotNode[], shape: RefShape): string | undefined {
  const matches = nodes.filter(
    (node) =>
      node.tag === shape.tag &&
      (shape.role === undefined || node.role === shape.role) &&
      (shape.inputType === undefined || node.inputType === shape.inputType),
  )
  return matches.length === 1 ? matches[0]?.ref : undefined
}

/** One line of an error message (what a retry report is written with). */
function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}

export class PlaywrightProvider implements BrowserUseProvider {
  readonly id = providerId
  private readonly config: ResolvedProviderConfig
  private readonly credentials?: { resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> }
  /**
   * The `general-service@1` seam, used ONLY to start a configured browser
   * service. Accepted as the SERVICE or as a RESOLVER: the service can load
   * AFTER this provider (the loader order is the deployment's), so `apply`
   * hands over a lazy lookup and the resolution happens on the CALL.
   */
  private readonly generalServiceSource?: GeneralServiceLike | (() => GeneralServiceLike | undefined)
  private resolvedGeneralService?: GeneralServiceLike
  /** The LAST browser-service start made through general-service@1, for the caller's result. */
  private serviceStart?: BrowserServiceStartRecord
  private readonly sessionsById = new Map<string, LiveSession>()
  private browser?: Browser
  private launching?: Promise<Browser>
  private holdsBrowser = false
  /** True when the browser is a REMOTE one this provider ATTACHED to (no local process). */
  private attached = false
  /** The version READ from the browser this provider really drove (never guessed). */
  private observedVersion?: string
  private snapshotCounter = 0
  private disposed = false

  constructor(
    config: BrowserUsePlaywrightConfig = {},
    credentials?: { resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> },
    generalService?: GeneralServiceLike | (() => GeneralServiceLike | undefined),
  ) {
    const bounds = { screenshotDir: undefined, storageStateDir: undefined }
    this.config = resolveProviderConfig(config, bounds)
    this.credentials = credentials
    this.generalServiceSource = generalService
  }

  /**
   * The `general-service@1` seam of THIS call, resolved lazily and memoized: a
   * deployment that loads the seam AFTER this provider must still be able to
   * start its browser service (the previous eager lookup silently disabled the
   * start and reported 'no general-service@1 provider is loaded').
   */
  private generalService(): GeneralServiceLike | undefined {
    if (this.resolvedGeneralService !== undefined) return this.resolvedGeneralService
    const source = this.generalServiceSource
    const resolved = typeof source === 'function' ? source() : source
    if (resolved !== undefined) this.resolvedGeneralService = resolved
    return resolved
  }

  // -------------------------------------------------------------------------
  // The honesty surface: availability, engine, capabilities.
  // -------------------------------------------------------------------------

  /**
   * Can this provider drive a browser RIGHT NOW? Two halves:
   *   * `playwright-core` must be resolvable (else the provider itself cannot
   *     run: `unavailableReason()` names the install step);
   *   * a chromium binary must be visible (else `open` fails with the typed
   *     `browser-use.no-browser`, and `engine()` reports `available: false`).
   * The FIRST half decides availability, the second is enforced at `open`: a
   * provider whose browser is missing still SELECTS (so the caller gets the
   * precise `no-browser` error + the requirement, not a generic "no provider").
   */
  available(): boolean {
    return !this.disposed && playwrightCoreAvailable()
  }

  unavailableReason(): string | undefined {
    if (this.disposed) return 'the plugin was unloaded (no provider is registered any more)'
    if (!playwrightCoreAvailable()) return browserRequirement(this.config)
    // ATTACH mode: whether the endpoint answers is only knowable by connecting,
    // so this provider does not refuse the SELECTION - the caller gets the
    // typed `endpoint-unreachable` (naming the endpoint) at `open`.
    if (this.config.wsEndpoint !== undefined) return undefined
    const binary = browserBinary(this.config)
    if (!binary.found) return browserRequirement(this.config)
    return undefined
  }

  engine(): BrowserEngineInfo {
    const binary = browserBinary(this.config)
    // The version is READ from the running browser when there is one: a browser
    // that was never launched must not carry a version nobody observed.
    const version = this.observedVersion ?? sharedBrowserVersion()
    const ready = playwrightCoreAvailable()
    const endpoint = this.config.wsEndpoint
    if (endpoint !== undefined) {
      // ATTACH mode: no local binary is involved at all, and the engine report
      // says so (the `source` names the endpoint, never a chromium path).
      return {
        engine: ENGINE,
        ...(version === undefined ? {} : { version }),
        headless: this.config.headless,
        source:
          `playwright-core + the remote CDP endpoint ${endpoint} (backend: ${this.config.backend})` +
          (this.config.browserService?.image === undefined
            ? ''
            : ` (browser service image ${this.config.browserService.image})`),
        available: ready,
        ...(ready ? {} : { requirement: browserRequirement(this.config) }),
      }
    }
    return {
      engine: ENGINE,
      ...(version === undefined ? {} : { version }),
      ...(binary.path === undefined ? {} : { executablePath: binary.path }),
      headless: this.config.headless,
      source: `playwright-core + ${binary.source}`,
      available: binary.found && ready,
      ...(binary.found && ready ? {} : { requirement: browserRequirement(this.config) }),
    }
  }

  capabilities(): BrowserProviderCapabilities {
    return {
      provider: providerId,
      engine: this.engine(),
      actKinds: [...ACT_KINDS],
      extractModes: [...EXTRACT_MODES],
      evaluate: true,
      screenshot: true,
      tabs: true,
      observe: true,
      storageState: true,
      // The seam never serves these: a caller sees the gap instead of assuming it.
      unsupported: ['pdf-export', 'proxy-rotation', 'ai-vision-loop'],
      // The REAL-browser halves: the BROWSER's own frame tree (cross-origin
      // frames included), the real mouse at coordinates, and a RAW observation
      // of every load (transport, document, frames, the browser's own moves).
      frames: true,
      mouse: true,
      rawObservation: true,
    }
  }

  sessions(): BrowserSessionInfo[] {
    return [...this.sessionsById.values()].map((session) => this.infoOf(session))
  }

  /** Releases every browser context and the shared browser (plugin unload). */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const session of [...this.sessionsById.values()]) {
      await this.persistState(session).catch(() => undefined)
      await session.context.close().catch(() => undefined)
    }
    this.sessionsById.clear()
    if (this.holdsBrowser) {
      this.holdsBrowser = false
      await releaseSharedBrowser().catch(() => undefined)
    }
    // An ATTACHED browser is NOT ours to close: the connection is dropped (the
    // contexts above are closed) and the browser container keeps running.
    if (this.attached) await this.browser?.close().catch(() => undefined)
    this.attached = false
    this.observedVersion = undefined
    this.browser = undefined
    this.launching = undefined
  }

  // -------------------------------------------------------------------------
  // Session lifecycle.
  // -------------------------------------------------------------------------

  async openSession(spec: BrowserSessionSpec, options: BrowserUseCallOptions): Promise<BrowserSessionInfo> {
    this.assertUsable()
    const id = safeSessionId(str(spec.session) ?? this.config.defaultSession)
    const existing = this.sessionsById.get(id)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      return this.infoOf(existing)
    }
    if (this.sessionsById.size >= options.maxSessions) {
      throw new BrowserUseError(
        'browser-use.session-limit',
        `the provider already holds ${this.sessionsById.size} session(s) (the cap of this deployment); close one first`,
        { stage: 'open', details: { maxSessions: options.maxSessions, live: [...this.sessionsById.keys()] } },
      )
    }
    if (spec.headless !== undefined && spec.headless !== this.config.headless) {
      // Honest refusal: chromium is SHARED with web-page/web-session, so a
      // per-session window mode cannot be honoured without a second process.
      throw new BrowserUseError(
        'browser-use.not-implemented',
        'headless is a LAUNCH-time setting of the shared chromium process: set plugins.browser-use-playwright.headless (the provider shares its browser with web-page/web-session)',
        { stage: 'open', details: { requested: spec.headless, effective: this.config.headless } },
      )
    }
    const browser = await this.ensureBrowser()
    const stateFile = str(spec.storageStateFile) ?? sessionStateFile(this.config.storageStateDir, id)
    const stateMode = str(spec.stateMode) ?? 'reuse'
    const { storageState, stateReused } = await this.resolveStorageState(stateMode, spec.storageState, stateFile)
    const downloadDir = str(spec.downloadDir) ?? path.join(this.config.downloadDir, id)
    await fs.promises.mkdir(downloadDir, { recursive: true }).catch(() => undefined)
    const proxy = await this.resolveProxy(spec.proxy)
    type ContextOptions = NonNullable<Parameters<Browser['newContext']>[0]>
    const contextOptions: ContextOptions = {
      acceptDownloads: true,
      viewport: spec.viewport ?? this.config.viewport,
      ...(spec.userAgent ?? this.config.userAgent) === undefined ? {} : { userAgent: (spec.userAgent ?? this.config.userAgent) as string },
    }
    const locale = spec.locale ?? this.config.locale
    if (locale !== undefined) contextOptions.locale = locale
    const timezone = spec.timezoneId ?? this.config.timezoneId
    if (timezone !== undefined) contextOptions.timezoneId = timezone
    if (proxy !== undefined) contextOptions.proxy = proxy
    if (storageState !== undefined) contextOptions.storageState = storageState as ContextOptions['storageState']
    const context = await browser.newContext(contextOptions).catch((error: unknown) => {
      throw this.mapLaunchError(error, 'open')
    })
    context.setDefaultTimeout(options.actionTimeoutMs)
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs)
    const session: LiveSession = {
      id,
      context,
      active: 0,
      stateFile,
      stateReused,
      // The browser-service start path, when it was taken: the caller can SEE that
      // the browser came from the configured service (its own image) and not from
      // a local launch, without reading this container's logs.
      ...(this.serviceStart === undefined ? {} : { browserServiceStart: this.serviceStart }),
      downloadDir,
      requests: [],
      downloads: [],
      refs: new Map(),
      snapshots: new Map(),
      nodes: new Map(),
      frameBindings: new Map(),
      lastTitle: '',
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      disposers: [],
    }
    this.observeSession(session)
    const page = context.pages()[0] ?? (await context.newPage())
    session.active = Math.max(0, context.pages().indexOf(page))
    this.sessionsById.set(id, session)
    await this.touch(session)
    return this.infoOf(session)
  }

  async closeSession(session: string, options: BrowserUseCallOptions): Promise<BrowserSessionInfo> {
    const live = this.requireSession(session)
    const info = this.infoOf(live, false)
    await this.persistState(live)
    for (const remove of live.disposers) {
      try {
        remove()
      } catch {
        // A listener that refuses to detach must not block the teardown.
      }
    }
    live.disposers = []
    await live.context.close().catch(() => undefined)
    this.sessionsById.delete(live.id)
    return info
  }

  async navigate(session: string, request: BrowserNavigateRequest, options: BrowserUseCallOptions): Promise<BrowserNavigateAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const waitUntil = request.waitUntil ?? 'load'
    const timeout = request.timeoutMs ?? options.navigationTimeoutMs
    const startedAt = Date.now()
    const recorder = this.recorderOf(live, page)
    const navMark = recorder.mark()
    const responseMark = recorder.responseMark()
    // Refs of the page we are leaving are stale from here on (honest, not a guess).
    this.invalidateRefs(live, page)
    let response: Awaited<ReturnType<Page['goto']>>
    recorder.beginRequested(request.url)
    try {
      response = await page.goto(request.url, { waitUntil, timeout })
    } catch (error) {
      throw mapError(error, `navigate ${request.url}`, 'browser-use.navigation-failed', { url: request.url, waitUntil })
    } finally {
      recorder.endRequested()
    }
    const load = await this.captureLoad(live, page, {
      recorder,
      responseMark,
      navMark,
      requestedUrl: request.url,
      startedAt,
      response,
    })
    const status = load.transport.httpStatus
    if (status !== undefined && status >= 400 && request.allowHttpError !== true) {
      // A refusal is REPORTED, never hidden: the whole raw observation travels in
      // the error details, so a caller can read exactly what the origin sent.
      throw new BrowserUseError('browser-use.http-status', `the page answered HTTP ${status} (pass allowHttpError: true to accept it)`, {
        stage: 'navigate',
        details: { url: load.transport.finalUrl, httpStatus: status, allowHttpError: false, raw: load },
      })
    }
    live.lastTitle = load.document.title
    await this.touch(live)
    return {
      ...this.observationOf(recorder, navMark, load, startedAt, [{ kind: 'navigate', navigationsAdded: 0 }]),
      action: 'navigate',
      session: live.id,
      url: load.transport.finalUrl,
      title: load.document.title,
      ...(status === undefined ? {} : { httpStatus: status }),
    }
  }

  async snapshot(session: string, request: BrowserSnapshotRequest, options: BrowserUseCallOptions): Promise<BrowserSnapshot> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const root = await this.rootFor(live, request)
    const maxNodes = Math.min(request.maxNodes ?? options.maxSnapshotNodes, options.maxSnapshotNodes)
    const includeText = request.includeText !== false
    const selector = str(request.selector)
    let result: { nodes: BrowserSnapshotNode[]; totalNodes: number }
    try {
      result = await root.evaluate(snapshotInPage, {
        includeText,
        maxNodes,
        refAttribute: REF_ATTRIBUTE,
        ...(selector === undefined ? {} : { selector }),
      })
    } catch (error) {
      throw mapError(error, 'snapshot', 'browser-use.provider-failed', { selector: selector ?? null })
    }
    const all = Array.isArray(result.nodes) ? result.nodes : []
    const nodes = all.slice(0, maxNodes)
    if (root !== page) {
      // A snapshot INSIDE a frame tags its nodes with the frame they came from,
      // so a caller can see where a ref lives.
      const index = page.frames().indexOf(root as Frame)
      const frameId = [...live.frameBindings.entries()].find(([, binding]) => binding.index === index)?.[0] ?? `pw:${String(index)}`
      for (const node of nodes) node.frameId = frameId
    }
    const snapshotId = this.mintSnapshotId(live)
    this.registerRefs(live, root, snapshotId, nodes)
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    return {
      action: 'snapshot',
      session: live.id,
      snapshotId,
      url: page.url(),
      title: live.lastTitle,
      nodes,
      totalNodes: all.length,
      truncated: all.length > nodes.length,
      maxNodes,
      chars: JSON.stringify(nodes).length,
    }
  }

  // -------------------------------------------------------------------------
  // Private plumbing: sessions, refs, storage state, teardown.
  // -------------------------------------------------------------------------

  /**
   * A call on a deployment that cannot drive a browser is a TYPED failure with
   * the exact requirement (requirement 3): never a fallback to an HTTP fetch
   * that pretends to be a browser.
   */
  private assertUsable(): void {
    if (this.disposed) {
      throw new BrowserUseError(
        'browser-use.no-provider',
        'the playwright provider was unloaded: re-load the plugin row before it can drive a browser again',
        { stage: 'open', details: { provider: providerId } },
      )
    }
    if (!playwrightCoreAvailable()) {
      throw new BrowserUseError('browser-use.no-browser', browserRequirement(this.config), {
        stage: 'open',
        details: { provider: providerId, missing: 'playwright-core' },
      })
    }
    // ATTACH mode: the local binary is NOT the browser, so it is not checked
    // here. Whether the endpoint answers is decided by the connect (which fails
    // with the typed `endpoint-unreachable` and never falls back to a launch).
    if (this.config.wsEndpoint !== undefined) return
    const binary = browserBinary(this.config)
    if (!binary.found) {
      throw new BrowserUseError('browser-use.no-browser', browserRequirement(this.config), {
        stage: 'open',
        details: { provider: providerId, executablePath: this.config.executablePath ?? null, checked: binary.source },
      })
    }
  }

  /**
   * The chromium of this deployment: the SHARED launcher of the repository, so
   * `web-page`, `web-session` and this provider never launch competing browsers
   * (the launcher is refcounted; the last holder closes the process).
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser !== undefined && this.browser.isConnected()) return this.browser
    if (this.launching !== undefined) return await this.launching
    const endpoint = this.config.wsEndpoint
    this.launching = (async () => {
      if (endpoint !== undefined) {
        const browser = await this.connectToEndpoint(endpoint)
        this.browser = browser
        this.attached = true
        this.holdsBrowser = false
        this.observedVersion = browser.version()
        return browser
      }
      const proxy = await this.resolveProxy(undefined)
      const browser = await acquireSharedBrowser({
        ...(this.config.executablePath === undefined ? {} : { executablePath: this.config.executablePath }),
        args: this.config.browserArgs,
        timeoutMs: this.config.launchTimeoutMs,
        headless: this.config.headless,
        ...(proxy === undefined ? {} : { proxy }),
      }).catch((error: unknown) => {
        throw this.mapLaunchError(error, 'launch')
      })
      this.browser = browser
      this.holdsBrowser = true
      this.observedVersion = browser.version()
      return browser
    })()
    try {
      return await this.launching
    } finally {
      this.launching = undefined
    }
  }

  /**
   * ATTACHES to the remote browser named by `wsEndpoint` (`cdpEndpoint` is the
   * same field). A failure here is the typed `browser-use.endpoint-unreachable`
   * naming the endpoint - this provider NEVER falls back to a local launch and
   * never to a non-browser fetch when an endpoint is configured (that is the
   * whole point of the setting).
   */
  private async connectToEndpoint(endpoint: string): Promise<Browser> {
    const playwright = await import('playwright-core').catch((error: unknown) => {
      throw new BrowserUseError('browser-use.no-browser', browserRequirement(this.config), {
        stage: 'open',
        details: { provider: providerId, missing: 'playwright-core', reason: messageOf(error) },
      })
    })
    // A service NAME in the endpoint (`http://browser:9222`, the shape a
    // deployment writes) is resolved to its ADDRESS first: chromium refuses a
    // DevTools request whose Host header is neither an IP nor `localhost`, and
    // the browser-service image forwards the Host header untouched. The
    // CONFIGURED string stays the one the result and the typed error name.
    const target = await connectTarget(endpoint)
    try {
      return await playwright.chromium.connectOverCDP(target, { timeout: this.config.launchTimeoutMs })
    } catch (error) {
      // The endpoint did not answer. When the deployment NAMED a browser service
      // (its OWN image, reached through the general-service@1 seam), START it
      // once through that seam and retry the attach, bounded by `startTimeoutMs`.
      // The path taken is REPORTED in the result: a silent local launch or an
      // HTTP fetch would both be a lie about what drove the page.
      const service = this.config.browserService
      const started = service === undefined ? undefined : await this.startBrowserService(service, error)
      if (started !== undefined) this.serviceStart = started
      if (started?.attempted === true && started.code === 0) {
        const budgetMs = service?.startTimeoutMs ?? 0
        const connected = await this.retryAttach(playwright, target, budgetMs)
        if (connected !== undefined) {
          started.waitedMs = budgetMs
          started.connected = true
          return connected
        }
        started.waitedMs = budgetMs
        started.connected = false
      }
      throw this.endpointError(endpoint, error, started)
    }
  }

  /**
   * Attaches again after a browser-service start, bounded: a just-started
   * chromium may take a few seconds before it listens on the debugging port.
   */
  private async retryAttach(
    playwright: typeof import('playwright-core'),
    endpoint: string,
    budgetMs: number,
  ): Promise<Browser | undefined> {
    const deadline = Date.now() + Math.max(budgetMs, 0)
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      try {
        return await playwright.chromium.connectOverCDP(endpoint, { timeout: this.config.launchTimeoutMs })
      } catch {
        if (Date.now() >= deadline) return undefined
      }
    }
  }

  /**
   * Starts the configured browser service ONCE, through the `general-service@1`
   * seam (container / ssh / shell / http chosen by CONFIG, never by this
   * provider). The result is returned for the call result and the typed error:
   * what was run, through which instance, and what it answered.
   */
  private async startBrowserService(service: ResolvedBrowserService, cause: unknown): Promise<BrowserServiceStartRecord> {
    const command = service.start
    if (command === undefined) {
      return { attempted: false, reason: "no 'browserService.start' command is configured", cause: firstLine(messageOf(cause)) }
    }
    const instance = service.generalService
    if (instance === undefined) {
      return {
        attempted: false,
        command,
        reason: "no 'browserService.generalService' instance is configured (the browser service is started through the general-service@1 seam)",
        cause: firstLine(messageOf(cause)),
      }
    }
    const generalService = this.generalService()
    if (generalService === undefined) {
      return {
        attempted: false,
        command,
        type: instance.type,
        reason: 'no general-service@1 provider is loaded in this deployment (the seam is resolved at CALL time, so it may be loaded after this provider)',
        cause: firstLine(messageOf(cause)),
      }
    }
    try {
      // The start call is BOUNDED: a launcher that runs the browser in the
      // FOREGROUND (a bare `docker exec start-browser`) would otherwise hold the
      // transport open forever. The budget is the same `startTimeoutMs` the
      // endpoint wait uses, so a stuck start fails LOUDLY instead of hanging.
      const result = await generalService
        .create({ type: instance.type, params: instance.params })
        .call(command, { timeoutMs: service.startTimeoutMs })
      const output = typeof result.output === 'string' ? result.output : ''
      const stderr = typeof result.stderr === 'string' ? result.stderr : ''
      return {
        attempted: true,
        command,
        type: instance.type,
        code: typeof result.code === 'number' ? result.code : -1,
        ...(output.length === 0 ? {} : { output: output.length > 2_000 ? output.slice(-2_000) : output }),
        ...(stderr.length === 0 ? {} : { stderr: stderr.length > 2_000 ? stderr.slice(-2_000) : stderr }),
      }
    } catch (error) {
      return {
        attempted: true,
        command,
        type: instance.type,
        reason: firstLine(messageOf(error)),
        cause: firstLine(messageOf(cause)),
      }
    }
  }

  /** The typed failure of an unreachable browser service (never a fallback). */
  private endpointError(endpoint: string, cause: unknown, started: BrowserServiceStartRecord | undefined): BrowserUseError {
    const service = this.config.browserService
    const startNote =
      started === undefined
        ? ''
        : started.attempted
          ? ` - the browser service start '${started.command ?? ''}' answered code ${started.code ?? 'none'}${started.connected === true ? ' and the endpoint then answered' : ''}${started.waitedMs === undefined ? '' : ` (waited ${started.waitedMs} ms for the endpoint)`}${started.output === undefined ? '' : `; output: ${started.output}`}${started.stderr === undefined ? '' : `; stderr: ${started.stderr}`}`
          : ` - the browser service start was NOT attempted: ${started.reason ?? 'unknown reason'}`
    return new BrowserUseError(
      'browser-use.endpoint-unreachable',
      `no browser is reachable at the configured CDP endpoint '${endpoint}' (backend: ${this.config.backend}): ${firstLine(messageOf(cause))}${startNote} - ${endpointRequirement(this.config)}`,
      {
        stage: 'open',
        details: {
          provider: providerId,
          backend: this.config.backend,
          endpoint,
          ...(service?.image === undefined ? {} : { image: service.image }),
          ...(service?.generalService === undefined ? {} : { generalService: service.generalService }),
          ...(started === undefined ? {} : { browserServiceStart: started }),
          fallback: 'none',
          requirement: endpointRequirement(this.config),
        },
      },
    )
  }

  /** A launch failure is `no-browser` when it reads like a missing binary. */
  private mapLaunchError(error: unknown, stage: string): BrowserUseError {
    if (isBrowserUseError(error)) return error
    const message = error instanceof Error ? error.message : String(error)
    if (looksLikeMissingBrowser(message)) {
      return new BrowserUseError('browser-use.no-browser', `${stage}: ${firstLine(message)} - ${browserRequirement(this.config)}`, {
        stage,
        details: { provider: providerId, requirement: browserRequirement(this.config) },
      })
    }
    return new BrowserUseError('browser-use.provider-failed', `${stage}: ${firstLine(message)}`, {
      stage,
      details: { provider: providerId },
    })
  }

  /**
   * The proxy a session launches with. A `credential` NAME is resolved through
   * `ctx.credentials` HERE, at launch time, and the VALUE never leaves this
   * method (no log line, no answer, no state file).
   */
  private async resolveProxy(
    override: BrowserSessionSpec['proxy'],
  ): Promise<{ server: string; username?: string; password?: string } | undefined> {
    const spec = override ?? this.config.proxy
    if (spec === undefined || typeof spec.server !== 'string' || spec.server.trim().length === 0) return undefined
    const resolved: { server: string; username?: string; password?: string } = { server: spec.server.trim() }
    if (typeof spec.username === 'string' && spec.username.trim().length > 0) resolved.username = spec.username.trim()
    const credential = typeof spec.credential === 'string' ? spec.credential.trim() : ''
    if (credential.length > 0) {
      const resolvedValue = await this.resolveCredential(credential)
      if (resolvedValue === undefined) {
        throw new BrowserUseError('browser-use.invalid-input', `the proxy credential '${credential}' is not resolvable in this deployment`, {
          stage: 'open',
          details: { field: 'proxy.credential' },
        })
      }
      resolved.password = resolvedValue
    }
    return resolved
  }

  /** One credential VALUE, or undefined (never logged, never answered). */
  private async resolveCredential(name: string): Promise<string | undefined> {
    if (this.credentials === undefined || typeof this.credentials.resolve !== 'function') return undefined
    try {
      const answer = await this.credentials.resolve({ name })
      const value = (answer as { value?: unknown } | undefined)?.value
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Seeds a session's storage state: `reuse` (the session's state file when it
   * exists, the `web-session` convention), `fresh` (nothing) or `inline` (the
   * caller's object). A corrupt file is IGNORED with a warning, never a failure:
   * a session that cannot reuse its cookies is still a usable session.
   */
  private async resolveStorageState(
    mode: string,
    inline: unknown,
    stateFile: string,
  ): Promise<{ storageState?: unknown; stateReused: boolean }> {
    if (mode === 'inline') return { storageState: inline, stateReused: false }
    if (mode === 'fresh') return { stateReused: false }
    let raw: string
    try {
      raw = await fs.promises.readFile(stateFile, 'utf8')
    } catch {
      return { stateReused: false }
    }
    try {
      return { storageState: JSON.parse(raw) as unknown, stateReused: true }
    } catch {
      return { stateReused: false }
    }
  }

  /** Persists the session's storage state to its file (cookies + localStorage). */
  private async persistState(session: LiveSession): Promise<void> {
    if (session.stateFile.length === 0) return
    await fs.promises.mkdir(path.dirname(session.stateFile), { recursive: true }).catch(() => undefined)
    await session.context.storageState({ path: session.stateFile }).catch(() => undefined)
  }

  /** The live session behind an id, or the typed failure that names the state. */
  private requireSession(session: string): LiveSession {
    const id = safeSessionId(session)
    const live = this.sessionsById.get(id)
    if (live === undefined) {
      const known = [...this.sessionsById.keys()]
      throw new BrowserUseError(
        known.length === 0 ? 'browser-use.no-session' : 'browser-use.unknown-session',
        known.length === 0
          ? `no browser session is open (provider '${providerId}'): call 'open' first`
          : `no session '${id}' in provider '${providerId}' (open: ${known.join(', ')})`,
        { stage: 'session', details: { session: id, open: known } },
      )
    }
    return live
  }

  /** The tab every action of a session uses (never a stale index). */
  private activePage(session: LiveSession): Page {
    const pages = session.context.pages()
    if (pages.length === 0) {
      throw new BrowserUseError('browser-use.no-session', `session '${session.id}' has no open page any more`, {
        stage: 'session',
        details: { session: session.id },
      })
    }
    session.active = Math.min(Math.max(0, session.active), pages.length - 1)
    return pages[session.active] as Page
  }

  /** What a caller learns about a session (never a cookie VALUE, never a secret). */
  private infoOf(session: LiveSession, live = true): BrowserSessionInfo {
    let url = 'about:blank'
    let tabs = 0
    try {
      tabs = session.context.pages().length
      url = session.context.pages()[session.active]?.url() ?? url
    } catch {
      // A closed context is still describable: the caller sees `live: false`.
    }
    return {
      id: session.id,
      provider: providerId,
      url,
      title: session.lastTitle,
      engine: this.engine(),
      live: live && !session.context.isClosed(),
      stateReused: session.stateReused,
      stateFile: session.stateFile,
      // The browser-service start path, when `open` had to take it: the caller
      // SEES that the browser came from the configured service (its OWN image)
      // and not from a local launch, without reading container logs.
      ...(this.serviceStart === undefined ? {} : { browserServiceStart: this.serviceStart }),
      tabs,
      requests: session.requests.length,
      downloads: session.downloads.length,
      openedAt: session.openedAt,
      lastUsedAt: session.lastUsedAt,
    }
  }

  /** Stamps the use of a session (the idle TTL of the deployment reads this). */
  private async touch(session: LiveSession): Promise<void> {
    session.lastUsedAt = Date.now()
  }

  /**
   * The ROOT a call acts in: the active page, or the FRAME the request names
   * (falling back to the session's selected frame). A cross-origin iframe is
   * only reachable THROUGH its frame object, so this is what makes an
   * interaction inside a widget possible at all.
   */
  private async rootFor(live: LiveSession, request: { frame?: BrowserFrameTarget }): Promise<Page | Frame> {
    const page = this.activePage(live)
    if (request.frame !== undefined) return resolveFrameTarget(page, request.frame, live.frameBindings)
    if (live.selectedFrameId === undefined) return page
    const frame = await resolveFrameTarget(page, { frameId: live.selectedFrameId }, live.frameBindings).catch(() => undefined)
    return frame ?? page
  }

  /**
   * The page-level CDP session (created LAZILY: only the frame tree needs it).
   * it). It is detached by the session disposers, so an unload leaves no CDP
   * connection behind.
   */
  private async cdpFor(live: LiveSession, page: Page): Promise<CDPSession> {
    if (live.cdp !== undefined) return live.cdp
    const cdp = await page.context().newCDPSession(page)
    live.cdp = cdp
    live.disposers.push(() => {
      void cdp.detach().catch(() => undefined)
    })
    return cdp
  }

  /** Drops the refs of a root: they belong to a document that is gone. */
  private invalidateRefs(session: LiveSession, root: Page | Frame): void {
    const previous = session.snapshots.get(root)
    session.snapshots.delete(root)
    session.nodes.delete(root)
    if (previous === undefined) return
    for (const [ref, snapshotId] of session.refs) {
      if (snapshotId === previous) session.refs.delete(ref)
    }
  }

  /** Mints the id of the next snapshot (`s1`, `s2`, ...). */
  private mintSnapshotId(session: LiveSession): string {
    this.snapshotCounter += 1
    return `s${String(this.snapshotCounter)}`
  }

  /**
   * Records which snapshot minted each ref. A ref of an OLDER snapshot of the
   * same page is `stale-ref`: the page changed under the caller's feet, and a
   * silent click at the old position is exactly what this provider refuses.
   */
  private registerRefs(session: LiveSession, root: Page | Frame, snapshotId: string, nodes: BrowserSnapshotNode[]): void {
    this.invalidateRefs(session, root)
    session.snapshots.set(root, snapshotId)
    // The node SHAPES are kept too: the stale-ref retry below re-resolves a ref
    // by the role+name it was minted for instead of guessing a new position.
    session.nodes.set(root, nodes)
    for (const node of nodes) session.refs.set(node.ref, snapshotId)
  }

  /**
   * The element an interaction targets: a REF from the current snapshot (the
   * round-tripping half of requirement 4) or the caller's own selector. Both
   * paths end in a `locator`, and neither ever guesses: an empty match is a
   * typed `selector-not-found` / `stale-ref`.
   */
  private async resolveTarget(
    session: LiveSession,
    root: Page | Frame,
    request: { ref?: string; selector?: string },
    what: string,
  ): Promise<ResolvedTarget> {
    const ref = request.ref === undefined ? undefined : requireRef(request.ref)
    if (ref !== undefined) {
      const snapshotId = session.refs.get(ref)
      const current = session.snapshots.get(root)
      if (snapshotId === undefined || snapshotId !== current) {
        throw new BrowserUseError(
          'browser-use.stale-ref',
          `the ref '${ref}' belongs to ${snapshotId === undefined ? 'no snapshot of this page' : `snapshot '${snapshotId}'`}; the page is on '${current ?? 'none'}' - take a fresh \`snapshot\` and act on its refs`,
          { stage: what, details: { ref, snapshot: current ?? null, mintedIn: snapshotId ?? null } },
        )
      }
      const locator = root.locator(`[${REF_ATTRIBUTE}="${ref}"]`)
      const count = await locator.count().catch(() => 0)
      if (count === 0) {
        throw new BrowserUseError('browser-use.stale-ref', `the element behind '${ref}' is gone from the page (take a fresh \`snapshot\`)`, {
          stage: what,
          details: { ref },
        })
      }
      return { locator: locator.first(), ref, selector: `[${REF_ATTRIBUTE}="${ref}"]`, resolved: true }
    }
    if (request.selector === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `${what} needs a 'ref' (from a \`snapshot\`) or a 'selector'`, {
        stage: what,
        details: { field: 'ref' },
      })
    }
    const selector = requireText(request.selector, 'selector', 4_096)
    const locator = root.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      throw new BrowserUseError('browser-use.selector-not-found', `${what}: '${selector}' matched no element`, {
        stage: what,
        details: { selector },
      })
    }
    return { locator: locator.first(), selector, resolved: false }
  }

  /** The role+name a ref was minted for (undefined: the ref is not known here). */
  private shapeOf(session: LiveSession, root: Page | Frame, ref: string): RefShape | undefined {
    const node = session.nodes.get(root)?.find((candidate) => candidate.ref === ref)
    if (node === undefined) return undefined
    return {
      tag: node.tag,
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.inputType === undefined ? {} : { inputType: node.inputType }),
    }
  }

  /**
   * Resolves the target of an interaction, HEALING a stale ref ONCE.
   *
   * The failure this fixes is the one a caller hits constantly: it takes a
   * `snapshot`, the page re-renders (a banner, a lazy panel, a nav bar) and the
   * `act` that follows is `stale-ref` - the caller then concludes it cannot
   * drive a browser. Instead: re-snapshot the page ONCE, re-resolve the SAME
   * element by the role+name it was minted for, and run the action. Only when
   * that fails does the caller get the typed `stale-ref`, and then WITH the
   * fresh refs. The path taken is reported in `BrowserActAnswer.refRetry`, so a
   * recovery is provable and never a silent interaction at a moved position.
   */
  private async resolveTargetWithRetry(
    session: LiveSession,
    root: Page | Frame,
    request: { ref?: string; selector?: string },
    what: string,
    options: BrowserUseCallOptions,
    frame?: BrowserFrameTarget,
  ): Promise<{ target: ResolvedTarget; retry?: BrowserRefRetry }> {
    try {
      return { target: await this.resolveTarget(session, root, request, what) }
    } catch (error) {
      if (request.ref === undefined || !isStaleRef(error)) throw error
      const ref = requireRef(request.ref)
      // The identity is read BEFORE the fresh snapshot: a snapshot replaces the
      // node table of the ROOT, and it keeps the SAME frame scope, so a ref
      // minted inside a widget frame is re-resolved inside that frame.
      const shape = this.shapeOf(session, root, ref)
      const fresh = await this.snapshot(session.id, frame === undefined ? {} : { frame }, options)
      // Identity first (role+name), then a UNIQUE shape match: a control with no
      // accessible name is still recoverable without guessing a position.
      const byName = shape === undefined ? undefined : matchRef(fresh.nodes, shape)
      const byShape = byName !== undefined || shape === undefined ? undefined : matchRefByShape(fresh.nodes, shape)
      const strategy = byName !== undefined ? 'role+name' : byShape !== undefined ? 'unique-shape' : 'fresh-snapshot'
      const retry: BrowserRefRetry = {
        attempted: true,
        recovered: false,
        from: ref,
        snapshotId: fresh.snapshotId,
        reason: firstLineOf(error),
      }
      const candidate = byName ?? byShape
      if (candidate !== undefined) {
        try {
          const target = await this.resolveTarget(session, root, { ref: candidate }, what)
          return { target, retry: { ...retry, recovered: true, to: candidate } }
        } catch (second) {
          if (!isStaleRef(second)) throw second
        }
      }
      throw new BrowserUseError(
        'browser-use.stale-ref',
        `the ref '${ref}' went stale between the snapshot and the call and the automatic retry could not re-resolve it ` +
          `(re-snapshotted as '${fresh.snapshotId}', strategy '${strategy}'); the FRESH refs of this page are in 'details.nodes' - ` +
          'pick the one whose role+name matches the element you meant and call again',
        {
          stage: what,
          details: { ref, snapshotId: fresh.snapshotId, strategy, retried: true, nodes: fresh.nodes.slice(0, 60) },
        },
      )
    }
  }

  /**
   * The evidence behind a timeout on a control the call DID resolve: disabled /
   * covered / zero-size / invisible / `pointer-events: none`. A `timeout` on a
   * genuinely non-interactable element must NAME the element and the reason
   * instead of a bare "Timeout exceeded".
   */
  private async diagnoseTarget(
    error: unknown,
    page: Page,
    target: ResolvedTarget | undefined,
    what: string,
  ): Promise<BrowserUseError | undefined> {
    if (target === undefined || target.selector === undefined || !isTimeoutLike(error)) return undefined
    const selector = target.selector
    const expression = `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) return { present: false };
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const x = Math.min(Math.max(rect.x + rect.width / 2, 1), window.innerWidth - 2);
      const y = Math.min(Math.max(rect.y + rect.height / 2, 1), window.innerHeight - 2);
      const hit = document.elementFromPoint(x, y);
      const covers = hit !== null && hit !== element && !element.contains(hit);
      return {
        present: true,
        tag: element.tagName.toLowerCase(),
        disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
        covered: covers,
        covering: covers && hit !== null ? hit.tagName.toLowerCase() + (hit.id === '' ? '' : '#' + hit.id) : undefined,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0',
        pointerEvents: style.pointerEvents,
      };
    })()`
    const evidence = (await page.evaluate(expression).catch(() => undefined)) as TargetDiagnosis | undefined
    const label = target.ref === undefined ? `'${selector}'` : `ref '${target.ref}' (${selector})`
    if (evidence === undefined || !evidence.present) {
      return new BrowserUseError(
        'browser-use.stale-ref',
        `${what}: the element behind ${label} left the page before the action could complete`,
        { stage: what, details: { ref: target.ref ?? null, selector } },
      )
    }
    const reasons: string[] = []
    if (evidence.disabled === true) reasons.push('the control is DISABLED (visible, but it refuses interaction)')
    if (evidence.covered === true) reasons.push(`it is COVERED by <${evidence.covering ?? 'another element'}>`)
    if (evidence.width === 0 || evidence.height === 0) reasons.push(`its box is ZERO-SIZE (${evidence.width}x${evidence.height})`)
    if (evidence.visible !== true) reasons.push('it is INVISIBLE (display/visibility/opacity)')
    if (evidence.pointerEvents === 'none') reasons.push("it is 'pointer-events: none'")
    if (reasons.length === 0) reasons.push('it is visible and not covered, so the engine could not finish the interaction within the budget')
    return new BrowserUseError('browser-use.timeout', `${what} timed out on ${label}: ${reasons.join('; ')}`, {
      stage: what,
      details: { ref: target.ref ?? null, selector, diagnosis: reasons, element: evidence },
    })
  }

  /**
   * Lets in-flight work settle after an interaction (a navigation started by a
   * click, a fetch that fills a panel). It is BOUNDED and never fails the call:
   * the caller asked for an interaction, not for a page that quiesces.
   */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => undefined)
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Interaction: `act` (the closed vocabulary), `evaluate`, `extract`.
  // -------------------------------------------------------------------------

  /**
   * ONE interaction. A REF comes from the CURRENT snapshot of the active page and
   * is resolved through the ref table the provider minted (never a caller-built
   * selector); a ref that no longer resolves is the typed `stale-ref`, so a
   * caller never clicks whatever moved into that position.
   */
  async act(session: string, request: BrowserActRequest, options: BrowserUseCallOptions): Promise<BrowserActAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    // A TARGETED act can run INSIDE a frame (a cross-origin widget has no other
    // door): the root below is the page, or the frame the request names.
    const root = await this.rootFor(live, request)
    const kind = requireEnum(request.kind, ACT_KINDS, 'kind')
    const timeout = request.timeoutMs ?? options.actionTimeoutMs
    const started = Date.now()
    let resolved = false
    let appliedRef: string | undefined
    let appliedSelector: string | undefined
    let retry: BrowserRefRetry | undefined
    let target: ResolvedTarget | undefined
    try {
      const targeted = TARGETED_ACT_KINDS.includes(kind)
      if (targeted || (kind === 'press' && (request.ref !== undefined || request.selector !== undefined))) {
        // A ref that no longer matches the DOM is NOT a dead end: the seam
        // re-snapshots the page ONCE, re-resolves the ref by the role+name it
        // was minted for and re-runs the very same action (see
        // `resolveTargetWithRetry`); only when THAT fails does the caller get
        // the typed `stale-ref`, together with the FRESH refs.
        const attempt = await this.resolveTargetWithRetry(live, root, request, `act: ${kind}`, options, request.frame)
        retry = attempt.retry
        target = attempt.target
        appliedRef = attempt.target.ref
        appliedSelector = attempt.target.selector
        resolved = attempt.target.resolved
        const locator = attempt.target.locator
        switch (kind) {
          case 'click':
            await locator.click({ timeout })
            break
          case 'type': {
            // `type` writes KEYSTROKE BY KEYSTROKE (an autocomplete sees every
            // key); `fill` replaces the value atomically. Both are honest.
            const value = requireText(request.value, 'value', 100_000)
            await locator.click({ timeout })
            await locator.fill('', { timeout })
            await locator.pressSequentially(value, { timeout })
            break
          }
          case 'fill':
            await locator.fill(requireText(request.value, 'value', 100_000), { timeout })
            break
          case 'select': {
            const value = requireText(request.value, 'value', 10_000)
            await locator.selectOption(request.byLabel === true ? { label: value } : { value }, { timeout })
            break
          }
          case 'hover':
            await locator.hover({ timeout })
            break
          case 'press':
            await locator.press(requireText(request.key, 'key', 64), { timeout })
            break
          case 'upload': {
            if (!Array.isArray(request.files) || request.files.length === 0) {
              throw new BrowserUseError('browser-use.invalid-input', "'act: upload' needs 'files' (one or more paths)", {
                stage: 'act',
                details: { field: 'files', kind },
              })
            }
            const files = request.files.map((file) => requireText(file, 'files[]', 4_096))
            await locator.setInputFiles(files, { timeout })
            break
          }
          case 'check':
            await locator.setChecked(request.checked !== false, { timeout })
            break
          case 'focus':
            await locator.focus()
            break
          case 'scroll':
            await locator.scrollIntoViewIfNeeded({ timeout })
            break
          case 'waitFor':
            await locator.waitFor({ state: request.state ?? 'visible', timeout })
            break
          default:
            throw new BrowserUseError('browser-use.not-implemented', `act: ${kind} is not served by this provider`, {
              stage: 'act',
              details: { kind },
            })
        }
      } else {
        switch (kind) {
          case 'scroll': {
            const direction = requireEnum(request.direction, SCROLL_DIRECTIONS, 'direction', 'down')
            const amount = request.amount === undefined ? undefined : requirePositiveInt(request.amount, 'amount', 100_000)
            const size = page.viewportSize()
            const horizontal = direction === 'left' || direction === 'right'
            const step = amount ?? (horizontal ? (size?.width ?? 1280) : (size?.height ?? 720))
            const dx = direction === 'left' ? -1 : direction === 'right' ? 1 : 0
            const dy = direction === 'up' ? -1 : direction === 'down' ? 1 : 0
            await page.evaluate(
              ({ x, y, pixels }: { x: number; y: number; pixels: number }) => {
                window.scrollBy(x * pixels, y * pixels)
              },
              { x: dx, y: dy, pixels: step },
            )
            break
          }
          case 'press':
            // No target: the chord goes to whatever the page has focused (a
            // modal, a global handler) - a documented behaviour, not an accident.
            await page.keyboard.press(requireText(request.key, 'key', 64))
            break
          case 'back':
            this.invalidateRefs(live, page)
            await page.goBack({ waitUntil: 'load', timeout })
            break
          case 'forward':
            this.invalidateRefs(live, page)
            await page.goForward({ waitUntil: 'load', timeout })
            break
          case 'reload':
            this.invalidateRefs(live, page)
            await page.reload({ waitUntil: 'load', timeout })
            break
          case 'waitFor':
            await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined)
            break
          default:
            throw new BrowserUseError(
              'browser-use.invalid-input',
              `'act: ${kind}' needs a 'ref' (from a \u0060snapshot\u0060) or a 'selector'`,
              { stage: 'act', details: { kind, field: 'ref' } },
            )
        }
      }
      if (request.settle !== false) await this.settle(page)
      live.lastTitle = await page.title().catch(() => live.lastTitle)
      await this.touch(live)
      const answer: BrowserActAnswer = {
        action: 'act',
        kind,
        session: live.id,
        url: page.url(),
        title: live.lastTitle,
        resolved,
        durationMs: Date.now() - started,
      }
      if (appliedRef !== undefined) answer.ref = appliedRef
      if (appliedSelector !== undefined) answer.selector = appliedSelector
      if (retry !== undefined) answer.refRetry = retry
      if (request.snapshot === true) answer.snapshot = await this.snapshot(live.id, request.frame === undefined ? {} : { frame: request.frame }, options)
      return answer
    } catch (error) {
      // A timeout on a control we DID resolve names the element and the reason
      // (disabled / covered / zero-size / invisible) when the evidence is there.
      const diagnosed = await this.diagnoseTarget(error, page, target, `act: ${kind}`)
      throw diagnosed ?? mapError(error, `act: ${kind}`, 'browser-use.provider-failed', { kind, ref: appliedRef ?? null })
    }
  }

  /** Runs ONE javascript expression in the page and answers a JSON-safe value. */
  async evaluate(
    session: string,
    request: BrowserEvaluateRequest,
    options: BrowserUseCallOptions,
  ): Promise<BrowserEvaluateAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const expression = requireText(request.expression, 'expression', 100_000)
    const values = Array.isArray(request.args) ? request.args : []
    const maxChars = Math.min(request.maxChars ?? options.maxTextChars, options.maxTextChars)
    let result: unknown
    try {
      result = await page.evaluate(
        async ({ source, args }: { source: string; args: unknown[] }) => {
          // The caller writes an EXPRESSION, never a module: it is wrapped and
          // called with the arguments it was handed (JSON only).
          const evaluator = new Function(...args.map((_value, index) => `a${String(index)}`), `return (${source})`) as (
            ...rest: unknown[]
          ) => unknown
          return await Promise.resolve(evaluator(...args))
        },
        { source: expression, args: values },
      )
    } catch (error) {
      throw mapError(error, 'evaluate', 'browser-use.evaluation-failed', { expression: firstLine(expression) })
    }
    let serialized: string
    try {
      serialized = JSON.stringify(result ?? null) ?? 'null'
    } catch {
      serialized = String(result)
      result = serialized
    }
    const truncated = serialized.length > maxChars
    const value = truncated ? serialized.slice(0, maxChars) : result
    const resultType = result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result
    await this.touch(live)
    return {
      action: 'evaluate',
      session: live.id,
      url: page.url(),
      value,
      resultType,
      truncated,
      chars: Math.min(serialized.length, maxChars),
    }
  }

  /**
   * Reads the page (or a scope of it) in a caller-chosen shape. The extraction
   * runs INSIDE the page in one round trip; a `web-recipe` scope is handed in by
   * the HOST as the request `selector` (it owns the store lookup, requirement 5),
   * so this provider never imports the recipe plugin.
   */
  async extract(
    session: string,
    request: BrowserExtractRequest,
    options: BrowserUseCallOptions,
  ): Promise<BrowserExtractAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const mode = request.mode === undefined ? 'text' : requireEnum(request.mode, EXTRACT_MODES, 'mode', 'text')
    const maxChars = Math.min(request.maxChars ?? options.maxTextChars, options.maxTextChars)
    // `extract` reads the SESSION's root: the frame selected through `frames
    // select` when there is one, else the main document.
    const root = await this.rootFor(live, {})
    let scope: string | undefined
    if (request.ref !== undefined) {
      const target = await this.resolveTarget(live, root, { ref: request.ref }, 'extract')
      scope = target.selector
    } else if (request.selector !== undefined) {
      scope = requireText(request.selector, 'selector', 4_096)
    }
    const payload: ExtractPayload = { mode, maxChars }
    if (scope !== undefined) payload.selector = scope
    if (mode === 'attributes') {
      payload.attributes = Array.isArray(request.attributes)
        ? request.attributes.map((name) => requireText(name, 'attributes[]', 128))
        : DEFAULT_ATTRIBUTES
    }
    if (mode === 'table') payload.index = request.index === undefined ? 0 : requireNonNegativeInt(request.index, 'index', 1_000)
    if (mode === 'json' && request.expression !== undefined) payload.expression = requireText(request.expression, 'expression', 100_000)
    let result: Awaited<ReturnType<typeof extractInPage>>
    try {
      result = await root.evaluate(extractInPage, payload)
    } catch (error) {
      throw mapError(error, 'extract', 'browser-use.provider-failed', { mode, selector: scope ?? null })
    }
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    const answer: BrowserExtractAnswer = {
      action: 'extract',
      session: live.id,
      url: page.url(),
      title: live.lastTitle,
      mode,
      chars: Math.min(typeof result.chars === 'number' ? result.chars : 0, maxChars),
      truncated: result.truncated === true,
    }
    if (typeof result.note === 'string') answer.note = result.note
    if (typeof result.text === 'string') answer.text = result.text.slice(0, maxChars)
    if (Array.isArray(result.rows)) answer.rows = result.rows
    if (Array.isArray(result.elements)) answer.elements = result.elements
    if (Array.isArray(result.links)) answer.links = result.links
    if (mode === 'json') {
      const json = typeof result.text === 'string' ? result.text : JSON.stringify(result.value ?? null)
      answer.text = json.slice(0, maxChars)
      answer.chars = answer.text.length
    }
    return answer
  }

  // -------------------------------------------------------------------------
  // Output + observation: `screenshot`, `tabs`, `wait`, `observe`, `state`.
  // -------------------------------------------------------------------------

  /**
   * Captures the page (or one element) into a FILE and answers its path, never
   * unbounded base64: a screenshot travels as a path a caller can read, and the
   * byte cap of the seam is enforced HERE (an oversized image is deleted and
   * reported as the typed `oversized`, so no caller ever receives a huge blob).
   */
  async screenshot(
    session: string,
    request: BrowserScreenshotRequest,
    options: BrowserUseCallOptions,
  ): Promise<BrowserScreenshotAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const format = request.format === undefined ? 'png' : requireEnum(request.format, SCREENSHOT_FORMATS, 'format', 'png')
    const maxBytes = Math.min(request.maxBytes ?? options.maxImageBytes, options.maxImageBytes)
    const explicit = str(request.path)
    // WHERE the file goes: an explicit `path` wins, then THIS provider's own
    // `screenshotDir` config (the provider owns the file it writes; the host
    // bound is only a fallback), then the absolute seam default. The answer is
    // ALWAYS ABSOLUTE - a caller reads the path back in its own namespace, so a
    // path resolved against the core's CWD is unusable (defect D1, thread 2577).
    const dir = path.resolve(explicit !== undefined ? path.dirname(explicit) : (this.config.screenshotDir ?? options.screenshotDir))
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined)
    const label = slugOf(`${str(request.label) ?? live.lastTitle ?? 'page'}`)
    const extension = format === 'jpeg' ? 'jpg' : 'png'
    const file = explicit !== undefined ? path.resolve(explicit) : path.join(dir, `${label}-${String(Date.now())}.${extension}`)
    const shot: ShotOptions = { path: file, type: format, fullPage: request.fullPage === true && request.ref === undefined && request.selector === undefined }
    if (format === 'jpeg' && request.quality !== undefined) shot.quality = requirePositiveInt(request.quality, 'quality', 100)
    let size: { width: number; height: number } | undefined
    try {
      if (request.ref !== undefined || request.selector !== undefined) {
        const target = await this.resolveTarget(live, page, request, 'screenshot')
        const box = await target.locator.boundingBox()
        if (box !== null) size = { width: Math.round(box.width), height: Math.round(box.height) }
        await target.locator.screenshot(shot)
      } else {
        size = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
          height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
        }))
        await page.screenshot(shot)
      }
    } catch (error) {
      throw mapError(error, 'screenshot', 'browser-use.provider-failed', { path: file })
    }
    const stat = await fs.promises.stat(file).catch(() => undefined)
    const bytes = stat === undefined ? 0 : stat.size
    if (bytes > maxBytes) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined)
      throw new BrowserUseError(
        'browser-use.oversized',
        `the screenshot is ${String(bytes)} bytes, above the cap of ${String(maxBytes)}; lower the viewport, capture one element or raise plugins.browser-use-impl.maxImageBytes`,
        { stage: 'screenshot', details: { bytes, maxBytes } },
      )
    }
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    return {
      action: 'screenshot',
      session: live.id,
      url: page.url(),
      path: file,
      format,
      mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      bytes,
      fullPage: shot.fullPage === true,
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
    }
  }

  /** Lists / opens / switches / closes the tabs of one session. */
  async tabs(session: string, request: BrowserTabRequest, options: BrowserUseCallOptions): Promise<BrowserTabAnswer> {
    const live = this.requireSession(session)
    const action = request.action === undefined ? 'list' : requireEnum(request.action, TAB_ACTIONS, 'tabAction', 'list')
    const timeout = request.timeoutMs ?? options.navigationTimeoutMs
    let opened: number | undefined
    let closed: number | undefined
    if (action === 'new') {
      const created = await live.context.newPage()
      live.active = Math.max(0, live.context.pages().indexOf(created))
      live.snapshots.delete(created)
      opened = live.active
      const url = str(request.url)
      if (url !== undefined) {
        try {
          await created.goto(url, { waitUntil: request.navigate === false ? 'commit' : 'load', timeout })
        } catch (error) {
          throw mapError(error, `tabs new ${url}`, 'browser-use.navigation-failed', { url })
        }
      }
    } else if (action === 'switch' || action === 'close') {
      const pages = live.context.pages()
      const index = requireNonNegativeInt(request.index, 'index', 10_000)
      const page = pages[index]
      if (page === undefined) {
        throw new BrowserUseError('browser-use.invalid-input', `'tabAction: ${action}' names tab ${String(index)} but the session has ${String(pages.length)} tab(s)`, {
          stage: 'tabs',
          details: { index, tabs: pages.length },
        })
      }
      if (action === 'switch') {
        live.active = index
      } else {
        await page.close().catch(() => undefined)
        closed = index
        if (pages.length <= 1) {
          throw new BrowserUseError('browser-use.invalid-input', 'closing the LAST tab would leave the session without a page; close the session instead', {
            stage: 'tabs',
            details: { index },
          })
        }
        live.active = Math.min(live.active, live.context.pages().length - 1)
      }
    }
    await this.touch(live)
    const pages = live.context.pages()
    const tabs = await Promise.all(
      pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: index === live.active,
      })),
    )
    return { action: 'tabs', session: live.id, tabs, activeIndex: live.active, ...(closed === undefined ? {} : { closed }), ...(opened === undefined ? {} : { opened }) }
  }

  /** A bounded sleep and/or a bounded condition (never an unbounded poll loop). */
  async wait(session: string, request: BrowserWaitRequest, options: BrowserUseCallOptions): Promise<BrowserWaitAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const started = Date.now()
    const budget = request.timeoutMs ?? options.actionTimeoutMs
    const satisfied: string[] = []
    if (request.ms !== undefined) {
      await sleep(Math.min(requireNonNegativeInt(request.ms, 'ms', 600_000), budget))
      satisfied.push(`slept ${String(request.ms)}ms`)
    }
    if (request.ref !== undefined || request.selector !== undefined) {
      const state = request.state ?? 'visible'
      const target = await this.resolveTarget(live, page, request, 'wait')
      try {
        await target.locator.waitFor({ state, timeout: budget })
      } catch (error) {
        throw mapError(error, `wait for ${state}`, 'browser-use.timeout', { state })
      }
      satisfied.push(`element ${state}`)
    }
    if (request.urlContains !== undefined) {
      const fragment = requireText(request.urlContains, 'urlContains', 4_096)
      try {
        await page.waitForURL((url) => url.toString().includes(fragment), { timeout: budget })
      } catch (error) {
        throw mapError(error, `wait for url~${fragment}`, 'browser-use.timeout', { urlContains: fragment })
      }
      satisfied.push('urlContains')
    }
    if (request.text !== undefined) {
      const text = requireText(request.text, 'text', 100_000)
      try {
        await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: budget })
      } catch (error) {
        throw mapError(error, 'wait for text', 'browser-use.timeout', { text: firstLine(text) })
      }
      satisfied.push('text')
    }
    if (request.networkIdle === true) {
      try {
        await page.waitForLoadState('networkidle', { timeout: budget })
      } catch (error) {
        throw mapError(error, 'wait for networkIdle', 'browser-use.timeout', { networkIdle: true })
      }
      satisfied.push('networkIdle')
    }
    await this.touch(live)
    return { action: 'wait', session: live.id, url: page.url(), waitedMs: Date.now() - started, satisfied }
  }

  /** What the session SAW: the bounded network + download view (no polling loop). */
  async observe(session: string, request: BrowserObserveRequest, options: BrowserUseCallOptions): Promise<BrowserObserveAnswer> {
    const live = this.requireSession(session)
    const limit = Math.min(request.limit === undefined ? this.config.observeLimit : requirePositiveInt(request.limit, 'limit', 5_000), this.config.observeLimit)
    const filter = str(request.filter)
    const requests = (filter === undefined ? live.requests : live.requests.filter((record) => record.url.includes(filter))).slice(-limit)
    const downloads = live.downloads.slice(-limit)
    await this.touch(live)
    return {
      action: 'observe',
      session: live.id,
      requests: requests.map((record) => ({
        method: record.method,
        url: record.url,
        ...(record.status === undefined ? {} : { status: record.status }),
        ...(record.resourceType === undefined ? {} : { resourceType: record.resourceType }),
        ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
      })),
      downloads: downloads.map((record) => ({
        url: record.url,
        suggestedFilename: record.suggestedFilename,
        ...(record.path === undefined ? {} : { path: record.path }),
        ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
        ...(record.state === undefined ? {} : { state: record.state }),
      })),
      totalRequests: live.requests.length,
      totalDownloads: live.downloads.length,
    }
  }

  /**
   * The storage state of a session (the SAME file `web-session` uses). The answer
   * reports COUNTS and hosts, never a cookie value: a state file is a secret of
   * the session, and the seam never echoes secrets.
   */
  async state(session: string, request: BrowserStateRequest, options: BrowserUseCallOptions): Promise<BrowserStateAnswer> {
    const live = this.requireSession(session)
    const action = request.action === undefined ? 'save' : requireEnum(request.action, STATE_ACTIONS, 'stateAction', 'save')
    const file = str(request.path) ?? live.stateFile
    if (action === 'clear') {
      await fs.promises.rm(file, { force: true }).catch(() => undefined)
      return { action: 'state', session: live.id, stateAction: 'clear', stateFile: file }
    }
    if (action === 'read') {
      const raw = await fs.promises.readFile(file, 'utf8').catch(() => undefined)
      if (raw === undefined) {
        throw new BrowserUseError('browser-use.no-session', `session '${live.id}' has no storage state at '${file}' yet`, {
          stage: 'state',
          details: { stateFile: file },
        })
      }
      const parsed = parseState(raw)
      return {
        action: 'state',
        session: live.id,
        stateAction: 'read',
        stateFile: file,
        bytes: Buffer.byteLength(raw, 'utf8'),
        ...(parsed === undefined ? {} : { cookies: parsed.cookies, origins: parsed.origins }),
      }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
    try {
      await live.context.storageState({ path: file })
    } catch (error) {
      throw mapError(error, 'state: save', 'browser-use.provider-failed', { stateFile: file })
    }
    live.stateFile = file
    const raw = await fs.promises.readFile(file, 'utf8').catch(() => undefined)
    const parsed = raw === undefined ? undefined : parseState(raw)
    await this.touch(live)
    return {
      action: 'state',
      session: live.id,
      stateAction: 'save',
      stateFile: file,
      ...(raw === undefined ? {} : { bytes: Buffer.byteLength(raw, 'utf8') }),
      ...(parsed === undefined ? {} : { cookies: parsed.cookies, origins: parsed.origins }),
    }
  }

  // -------------------------------------------------------------------------
  // FRAMES and MOUSE: the two GENERIC doors that make this a real browser on a
  // page whose interesting half sits in a cross-origin frame.
  // -------------------------------------------------------------------------

  /** Enumerates the frame tree and selects/clears the session's default frame. */
  async frames(session: string, request: BrowserFramesRequest, options: BrowserUseCallOptions): Promise<BrowserFramesAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const action = request.frameAction === undefined ? 'list' : requireEnum(request.frameAction, FRAME_ACTIONS, 'frameAction', 'list')
    const started = Date.now()
    const maxFrames = Math.min(request.maxFrames ?? Math.max(options.maxSnapshotNodes, 40), 500)
    const cdp = await this.cdpFor(live, page)
    const { frames, bindings, mainFrameId } = await enumerateFrames(page, cdp, maxFrames)
    live.frameBindings = bindings
    if (action === 'clear') live.selectedFrameId = undefined
    let target: BrowserFrameInfo | undefined
    if (action === 'select') {
      const frame = await resolveFrameTarget(page, request.frame, bindings)
      const index = page.frames().indexOf(frame)
      const frameId = [...bindings.entries()].find(([, binding]) => binding.index === index)?.[0] ?? mainFrameId
      live.selectedFrameId = frameId
      target = frames.find((candidate) => candidate.frameId === frameId)
    }
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    return {
      action: 'frames',
      session: live.id,
      frameAction: action,
      url: page.url(),
      title: live.lastTitle,
      mainFrameId,
      frames,
      totalFrames: page.frames().length,
      selectedFrameId: live.selectedFrameId ?? mainFrameId,
      ...(target === undefined ? {} : { target }),
      durationMs: Date.now() - started,
    }
  }

  /** Drives the REAL mouse at COORDINATES (the door into a control no selector addresses). */
  async mouse(session: string, request: BrowserMouseRequest, options: BrowserUseCallOptions): Promise<BrowserMouseAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const startedAt = Date.now()
    const recorder = this.recorderOf(live, page)
    const navMark = recorder.mark()
    const responseMark = recorder.responseMark()
    const cdp = await this.cdpFor(live, page)
    const { bindings } = await enumerateFrames(page, cdp, 200)
    live.frameBindings = bindings
    let fallback: Frame | undefined
    if (request.frame !== undefined) fallback = await resolveFrameTarget(page, request.frame, bindings)
    else if (live.selectedFrameId !== undefined) {
      fallback = await resolveFrameTarget(page, { frameId: live.selectedFrameId }, bindings).catch(() => undefined)
    }
    let result: Awaited<ReturnType<typeof driveMouse>>
    try {
      result = await driveMouse(page, request, bindings, fallback)
    } catch (error) {
      if (isBrowserUseError(error)) throw error
      throw mapError(error, 'mouse', 'browser-use.provider-failed', { mouseAction: request.mouseAction ?? 'click' })
    }
    // A page that ANSWERS an input with a navigation is waited for (bounded): the
    // browser keeps driving, this side only listens and then reads the landing.
    const budget = options.navigationTimeoutMs
    const waitBudget = Math.min(typeof budget === 'number' && budget > 0 ? budget : 30_000, 30_000)
    const moved = await recorder.waitForNavigation(navMark, waitBudget)
    const navigationsAdded = recorder.browserSince(navMark).length
    let resultingLoad: BrowserRawLoad | undefined
    if (moved) {
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined)
      const landed = recorder
        .since(navMark)
        .filter((entry) => entry.response !== undefined)
        .at(-1)
      resultingLoad = await this.captureLoad(live, page, {
        recorder,
        responseMark,
        navMark,
        startedAt: Date.now(),
        // The landing response is the one the ENGINE recorded for the navigation
        // the PAGE performed; without it the transport could report only the URL,
        // so the raw status and headers of the landing load would be missing.
        response: landed?.response ?? null,
      })
    }
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    return {
      action: 'mouse',
      session: live.id,
      mouseAction: result.mouseAction,
      x: Math.round(result.x),
      y: Math.round(result.y),
      ...(result.toX === undefined ? {} : { toX: Math.round(result.toX) }),
      ...(result.toY === undefined ? {} : { toY: Math.round(result.toY) }),
      relativeTo: result.relativeTo,
      button: result.button,
      ...(result.frameId === undefined ? {} : { frameId: result.frameId }),
      navigationsAdded,
      ...(resultingLoad === undefined ? {} : { resultingLoad }),
      url: page.url(),
      title: live.lastTitle,
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * The raw-transcript recorder of the page a call is driving. One recorder per
   * PAGE (a session switches tabs), attached lazily and detached with the
   * session, so no listener ever outlives its context.
   */
  private recorderOf(live: LiveSession, page: Page): LoadRecorder {
    const existing = live.recorder
    if (existing !== undefined && existing.page === page) return existing
    existing?.dispose()
    const recorder = new LoadRecorder(page, Math.max(50, this.config.observeLimit))
    recorder.attach()
    live.recorder = recorder
    live.disposers.push(() => recorder.dispose())
    return recorder
  }

  /**
   * Captures ONE raw load: the transport facts, the document, the resources, the
   * cookies the load stored and the BROWSER's frame tree (never the page DOM).
   */
  private async captureLoad(
    live: LiveSession,
    page: Page,
    input: {
      recorder: LoadRecorder
      responseMark: number
      navMark: number
      requestedUrl?: string
      startedAt: number
      response: Awaited<ReturnType<Page['goto']>>
    },
  ): Promise<BrowserRawLoad> {
    const cdp = await this.cdpFor(live, page).catch(() => undefined)
    const { frames, bindings } = await enumerateFrames(page, cdp, 200)
    live.frameBindings = bindings
    return await captureRawLoad(page, {
      ...(input.requestedUrl === undefined ? {} : { requestedUrl: input.requestedUrl }),
      ...(input.response === null ? {} : { response: input.response }),
      recorder: input.recorder,
      responseMark: input.responseMark,
      frames,
      framesOverflow: Math.max(0, page.frames().length - frames.length),
      navigations: input.recorder.since(input.navMark),
      startedAtMs: input.startedAt,
      excerptChars: 600,
    })
  }

  /** The observation envelope `navigate` and `mouse` answer with (raw facts only). */
  private observationOf(
    recorder: LoadRecorder,
    navMark: number,
    load: BrowserRawLoad,
    startedAt: number,
    actions: BrowserRawAction[],
  ): BrowserRawObservation {
    const navigations = recorder.since(navMark).map((navigation) => rawNavigation(navigation))
    return {
      load,
      navigations,
      browserInitiatedNavigations: navigations.filter((navigation) => navigation.kind === 'browser'),
      actions,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * Attaches the network + download observers of a session. They are bounded
   * ring buffers of the provider config and their detach functions are pushed
   * into the session disposers, so unloading the plugin removes them with the
   * context (requirement 7: no leaked listener, no leaked browser).
   */
  private observeSession(session: LiveSession): void {
    const limit = this.config.observeLimit
    const push = <T>(list: T[], item: T): void => {
      list.push(item)
      if (list.length > limit) list.splice(0, list.length - limit)
    }
    const context = session.context
    const onResponse = (response: Response): void => {
      try {
        const request = response.request()
        const contentType = response.headers()['content-type']
        const record: RequestRecord = { method: request.method(), url: request.url(), status: response.status() }
        const resourceType = request.resourceType()
        if (typeof resourceType === 'string') record.resourceType = resourceType
        if (typeof contentType === 'string') record.contentType = contentType.split(';')[0]?.trim() ?? contentType
        push(session.requests, record)
      } catch {
        // A closed context is not an observation failure.
      }
    }
    const onDownload = (download: Download): void => {
      const record: DownloadRecord = { url: download.url(), suggestedFilename: download.suggestedFilename(), state: 'started' }
      push(session.downloads, record)
      void download
        .path()
        .then((location) => {
          if (typeof location === 'string') record.path = location
          record.state = 'finished'
        })
        .catch(() => {
          record.state = 'failed'
        })
    }
    context.on('response', onResponse)
    context.on('download', onDownload)
    session.disposers.push(() => {
      context.off('response', onResponse)
      context.off('download', onDownload)
    })
  }

}

// ---------------------------------------------------------------------------
// Module helpers + the plugin entrypoint.
// ---------------------------------------------------------------------------

/** A bounded sleep (the `wait` action). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** The `screenshot` formats this provider writes. */
const SCREENSHOT_FORMATS = ['png', 'jpeg'] as const

/** The subset of playwright's screenshot options this provider sets. */
interface ShotOptions {
  path: string
  type: 'png' | 'jpeg'
  fullPage: boolean
  quality?: number
}

/** The `state` actions of the contract. */
const STATE_ACTIONS: readonly string[] = ['save', 'read', 'clear']

/** The credentials service as THIS provider uses it (structural: no import). */
interface CredentialsLike {
  resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined>
}

/** The cookie count and the localStorage ORIGINS of a state file (never a value). */
function parseState(raw: string): { cookies: number; origins: string[] } | undefined {
  try {
    const parsed = JSON.parse(raw) as { cookies?: unknown; origins?: unknown }
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0
    const origins = Array.isArray(parsed.origins)
      ? parsed.origins
          .map((origin) => (isRecord(origin) && typeof origin.origin === 'string' ? origin.origin : undefined))
          .filter((origin): origin is string => origin !== undefined)
      : []
    return { cookies, origins }
  } catch {
    return undefined
  }
}

/** The `general-service@1` surface this provider uses to START its browser service. */
export interface GeneralServiceLike {
  create(config: { type: string; params: Record<string, unknown> }): {
    call(input: string, options?: { timeoutMs?: number }): Promise<{
      output?: string
      code?: number
      stderr?: string
      durationMs?: number
    }>
  }
}

/** What a browser-service start attempt did (reported in results and errors). */
export interface BrowserServiceStartRecord {
  /** True when a command was actually run through the general-service seam. */
  attempted: boolean
  /** Why the start was not attempted (when `attempted` is false). */
  reason?: string
  /** The start command. */
  command?: string
  /** The transport type of the instance the command ran through. */
  type?: string
  /** The exit code the command answered. */
  code?: number
  /** The tail of the command output. */
  output?: string
  /** The tail of the command stderr (why a start FAILED is usually here). */
  stderr?: string
  /** The pre-start connect failure, for the report. */
  cause?: string
  /** How long the endpoint was awaited after a successful start. */
  waitedMs?: number
  /** True when the endpoint answered after the start. */
  connected?: boolean
}

/** The `general-service@1` service of a context, when the deployment loaded one. */
function generalServiceOf(target: ServiceContext): GeneralServiceLike | undefined {
  const candidate = serviceOf(target, GENERAL_SERVICE)
  if (typeof candidate !== 'object' || candidate === null) return undefined
  return typeof (candidate as GeneralServiceLike).create === 'function' ? (candidate as GeneralServiceLike) : undefined
}

/** Builds the provider from a config row (the tests and `apply` use this). */
export function createPlaywrightProvider(
  config: BrowserUsePlaywrightConfig = {},
  credentials?: CredentialsLike,
  generalService?: GeneralServiceLike | (() => GeneralServiceLike | undefined),
): PlaywrightProvider {
  return new PlaywrightProvider(config, credentials, generalService)
}

/**
 * Registers the playwright provider with the `browser-use@1` service host.
 *
 * The dependency is declared with `ctx.inject`, so this plugin may be applied
 * BEFORE the host (cordis applies it as soon as the service appears) and is
 * INERT in a deployment without one (no host: nothing to register on).
 */
export function apply(ctx: PluginContext, config: BrowserUsePlaywrightConfig = {}): void {
  // The provider spawns a browser process: the execution policy must be declared.
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [BROWSER_USE] })
  const attach = (target: ServiceContext): void => {
    const service = browserUseOf(target)
    if (service === undefined) return
    const credentials = credentialsOf(target) as unknown as CredentialsLike | undefined
    // LAZY on purpose: `general-service-impl` may be loaded AFTER this plugin,
    // and a service resolved here (at registration) would be undefined forever.
    const generalService = (): GeneralServiceLike | undefined =>
      generalServiceOf(ctx as unknown as ServiceContext) ?? generalServiceOf(target)
    const provider = createPlaywrightProvider(config, credentials, generalService)
    const unregister = service.register(provider)
    ctx.effect?.(() => () => {
      unregister()
      void provider.dispose()
    })
    // Report the REAL state of the deployment once, at load time: the provider
    // stays registered (so a caller gets the typed `no-browser` error and the
    // exact requirement) and never pretends a browser exists.
    const resolved = resolveProviderConfig(config)
    const binary = browserBinary(resolved)
    if (!binary.found || !playwrightCoreAvailable()) {
      ctx.logger?.warn?.(
        `browser-use-playwright: no browser is usable yet (${browserRequirement(resolved)}); every 'browser open' will fail with the typed browser-use.no-browser error until it is installed (config row: plugins.browser-use-playwright)`,
        'browser-use-playwright',
      )
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject([BROWSER_USE], (injected) => attach(injected))
}

export default { name, inject: [], apply }


/**
 * The endpoint ACTUALLY dialled for `browserService.endpoint` / `wsEndpoint`.
 *
 * A deployment names the browser SERVICE by its DNS name (`http://browser:9222`,
 * a compose service on the shared network), but chromium's DevTools server
 * REJECTS any request whose `Host` header is neither an IP address nor
 * `localhost` - its DNS-rebinding guard:
 *
 *   $ curl -sS http://browser:9222/json/version
 *   Host header is specified and is not an IP address or localhost.
 *
 * The browser-service image is a plain TCP forwarder (`browser/cdp-forward.js`),
 * so it passes that Host header through untouched and the attach would die with
 * a protocol error that names nothing. Chromium also BUILDS the
 * `webSocketDebuggerUrl` from the Host header, so rewriting the NAME to its
 * ADDRESS fixes both the `/json/version` probe and the websocket that follows.
 *
 * The CONFIGURED string stays the one reported in results and typed errors; only
 * the dialled URL is resolved. A name that does not resolve is returned
 * unchanged, so the caller fails with the typed
 * `browser-use.endpoint-unreachable` naming it, never with a silent local launch.
 */
export async function connectTarget(
  endpoint: string,
  resolve: (name: string) => Promise<string | undefined> = async (name) =>
    dns.promises.lookup(name).then(
      (answer) => answer.address,
      () => undefined,
    ),
): Promise<string> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return endpoint
  }
  const name = url.hostname.replace(/^\[|\]$/g, '')
  if (name === 'localhost' || net.isIP(name) !== 0) return endpoint
  const address = await resolve(name)
  if (address === undefined) return endpoint
  const host = net.isIP(address) === 6 ? `[${address}]` : address
  const port = url.port.length === 0 ? '' : `:${url.port}`
  const path = url.pathname === '/' ? '' : url.pathname
  return `${url.protocol}//${host}${port}${path}${url.search}`
}
