// core/browser-use-playwright/frames - THE FRAME TREE, MOUSE INPUT and the RAW
// LOAD RECORDER.
//
// WHY THIS MODULE EXISTS (measured, not theoretical):
//
//   * The interesting half of a real page often lives in a CROSS-ORIGIN IFRAME
//     (an embedded payment form, a third-party editor, an offered control). A
//     CSS selector of the main document can never reach inside it, the page's
//     own DOM may not even admit that the frame exists, and a frame with no
//     addressable element still HAS PIXELS. So this provider exposes two
//     GENERIC things: the BROWSER's frame tree (`Page.getFrameTree` over CDP
//     plus the real element geometry) and the REAL MOUSE at coordinates
//     (`page.mouse`), which drives the same input pipeline a human click uses.
//   * What a call OBSERVED is not a verdict. This module records the transport
//     facts of every document load (status, headers verbatim, redirects, cookie
//     NAMES), what the document contained, the frame tree, the navigations the
//     browser performed ON ITS OWN and the actions this side drove. Nothing here
//     matches a keyword, names a vendor, or decides what a page "means": the
//     CALLER reads the observation and judges.
//
// HONESTY: no fingerprint spoofing is used or needed. This is a real Chromium
// driven through CDP against real pages.
import type { CDPSession, ElementHandle, Frame, Page, Response } from 'playwright-core'
import {
  BrowserUseError,
  MOUSE_ACTIONS,
  MOUSE_BUTTONS,
  MOUSE_ORIGINS,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireText,
  type BrowserFrameBox,
  type BrowserFrameFocusables,
  type BrowserFrameInfo,
  type BrowserFrameTarget,
  type BrowserMouseRequest,
  type BrowserRawCookie,
  type BrowserRawDocument,
  type BrowserRawLoad,
  type BrowserRawNavigation,
  type BrowserRawResources,
  type MouseAction,
  type MouseButton,
  type MouseOrigin,
} from '../../definitions/browser-use.ts'

// ---------------------------------------------------------------------------
// The frame tree.
// ---------------------------------------------------------------------------

/** The session-side binding of a frame id, so `frameId` round-trips. */
export interface FrameBinding {
  frameId: string
  index: number
  url: string
  name: string
}

/** One row of the CDP frame tree (the ENGINE's view, real frame ids). */
interface CdpFrameRow {
  frameId: string
  parentFrameId?: string
  url: string
  name?: string
  depth: number
}

/** Flattens `Page.getFrameTree` into DFS rows (main frame first). */
function flattenFrameTree(result: unknown): CdpFrameRow[] {
  const root = (result as { frameTree?: CdpFrameTree }).frameTree
  const rows: CdpFrameRow[] = []
  const walk = (node: CdpFrameTree | undefined, depth: number, parentFrameId?: string): void => {
    const frame = node?.frame
    if (frame === undefined || typeof frame.id !== 'string' || frame.id.length === 0) return
    rows.push({
      frameId: frame.id,
      ...(parentFrameId === undefined ? {} : { parentFrameId }),
      url: typeof frame.url === 'string' ? frame.url : '',
      ...(typeof frame.name === 'string' && frame.name.length > 0 ? { name: frame.name } : {}),
      depth,
    })
    for (const child of Array.isArray(node?.childFrames) ? node.childFrames : []) walk(child, depth + 1, frame.id)
  }
  walk(root, 0, undefined)
  return rows
}

interface CdpFrameTree {
  frame?: { id?: string; url?: string; name?: string }
  childFrames?: CdpFrameTree[]
}

/** The origin of a URL (`undefined` when it cannot be parsed). */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** A CSS string literal (a frame `src` goes into a selector verbatim). */
function cssLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The selector of a frame ELEMENT in its parent document (best effort). */
async function selectorOfFrame(frame: Frame): Promise<string | undefined> {
  let handle: ElementHandle<Element> | null = null
  try {
    // `frameElement()` is typed `ElementHandle<Node>` by this playwright-core
    // version while it really is the `iframe`/`frame` ELEMENT: narrow it once
    // here so the attribute reads below stay typed.
    handle = (await frame.frameElement()) as unknown as ElementHandle<Element> | null
  } catch {
    return undefined
  }
  if (handle === null) return undefined
  const tag = await frame.page().evaluate((element: Element) => element.tagName.toLowerCase(), handle).catch(() => 'iframe')
  const src = await handle.getAttribute('src').catch(() => null)
  if (src !== null && src.length > 0) return `${tag}[src=${cssLiteral(src)}]`
  const id = await handle.getAttribute('id').catch(() => null)
  if (id !== null && id.length > 0) return `${tag}[id=${cssLiteral(id)}]`
  const name = await handle.getAttribute('name').catch(() => null)
  if (name !== null && name.length > 0) return `${tag}[name=${cssLiteral(name)}]`
  return tag
}

