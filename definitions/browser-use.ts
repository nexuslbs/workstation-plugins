// definitions/browser-use.ts - the `browser-use@1` capability: the CONTROLLED
// side of a real browser.
//
// WHY THIS MODULE EXISTS: workbench can READ a page (`web-page`) and drive a
// SESSION-ORIENTED, site-configured browser (`web-session`), but it had no
// DECLARED seam an agent can drive a browser through: navigate, inspect the DOM
// as a compact view with STABLE element refs, interact (click/type/select/
// hover/scroll/press/upload), evaluate JS, extract readable text/markdown,
// screenshot, manage tabs, reuse storage state and observe network/downloads.
// That is the gap of the thread-2535 list (item "browser-use"; operator
// telegram thread 2543: "computer-use . browser-use"), and this module is the
// CONTRACT of that capability.
//
//        Provider plugins  ->  Definition  <-  Consumer
//   core/browser-use-playwright                      plugins/browser-use-tools
//   (a future stub/cdp/... provider)                 any other caller of
//            \        /                              `ctx['browser-use']`
//        core/browser-use-impl (SERVICE HOST: registry + selection + bounds)
//
// SHAPE: modelled on the DeepSeek harness `browser-use` group (MIT, packages/
// browser-use/*): a provider REGISTRY where a deployment enables ONE browser
// backend at a time, registration owned by the provider, availability decided by
// a CHEAP LOCAL check (never a probe that needs a live page), and a provider
// that reports what it can really do. See THIRD_PARTY.md for the MIT notice.
//
// THE SNAPSHOT + REF MODEL (the DSH-style contract this seam adopts): a
// `snapshot` answers a COMPACT, STABLE view of the page - one entry per
// actionable/inspectable element carrying a SHORT ref (`e12`). The ref is what
// the caller acts on, so `snapshot` -> `act { ref }` ROUND-TRIPS across calls
// (requirement 4). A ref the provider can no longer resolve is a typed
// `browser-use.stale-ref` error, never a silent wrong click.
//
// ONE DELIBERATE DIFFERENCE from DSH: DSH's providers are MCP servers (one
// client per agent/session, owned browser state, no common operation interface).
// This seam instead declares ONE typed operation interface, because workbench is
// agent-AGNOSTIC: the consumer tools and any HTTP caller talk to the same
// contract, the deployment picks the backend by config, and the reasoning loop
// stays outside (operator: "agent-specific stuff are not needed ... omniagent
// should have that").
//
// HONESTY (non-negotiable, requirement 3): a deployment without a browser MUST
// fail with the typed `browser-use.no-browser` error naming the exact
// requirement (`playwright-core` + the chromium binary, `executablePath` or
// `PLAYWRIGHT_BROWSERS_PATH`) - there is no silent fallback to a non-browser
// fetch pretending to be a browser, and every answer carries the provider and
// the ENGINE that produced it.
//
// SANDBOX-AWARENESS (extension point ONLY, requirement 6): a `sandbox@1`
// provider, when the deployment has one, is consulted BEFORE a call that would
// reach the network (`browserUseSandbox(ctx)` below). Nothing here imports or
// requires that seam: a deployment without it behaves exactly as documented.

import os from 'node:os'
import path from 'node:path'

import {
  ServiceError,
  isRecord,
  positiveInt,
  serviceOf,
  str,
  type ServiceContext,
  type ServiceErrorCode,
} from './support.ts'

/** The capability id. */
export const BROWSER_USE = 'browser-use'
/** The contract version of this Definition. */
export const BROWSER_USE_VERSION = 1
/** `browser-use@1`, the string a manifest and a policy name. */
export const BROWSER_USE_CONTRACT = `${BROWSER_USE}@${BROWSER_USE_VERSION}`
/** The config row an operator edits to pick a provider (named by every error). */
export const BROWSER_USE_CONFIG_ROW = 'config.yml -> plugins.browser-use-impl: { provider: <provider id> }'
/** The name of the single agent-facing tool of this capability. */
export const BROWSER_USE_TOOL_NAME = 'browser'
/** Default `page.goto` budget of one navigation. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
/** Default budget of ONE interaction (click/type/wait-for). */
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000
/** Default budget of one whole call once it holds a session. */
export const DEFAULT_SESSION_TIMEOUT_MS = 60_000
/** How many sessions may be live at once when the config names none. */
export const DEFAULT_MAX_SESSIONS = 4
/** How many snapshot nodes one answer may carry when the config names none. */
export const DEFAULT_MAX_SNAPSHOT_NODES = 120
/** Default character cap of an extracted body. */
export const DEFAULT_MAX_TEXT_CHARS = 20_000
/** Hard character cap a caller can never exceed (the seam's own ceiling). */
export const HARD_MAX_TEXT_CHARS = 200_000
/** Byte cap of ONE screenshot file that reaches the caller. */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024
/**
 * Where a screenshot is written when the provider config names no directory.
 * ABSOLUTE on purpose (defect D1 of thread 2577): the answer of `screenshot` is
 * a PATH a caller must be able to READ back, and that caller (omniagent) lives
 * in another container/filesystem namespace than the core. A relative default
 * resolves against whatever CWD the core was started in, so the path is either
 * unreadable for the caller or unreadable at all (ENOENT).
 */
export const DEFAULT_SCREENSHOT_DIR = path.join(os.tmpdir(), 'workbench-browser-use')
/** Where storage-state files live when the config names no directory. */
export const DEFAULT_STORAGE_DIR = path.join(DEFAULT_SCREENSHOT_DIR, 'state')
/** The `waitUntil` strategies `navigate` accepts. */
export const WAIT_UNTIL = ['commit', 'domcontentloaded', 'load', 'networkidle'] as const
/** One navigation wait strategy. */
export type WaitUntil = (typeof WAIT_UNTIL)[number]
/** The image formats a screenshot may be encoded in. */
export const SCREENSHOT_FORMATS = ['png', 'jpeg'] as const
/** One screenshot encoding. */
export type ScreenshotFormat = (typeof SCREENSHOT_FORMATS)[number]
/** What `act` drives (the closed vocabulary of the contract). */
export const ACT_KINDS = [
  'click',
  'type',
  'fill',
  'select',
  'hover',
  'scroll',
  'press',
  'upload',
  'check',
  'focus',
  'waitFor',
  'back',
  'forward',
  'reload',
] as const
/** One `act` kind. */
export type ActKind = (typeof ACT_KINDS)[number]
/** The `act` kinds that need a target (a ref or a selector). */
export const TARGETED_ACT_KINDS: readonly ActKind[] = ['click', 'type', 'fill', 'select', 'hover', 'press', 'upload', 'check', 'focus']
/** The `waitFor` states (playwright vocabulary). */
export const WAIT_STATES = ['visible', 'hidden', 'attached', 'detached'] as const
/** One `waitFor` state. */
export type WaitState = (typeof WAIT_STATES)[number]
/** What `tabs` asks for. */
export const TAB_ACTIONS = ['list', 'new', 'switch', 'close'] as const
/** One tab action. */
export type TabAction = (typeof TAB_ACTIONS)[number]
/** What `extract` reads. */
export const EXTRACT_MODES = ['text', 'markdown', 'html', 'table', 'attributes', 'links', 'json'] as const
/** One extract mode. */
export type ExtractMode = (typeof EXTRACT_MODES)[number]
/** The scroll axes of the contract. */
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const
/** One scroll direction. */
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number]
/** How a session's storage state is handled at `open`. */
export const STATE_MODES = ['reuse', 'fresh', 'inline'] as const
/** One storage-state mode. */
export type StateMode = (typeof STATE_MODES)[number]

