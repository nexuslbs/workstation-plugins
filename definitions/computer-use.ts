// definitions/computer-use.ts - the `computer-use@1` capability: the CONTROLLED
// side of a desktop/GUI session.
//
// WHY THIS MODULE EXISTS: workbench could reach a host (shell/docker/ssh) and
// drive a BROWSER (`web-session`), but it had no seam for controlling a GUI -
// screen, pointer, keyboard, windows, clipboard. That is the gap of the
// thread-2535 list (item "computer-use"; operator thread 2543: "computer-use ·
// browser-use"). This module is the CONTRACT of that capability: a provider
// plugin owns a real display (or a headless one it starts itself) and this
// Definition is what a consumer talks to.
//
//        Provider plugins  ->  Definition  <-  Consumer
//   core/computer-use-x11                            plugins/computer-use-tools
//   (a future stub/vnc/... provider)                 any other caller of
//            \        /                              `ctx['computer-use']`
//        core/computer-use-impl (SERVICE HOST: registry + selection + caps)
//
// SHAPE: modelled on the DeepSeek harness `computer-use` group (MIT,
// `packages/computer-use/*`): ONE capability (`computer use`), a PROVIDER
// REGISTRY where a deployment enables exactly ONE desktop driver, availability
// decided by a CHEAP LOCAL check (never a probe that needs the GUI to work), and
// a provider that reports what its driver can really do. See THIRD_PARTY.md for
// the MIT notice.
//
// ONE DELIBERATE DIFFERENCE: DSH's only shipped drivers are two experimental
// npm packages around an already installed `cua-driver` executable. This seam
// instead implements its reference provider (`computer-use-x11`) on the X11
// toolchain (Xvfb, xdotool, ImageMagick, xclip, wmctrl) because those are the
// binaries a container image can install with one `apt-get` and drive with NO
// model API and NO vendor package: the minimum a headless workbench needs.
//
// HONESTY (non-negotiable, requirement 3 of the task): an action the provider
// cannot serve MUST fail with a typed `computer-use.not-implemented` /
// `computer-use.no-display` error naming the missing half. There is no silent
// no-op and no fabricated answer anywhere in this seam: `capabilities()` is the
// single source of truth and every answer carries the provider that produced it.
//
// SANDBOX-AWARENESS (extension point ONLY, requirement 5): a `sandbox@1`
// provider, when the deployment has one, is consulted BEFORE a call that would
// touch the desktop (`computerUseSandbox(ctx)` below). Nothing here imports or
// requires that seam: a deployment without it behaves exactly as documented.

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
export const COMPUTER_USE = 'computer-use'
/** The contract version of this Definition. */
export const COMPUTER_USE_VERSION = 1
/** `computer-use@1`, the string a manifest and a policy name. */
export const COMPUTER_USE_CONTRACT = `${COMPUTER_USE}@${COMPUTER_USE_VERSION}`
/** The config row an operator edits to pick a provider (named by every error). */
export const COMPUTER_USE_CONFIG_ROW = 'config.yml -> plugins.computer-use-impl: { provider: <provider id> }'
/** The name of the single agent-facing tool of this capability. */
export const COMPUTER_USE_TOOL_NAME = 'computer'
/** Byte cap of ONE screenshot file that reaches the caller. */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024
/** Wall-clock bound of one call to the desktop. */
export const DEFAULT_COMPUTER_TIMEOUT_MS = 15_000
/** Where a screenshot is written when the provider config names no directory. */
export const DEFAULT_SCREENSHOT_DIR = 'workbench-computer-use'
/** The image formats a screenshot may be encoded in. */
export const SCREENSHOT_FORMATS = ['png', 'jpeg'] as const
/** One screenshot encoding. */
export type ScreenshotFormat = (typeof SCREENSHOT_FORMATS)[number]
/** The pointer buttons of the contract. */
export const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const
/** One pointer button. */
export type MouseButton = (typeof MOUSE_BUTTONS)[number]
/** The scroll axes of the contract. */
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const
/** One scroll direction. */
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number]
/** Which X selection a clipboard call reads or writes. */
export const CLIPBOARD_SELECTIONS = ['clipboard', 'primary'] as const
/** One clipboard selection. */
export type ClipboardSelection = (typeof CLIPBOARD_SELECTIONS)[number]
/** The action enum of the agent-facing tool (`computer <action>`). */
export const COMPUTER_ACTIONS = ['open', 'screen', 'screenshot', 'act', 'window', 'wait', 'close'] as const
/** One tool action. */
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number]
/** What `action: 'act'` drives (the input families of the contract). */
export const COMPUTER_INPUT_KINDS = [
  'move',
  'click',
  'drag',
  'scroll',
  'type',
  'key',
  'copy',
  'paste',
] as const
/** One `act` kind. */
export type ComputerInputKind = (typeof COMPUTER_INPUT_KINDS)[number]
/** What `action: 'window'` asks for. */
export const WINDOW_ACTIONS = ['list', 'focus', 'close', 'launch', 'wait'] as const
/** One window action. */
export type WindowAction = (typeof WINDOW_ACTIONS)[number]
/** How a provider reaches the display: the LOCAL host or a container/docker target. */
export const RUNNER_KINDS = ['local', 'docker'] as const
/** One runner kind. */
export type RunnerKind = (typeof RUNNER_KINDS)[number]
/** What kind of display a provider serves. */
export const DISPLAY_TARGETS = ['existing', 'xvfb'] as const
/** One display target. */
export type DisplayTarget = (typeof DISPLAY_TARGETS)[number]