/** The focusable controls a frame's OWN document exposes (a structural count). */
async function focusablesOf(frame: Frame): Promise<BrowserFrameFocusables> {
  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="checkbox"], [tabindex]'
  return await frame
    .evaluate((css) => {
      const elements = Array.from(document.querySelectorAll(css))
      const tags = Array.from(new Set(elements.map((element) => element.tagName.toLowerCase()))).sort()
      return { tags, count: elements.length }
    }, selector)
    .catch(() => ({ tags: [] as string[], count: 0 }))
}

/**
 * The frame element's box in MAIN-frame CSS pixels. The main frame answers the
 * viewport; a frame whose element cannot be measured (detached, not rendered,
 * hidden behind an unbuilt layout) answers `undefined` - an ABSENCE, never a
 * fabricated zero, so a caller can tell "no box" from "box at 0,0".
 */
async function boxOf(page: Page, frame: Frame): Promise<BrowserFrameBox | undefined> {
  if (frame === page.mainFrame()) {
    const size = page.viewportSize()
    return size === null ? undefined : { x: 0, y: 0, width: size.width, height: size.height }
  }
  let handle: ElementHandle<Element> | null = null
  try {
    handle = (await frame.frameElement()) as unknown as ElementHandle<Element> | null
  } catch {
    return undefined
  }
  if (handle === null) return undefined
  const box = await handle.boundingBox().catch(() => null)
  if (box === null) return undefined
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/**
 * Enumerates the frame tree of the page. The ids are the ENGINE's CDP frame
 * ids when they can be read (`frameIdSource: 'cdp'`), else positional ids
 * (`pw:<index>`) - and the caller can SEE which one it got, so it never trusts
 * an id that is only a position.
 */
export async function enumerateFrames(
  page: Page,
  cdp: CDPSession | undefined,
  maxFrames: number,
): Promise<{ frames: BrowserFrameInfo[]; bindings: Map<string, FrameBinding>; mainFrameId: string }> {
  let rows: CdpFrameRow[] | undefined
  if (cdp !== undefined) {
    rows = await cdp
      .send('Page.getFrameTree')
      .then((result) => flattenFrameTree(result))
      .catch(() => undefined)
  }
  const playwrightFrames = page.frames()
  const main = page.mainFrame()
  const mainOrigin = originOf(main.url())
  const frames: BrowserFrameInfo[] = []
  const bindings = new Map<string, FrameBinding>()
  const used = new Set<string>()
  const limit = Math.max(1, maxFrames)
  for (const [index, frame] of playwrightFrames.entries()) {
    if (frames.length >= limit) break
    const url = frame.url()
    const name = frame.name()
    const sameName = (row: CdpFrameRow): boolean => (row.name ?? '') === name
    const candidate =
      rows?.find((row) => !used.has(row.frameId) && row.url === url && sameName(row)) ??
      (rows !== undefined && rows[index] !== undefined && !used.has(rows[index]!.frameId) && rows[index]!.url === url
        ? rows[index]
        : undefined)
    if (candidate !== undefined) used.add(candidate.frameId)
    const frameId = candidate?.frameId ?? `pw:${String(index)}`
    const selector = index === 0 ? undefined : await selectorOfFrame(frame)
    const frameOrigin = originOf(url)
    const box = await boxOf(page, frame)
    const focusables = await focusablesOf(frame)
    frames.push({
      frameId,
      frameIdSource: candidate === undefined ? 'positional' : 'cdp',
      ...(candidate?.parentFrameId === undefined ? {} : { parentFrameId: candidate.parentFrameId }),
      url,
      ...(name.length === 0 ? {} : { name }),
      depth: candidate?.depth ?? (index === 0 ? 0 : 1),
      isMainFrame: frame === main,
      crossOrigin: mainOrigin !== undefined && frameOrigin !== undefined && mainOrigin !== frameOrigin,
      ...(selector === undefined ? {} : { selector }),
      ...(frameOrigin === undefined ? {} : { origin: frameOrigin }),
      sameOriginAsTop: frameOrigin !== undefined && mainOrigin !== undefined && frameOrigin === mainOrigin,
      ...(box === undefined ? {} : { box }),
      visible: box !== undefined && box.width > 0 && box.height > 0,
      focusables,
    })
    bindings.set(frameId, { frameId, index, url, name })
  }
  const mainFrameId = frames[0]?.frameId ?? 'pw:0'
  return { frames, bindings, mainFrameId }
}

/**
 * Resolves a frame target against the LIVE frame list, using the bindings the
 * last enumeration recorded (so a `frameId` round-trips). The order is
 * `frameId`, `selector`, `url`, `name`, `index`; no target at all is the MAIN
 * frame. Every failure is typed, never a guess at "some" frame.
 */
export async function resolveFrameTarget(
  page: Page,
  target: BrowserFrameTarget | undefined,
  bindings: Map<string, FrameBinding>,
): Promise<Frame> {
  const frames = page.frames()
  if (target === undefined) return page.mainFrame()
  if (target.frameId !== undefined) {
    const frameId = requireText(target.frameId, 'frame.frameId', 256)
    const binding = bindings.get(frameId)
    if (binding !== undefined) {
      const frame = frames[binding.index]
      if (frame !== undefined) return frame
    }
    const positional = /^pw:(\d+)$/.exec(frameId)
    if (positional !== null) {
      const frame = frames[Number(positional[1])]
      if (frame !== undefined) return frame
    }
    throw new BrowserUseError(
      'browser-use.invalid-input',
      `no frame '${frameId}' in this session (call \`frames\` and use a frameId it reported)`,
      { stage: 'frame', details: { frameId, known: [...bindings.keys()] } },
    )
  }
  if (target.selector !== undefined) {
    const selector = requireText(target.selector, 'frame.selector', 4_096)
    const locator = page.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      throw new BrowserUseError('browser-use.selector-not-found', `'frame.selector': '${selector}' matched no element`, {
        stage: 'frame',
        details: { selector, frames: page.frames().map((frame) => frame.url()) },
      })
    }
    const handle = await locator.first().elementHandle()
    const frame = handle === null ? null : await handle.contentFrame()
    if (frame === null) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'frame.selector': '${selector}' is not a frame (an iframe/frame element)`,
        { stage: 'frame', details: { selector } },
      )
    }
    return frame
  }
  if (target.url !== undefined) {
    const wanted = requireText(target.url, 'frame.url', 4_096)
    const frame = frames.find((candidate) => candidate.url() === wanted) ?? frames.find((candidate) => candidate.url().includes(wanted))
    if (frame === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `no frame whose URL is '${wanted}'`, {
        stage: 'frame',
        details: { url: wanted, frames: frames.map((candidate) => candidate.url()) },
      })
    }
    return frame
  }
  if (target.name !== undefined) {
    const wanted = requireText(target.name, 'frame.name', 256)
    const frame = frames.find((candidate) => candidate.name() === wanted)
    if (frame === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `no frame named '${wanted}'`, {
        stage: 'frame',
        details: { name: wanted, frames: frames.map((candidate) => candidate.name()) },
      })
    }
    return frame
  }
  if (target.index !== undefined) {
    const index = requireNonNegativeInt(target.index, 'frame.index', 10_000)
    const frame = frames[index]
    if (frame === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `no frame at index ${String(index)} (the page has ${String(frames.length)})`, {
        stage: 'frame',
        details: { index, frames: frames.length },
      })
    }
    return frame
  }
  throw new BrowserUseError(
    'browser-use.invalid-input',
    "'frame' names no frame: pass frameId, selector, url, name or index",
    { stage: 'frame', details: { accepted: ['frameId', 'selector', 'url', 'name', 'index'] } },
  )
}

// ---------------------------------------------------------------------------
// Mouse input at coordinates.
// ---------------------------------------------------------------------------

/** A finite number in range, or a typed `invalid-input`. */
function requireNumber(value: unknown, field: string, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || Math.abs(number) > max) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be a number between -${String(max)} and ${String(max)}`, {
      stage: 'mouse',
      details: { field, value: typeof value === 'number' || typeof value === 'string' ? value : String(value) },
    })
  }
  return number
}