// ---------------------------------------------------------------------------
// Frames and mouse.
//
// These two vocabularies exist because the interesting half of a real page
// often lives in a CROSS-ORIGIN iframe (an embedded payment form, a
// third-party editor, an offered control): a CSS selector of the main document
// can never reach inside it, so a caller needs (1) the FRAME TREE with a target
// it can name and the geometry of every frame, and (2) MOUSE-LEVEL input at
// coordinates for the pixels no selector addresses. Neither one judges
// anything: they report what the browser saw and what the input did.
// ---------------------------------------------------------------------------

/** What `frames` does with the frame tree of the active page. */
export const FRAME_ACTIONS = ['list', 'select', 'clear'] as const
/** One `frames` action. */
export type FrameAction = (typeof FRAME_ACTIONS)[number]

/** The mouse gestures of the contract (`mouse`). */
export const MOUSE_ACTIONS = ['click', 'dblclick', 'move', 'down', 'up', 'hover', 'drag', 'wheel'] as const
/** One mouse gesture. */
export type MouseAction = (typeof MOUSE_ACTIONS)[number]

/** The mouse buttons of the contract. */
export const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const
/** One mouse button. */
export type MouseButton = (typeof MOUSE_BUTTONS)[number]

/**
 * Where a mouse coordinate is measured. `page` (default) is the MAIN frame
 * viewport, the SAME origin a `screenshot` uses, so a coordinate read off an
 * image is directly usable; `frame` is relative to the target frame's own box
 * (the provider adds the box offset before driving the real mouse).
 */
export const MOUSE_ORIGINS = ['page', 'frame'] as const
/** One coordinate origin. */
export type MouseOrigin = (typeof MOUSE_ORIGINS)[number]

/**
 * How a frame is named. ONE of these is enough; they are tried in the order
 * `frameId`, `selector`, `url`, `name`, `index`, and no target at all means the
 * MAIN frame (the page itself).
 */
export interface BrowserFrameTarget {
  /** The frame id `frames` reported (`cdp` when the engine gave one). */
  frameId?: string
  /** A selector of the `iframe`/`frame` ELEMENT in its PARENT document. */
  selector?: string
  /** The frame URL, matched exactly first and then as a substring. */
  url?: string
  /** The frame's `name` attribute. */
  name?: string
  /** The index in the frame tree, `0` being the main frame. */
  index?: number
}

/** One frame of the tree, as `frames` reports it. */
export interface BrowserFrameInfo {
  /** The frame id: the engine's CDP frameId when it could be read, else a positional id. */
  frameId: string
  /** How `frameId` was produced, so a caller knows what it can trust. */
  frameIdSource: 'cdp' | 'positional'
  /** The parent frame id (`undefined` for the main frame). */
  parentFrameId?: string
  url: string
  name?: string
  /** Distance from the main frame (`0` = main). */
  depth: number
  isMainFrame: boolean
  /** True when this frame's origin differs from the main frame's. */
  crossOrigin: boolean
  /** A selector for the frame element in the parent, when one can be built. */
  selector?: string
  /** The frame's origin, when its URL parses. */
  origin?: string
  /** True when this frame's origin equals the TOP frame's origin. */
  sameOriginAsTop: boolean
  /** The frame element's viewport box in MAIN-frame coordinates. */
  box?: BrowserFrameBox
  /** True when the frame element occupies a non-empty, on-screen box. */
  visible: boolean
  /** The focusable controls the frame's own document exposes (structural count). */
  focusables: BrowserFrameFocusables
}

/** A rectangle in MAIN-frame CSS pixels. */
export interface BrowserFrameBox {
  x: number
  y: number
  width: number
  height: number
}

/** The focusable elements a frame's OWN document reports (never a verdict). */
export interface BrowserFrameFocusables {
  /** The distinct tag names counted (`a`, `button`, `input`, ...). */
  tags: string[]
  /** How many focusable elements the frame's document exposes. */
  count: number
}

/** `frames`: list the tree, select a frame, or clear the selection. */
export interface BrowserFramesRequest {
  /** `list` (default), `select` or `clear`. */
  frameAction?: FrameAction
  /** Alias of `frameAction` (every other action of this capability names its verb `action`). */
  action?: FrameAction
  /** `select`: which frame becomes the session's default target. */
  frame?: BrowserFrameTarget
  /** Cap the reported frames (bounded by the seam). */
  maxFrames?: number
}

/** `frames` answers the tree plus which frame is the current target. */
export interface BrowserFramesAnswer {
  action: 'frames'
  session: string
  frameAction: FrameAction
  url: string
  title: string
  /** The MAIN frame id of the page. */
  mainFrameId: string
  frames: BrowserFrameInfo[]
  /** How many frames the page really has (before the cap). */
  totalFrames: number
  /** The frame the session now targets by default (the main frame when none). */
  selectedFrameId: string
  /** The target that was resolved, when one was. */
  target?: BrowserFrameInfo
  durationMs: number
}

/** `mouse`: drive the real mouse at COORDINATES (the way into a control no selector addresses). */
export interface BrowserMouseRequest {
  /** `click` (default), `dblclick`, `move`, `down`, `up`, `hover`, `drag`, `wheel`. */
  mouseAction?: MouseAction
  /** Alias of `mouseAction`. */
  action?: MouseAction
  /** The x of the point (or the drag START). */
  x?: number
  /** The y of the point (or the drag START). */
  y?: number
  /** `drag`: the destination x. */
  toX?: number
  /** `drag`: the destination y. */
  toY?: number
  /** `wheel`: horizontal delta in pixels. */
  deltaX?: number
  /** `wheel`: vertical delta in pixels. */
  deltaY?: number
  /** Which button to press (default `left`). */
  button?: MouseButton
  /** `click`/`dblclick`: how many clicks (default 1 / 2). */
  clickCount?: number
  /** `drag`: intermediate move steps (default 10). */
  steps?: number
  /** The origin of `x`/`y` (default `page`). */
  relativeTo?: MouseOrigin
  /** The frame `relativeTo: 'frame'` is measured in (default: the session target). */
  frame?: BrowserFrameTarget
}