// ---------------------------------------------------------------------------
// Errors. Every failure of this capability is a `ComputerUseError` (a
// `ServiceError` subclass) whose `reason` is machine-branchable and whose
// `details` name the missing half or the config row to touch.
// ---------------------------------------------------------------------------

/** The reasons a call of this capability can fail (branch on `reason`). */
export type ComputerUseErrorReason =
  /** The caller passed something the contract cannot use (bad id, empty text, ...). */
  | 'computer-use.invalid-input'
  /** No `computer-use@1` provider plugin is loaded at all. */
  | 'computer-use.missing-service'
  /** No provider could be selected: a CONFIG GAP (nothing registered/configured). */
  | 'computer-use.no-provider'
  /** The caller named a provider id that is not registered. */
  | 'computer-use.unknown-provider'
  /** No provider was named and several are usable: pick one explicitly. */
  | 'computer-use.ambiguous'
  /** Two providers tried to register the same id. */
  | 'computer-use.duplicate-provider'
  /** The selected provider exists but cannot run (display unreachable, off). */
  | 'computer-use.provider-unavailable'
  /** There is no display to talk to (DISPLAY unset, Xvfb gone, X socket refused). */
  | 'computer-use.no-display'
  /** The display exists but refuses this operation (permissions, X access). */
  | 'computer-use.not-permitted'
  /** The action needs a tool the target does not have (xdotool, import, ...). */
  | 'computer-use.missing-tool'
  /** The provider does not implement this action at all (the exact half is named). */
  | 'computer-use.not-implemented'
  /** The call did not finish within its deadline. */
  | 'computer-use.timeout'
  /** A command of the target failed (non-zero exit): its stderr is in `details`. */
  | 'computer-use.command-failed'
  /** A command answered something this contract cannot parse. */
  | 'computer-use.malformed-output'
  /** The screenshot exceeds the byte cap of the seam (`details.bytes`, `.maxBytes`). */
  | 'computer-use.oversized'
  /** The `sandbox@1` policy refused the call. */
  | 'computer-use.sandbox-denied'

export interface ComputerUseErrorOptions {
  stage?: string
  details?: Record<string, unknown>
  /** The `ServiceError.code` reported alongside `reason` (default: derived). */
  code?: ServiceErrorCode
}

/**
 * The `ServiceError.code` a reason reports when the caller names none: `reason`
 * is the PRECISE discriminator a caller branches on, the code is the coarse
 * taxonomy of `definitions/support.ts` (which has no value for "no display" or
 * "missing binary", so those map to the closest one it has).
 */