/** Where the coordinates of this gesture are measured, plus the frame box. */
async function coordinateBase(
  page: Page,
  request: BrowserMouseRequest,
  bindings: Map<string, FrameBinding>,
  fallback: Frame | undefined,
): Promise<{ origin: MouseOrigin; frame: Frame | undefined; offsetX: number; offsetY: number; frameId?: string }> {
  const origin = requireEnum(request.relativeTo ?? 'page', MOUSE_ORIGINS, 'relativeTo', 'page')
  const frame = request.frame === undefined ? fallback : await resolveFrameTarget(page, request.frame, bindings)
  if (origin === 'page') {
    const anchor = frame === undefined ? undefined : frameIdOf(frame, bindings)
    return { origin, frame, offsetX: 0, offsetY: 0, ...(anchor === undefined ? {} : { frameId: anchor }) }
  }
  const target = frame ?? page.mainFrame()
  if (target === page.mainFrame()) return { origin, frame: target, offsetX: 0, offsetY: 0, frameId: frameIdOf(target, bindings) }
  const handle = await target.frameElement().catch(() => null)
  const box = handle === null ? null : await handle.boundingBox().catch(() => null)
  if (box === null) {
    throw new BrowserUseError('browser-use.invalid-input', "the frame has no box: it is detached or not rendered", {
      stage: 'mouse',
      details: { frameUrl: target.url() },
    })
  }
  return { origin, frame: target, offsetX: box.x, offsetY: box.y, frameId: frameIdOf(target, bindings) }
}