/** `mouse` answers the coordinates that were really driven. */
export interface BrowserMouseAnswer {
  action: 'mouse'
  session: string
  mouseAction: MouseAction
  /** The resolved point in MAIN-frame coordinates (what the browser received). */
  x: number
  y: number
  toX?: number
  toY?: number
  relativeTo: MouseOrigin
  button: MouseButton
  /** The frame the input landed in, when it was addressed through one. */
  frameId?: string
  /**
   * How many BROWSER-INITIATED main-frame navigations this gesture produced. A
   * click the page answers with a navigation reports it here, so the caller
   * never has to guess whether the input did anything.
   */
  navigationsAdded: number
  /** The load the browser landed on because of this gesture, when it moved. */
  resultingLoad?: BrowserRawLoad
  url: string
  title: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// THE RAW OBSERVATION: what the browser really saw and did.
//
// This capability reports OBSERVABLES, never a verdict. A navigation (or an
// interaction that made the page navigate on its own) answers the transport
// facts (status, headers verbatim, redirects), what the document contained, the
// BROWSER's frame tree, every navigation the page initiated itself, and the
// actions this side drove. Deciding what any of it MEANS belongs to the caller:
// there is no keyword table, no classification and no vendor-specific path
// anywhere in this seam.
// ---------------------------------------------------------------------------

/** One cookie the response asked the browser to store (NEVER its value). */
export interface BrowserRawCookie {
  name: string
  domain?: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
  /** Expiry in seconds since the epoch (a session cookie has none). */
  expires?: number
}

/** The transport facts of ONE document load. */
export interface BrowserRawTransport {
  /** The URL the caller asked for. */
  requestedUrl: string
  /** The URL the document really ended on. */
  finalUrl: string
  /** The document response status, verbatim (absent when none was observed). */
  httpStatus?: number
  /** The document response status text, verbatim. */
  statusText?: string
  /** EVERY response header, verbatim (lower-cased names, as sent). */
  responseHeaders: Record<string, string>
  /** The redirect hops, in order. */
  redirects: string[]
}

/** What the loaded document contained (counts and a bounded excerpt). */
export interface BrowserRawDocument {
  title: string
  /** A bounded excerpt of the rendered text (the first `documentExcerptChars`). */
  bodyTextExcerpt: string
  /** `document.documentElement.outerHTML.length`. */
  htmlLength: number
  /** How many `form` elements the document has. */
  formCount: number
  /** `document.body.innerText.length`. */
  textLength: number
}

/** One main-frame navigation the browser performed. */
export interface BrowserRawNavigation {
  /** When the browser committed the navigation (ISO 8601). */
  at: string
  url: string
  /** `requested` when this side called `navigate`; `browser` when the page did it. */
  kind: 'requested' | 'browser'
  /** The document response status of that navigation, when one was observed. */
  httpStatus?: number
  statusText?: string
}

/** One interaction this side drove. */
export interface BrowserRawAction {
  /** The action name (`mouse.click`, `act.click`, ...). */
  kind: string
  target?: BrowserRawActionTarget
  /** How many browser-initiated main-frame navigations this action produced. */
  navigationsAdded: number
  /** The load the browser landed on because of this action, when it moved. */
  resultingLoad?: BrowserRawLoad
}

/** What an action was aimed at. */
export interface BrowserRawActionTarget {
  /** The frame the input landed in, when it was addressed through one. */
  frameId?: string
  /** The frame's URL. */
  frameUrl?: string
  /** The MAIN-frame point the real pointer was driven to. */
  point?: { x: number; y: number }
  /** The selector, when the action was selector-based. */
  selector?: string
}

/** The resources observed while ONE document was loading. */
export interface BrowserRawResources {
  total: number
  /** The URLs that came back with a status >= 400 (no verdict, just the facts). */
  failed: string[]
}

/** One raw load: the transport, the document and what it pulled in. */
export interface BrowserRawLoad {
  transport: BrowserRawTransport
  document: BrowserRawDocument
  resources: BrowserRawResources
  /** The cookies this load caused the browser to store (names + attributes only). */
  cookiesSet: BrowserRawCookie[]
  /** How long the load took, measured on this side. */
  timing: { startedAt: string; endedAt: string; durationMs: number }
  /** The navigations the browser performed (never the caller's own request). */
  browserInitiatedNavigations: BrowserRawNavigation[]
  /** The full frame tree of the loaded document (cross-origin frames included). */
  frames: BrowserFrameInfo[]
  /** A screenshot of the landed page, when one was taken. */
  screenshot?: { path: string; width: number; height: number }
}

/**
 * WHAT A CALL OBSERVED. `load` is the document the call ended on;
 * `navigations` is every main-frame navigation seen while the call ran, with the
 * browser's own ones called out. Both the navigation the caller asked for and the
 * one the browser performed itself are reported: an interaction that the page
 * answers with a navigation is exactly the case a caller must be able to see.
 */
export interface BrowserRawObservation {
  load: BrowserRawLoad
  navigations: BrowserRawNavigation[]
  browserInitiatedNavigations: BrowserRawNavigation[]
  /** Every interaction this side drove while the call ran. */
  actions: BrowserRawAction[]
  startedAt: string
  endedAt: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// Errors. Every failure of this capability is a `BrowserUseError` (a
// `ServiceError` subclass) whose `reason` is machine-branchable and whose
// `details` name the missing half or the config row to touch.
// ---------------------------------------------------------------------------

/** The reasons a call of this capability can fail (branch on `reason`). */
export type BrowserUseErrorReason =
  /** The caller passed something the contract cannot use (bad ref, empty value, ...). */
  | 'browser-use.invalid-input'
  /** No `browser-use@1` provider plugin is loaded at all. */
  | 'browser-use.missing-service'
  /** No provider could be selected: a CONFIG GAP (nothing registered/configured). */
  | 'browser-use.no-provider'
  /** The caller named a provider id that is not registered. */
  | 'browser-use.unknown-provider'
  /** No provider was named and several are usable: pick one explicitly. */
  | 'browser-use.ambiguous'
  /** Two providers tried to register the same id. */
  | 'browser-use.duplicate-provider'
  /** The selected provider exists but cannot run (running outside a container, ...). */
  | 'browser-use.provider-unavailable'
  /** NO BROWSER IS INSTALLED / launchable: the exact prerequisite is named. */
  | 'browser-use.no-browser'
  /**
   * A `wsEndpoint`/`cdpEndpoint` is configured but nothing answers there. The
   * provider NEVER falls back to a local launch and never to an HTTP fetch:
   * the caller gets this reason with the endpoint that was tried.
   */
  | 'browser-use.endpoint-unreachable'
  /** No session is open (and none was named), so there is nothing to drive. */
  | 'browser-use.no-session'
  /** The named session id is not live (closed, evicted, or never opened). */
  | 'browser-use.unknown-session'
  /** The session limit is reached and no session can be evicted. */
  | 'browser-use.session-limit'
  /** The navigation itself failed (DNS, TLS, connection, HTTP error). */
  | 'browser-use.navigation-failed'
  /** The page answered a 4xx/5xx where the caller asked for a page. */
  | 'browser-use.http-status'
  /** The selector/ref matched nothing within its budget. */
  | 'browser-use.selector-not-found'
  /** The ref the caller passed belongs to an OLDER snapshot and no longer resolves. */
  | 'browser-use.stale-ref'
  /** The javascript expression threw or answered something unserializable. */
  | 'browser-use.evaluation-failed'
  /** The call did not finish within its deadline. */
  | 'browser-use.timeout'
  /** The screenshot exceeds the byte cap of the seam (`details.bytes`, `.maxBytes`). */
  | 'browser-use.oversized'
  /** The provider does not implement this action at all (the exact half is named). */
  | 'browser-use.not-implemented'
  /** A driver answered something this contract cannot parse. */
  | 'browser-use.malformed-output'
  /** The `sandbox@1` policy refused the call. */
  | 'browser-use.sandbox-denied'
  /** The provider failed for a reason it could not classify (its message is carried). */
  | 'browser-use.provider-failed'

export interface BrowserUseErrorOptions {
  stage?: string
  details?: Record<string, unknown>
  /** The `ServiceError.code` reported alongside `reason` (default: derived). */
  code?: ServiceErrorCode
}

/**
 * The `ServiceError.code` a reason reports when the caller names none: `reason`
 * is the PRECISE discriminator a caller branches on, the code is the coarse
 * taxonomy of `definitions/support.ts` (which has no value for "no browser" or
 * "stale ref", so those map to the closest one it has).
 */
const REASON_CODES: Partial<Record<BrowserUseErrorReason, ServiceErrorCode>> = {
  'browser-use.invalid-input': 'invalid-input',
  'browser-use.missing-service': 'missing-service',
  'browser-use.no-provider': 'not-configured',
  'browser-use.unknown-provider': 'invalid-config',
  'browser-use.ambiguous': 'not-configured',
  'browser-use.duplicate-provider': 'invalid-config',
  'browser-use.provider-unavailable': 'unsupported-provider',
  'browser-use.no-browser': 'unreachable',
  'browser-use.endpoint-unreachable': 'unreachable',
  'browser-use.no-session': 'not-configured',
  'browser-use.unknown-session': 'invalid-input',
  'browser-use.session-limit': 'not-configured',
  'browser-use.navigation-failed': 'unreachable',
  'browser-use.http-status': 'unreachable',
  'browser-use.selector-not-found': 'unsupported',
  'browser-use.stale-ref': 'invalid-input',
  'browser-use.evaluation-failed': 'malformed-output',
  'browser-use.timeout': 'timeout',
  'browser-use.oversized': 'unsupported',
  'browser-use.not-implemented': 'unsupported',
  'browser-use.malformed-output': 'malformed-output',
  'browser-use.sandbox-denied': 'unsupported',
  'browser-use.provider-failed': 'non-zero-exit',
}

/** The one error shape this capability throws. */
export class BrowserUseError extends ServiceError {
  readonly reason: BrowserUseErrorReason