const REASON_CODES: Partial<Record<ComputerUseErrorReason, ServiceErrorCode>> = {
  'computer-use.invalid-input': 'invalid-input',
  'computer-use.missing-service': 'missing-service',
  'computer-use.no-provider': 'not-configured',
  'computer-use.unknown-provider': 'invalid-config',
  'computer-use.ambiguous': 'not-configured',
  'computer-use.duplicate-provider': 'invalid-config',
  'computer-use.provider-unavailable': 'unsupported-provider',
  'computer-use.no-display': 'unreachable',
  'computer-use.not-permitted': 'unsupported',
  'computer-use.missing-tool': 'unsupported',
  'computer-use.not-implemented': 'unsupported',
  'computer-use.timeout': 'timeout',
  'computer-use.command-failed': 'non-zero-exit',
  'computer-use.malformed-output': 'malformed-output',
  'computer-use.oversized': 'unsupported',
  'computer-use.sandbox-denied': 'unsupported',
}

/** The one error shape this capability throws. */
export class ComputerUseError extends ServiceError {
  readonly reason: ComputerUseErrorReason

  constructor(reason: ComputerUseErrorReason, message: string, options: ComputerUseErrorOptions = {}) {
    super(options.code ?? REASON_CODES[reason] ?? 'invalid-input', message, {
      stage: options.stage ?? 'computer-use',
      details: options.details ?? {},
    })
    this.name = 'ComputerUseError'
    this.reason = reason
  }

  /** A JSON-safe view (what a tool answers, what a log line carries). */
  override toJSON(): {
    error: string
    code: ServiceErrorCode
    stage: string
    reason: ComputerUseErrorReason
    details: Record<string, unknown>
  } {
    return { error: this.message, code: this.code, stage: this.stage, reason: this.reason, details: this.details }
  }
}

/** True when the value is a failure of THIS capability (and not of another one). */
export function isComputerUseError(value: unknown): value is ComputerUseError {
  if (value instanceof ComputerUseError) return true
  // DUCK-TYPED on purpose: this definition module can be instantiated more than
  // once (a path source and a git source of this repository), and a caller must
  // still recognise the failure envelope of the other instance.
  if (value === null || typeof value !== 'object') return false
  const reason = (value as { reason?: unknown }).reason
  return typeof reason === 'string' && reason.startsWith('computer-use.')
}

/** The typed error a provider raises for an action it does not serve. */
export function notImplemented(what: string, details: Record<string, unknown> = {}): ComputerUseError {
  return new ComputerUseError(
    'computer-use.not-implemented',
    `the selected computer-use provider does not implement ${what}; the capability is declared but that half is missing`,
    { stage: 'provider', details: { action: what, ...details } },
  )
}

// ---------------------------------------------------------------------------
// The geometry and input vocabulary.
// ---------------------------------------------------------------------------

/** A rectangle of the screen (or of a window). */
export interface ScreenRegion {
  x: number
  y: number
  width: number
  height: number
}

/** A point of the screen. */
export interface PointerPosition {
  x: number
  y: number
}

/** The screen geometry of a display. */
export interface ScreenInfo {
  /** The X display name, e.g. `:99` (absent when the target has none). */
  display?: string
  width: number
  height: number
  depth?: number
  /** Where the pointer was at the time of the call, when the provider can tell. */
  pointer?: PointerPosition
  /** The provider that answered (never a guess: the seam stamps it). */
  provider: string
  /** How the provider reaches the display (`local` or `docker`). */
  runner?: RunnerKind
  /** `existing` (attached to a display the deployment provides) or `xvfb` (managed). */
  target?: DisplayTarget
}

/** One binary the provider needs, and whether the target has it. */
export interface ComputerUseToolStatus {
  /** The binary name, e.g. `xdotool`. */
  binary: string
  /** Which package usually provides it (operator-facing hint). */
  package: string
  /** True when the target can execute it. */
  present: boolean
  /** The action(s) that stop working without it. */
  usedFor: readonly string[]
}

/** What a provider can really do, now, on this target. */
export interface ComputerUseCapabilityReport {
  /** The provider id that answered. */
  provider: string
  /** How it reaches the display. */
  runner: RunnerKind
  /** `existing` or `xvfb`. */
  target: DisplayTarget
  /** The X display it drives, when it has one. */
  display?: string
  /** True when the display answered a live probe. */
  reachable: boolean
  /** Why it is not reachable (the raw probe error), when it is not. */
  unreachableReason?: string
  /** The screen geometry, when reachable. */
  screen?: { width: number; height: number; depth?: number }
  /** The toolchain of the target, one entry per binary the provider uses. */
  tools: ComputerUseToolStatus[]
  /** Whether each action of the contract is usable RIGHT NOW. */
  actions: Record<string, boolean>
  /** The actions that are NOT usable, each with its reason. */
  unavailable: Array<{ action: string; reason: string; missing?: string }>
  /** Free-form facts worth reporting (display vars, WM, notes). */
  notes: string[]
}