/** The id the bindings know for a frame (`undefined` when it was never listed). */
function frameIdOf(frame: Frame, bindings: Map<string, FrameBinding>): string | undefined {
  for (const [frameId, binding] of bindings) {
    if (binding.url === frame.url() && binding.name === frame.name()) return frameId
  }
  return undefined
}

/** What a mouse gesture really did (the coordinates the browser received). */
export interface MouseResult {
  mouseAction: MouseAction
  x: number
  y: number
  toX?: number
  toY?: number
  relativeTo: MouseOrigin
  button: MouseButton
  frameId?: string
  /** The frame URL the input was aimed through, when a frame was addressed. */
  frameUrl?: string
}

/**
 * Drives the REAL mouse. `relativeTo: 'page'` (default) uses the main frame
 * viewport - the SAME origin a screenshot uses; `relativeTo: 'frame'` measures
 * from the target frame's box, and the offset is added here so the browser
 * always receives main-frame coordinates (which is what makes a click inside a
 * cross-origin frame land where the caller meant).
 */
export async function driveMouse(
  page: Page,
  request: BrowserMouseRequest,
  bindings: Map<string, FrameBinding>,
  fallback: Frame | undefined,
): Promise<MouseResult> {
  const action = requireEnum(request.mouseAction ?? 'click', MOUSE_ACTIONS, 'mouseAction', 'click')
  const button = requireEnum(request.button ?? 'left', MOUSE_BUTTONS, 'button', 'left')
  const base = await coordinateBase(page, request, bindings, fallback)
  const steps = request.steps === undefined ? 10 : requirePositiveInt(request.steps, 'steps', 200)
  const max = 100_000
  const toResult = (x: number, y: number, extra: { toX?: number; toY?: number } = {}): MouseResult => ({
    mouseAction: action,
    x,
    y,
    ...extra,
    relativeTo: base.origin,
    button,
    ...(base.frameId === undefined ? {} : { frameId: base.frameId }),
    ...(base.origin === 'frame' && base.frame !== undefined ? { frameUrl: base.frame.url() } : {}),
  })
  if (action === 'wheel') {
    const deltaX = request.deltaX === undefined ? 0 : requireNumber(request.deltaX, 'deltaX', max)
    const deltaY = request.deltaY === undefined ? 0 : requireNumber(request.deltaY, 'deltaY', max)
    if (request.x !== undefined && request.y !== undefined) {
      await page.mouse.move(requireNumber(request.x, 'x', max) + base.offsetX, requireNumber(request.y, 'y', max) + base.offsetY)
    }
    await page.mouse.wheel(deltaX, deltaY)
    return toResult(
      request.x === undefined ? 0 : requireNumber(request.x, 'x', max),
      request.y === undefined ? 0 : requireNumber(request.y, 'y', max),
    )
  }
  const x = requireNumber(request.x, 'x', max) + base.offsetX
  const y = requireNumber(request.y, 'y', max) + base.offsetY
  if (action === 'drag') {
    const toX = requireNumber(request.toX, 'toX', max) + base.offsetX
    const toY = requireNumber(request.toY, 'toY', max) + base.offsetY
    await page.mouse.move(x, y)
    await page.mouse.down({ button })
    await page.mouse.move(toX, toY, { steps })
    await page.mouse.up({ button })
    return toResult(x, y, { toX, toY })
  }
  if (action === 'down') {
    await page.mouse.move(x, y)
    await page.mouse.down({ button })
    return toResult(x, y)
  }
  if (action === 'up') {
    await page.mouse.move(x, y)
    await page.mouse.up({ button })
    return toResult(x, y)
  }
  if (action === 'click' || action === 'dblclick') {
    const defaultCount = action === 'dblclick' ? 2 : 1
    const clickCount = request.clickCount === undefined ? defaultCount : requirePositiveInt(request.clickCount, 'clickCount', 3)
    // A MOVE first, then the click: the pointer really travels to the pixel (an
    // element that reacts to hover/pointermove sees it, exactly like a human).
    await page.mouse.move(x, y)
    await page.mouse.click(x, y, { button, clickCount })
    return toResult(x, y)
  }
  await page.mouse.move(x, y, { steps })
  return toResult(x, y)
}