  constructor(reason: BrowserUseErrorReason, message: string, options: BrowserUseErrorOptions = {}) {
    super(options.code ?? REASON_CODES[reason] ?? 'invalid-input', message, {
      stage: options.stage ?? 'browser-use',
      details: options.details ?? {},
    })
    this.name = 'BrowserUseError'
    this.reason = reason
  }

  /** A JSON-safe view (what a tool answers, what a log line carries). */
  override toJSON(): {
    error: string
    code: ServiceErrorCode
    stage: string
    reason: BrowserUseErrorReason
    details: Record<string, unknown>
  } {
    return { error: this.message, code: this.code, stage: this.stage, reason: this.reason, details: this.details }
  }
}

/** True when the value is a failure of THIS capability (and not of another one). */
export function isBrowserUseError(value: unknown): value is BrowserUseError {
  if (value instanceof BrowserUseError) return true
  // DUCK-TYPED on purpose: this definition module can be instantiated more than
  // once (a path source and a git source of this repository), and a caller must
  // still recognise the failure envelope of the other instance.
  if (value === null || typeof value !== 'object') return false
  const reason = (value as { reason?: unknown }).reason
  return typeof reason === 'string' && reason.startsWith('browser-use.')
}

/** The typed error a provider raises for an action it does not serve. */
export function notImplemented(what: string, details: Record<string, unknown> = {}): BrowserUseError {
  return new BrowserUseError(
    'browser-use.not-implemented',
    `the selected browser-use provider does not implement ${what}; the capability is declared but that half is missing`,
    { stage: 'provider', details: { action: what, ...details } },
  )
}

// ---------------------------------------------------------------------------
// The engine report: WHICH browser is really driven (requirement 3).
// ---------------------------------------------------------------------------

/** The browser engine a provider drives. */
export interface BrowserEngineInfo {
  /** The engine family, e.g. `chromium`. */
  engine: string
  /** The product version when the provider can tell, e.g. `140.0.7339.16`. */
  version?: string
  /** The binary actually launched, when the provider can tell. */
  executablePath?: string
  /** True when the browser runs without a window. */
  headless: boolean
  /** HOW the browser is provided: `playwright-core` + the deployment's chromium. */
  source: string
  /** True when the binary is present and launchable RIGHT NOW (a local check). */
  available: boolean
  /** When `available` is false: the exact prerequisite, never a vague sentence. */
  requirement?: string
}

/** What a provider says it can really do (the honesty surface of the seam). */
export interface BrowserProviderCapabilities {
  /** The provider id (stamped again by the host). */
  provider: string
  /** The engine report of this provider. */
  engine: BrowserEngineInfo
  /** The `act` kinds this provider serves. */
  actKinds: ActKind[]
  /** The `extract` modes this provider serves. */
  extractModes: ExtractMode[]
  /** True when `evaluate` is served. */
  evaluate: boolean
  /** True when `screenshot` is served. */
  screenshot: boolean
  /** True when tabs are managed. */
  tabs: boolean
  /** True when network/download observation is served. */
  observe: boolean
  /** True when storage state can be read/written. */
  storageState: boolean
  /** True when the frame tree can be enumerated and frames can be targeted. */
  frames?: boolean
  /** True when mouse-level input at coordinates is served. */
  mouse?: boolean
  /** True when a navigation answers the RAW observation set. */
  rawObservation?: boolean
  /** Everything the provider does NOT serve, so a caller sees the gaps. */
  unsupported: string[]
}

// ---------------------------------------------------------------------------
// The session vocabulary.
// ---------------------------------------------------------------------------

/** A viewport in CSS pixels. */
export interface BrowserViewport {
  width: number
  height: number
}

/** A per-request proxy (a VALUE password is resolved by the provider, never here). */
export interface BrowserProxy {
  server: string
  username?: string
  /** A CREDENTIAL NAME resolved through `ctx.credentials` at launch time. */
  credential?: string
}

/**
 * The session a caller opens. Every field is OPTIONAL: absent fields come from
 * the provider config, so a caller can open with `{}` and get the deployment's
 * defaults.
 */
export interface BrowserSessionSpec {
  /** The session id (default: the provider's `defaultSession`, else `default`). */
  session?: string
  /** Run headless (default from the config). */
  headless?: boolean
  /** The viewport (default from the config). */
  viewport?: BrowserViewport
  /** The user agent override. */
  userAgent?: string
  /** The BCP-47 locale, e.g. `en-US`. */
  locale?: string
  /** The IANA timezone, e.g. `Europe/Berlin`. */
  timezoneId?: string
  /** Per-session proxy (a `credential` NAME, never a value). */
  proxy?: BrowserProxy
  /**
   * How the session's storage state (cookies + localStorage) is seeded:
   * `reuse` (default) reads the session's state file when it exists, `fresh`
   * ignores it, `inline` uses `storageState` below verbatim.
   */
  stateMode?: StateMode
  /** An INLINE storage state (playwright shape) used by `stateMode: inline`. */
  storageState?: unknown
  /** Where the session state lives (default: `<storageStateDir>/<session>.json`). */
  storageStateFile?: string
  /** Download directory for this session (default: a per-session temp dir). */
  downloadDir?: string
  /** Extra chromium argv for this session (never a shell string). */
  args?: string[]
}

/** What a caller learns about a live session (never a credential, never a secret). */
export interface BrowserSessionInfo {
  /** The session id (the handle every later call uses). */
  id: string
  /** The provider that OWNS the session. */
  provider: string
  /** The page the session is currently on. */
  url: string
  title: string
  /** The engine really driven (requirement 3). */
  engine: BrowserEngineInfo
  /** True when the session holds a browser context right now. */
  live: boolean
  /** True when an existing storage-state file was loaded at open. */
  stateReused: boolean
  /** Where the session state is persisted (absent when the provider keeps none). */
  stateFile?: string
  /** How many pages/tabs the session holds. */
  tabs: number
  /** How many network requests the session observed so far. */
  requests: number
  /** How many downloads the session observed so far. */
  downloads: number
  /** When the session was opened (epoch ms). */
  openedAt: number
  /** When the session was last used (epoch ms). */
  lastUsedAt: number
  /**
   * Present when `open` had to START the configured browser service (its OWN
   * image, reached through the `general-service@1` seam) before it could attach:
   * what was run, through which transport, and what it answered. Absent when the
   * endpoint was already answering: the path taken is provable from the result,
   * never inferred from logs.
   */
  browserServiceStart?: {
    /** True when a command really ran through the general-service seam. */
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
}

// ---------------------------------------------------------------------------
// Requests and answers. One request type per action of the contract.
// ---------------------------------------------------------------------------

/** `navigate`: go to a URL. */
export interface BrowserNavigateRequest {
  url: string
  waitUntil?: WaitUntil
  /** Navigation budget in ms (default from the seam bounds). */
  timeoutMs?: number
  /** Accept an HTTP >= 400 answer instead of failing with `http-status`. */
  allowHttpError?: boolean
}

/**
 * `navigate` answers the RAW observation of the load it produced: the transport
 * facts of the document, the document itself, the cookies the load stored, the
 * BROWSER's frame tree, every navigation the page performed on its own, and the
 * actions this side drove. It carries no verdict - the caller reads the
 * observation and decides.
 *
 * `url`/`title`/`httpStatus` are conveniences over `load` (the final URL, the
 * document title and the document response status, VERBATIM); the full set
 * stays in `load`.
 */
export interface BrowserNavigateAnswer extends BrowserRawObservation {
  action: 'navigate'
  session: string
  url: string
  title: string
  /** The document response status, verbatim (absent when none was observed). */
  httpStatus?: number
  durationMs: number
}

/** `snapshot`: ask for the compact view of the page. */
export interface BrowserSnapshotRequest {
  /** Scope the snapshot to a selector (default: the whole page). */
  selector?: string
  /**
   * Include nodes no caller can act on (headings, plain text) as well as the
   * actionable ones (default true: the caller wants to READ then act).
   */
  includeText?: boolean
  /** Cap the nodes of THIS answer (bounded by the seam's `maxSnapshotNodes`). */
  maxNodes?: number
  /**
   * Read INSIDE a frame instead of the main document (default: the main frame).
   * This is what makes a CROSS-ORIGIN control readable at all: its DOM belongs
   * to another origin, so no selector of the main document can reach it.
   */
  frame?: BrowserFrameTarget
}

/**
 * One node of the snapshot. `ref` is the STABLE handle the caller acts on in a
 * later call (`act { ref: 'e12' }`); it is short on purpose (an agent passes it
 * around) and never a CSS selector the caller has to build.
 */
export interface BrowserSnapshotNode {
  /** The short ref, e.g. `e12` (round-trips into `act`/`extract`/`wait`). */
  ref: string
  /** The element tag, lower case (`button`, `input`, `a`, ...). */
  tag: string
  /** The ARIA role when the page exposes one. */
  role?: string
  /** The accessible name: label / text / placeholder / aria-label. */
  name?: string
  /** The element's own visible text, bounded. */
  text?: string
  /** The current value of a form control (never a password field). */
  value?: string
  /** The href of a link (absolute). */
  href?: string
  /** The input type (`text`, `password`-less: reported as `password` but no value). */
  inputType?: string
  /** True for a disabled control (the caller cannot click it). */
  disabled?: boolean
  /** True for a checked checkbox/radio. */
  checked?: boolean
  /**
   * The id of the FRAME this node lives in (`undefined` = the main frame).
   * `act`/`snapshot` accept it back through their `frame.frameId`.
   */
  frameId?: string
}

/** `snapshot` answers the view + the identity of the snapshot the refs belong to. */
export interface BrowserSnapshot {
  action: 'snapshot'
  session: string
  /** The snapshot id the refs belong to (a ref of an older id is `stale-ref`). */
  snapshotId: string
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  /** How many nodes the page really had (before the cap). */
  totalNodes: number
  /** True when the cap cut the node list. */
  truncated: boolean
  /** The cap that was applied. */
  maxNodes: number
  /** Serialized size of the answer in characters (the caller's cost signal). */
  chars: number
}

/** `act`: one interaction, on a ref or a selector, or none (back/forward/reload). */
export interface BrowserActRequest {
  kind: ActKind
  /** The snapshot ref to act on (preferred: it round-trips). */
  ref?: string
  /** A CSS/XPath/role selector, for a caller that has one of its own. */
  selector?: string
  /** `type`/`fill`: the text to write. `press`: the key. `select`: the value. */
  value?: string
  /** `select`: when true the value is treated as a LABEL, not a value. */
  byLabel?: boolean
  /** `press`: the key or chord, e.g. `Enter`, `Control+A`. */
  key?: string
  /** `upload`: the file paths handed to the file input. */
  files?: string[]
  /** `scroll`: the direction (default `down`). */
  direction?: ScrollDirection
  /** `scroll`: how many pixels (default: one viewport). */
  amount?: number
  /** `waitFor`: which state to wait for (default `visible`). */
  state?: WaitState
  /** `check`: set the checkbox/radio to this state (default true). */
  checked?: boolean
  /** Interaction budget in ms (default from the seam bounds). */
  timeoutMs?: number
  /** Let in-flight work settle after the interaction (default true). */
  settle?: boolean
  /** Answer a FRESH snapshot with the result (default false: refs go stale). */
  snapshot?: boolean
  /**
   * Act INSIDE a frame instead of the main document (default: the main frame).
   * A `ref` resolves within that frame, a `selector` is looked up THERE.
   */
  frame?: BrowserFrameTarget
}

/**
 * What the seam did about a ref that did not resolve any more. It is reported in
 * the `act` answer (and in the typed `stale-ref` details) so the caller can
 * PROVE which path was taken instead of trusting a claim: `recovered: true`
 * means the call re-snapshotted once, re-resolved the target by role+name and
 * the action succeeded on the FRESH ref (`to`); `recovered: false` means the
 * one retry was made and the target was still gone, so the error carries the
 * fresh refs.
 */
export interface BrowserRefRetry {
  /** Always true in a report: a retry report only exists when one was made. */
  attempted: boolean
  /** True when the retry resolved the target and the action then succeeded. */
  recovered: boolean
  /** The ref the caller passed (the stale one). */
  from: string
  /** The ref the retry resolved, when it is not `from`. */
  to?: string
  /** The snapshot the retry worked from (the FRESH one). */
  snapshotId?: string
  /** Why the first attempt failed, in one line. */
  reason: string
}

/** `act` answers what happened, on which page, and optionally a fresh snapshot. */
export interface BrowserActAnswer {
  action: 'act'
  kind: ActKind
  session: string
  /** The ref the call acted on, echoed (absent when the act had no target). */
  ref?: string
  /** The selector the call acted on, echoed. */
  selector?: string
  url: string
  title: string
  /** True when the target was resolved through the CURRENT snapshot's ref table. */
  resolved: boolean
  /** Present when a stale ref was retried (see {@link BrowserRefRetry}). */
  refRetry?: BrowserRefRetry
  durationMs: number
  /** The fresh snapshot, when the caller asked for one. */
  snapshot?: BrowserSnapshot
}

/** `evaluate`: run a JS expression in the page. */
export interface BrowserEvaluateRequest {
  /** The expression, evaluated in the page (an expression, never a module). */
  expression: string
  /** Arguments handed to the expression as a JSON array (`...args`). */
  args?: unknown[]
  /** Wait for the result when it is a promise (default true). */
  awaitPromise?: boolean
  /** Character cap of the serialized answer (default from the seam bounds). */
  maxChars?: number
}

/** `evaluate` answers a JSON-serializable value and its type. */
export interface BrowserEvaluateAnswer {
  action: 'evaluate'
  session: string
  url: string
  /** The JSON-safe value (a non-serializable one is reported as its string form). */
  value: unknown
  /** The JavaScript `typeof` of the result. */
  resultType: string
  /** True when `maxChars` cut the serialized value. */
  truncated: boolean
  /** Serialized size in characters. */
  chars: number
}

/** `extract`: read the page, or a part of it, in a caller-chosen shape. */
export interface BrowserExtractRequest {
  /** Extract INSIDE this frame (from `frames`), when the content is in an iframe. */
  frame?: BrowserFrameTarget
  mode?: ExtractMode
  /** Scope the extraction to a selector or a ref. */
  selector?: string
  ref?: string
  /** Cap the extracted text (bounded by the seam's hard cap). */
  maxChars?: number
  /** `attributes`: the attribute names to read (default all). */
  attributes?: string[]
  /** `table`: which table to read when the page has several (default the first). */
  index?: number
  /** `json`: a JSON path-ish expression handed to `evaluate` (advanced). */
  expression?: string
  /**
   * Consult the `web-recipe` store for this domain when it is loaded (default
   * true). A missing recipe never fails the call: it is reported as `used:false`.
   */
  useRecipe?: boolean
}

/** `extract` answers the payload plus how it was produced. */
export interface BrowserExtractAnswer {
  action: 'extract'
  session: string
  url: string
  title: string
  mode: ExtractMode
  /** The extracted payload (text/markdown/html), or the JSON rows for table/json. */
  text?: string
  rows?: unknown[]
  /** The elements read by `attributes`. */
  elements?: { tag: string; attrs: Record<string, string>; text: string }[]
  /** The links read by `links`. */
  links?: { text: string; href: string }[]
  chars: number
  truncated: boolean
  /** A human-readable note about the extraction (the recipe outcome the provider adds, ...). */
  note?: string
  /** The `web-recipe` outcome: whether a stored recipe shaped this call. */
  recipe?: { consulted: boolean; used: boolean; domain?: string; path?: string; note?: string }
}

/** `screenshot`: capture the page (or one element) into a FILE. */
export interface BrowserScreenshotRequest {
  /** Capture the whole scrollable page (default false: the viewport). */
  fullPage?: boolean
  /** Capture only this element. */
  selector?: string
  ref?: string
  format?: ScreenshotFormat
  /** JPEG quality 1..100 (ignored for png). */
  quality?: number
  /** Write the file HERE instead of the provider's screenshot directory. */
  path?: string
  /** A short label used in the file name. */
  label?: string
  /** Byte cap of this answer (bounded by the seam's cap). */
  maxBytes?: number
}

/** `screenshot` answers a PATH, never unbounded base64. */
export interface BrowserScreenshotAnswer {
  action: 'screenshot'
  session: string
  url: string
  /** The absolute path of the written image. */
  path: string
  format: ScreenshotFormat
  mime: string
  bytes: number
  width?: number
  height?: number
  fullPage: boolean
}

/** `tabs`: manage the pages of one session. */
export interface BrowserTabRequest {
  action?: TabAction
  /** `switch`/`close`: the tab index (0-based) as `list` reported it. */
  index?: number
  /** `new`: the URL to open in the new tab (default `about:blank`). */
  url?: string
  /** `new`: wait for the URL before answering (default true). */
  navigate?: boolean
  timeoutMs?: number
}

/** `tabs` answers the tab table and which one is active. */
export interface BrowserTabAnswer {
  action: 'tabs'
  session: string
  tabs: { index: number; url: string; title: string; active: boolean }[]
  activeIndex: number
  closed?: number
  opened?: number
}

/** `wait`: a bounded sleep and/or a condition. */
export interface BrowserWaitRequest {
  /** Wait for the element inside this frame (from `frames`). */
  frame?: BrowserFrameTarget
  /** Sleep this long (bounded by the seam's deadline). */
  ms?: number
  /** Wait for this element (ref or selector) to reach `state`. */
  ref?: string
  selector?: string
  state?: WaitState
  /** Wait until the URL contains this fragment. */
  urlContains?: string
  /** Wait until the page contains this text. */
  text?: string
  /** Wait until no network request is in flight (a bounded settle). */
  networkIdle?: boolean
  timeoutMs?: number
}

/** `wait` answers what was satisfied (and what was not). */
export interface BrowserWaitAnswer {
  action: 'wait'
  session: string
  url: string
  waitedMs: number
  satisfied: string[]
}

/** `observe`: the network + download view of a session (no polling loop). */
export interface BrowserObserveRequest {
  /** How many of the NEWEST requests to report (default from the config). */
  limit?: number
  /** Only requests whose URL contains this fragment. */
  filter?: string
}

/** `observe` answers what the session saw. */
export interface BrowserObserveAnswer {
  action: 'observe'
  session: string
  requests: { method: string; url: string; status?: number; resourceType?: string; contentType?: string }[]
  downloads: { url: string; suggestedFilename: string; path?: string; bytes?: number; state?: string }[]
  totalRequests: number
  totalDownloads: number
}

/** `state`: read/write the storage state of a session. */
export interface BrowserStateRequest {
  /** `save` (default) persists + answers the state, `read` answers it, `clear` drops it. */
  action?: 'save' | 'read' | 'clear'
  /** Write to THIS path instead of the session's state file. */
  path?: string
}

/** `state` answers where the state is (never a secret: cookies are the session's own). */
export interface BrowserStateAnswer {
  action: 'state'
  session: string
  stateAction: 'save' | 'read' | 'clear'
  stateFile?: string
  bytes?: number
  /** How many cookies the state carries (a count, never the values). */
  cookies?: number
  /** Origins the localStorage part covers (hosts only, no values). */
  origins?: string[]
}

// ---------------------------------------------------------------------------
// The provider contract.
// ---------------------------------------------------------------------------

/** Per-call bounds, resolved by the HOST and handed to the provider. */
export interface BrowserUseCallOptions {
  /** Wall-clock bound of the call. */
  timeoutMs: number
  /** Navigation budget. */
  navigationTimeoutMs: number
  /** Interaction budget. */
  actionTimeoutMs: number
  /** Cap of a snapshot node list. */
  maxSnapshotNodes: number
  /** Cap of extracted/answered text. */
  maxTextChars: number
  /** Cap of a screenshot file in bytes. */
  maxImageBytes: number
  /** Directory a screenshot without an explicit `path` is written to. */
  screenshotDir: string
  /** Directory storage-state files live in. */
  storageStateDir: string
  /** How many sessions may be live at once. */
  maxSessions: number
}

/** What a provider plugin must implement to be registered on this seam. */
export interface BrowserUseProvider {
  /** The provider id (`playwright`, `stub`, ...). */
  readonly id: string
  /** A CHEAP LOCAL check: can this provider drive a browser right now? */
  available(): boolean
  /** When `available()` is false: the exact prerequisite, in one sentence. */
  unavailableReason?(): string | undefined
  /** The engine report (requirement 3): which browser, which binary, available? */
  engine(): BrowserEngineInfo
  /** What this provider really serves. */
  capabilities(): BrowserProviderCapabilities
  openSession(spec: BrowserSessionSpec, options: BrowserUseCallOptions): Promise<BrowserSessionInfo>
  closeSession(session: string, options: BrowserUseCallOptions): Promise<BrowserSessionInfo>
  navigate(session: string, request: BrowserNavigateRequest, options: BrowserUseCallOptions): Promise<BrowserNavigateAnswer>
  snapshot(session: string, request: BrowserSnapshotRequest, options: BrowserUseCallOptions): Promise<BrowserSnapshot>
  act(session: string, request: BrowserActRequest, options: BrowserUseCallOptions): Promise<BrowserActAnswer>
  evaluate(session: string, request: BrowserEvaluateRequest, options: BrowserUseCallOptions): Promise<BrowserEvaluateAnswer>
  extract(session: string, request: BrowserExtractRequest, options: BrowserUseCallOptions): Promise<BrowserExtractAnswer>
  screenshot(session: string, request: BrowserScreenshotRequest, options: BrowserUseCallOptions): Promise<BrowserScreenshotAnswer>
  tabs(session: string, request: BrowserTabRequest, options: BrowserUseCallOptions): Promise<BrowserTabAnswer>
  wait(session: string, request: BrowserWaitRequest, options: BrowserUseCallOptions): Promise<BrowserWaitAnswer>
  observe(session: string, request: BrowserObserveRequest, options: BrowserUseCallOptions): Promise<BrowserObserveAnswer>
  state(session: string, request: BrowserStateRequest, options: BrowserUseCallOptions): Promise<BrowserStateAnswer>
  /**
   * The FRAME TREE of the active page plus frame targeting (optional half: a
   * provider that does not serve it is called with the typed `not-implemented`).
   */
  frames?(session: string, request: BrowserFramesRequest, options: BrowserUseCallOptions): Promise<BrowserFramesAnswer>
  /** Mouse-level input at coordinates (optional half, see above). */
  mouse?(session: string, request: BrowserMouseRequest, options: BrowserUseCallOptions): Promise<BrowserMouseAnswer>
  /** The live sessions of this provider (diagnostics; never a secret). */
  sessions(): BrowserSessionInfo[]
  /** Release every browser resource this provider owns (plugin unload). */
  dispose?(): Promise<void>
}

/** The `browser-use@1` service HOST (the seam a consumer talks to). */
export interface BrowserUseService {
  readonly contract: string
  /** The provider the last call was routed to (`''` before the first one). */
  readonly providerId: string
  /** Registers a backend; the returned disposer releases it. */
  register(provider: BrowserUseProvider): () => void
  /** The registered backends and which one is usable. */
  providers(): BrowserProviderInfo[]
  /** The selection policy in force (config + what it currently resolves to). */
  selection(): BrowserSelection
  /** The capability report of the selected provider (what it really serves). */
  capabilities(provider?: string): Promise<BrowserCapabilityReport>
  /** The live sessions of every provider, stamped with their owner. */
  sessions(): (BrowserSessionInfo & { owner: string })[]
  open(spec?: BrowserSessionSpec, provider?: string): Promise<BrowserSessionInfo>
  close(session: string, provider?: string): Promise<BrowserSessionInfo>
  navigate(session: string, request: BrowserNavigateRequest, provider?: string): Promise<BrowserNavigateAnswer>
  snapshot(session: string, request?: BrowserSnapshotRequest, provider?: string): Promise<BrowserSnapshot>
  act(session: string, request: BrowserActRequest, provider?: string): Promise<BrowserActAnswer>
  evaluate(session: string, request: BrowserEvaluateRequest, provider?: string): Promise<BrowserEvaluateAnswer>
  extract(session: string, request: BrowserExtractRequest, provider?: string): Promise<BrowserExtractAnswer>
  screenshot(session: string, request: BrowserScreenshotRequest, provider?: string): Promise<BrowserScreenshotAnswer>
  tabs(session: string, request: BrowserTabRequest, provider?: string): Promise<BrowserTabAnswer>
  wait(session: string, request: BrowserWaitRequest, provider?: string): Promise<BrowserWaitAnswer>
  observe(session: string, request: BrowserObserveRequest, provider?: string): Promise<BrowserObserveAnswer>
  state(session: string, request: BrowserStateRequest, provider?: string): Promise<BrowserStateAnswer>
  /**
   * The frame tree of the active page (`list`), or the frame this session then
   * targets by default (`select`/`clear`). A provider without the optional half
   * answers the typed `browser-use.not-implemented`.
   */
  frames(session: string, request?: BrowserFramesRequest, provider?: string): Promise<BrowserFramesAnswer>
  /**
   * Real mouse input at coordinates - the door into a cross-origin control that
   * offers no addressable element. `relativeTo: 'frame'` measures from the
   * target frame's OWN box, so a point read off the frame tree lands where the
   * caller means even when the frame is off-origin.
   */
  mouse(session: string, request: BrowserMouseRequest, provider?: string): Promise<BrowserMouseAnswer>
}

/** One registered backend, as the seam reports it. */
export interface BrowserProviderInfo {
  id: string
  /** True when the config names this provider as the default. */
  configured: boolean
  /** The cheap local availability check. */
  available: boolean
  /** Why it is not available, when it is not. */
  reason?: string
  /** The engine report, so an operator sees WHICH browser would run. */
  engine: BrowserEngineInfo
  /** How many sessions this provider owns right now. */
  sessions: number
}

/** The selection policy in force. */
export interface BrowserSelection {
  /** The configured default, when the config names one. */
  provider?: string
  fallback: string[]
  /** The provider the seam currently resolves to (absent when none is usable). */
  selected?: string
  /** Why no provider is usable (a typed sentence). */
  reason?: string
  configRow: string
}

/** The capability report of one provider, as `capabilities` answers it. */
export interface BrowserCapabilityReport {
  provider: string
  engine: BrowserEngineInfo
  capabilities: BrowserProviderCapabilities
  configRow: string
}

/** The provider row of this capability (`plugins.browser-use-impl`). */
export interface BrowserUseConfig {
  /** Default provider id. Absent: the single usable registered provider. */
  provider?: string
  /** Ordered provider ids tried when the default cannot run. */
  fallback?: string[]
  /** The session id a call uses when it names none (default `default`). */
  defaultSession?: string
  /** How many sessions may be live at once. */
  maxSessions?: number
  headless?: boolean
  viewport?: BrowserViewport
  userAgent?: string
  locale?: string
  timezoneId?: string
  proxy?: BrowserProxy
  /** Where storage-state files live. */
  storageStateDir?: string
  /** Where screenshots are written. */
  screenshotDir?: string
  /** Cap of a screenshot file in bytes. */
  maxImageBytes?: number
  /** Cap of a snapshot node list. */
  maxSnapshotNodes?: number
  /** Cap of extracted text. */
  maxTextChars?: number
  navigationTimeoutMs?: number
  actionTimeoutMs?: number
  /** Whole-call deadline. */
  timeoutMs?: number
  /** How many of the newest requests `observe` reports by default. */
  observeLimit?: number
  /** A chromium binary; absent: playwright resolves it. */
  executablePath?: string
  /** Extra chromium argv. */
  browserArgs?: string[]
}

// ---------------------------------------------------------------------------
// Validation helpers: a bad request field is a TYPED error, never a crash.
// ---------------------------------------------------------------------------

/** A positive integer or a typed error (never a silent coercion). */
export function requirePositiveInt(value: unknown, field: string, max = 3_600_000): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0 || number > max) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be an integer between 1 and ${max}`, {
      stage: 'request',
      details: { field, max, value: typeof value === 'number' || typeof value === 'string' ? value : String(value) },
    })
  }
  return number
}

/** An integer >= 0 or a typed error. */
export function requireNonNegativeInt(value: unknown, field: string, max = 3_600_000): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || number > max) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be an integer between 0 and ${max}`, {
      stage: 'request',
      details: { field, max },
    })
  }
  return number
}