// ---------------------------------------------------------------------------
// Requests and answers.
// ---------------------------------------------------------------------------

/** What a screenshot call may ask for. */
export interface ScreenshotRequest {
  /** A rectangle of the screen; absent = the whole root window. */
  region?: ScreenRegion
  /** `png` (default) or `jpeg`. */
  format?: ScreenshotFormat
  /** jpeg quality 1..100 (ignored for png). */
  quality?: number
  /** A short label used in the file name (sanitized). */
  label?: string
  /** Write the file HERE instead of the provider's screenshot directory. */
  path?: string
}

/** The answer of a screenshot call: a FILE on disk, never inline base64. */
export interface ScreenshotAnswer {
  /** The absolute path of the written file (what the caller hands to `fs read`). */
  path: string
  /** `image/png` or `image/jpeg`. */
  mime: string
  /** The real size on disk in bytes. */
  bytes: number
  /** The encoding actually used. */
  format: ScreenshotFormat
  /** The image dimensions. */
  width: number
  height: number
  /** The region captured (absent = full screen). */
  region?: ScreenRegion
  /** The provider that wrote it. */
  provider: string
  /** The display it was taken from. */
  display?: string
  /** True when the byte cap of the SEAM was the reason the answer is bounded. */
  truncated: boolean
  /** Free-form note (e.g. that only a part of the image could be kept). */
  note?: string
}

/** A pointer movement. */
export interface MouseMoveRequest {
  x: number
  y: number
  /** Duration of the movement in ms (0 = teleport, the default). */
  durationMs?: number
}

/** A pointer click (optionally preceded by a move). */
export interface MouseClickRequest {
  x?: number
  y?: number
  button?: MouseButton
  /** Click count: 1 single, 2 double, 3 triple. */
  clicks?: number
  /** Delay between repeated clicks in ms. */
  delayMs?: number
}

/** A pointer drag from one point to another. */
export interface MouseDragRequest {
  from: PointerPosition
  to: PointerPosition
  button?: MouseButton
  /** Duration of the drag in ms. */
  durationMs?: number
}

/** A scroll (optionally preceded by a move). */
export interface MouseScrollRequest {
  x?: number
  y?: number
  direction?: ScrollDirection
  /** Number of wheel steps (default 3). */
  amount?: number
}

/** Typing literal text. */
export interface KeyboardTypeRequest {
  text: string
  /** Delay between keystrokes in ms (default 12). */
  delayMs?: number
}

/** One key or chord, e.g. `Return`, `ctrl+shift+t`, `alt+F4`. */
export interface KeyboardKeyRequest {
  /** The chord (`+`-separated keysym names, xdotool vocabulary). */
  chord: string
  /** `press` (default) sends the chord; `release`/`down` holds it (combo helper). */
  action?: 'press' | 'down' | 'up'
}

/** An answer of an input action (what the target did). */
export interface InputAnswer {
  /** The action that ran, e.g. `mouse.click`. */
  action: string
  /** The pointer position after the action, when the provider can tell. */
  pointer?: PointerPosition
  /** Human-readable detail (the argv that ran is never answered raw). */
  detail?: string
}

/** A clipboard read/write request. */
export interface ClipboardRequest {
  /** `clipboard` (default) or `primary`. */
  selection?: ClipboardSelection
  /** The text to write; absent = read. */
  text?: string
}

/** A clipboard answer. */
export interface ClipboardAnswer {
  selection: ClipboardSelection
  /** The text read (empty on a write). */
  text: string
  bytes: number
  /** True when the text was cut by the inline cap of the seam. */
  truncated: boolean
  /** The action that ran: `clipboard.read` or `clipboard.write`. */
  action: string
}