// ---------------------------------------------------------------------------
// The raw transcript: what the browser did on its own, and what it fetched.
//
// A page that reacts to an interaction by navigating ITSELF is the case this
// recorder exists for: the caller must be able to see that the navigation came
// from the browser, and to read the RAW load it landed on, without this side
// ever issuing a navigation of its own (a self-issued re-navigation discards
// the in-flight interaction state of the page - measured).
// ---------------------------------------------------------------------------

/** One main-frame navigation the browser committed. */
export interface RecordedNavigation {
  at: string
  url: string
  /** `requested` when this side called `navigate`, `browser` when the page did it. */
  kind: 'requested' | 'browser'
  httpStatus?: number
  statusText?: string
  /** The document response, so the RAW load of this navigation can be captured. */
  response?: Response
}

/** One response the page received (bounded: a summary, never a full log). */
interface RecordedResponse {
  at: string
  url: string
  status: number
}

/** The bounded transcript of a live page. */
export class LoadRecorder {
  /** The page this recorder is attached to (the provider re-attaches per page). */
  readonly page: Page
  private readonly limit: number
  private readonly navs: RecordedNavigation[] = []
  private readonly responses: RecordedResponse[] = []
  private readonly detachers: (() => void)[] = []
  private readonly waiters = new Set<() => void>()
  private requestedUrl: string | undefined

  constructor(page: Page, limit = 500) {
    this.page = page
    this.limit = Math.max(10, limit)
  }

  /** Starts recording (idempotent: a second call is a no-op). */
  attach(): void {
    if (this.detachers.length > 0) return
    const onResponse = (response: Response): void => {
      const request = response.request()
      const isMainNavigation = request.isNavigationRequest() && response.frame() === this.page.mainFrame()
      if (isMainNavigation) {
        const kind: 'requested' | 'browser' = this.requestedUrl === undefined ? 'browser' : 'requested'
        this.navs.push({
          at: new Date().toISOString(),
          url: request.url(),
          kind,
          httpStatus: response.status(),
          statusText: response.statusText(),
          response,
        })
        if (this.navs.length > this.limit) this.navs.splice(0, this.navs.length - this.limit)
        for (const waiter of [...this.waiters]) waiter()
      } else {
        this.responses.push({ at: new Date().toISOString(), url: request.url(), status: response.status() })
        if (this.responses.length > this.limit * 4) this.responses.splice(0, this.responses.length - this.limit * 4)
      }
    }
    this.page.on('response', onResponse)
    this.detachers.push(() => this.page.off('response', onResponse))
  }