/**
 * A non-empty string or a typed `invalid-input`. The value is TRIMMED: outer
 * whitespace is a transport artefact in every action of this seam (a selector, a
 * URL, a key chord), so a whitespace-only string is absent, not "a valid value".
 */
export function requireText(value: unknown, field: string, maxChars = 1_000_000): string {
  const raw = typeof value === 'string' ? value.trim() : undefined
  if (raw === undefined || raw.length === 0) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be a non-empty string`, {
      stage: 'request',
      details: { field },
    })
  }
  if (raw.length > maxChars) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' exceeds ${maxChars} characters`, {
      stage: 'request',
      details: { field, maxChars, chars: raw.length },
    })
  }
  return raw
}

/** One of `allowed`, or a typed error naming the vocabulary (case-insensitive). */
export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  const raw = str(value)?.toLowerCase()
  if (raw === undefined && fallback !== undefined) return fallback
  const match = (allowed as readonly string[]).find((option) => option.toLowerCase() === raw)
  if (match === undefined) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be one of ${allowed.join(' | ')}`, {
      stage: 'request',
      details: { field, allowed: [...allowed], value: raw ?? null },
    })
  }
  return match as T
}

/** The shape of a snapshot ref: `e` + digits (short, unique per snapshot). */
export const REF_PATTERN = /^e[0-9]{1,6}$/

/** A validated snapshot ref or a typed `invalid-input` naming the shape. */
export function requireRef(value: unknown, field = 'ref'): string {
  const raw = requireText(value, field, 32)
  if (!REF_PATTERN.test(raw)) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be a snapshot ref like 'e12' (from a \`snapshot\` answer)`, {
      stage: 'request',
      details: { field, value: raw },
    })
  }
  return raw
}