/** One window as the target reports it. */
export interface WindowInfo {
  /** The window id (hex, as the driver prints it). */
  id: string
  title: string
  /** The desktop/workspace number, when the driver reports one. */
  desktop?: number
  /** The owning pid, when the driver reports one. */
  pid?: number
  /** Geometry, when the driver reports it. */
  geometry?: ScreenRegion
  /** True for the window the WM reports as active. */
  active?: boolean
}

/** Listing / focusing / closing / launching / awaiting a window. */
export interface WindowRequest {
  /** Match by title (substring, case-insensitive) - the common case. */
  title?: string
  /** Match by window id (exact) - the precise case. */
  id?: string
  /** `list` (default) | `focus` | `close` | `launch` | `wait`. */
  action?: WindowAction
  /** `action: 'launch'`: the binary to run on the target, e.g. `xterm`. */
  command?: string
  /** `action: 'launch'`: its arguments. */
  args?: readonly string[]
  /** `action: 'launch'`: after starting, wait for a window whose title contains this. */
  waitTitle?: string
  /** Bound of a `wait` (and of the `launch` wait) in ms. */
  timeoutMs?: number
}

/** Launching an application that opens a window. */
export interface LaunchRequest {
  /** The binary to run on the target, e.g. `xterm`. */
  command: string
  args?: string[]
  /** When set, wait for a window whose title contains this (bounded by timeoutMs). */
  waitTitle?: string
  timeoutMs?: number
}

/** Waiting for readiness: a plain delay, or a window to appear. */
export interface WaitRequest {
  /** Sleep this long (bounded). */
  ms?: number
  /** Wait for a window whose title contains this. */
  title?: string
  timeoutMs?: number
}

/** A window answer. */
export interface WindowAnswer {
  action: WindowAction
  /** The windows when `list`/`wait` ran (empty is a legitimate answer). */
  windows: WindowInfo[]
  /** The window that was focused/closed, when one was. */
  window?: WindowInfo
  /** The pid of a launched app, when one was started. */
  pid?: number
  /** What really happened, in one line. */
  detail?: string
}

/** Per-call bounds the SERVICE HOST (not the provider) owns. */
export interface ComputerUseCallOptions {
  timeoutMs?: number
  /** The byte cap of one screenshot file. */
  maxImageBytes?: number
  /** Where a screenshot is written. */
  screenshotDir?: string
  /** The inline character cap of a clipboard read. */
  maxTextChars?: number
}

// ---------------------------------------------------------------------------
// The provider contract. STRICTURAL on purpose: a provider plugin only has to
// export an object shaped like this (it never imports a consumer, and the seam
// check enforces the direction).
// ---------------------------------------------------------------------------

/**
 * What a provider plugin implements. Every method is optional EXCEPT
 * `capabilities()` and `screenInfo()`: a provider that cannot serve an action
 * simply leaves it out, and the seam turns that into a typed
 * `computer-use.not-implemented` naming the missing half. `capabilities()` is
 * the ONLY place availability is decided - never guessed by a caller.
 */