  /** Marks the navigation THIS side is about to drive (so it is not billed to the page). */
  beginRequested(url: string): void {
    this.requestedUrl = url
  }

  /** The requested navigation settled: from here on, navigations are the page's own. */
  endRequested(): void {
    this.requestedUrl = undefined
  }

  /** Every navigation recorded so far, oldest first. */
  navigations(): RecordedNavigation[] {
    return [...this.navs]
  }

  /** The navigations the PAGE initiated (never the caller's own request). */
  browserInitiated(): RecordedNavigation[] {
    return this.navs.filter((navigation) => navigation.kind === 'browser')
  }

  /** The count of navigations recorded so far (the window marker). */
  mark(): number {
    return this.navs.length
  }

  /** The navigations recorded after a {@link mark}. */
  since(marker: number): RecordedNavigation[] {
    return this.navs.slice(marker)
  }

  /** The page-initiated navigations recorded after a {@link mark}. */
  browserSince(marker: number): RecordedNavigation[] {
    return this.navs.slice(marker).filter((navigation) => navigation.kind === 'browser')
  }

  /** The response index a load starts at (the resource summary window). */
  responseMark(): number {
    return this.responses.length
  }

  /** The resources observed after a {@link responseMark} (bounded, counts only). */
  resourcesSince(marker: number, maxFailed = 50): BrowserRawResources {
    const window = this.responses.slice(marker)
    const failed: string[] = []
    for (const response of window) {
      if (response.status >= 400 && failed.length < maxFailed) failed.push(response.url)
    }
    return { total: window.length, failed }
  }

  /**
   * Waits (bounded) until the page commits a navigation after `mark`. Event
   * driven, never a poll loop: the recorder notifies on every recorded
   * navigation. Answers `true` when one arrived inside the budget.
   */
  async waitForNavigation(mark: number, timeoutMs: number): Promise<boolean> {
    if (this.navs.length > mark) return true
    return await new Promise<boolean>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(value)
      }
      const waiter = (): void => {
        if (this.navs.length > mark) finish(true)
      }
      this.waiters.add(waiter)
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    })
  }

  /** Stops recording and releases the page listeners. */
  dispose(): void {
    for (const detach of this.detachers.splice(0)) detach()
    this.waiters.clear()
  }
}

// ---------------------------------------------------------------------------
// Capturing a RAW load.
// ---------------------------------------------------------------------------

/** The document facts a load reports (a bounded excerpt, counts, no verdict). */
async function documentFacts(page: Page, excerptChars: number): Promise<BrowserRawDocument> {
  const facts = await page
    .evaluate((max) => {
      const body = document.body
      const text = body === null ? '' : body.innerText
      return {
        title: document.title,
        bodyTextExcerpt: text.slice(0, max),
        htmlLength: document.documentElement === null ? 0 : document.documentElement.outerHTML.length,
        formCount: document.querySelectorAll('form').length,
        textLength: text.length,
      }
    }, excerptChars)
    .catch(() => ({ title: '', bodyTextExcerpt: '', htmlLength: 0, formCount: 0, textLength: 0 }))
  return facts
}

/**
 * The cookies ONE response asked the browser to store: the NAME and the
 * attributes, never the value. The value is dropped at the first `;` of the
 * header, so a session cookie can never leak through an observation.
 */