/** A normalized viewport (integers, strictly positive) or a typed error. */
export function normalizeViewport(value: unknown): BrowserViewport | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new BrowserUseError('browser-use.invalid-input', "'viewport' must be an object { width, height }", {
      stage: 'request',
      details: { field: 'viewport' },
    })
  }
  return {
    width: requirePositiveInt(value.width, 'viewport.width', 20_000),
    height: requirePositiveInt(value.height, 'viewport.height', 20_000),
  }
}

/**
 * A URL as this capability accepts it: absolute `http(s)` or `file` (a LOCAL
 * fixture is a first-class target of the seam: the end-to-end gate needs one and
 * a deployment may serve static pages itself). `about:blank` is allowed because
 * it is what a fresh tab starts on.
 */
export function requireUrl(value: unknown, field = 'url', maxChars = 8192): string {
  const raw = requireText(value, field, maxChars)
  if (raw === 'about:blank') return raw
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be an absolute URL (http, https, file or about:blank)`, {
      stage: 'request',
      details: { field, value: raw },
    })
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new BrowserUseError(
      'browser-use.invalid-input',
      `'${field}' must use http, https or file (got '${parsed.protocol}')`,
      { stage: 'request', details: { field, protocol: parsed.protocol } },
    )
  }
  return raw
}

/** A file-name-safe slug of a label (never empty). */
export function slugOf(value: string, fallback = 'page'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length === 0 ? fallback : slug
}

/** The `browser-use@1` service, when the deployment has one. */
export function browserUseOf(ctx: ServiceContext): BrowserUseService | undefined {
  return serviceOf<BrowserUseService>(ctx, BROWSER_USE)
}

/** The `browser-use@1` service, or a typed `missing-service` error naming it. */
export function requireBrowserUse(ctx: ServiceContext): BrowserUseService {
  const service = browserUseOf(ctx)
  if (service === undefined) {
    throw new BrowserUseError(
      'browser-use.missing-service',
      "no browser-use@1 provider is loaded: add a 'browser-use-impl' row to the plugins roster",
      { stage: 'lookup', details: { service: BROWSER_USE } },
    )
  }
  return service
}

/**
 * The SANDBOX handle of the deployment, when it has one (extension point ONLY,
 * requirement 6): the seam consults it before a call that reaches the network and
 * turns a DENY into `browser-use.sandbox-denied`. The shape is the structural
 * subset of `definitions/sandbox.ts` this capability needs - the seam never
 * imports that Definition, so a deployment without a sandbox provider is
 * completely unaffected.
 */
export interface BrowserUseSandboxLike {
  check(request: { resource: string; command?: { argv: readonly string[] } }): unknown
}

/** The `sandbox@1` service as THIS capability uses it, or undefined. */
export function browserUseSandbox(ctx: ServiceContext): BrowserUseSandboxLike | undefined {
  const service = serviceOf<BrowserUseSandboxLike>(ctx, 'sandbox')
  return service !== undefined && typeof service.check === 'function' ? service : undefined
}

/** The bounds of a call once the config was read (never a raw config value). */
export function resolveBrowserUseBounds(
  config: BrowserUseConfig = {},
  overrides: Partial<BrowserUseCallOptions> = {},
): BrowserUseCallOptions {
  return {
    timeoutMs: overrides.timeoutMs ?? positiveInt(config.timeoutMs, DEFAULT_SESSION_TIMEOUT_MS, 600_000),
    navigationTimeoutMs:
      overrides.navigationTimeoutMs ?? positiveInt(config.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, 600_000),
    actionTimeoutMs: overrides.actionTimeoutMs ?? positiveInt(config.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 600_000),
    maxSnapshotNodes: overrides.maxSnapshotNodes ?? positiveInt(config.maxSnapshotNodes, DEFAULT_MAX_SNAPSHOT_NODES, 5_000),
    maxTextChars: overrides.maxTextChars ?? positiveInt(config.maxTextChars, DEFAULT_MAX_TEXT_CHARS, HARD_MAX_TEXT_CHARS),
    maxImageBytes: overrides.maxImageBytes ?? positiveInt(config.maxImageBytes, DEFAULT_SCREENSHOT_MAX_BYTES, 64 * 1024 * 1024),
    screenshotDir: overrides.screenshotDir ?? str(config.screenshotDir) ?? DEFAULT_SCREENSHOT_DIR,
    storageStateDir: overrides.storageStateDir ?? str(config.storageStateDir) ?? DEFAULT_STORAGE_DIR,
    maxSessions: overrides.maxSessions ?? positiveInt(config.maxSessions, DEFAULT_MAX_SESSIONS, 64),
  }
}