export interface ComputerUseProvider {
  /** The id this provider is configured and requested by, e.g. `x11`. */
  id: string
  /** How it reaches the display. */
  runner: RunnerKind
  /** `existing` (an operator-provided display) or `xvfb` (managed by the provider). */
  target: DisplayTarget
  /** The display it drives, when it has one right now. */
  display?: string
  /** False takes the provider out of selection (`capabilities()` says why). */
  available(): boolean
  /** Why it is not available (reported by `computer providers`). */
  unavailableReason?(): string | undefined
  /** What the target can really do, probed NOW (never cached, never guessed). */
  capabilities(): ComputerUseCapabilityReport | Promise<ComputerUseCapabilityReport>
  /** Bring the display up (managed targets) and report its geometry. */
  start?(options?: ComputerUseCallOptions): Promise<ScreenInfo>
  /** Release the display (the disposer of a managed target). */
  stop?(): Promise<void>
  screenInfo(options?: ComputerUseCallOptions): Promise<ScreenInfo> | ScreenInfo
  screenshot(request: ScreenshotRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  mouseMove?(request: MouseMoveRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  mouseClick?(request: MouseClickRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  mouseDrag?(request: MouseDragRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  mouseScroll?(request: MouseScrollRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  pointerPosition?(options?: ComputerUseCallOptions): Promise<PointerPosition> | PointerPosition
  typeText?(request: KeyboardTypeRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  pressKey?(request: KeyboardKeyRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  clipboard?(request: ClipboardRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  windows?(request: WindowRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  launch?(request: LaunchRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  wait?(request: WaitRequest, options?: ComputerUseCallOptions): Promise<unknown> | unknown
  /** Free-form facts the provider wants `computer screen` to report. */
  notes?(): readonly string[]
}

/** What `computer providers` reports about ONE provider. */
export interface ComputerUseProviderInfo {
  id: string
  /** True when the config named it as the default provider. */
  configured: boolean
  /** `available()` of the provider. */
  available: boolean
  runner: RunnerKind
  target: DisplayTarget
  display?: string
  /** Why it is not available, when it is not. */
  reason?: string
  /** The actions it reports as usable right now. */
  actions?: string[]
}

/** The provider selection in effect (the DSH "one driver at a time" model). */
export interface ComputerUseSelection {
  /** The default provider id from the config, when one is set. */
  provider?: string
  /** The ordered fallback chain. */
  fallback: string[]
  /** The provider that a call naming none WOULD use (absent when none is usable). */
  selected?: string
  /** Why selection is not possible, when it is not. */
  reason?: string
  /** The config row to edit. */
  configRow: string
}

/** The `computer-use@1` capability as a CONSUMER sees it. */
export interface ComputerUseService {
  readonly contract: string
  /** The id of the provider that served the last selection (empty when none). */
  readonly providerId: string
  /** Registers a provider; the returned callback unregisters it (idempotent). */
  register(provider: ComputerUseProvider): () => void
  /** Every registered provider with its configured/available state. */
  providers(): ComputerUseProviderInfo[]
  /** The selection policy in effect. */
  selection(): ComputerUseSelection
  /** What the selected provider can do now. */
  capabilities(provider?: string): Promise<ComputerUseCapabilityReport>
  screenInfo(provider?: string): Promise<ScreenInfo>
  screenshot(request: ScreenshotRequest, provider?: string): Promise<ScreenshotAnswer>
  mouse(action: 'move' | 'click' | 'drag' | 'scroll', request: Record<string, unknown>, provider?: string): Promise<InputAnswer>
  keyboard(action: 'type' | 'key', request: Record<string, unknown>, provider?: string): Promise<InputAnswer>
  clipboard(request: ClipboardRequest, provider?: string): Promise<ClipboardAnswer>
  windows(request: WindowRequest, provider?: string): Promise<WindowAnswer>
  wait(request: WaitRequest, provider?: string): Promise<WindowAnswer>
  /** Close the session target (a managed display) or one window by title/id. */
  close(request: WindowRequest, provider?: string): Promise<WindowAnswer>
}

/** The config of the service host (`computer-use-impl`). */
export interface ComputerUseConfig {
  /** The default provider id, e.g. `x11`. */
  provider?: string
  /** Ordered ids tried when the default cannot run. */
  fallback?: readonly string[]
  /** Where a screenshot is written (default: <tmpdir>/workbench-computer-use). */
  screenshotDir?: string
  /** The byte cap of one screenshot file. */
  maxImageBytes?: number
  /** The wall-clock bound of one call. */
  timeoutMs?: number
  /** The inline character cap of a clipboard read. */
  maxTextChars?: number
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no cordis): the seam and the provider share them so a
// value is normalized ONCE, at the same place, whichever provider answers.
// ---------------------------------------------------------------------------

/** The mime type of a screenshot format. */
export function mimeOfFormat(format: ScreenshotFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png'
}

/** The file extension of a screenshot format. */
export function extensionOfFormat(format: ScreenshotFormat): string {
  return format === 'jpeg' ? 'jpg' : 'png'
}

/** The format of a request (`png` when it names none or names an unknown one). */
export function resolveScreenshotFormat(value: unknown): ScreenshotFormat {
  const raw = str(value)?.toLowerCase()
  return raw === 'jpeg' || raw === 'jpg' ? 'jpeg' : 'png'
}

/**
 * A POSITIVE integer (>= 1) or a typed `invalid-input` - counts and sizes, where
 * zero is meaningless.
 */
export function requirePositiveInt(value: unknown, field: string, max = 1_000_000): number {
  return requireInt(value, field, 1, max)
}

/**
 * A NON-NEGATIVE integer (>= 0) or a typed `invalid-input` - screen coordinates,
 * durations and delays, where zero is a legal value (top-left, teleport, no
 * delay).
 */
export function requireNonNegativeInt(value: unknown, field: string, max = 1_000_000): number {
  return requireInt(value, field, 0, max)
}

/** The one integer gate: a whole number in [min, max], or a typed error. */
function requireInt(value: unknown, field: string, min: number, max: number): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new ComputerUseError('computer-use.invalid-input', `'${field}' must be an integer between ${min} and ${max}`, {
      stage: 'request',
      details: { field, min, max, value: typeof value === 'number' ? value : String(value) },
    })
  }
  return number
}

/**
 * A non-empty string or a typed `invalid-input`. The value is TRIMMED: outer
 * whitespace is a transport artefact in every action of this seam (a title, a
 * label, a command, a keystroke payload), so a whitespace-only string is absent,
 * not "a valid one-character-space value".
 */
export function requireText(value: unknown, field: string, maxChars = 100_000): string {
  const raw = typeof value === 'string' ? value.trim() : undefined
  if (raw === undefined || raw.length === 0) {
    throw new ComputerUseError('computer-use.invalid-input', `'${field}' must be a non-empty string`, {
      stage: 'request',
      details: { field },
    })
  }
  if (raw.length > maxChars) {
    throw new ComputerUseError('computer-use.invalid-input', `'${field}' exceeds ${maxChars} characters`, {
      stage: 'request',
      details: { field, maxChars, chars: raw.length },
    })
  }
  return raw
}

/**
 * One of `allowed`, or a typed `invalid-input` naming the vocabulary. The match
 * is CASE-INSENSITIVE (`LEFT` == `left`): the vocabulary is lower-case, and a
 * caller typing `Return`-style capitalization is not an error. The canonical
 * (lower-case) member is what the answer carries.
 */
export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  const raw = str(value)?.toLowerCase()
  if (raw === undefined && fallback !== undefined) return fallback
  const match = (allowed as readonly string[]).find((option) => option.toLowerCase() === raw)
  if (match === undefined) {
    throw new ComputerUseError('computer-use.invalid-input', `'${field}' must be one of ${allowed.join(' | ')}`, {
      stage: 'request',
      details: { field, allowed: [...allowed], value: raw ?? null },
    })
  }
  return match as T
}

/** A normalized region (integers, strictly positive size) or a typed error. */
export function normalizeRegion(value: unknown): ScreenRegion | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new ComputerUseError('computer-use.invalid-input', "'region' must be an object { x, y, width, height }", {
      stage: 'request',
      details: { field: 'region' },
    })
  }
  const width = requirePositiveInt(value.width, 'region.width')
  const height = requirePositiveInt(value.height, 'region.height')
  return { x: requireNonNegativeInt(value.x ?? 0, 'region.x'), y: requireNonNegativeInt(value.y ?? 0, 'region.y'), width, height }
}

/** A normalized point (integers >= 0) or a typed error. */
export function normalizePointer(value: unknown, field = 'position'): PointerPosition {
  if (!isRecord(value)) {
    throw new ComputerUseError('computer-use.invalid-input', `'${field}' must be an object { x, y }`, {
      stage: 'request',
      details: { field },
    })
  }
  return { x: requireNonNegativeInt(value.x, `${field}.x`), y: requireNonNegativeInt(value.y, `${field}.y`) }
}

/**
 * A key CHORD in the xdotool vocabulary, validated by shape: `+`-separated
 * keysym names, no whitespace, no shell metacharacter. The provider never hands
 * this to a shell, but a chord that is obviously wrong is a typed input error
 * instead of a driver failure.
 */
/** The modifier names xdotool accepts case-insensitively (normalized to lower case). */
const MODIFIER_NAMES = new Set([
  'ctrl',
  'control',
  'shift',
  'alt',
  'super',
  'meta',
  'hyper',
  'cmd',
  'mod1',
  'mod2',
  'mod3',
  'mod4',
  'mod5',
])

export function normalizeChord(value: unknown): string {
  const raw = requireText(value, 'chord', 64)
  // Whitespace around a `+` is cosmetic (`ctrl + Shift + t` == `ctrl+shift+t`);
  // whitespace INSIDE a keysym name is not (no keysym name contains one).
  const key = raw.replace(/\s*\+\s*/g, '+')
  if (!/^[A-Za-z0-9_+]+$/.test(key)) {
    throw new ComputerUseError(
      'computer-use.invalid-input',
      "'chord' must be '+' -separated keysym names, e.g. ctrl+shift+t or Return (no spaces inside a name, no shell characters)",
      { stage: 'request', details: { field: 'chord' } },
    )
  }
  // A MODIFIER is case-insensitive and is normalized; a keysym such as `Return`
  // or `F4` keeps its case, because X is case-sensitive there.
  return key
    .split('+')
    .map((part) => (MODIFIER_NAMES.has(part.toLowerCase()) ? part.toLowerCase() : part))
    .join('+')
}

/**
 * A file-name-safe slug of a label (never empty): lower-cased and reduced to
 * `[a-z0-9-]`, so a label is safe on a case-insensitive file system too.
 */
export function slugOf(value: string, fallback = 'screen'): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length === 0 ? fallback : slug
}

/**
 * Clamps a region to the screen: a capture outside the display is a caller
 * mistake, and the seam answers the region that was REALLY captured.
 */
export function clampRegion(region: ScreenRegion, screen: { width: number; height: number }): {
  region: ScreenRegion
  clamped: boolean
} {
  const x = Math.min(region.x, Math.max(0, screen.width - 1))
  const y = Math.min(region.y, Math.max(0, screen.height - 1))
  const width = Math.min(region.width, screen.width - x)
  const height = Math.min(region.height, screen.height - y)
  const clamped = x !== region.x || y !== region.y || width !== region.width || height !== region.height
  return { region: { x, y, width, height }, clamped }
}

/** The `computer-use@1` service, when the deployment has one. */
export function computerUseOf(ctx: ServiceContext): ComputerUseService | undefined {
  return serviceOf<ComputerUseService>(ctx, COMPUTER_USE)
}

/** The `computer-use@1` service, or a typed `missing-service` error naming it. */
export function requireComputerUse(ctx: ServiceContext): ComputerUseService {
  const service = computerUseOf(ctx)
  if (service === undefined) {
    throw new ComputerUseError(
      'computer-use.missing-service',
      "no computer-use@1 provider is loaded: add a 'computer-use-impl' row to the plugins roster",
      { stage: 'lookup', details: { service: COMPUTER_USE } },
    )
  }
  return service
}

/**
 * The SANDBOX handle of the deployment, when it has one (extension point ONLY,
 * requirement 5): the seam consults it before a call that touches the desktop and
 * turns a DENY into `computer-use.sandbox-denied`. The shape is the structural
 * subset of `definitions/sandbox.ts` this capability needs - the seam never
 * imports that Definition, so a deployment without a sandbox provider is
 * completely unaffected.
 */
export interface ComputerUseSandboxLike {
  check(request: { resource: string; command?: { argv: readonly string[] } }): unknown
}

/** The `sandbox@1` service as THIS capability uses it, or undefined. */
export function computerUseSandbox(ctx: ServiceContext): ComputerUseSandboxLike | undefined {
  const service = serviceOf<ComputerUseSandboxLike>(ctx, 'sandbox')
  return service !== undefined && typeof service.check === 'function' ? service : undefined
}

/** The bounds of a call once the config was read (never a raw config value). */
export function resolveComputerUseBounds(config: ComputerUseConfig = {}): Required<
  Pick<ComputerUseConfig, 'maxImageBytes' | 'timeoutMs' | 'maxTextChars'>
> {
  return {
    maxImageBytes: positiveInt(config.maxImageBytes, DEFAULT_SCREENSHOT_MAX_BYTES, 64 * 1024 * 1024),
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_COMPUTER_TIMEOUT_MS, 120_000),
    maxTextChars: positiveInt(config.maxTextChars, 20_000, 1_000_000),
  }
}