export function cookiesFromSetCookie(headers: { name: string; value: string }[], max = 50): BrowserRawCookie[] {
  const cookies: BrowserRawCookie[] = []
  for (const header of headers) {
    if (header.name.toLowerCase() !== 'set-cookie') continue
    const parts = header.value.split(';')
    const name = (parts[0] ?? '').split('=')[0]?.trim()
    if (name === undefined || name.length === 0) continue
    const cookie: BrowserRawCookie = { name }
    for (const attribute of parts.slice(1)) {
      const [rawKey, ...rest] = attribute.trim().split('=')
      const key = (rawKey ?? '').toLowerCase()
      const value = rest.join('=').trim()
      if (key === 'domain' && value.length > 0) cookie.domain = value
      else if (key === 'path' && value.length > 0) cookie.path = value
      else if (key === 'httponly') cookie.httpOnly = true
      else if (key === 'secure') cookie.secure = true
      else if (key === 'samesite' && value.length > 0) cookie.sameSite = value
      else if (key === 'max-age' && value.length > 0) {
        const seconds = Number(value)
        if (Number.isFinite(seconds)) cookie.expires = Math.floor(Date.now() / 1000) + seconds
      } else if (key === 'expires' && value.length > 0) {
        const at = Date.parse(value)
        if (Number.isFinite(at)) cookie.expires = Math.floor(at / 1000)
      }
    }
    cookies.push(cookie)
    if (cookies.length >= max) break
  }
  return cookies
}

/** Everything {@link captureRawLoad} needs (all of it observed, none of it judged). */
export interface RawLoadInput {
  /** The URL this side asked for, when this side asked for one. */
  requestedUrl?: string
  /** The document response the browser observed, when one was observed. */
  response?: Response
  /** The recorder this load was observed with. */
  recorder: LoadRecorder
  /** The resource window marker (`LoadRecorder.responseMark()` at load start). */
  responseMark: number
  /** The frame tree to report (already enumerated). */
  frames: BrowserFrameInfo[]
  /** How many frames exist beyond the reported set (never a silent truncation). */
  framesOverflow?: number
  /** The navigations this load covers. */
  navigations: RecordedNavigation[]
  /** When the load started (ms since the epoch). */
  startedAtMs: number
  /** The maximum document excerpt in characters. */
  excerptChars: number
  /** A screenshot of the landed page, when one was taken. */
  screenshot?: { path: string; width: number; height: number }
}

/** Captures ONE load: transport, document, resources, cookies, frames, timing. */
export async function captureRawLoad(page: Page, input: RawLoadInput): Promise<BrowserRawLoad> {
  const response = input.response
  const responseHeaders: Record<string, string> = {}
  let cookiesSet: BrowserRawCookie[] = []
  if (response !== undefined) {
    const headers = await response.allHeaders().catch(() => ({}))
    for (const [name, value] of Object.entries(headers)) responseHeaders[name.toLowerCase()] = value
    const raw = await response.headersArray().catch(() => [])
    cookiesSet = cookiesFromSetCookie(raw)
  }
  const redirects: string[] = []
  if (response !== undefined) {
    let hop = response.request().redirectedFrom()
    while (hop !== null) {
      redirects.unshift(hop.url())
      hop = hop.redirectedFrom()
    }
  }
  const document = await documentFacts(page, input.excerptChars)
  const startedAt = new Date(input.startedAtMs).toISOString()
  const endedAtMs = Date.now()
  return {
    transport: {
      requestedUrl: input.requestedUrl ?? page.url(),
      finalUrl: page.url(),
      ...(response === undefined ? {} : { httpStatus: response.status(), statusText: response.statusText() }),
      responseHeaders,
      redirects,
    },
    document,
    resources: input.recorder.resourcesSince(input.responseMark),
    cookiesSet,
    timing: { startedAt, endedAt: new Date(endedAtMs).toISOString(), durationMs: endedAtMs - input.startedAtMs },
    browserInitiatedNavigations: input.navigations
      .filter((navigation) => navigation.kind === 'browser')
      .map((navigation) => rawNavigation(navigation)),
    ...(input.framesOverflow === undefined ? {} : { framesOverflow: input.framesOverflow }),
    frames: input.frames,
    ...(input.screenshot === undefined ? {} : { screenshot: input.screenshot }),
  } as BrowserRawLoad & { framesOverflow?: number }
}

/** One recorded navigation, as the contract reports it (raw facts only). */
export function rawNavigation(navigation: RecordedNavigation): BrowserRawNavigation {
  return {
    at: navigation.at,
    url: navigation.url,
    kind: navigation.kind,
    ...(navigation.httpStatus === undefined ? {} : { httpStatus: navigation.httpStatus }),
    ...(navigation.statusText === undefined ? {} : { statusText: navigation.statusText }),
  }
}
