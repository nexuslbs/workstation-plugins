// The playwright implementation of the small driver interface the session
// manager talks to.
//
// Why an interface at all: the manager (dispatch, deltas, budgets, error
// mapping, persistence) is the product of this plugin and must be unit-testable
// WITHOUT a browser; only this file knows playwright. A test injects a fake
// `SessionDriver`, so the action dispatch and the error mapping are pinned by
// fast tests, and the real browser is exercised by the end-to-end gate.
//
// `playwright-core` is imported DYNAMICALLY (inside `openContext`) through the
// SHARED launcher of `plugins/web-shared/browser.ts`, so `web-page` and
// `web-session` never fight over chromium and a deployment without the module
// still loads both plugins and answers a structured error.
import type { BrowserContext, Locator, Page } from 'playwright-core'
import type { ResolvedConfig, ResolvedSite } from './config.ts'
import type { Snapshot } from './delta.ts'
import type { ObservedRequest } from './intercept.ts'
import { SessionError } from './errors.ts'
import type { ParsedSelector } from './selectors.ts'
import { acquireSharedBrowser, releaseSharedBrowser } from '../../shared/browser.ts'

export interface ElementRead {
  tag: string
  /** innerText of the element. */
  text: string
  /** outerHTML of the element (bounded by the caller's cap). */
  html: string
  attrs: Record<string, string>
}

export interface OutlineRead {
  headings: { level: number; text: string }[]
  links: { text: string; href: string }[]
}

export interface DriverPage {
  url(): string
  title(): Promise<string>
  goto(url: string, timeoutMs: number, waitUntil: string): Promise<number | undefined>
  /** Let in-flight XHRs land, bounded (never a fixed long sleep). */
  settle(timeoutMs: number): Promise<void>
  click(selector: ParsedSelector, timeoutMs: number): Promise<void>
  fill(selector: ParsedSelector, value: string, timeoutMs: number): Promise<void>
  select(selector: ParsedSelector, value: string, timeoutMs: number): Promise<void>
  press(selector: ParsedSelector | undefined, key: string, timeoutMs: number): Promise<void>
  waitFor(selector: ParsedSelector | undefined, state: string, timeoutMs: number): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  hasText(text: string, timeoutMs: number): Promise<boolean>
  count(selector: ParsedSelector): Promise<number>
  elements(selector: ParsedSelector, limit: number): Promise<ElementRead[]>
  outline(limits: { headings: number; links: number }): Promise<OutlineRead>
  snapshot(): Promise<Snapshot>
  close(): Promise<void>
}

export interface DriverRequestResult {
  status: number
  contentType: string
  body: string
}

export interface DriverContext {
  page: DriverPage
  /** Every page RESPONSE of this context is reported here (interception). */
  onResponse(handler: (observed: ObservedRequest) => void): void
  /** playwright storage state (cookies + localStorage) of this context. */
  storageState(): Promise<unknown>
  /** A direct HTTP call that SHARES this context's cookies. */
  request(url: string, method: string, timeoutMs: number): Promise<DriverRequestResult>
  close(): Promise<void>
}

export interface DriverOpenOptions {
  /** A previously persisted storage state; absent: a brand new context. */
  storageState?: unknown
}

/** What the session manager needs from a browser. */
export interface SessionDriver {
  openContext(site: ResolvedSite, options: DriverOpenOptions): Promise<DriverContext>
}

// ---------------------------------------------------------------------------
// Page-side scripts. They run INSIDE the browser, so they are written as
// strings: this project's tsconfig carries no DOM lib (the host process never
// touches a DOM) and a string is not type-checked as host code.
// ---------------------------------------------------------------------------

/**
 * The text-node snapshot the delta is computed from: one entry per element
 * whose text comes from its OWN text nodes (a container whose text comes from
 * descendants is not an entry, so a re-rendered container is not reported).
 * `input`/`textarea`/`select` values are deliberately EXCLUDED: a filled
 * password field must never reach a delta payload.
 */
const SNAPSHOT_SCRIPT = `() => {
  const refOf = (el) => {
    if (el.id) return '#' + el.id;
    const testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + testid + '"]';
    const name = el.getAttribute('name');
    if (name) return '[name="' + name + '"]';
    let node = el, parts = [];
    while (node && node.nodeType === 1 && parts.length < 4) {
      let index = 1, sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) index++; sib = sib.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return parts.join('>');
  };
  const flat = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  const SKIP = { script: 1, style: 1, noscript: 1, svg: 1, template: 1, input: 1, textarea: 1, select: 1, option: 1 };
  const nodes = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (SKIP[tag]) continue;
    const own = flat(el.textContent);
    if (own.length === 0) continue;
    let child = false;
    for (const c of el.children) { if (flat(c.textContent).length > 0) { child = true; break; } }
    if (child) continue;
    nodes.push({ ref: refOf(el), tag: tag, text: flat(el.innerText || el.textContent).slice(0, 400) });
  }
  return { url: location.href, title: document.title || '', nodes: nodes };
}`

/** The bounded outline of a page: headings + links, no body text. */
const OUTLINE_SCRIPT = (headings: number, links: number): string => `() => {
  const flat = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  const out = { headings: [], links: [] };
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (out.headings.length >= ${String(headings)}) break;
    const text = flat(el.textContent);
    if (text.length > 0) out.headings.push({ level: Number(el.tagName.slice(1)), text: text.slice(0, 160) });
  }
  for (const el of document.querySelectorAll('a[href]')) {
    if (out.links.length >= ${String(links)}) break;
    const text = flat(el.textContent);
    if (text.length > 0 && el.href && !el.href.startsWith('javascript:')) out.links.push({ text: text.slice(0, 100), href: el.href });
  }
  return out;
}`

/** One element's metadata (tag, attributes, outerHTML); `text` is read natively. */
const ELEMENT_SCRIPT = `(node) => ({
  tag: node.tagName.toLowerCase(),
  attrs: Object.fromEntries(Array.from(node.attributes).map((a) => [a.name, a.value])),
  html: node.outerHTML,
})`

/**
 * Materialize a page-side function SOURCE into a REAL function object.
 *
 * The host process carries no DOM lib, so the page scripts below are written as
 * SOURCE STRINGS. Playwright, however, only calls a page function when it gets a
 * real Function (it serializes it with `toString()` and invokes it in the page).
 * A bare source string is evaluated as an EXPRESSION instead: `() => {...}`
 * evaluates to a function OBJECT, which is not serializable over the RPC, so
 * `evaluate()` resolves to `undefined` - exactly the\n * `Cannot read properties of undefined` the end-to-end gate caught. `new Function`
 * (not `eval`) keeps the source out of this module's scope.
 */
function pageFunction<T>(source: string): T {
  return new Function(`return (${source})`)() as T
}

const SNAPSHOT_FN = pageFunction<() => { url: string; title: string; nodes: { ref: string; tag: string; text: string }[] }>(SNAPSHOT_SCRIPT)
const ELEMENT_FN = pageFunction<(node: unknown) => { tag: string; attrs: Record<string, string>; html: string }>(ELEMENT_SCRIPT)

class PlaywrightPage implements DriverPage {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  url(): string {
    return this.page.url()
  }

  async title(): Promise<string> {
    return await this.page.title()
  }

  async goto(url: string, timeoutMs: number, waitUntil: string): Promise<number | undefined> {
    const response = await this.page.goto(url, { timeout: timeoutMs, waitUntil: waitUntil as 'domcontentloaded' })
    return response === null ? undefined : response.status()
  }

  async settle(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined)
    // A short bounded flush: a SPA that answers an XHR after networkidle has
    // been reached still has its response observed by the recorder.
    await this.page.waitForTimeout(Math.min(150, timeoutMs)).catch(() => undefined)
  }

  private locate(selector: ParsedSelector): Locator {
    if (selector.kind === 'css') return this.page.locator(selector.css as string)
    if (selector.kind === 'xpath') return this.page.locator(`xpath=${selector.xpath as string}`)
    const role = selector.role as string
    const options = selector.name === undefined ? undefined : { name: selector.name }
    // playwright's role union is exhaustive; a caller's role string is resolved
    // at run time by playwright itself (an unknown role is a named failure).
    return (this.page.getByRole as (r: string, o?: { name: string }) => Locator)(role, options)
  }

  async click(selector: ParsedSelector, timeoutMs: number): Promise<void> {
    await this.locate(selector).first().click({ timeout: timeoutMs })
  }

  async fill(selector: ParsedSelector, value: string, timeoutMs: number): Promise<void> {
    await this.locate(selector).first().fill(value, { timeout: timeoutMs })
  }

  async select(selector: ParsedSelector, value: string, timeoutMs: number): Promise<void> {
    await this.locate(selector).first().selectOption(value, { timeout: timeoutMs })
  }

  async press(selector: ParsedSelector | undefined, key: string, timeoutMs: number): Promise<void> {
    if (selector === undefined) await this.page.keyboard.press(key)
    else await this.locate(selector).first().press(key, { timeout: timeoutMs })
  }

  async waitFor(selector: ParsedSelector | undefined, state: string, timeoutMs: number): Promise<void> {
    const options = { state: state as 'visible', timeout: timeoutMs }
    if (selector === undefined) await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs })
    else await this.locate(selector).first().waitFor(options)
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms)
  }

  async hasText(text: string, timeoutMs: number): Promise<boolean> {
    return await this.page
      .getByText(text)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
  }

  async count(selector: ParsedSelector): Promise<number> {
    return await this.locate(selector).count()
  }

  async elements(selector: ParsedSelector, limit: number): Promise<ElementRead[]> {
    const locator = this.locate(selector)
    const count = await locator.count()
    const out: ElementRead[] = []
    for (let index = 0; index < Math.min(count, limit); index += 1) {
      const element = locator.nth(index)
      const text = await element.innerText().catch(() => '')
      const meta = (await element.evaluate(ELEMENT_FN)) as { tag: string; attrs: Record<string, string>; html: string }
      out.push({ tag: meta.tag, attrs: meta.attrs, html: meta.html, text })
    }
    return out
  }

  async outline(limits: { headings: number; links: number }): Promise<OutlineRead> {
    const source = OUTLINE_SCRIPT(limits.headings, limits.links)
    const script = pageFunction<() => OutlineRead>(source)
    return (await this.page.evaluate(script)) as OutlineRead
  }

  async snapshot(): Promise<Snapshot> {
    const raw = (await this.page.evaluate(SNAPSHOT_FN)) as { url: string; title: string; nodes: { ref: string; tag: string; text: string }[] }
    return { url: raw.url, title: raw.title, nodes: raw.nodes }
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined)
  }
}

class PlaywrightContext implements DriverContext {
  private readonly context: BrowserContext
  readonly page: DriverPage

  constructor(context: BrowserContext, page: Page) {
    this.context = context
    this.page = new PlaywrightPage(page)
  }

  onResponse(handler: (observed: ObservedRequest) => void): void {
    this.context.on('response', (response) => {
      const request = response.request()
      let contentType = ''
      try {
        contentType = response.headers()['content-type'] ?? ''
      } catch {
        contentType = ''
      }
      handler({ method: request.method(), url: response.url(), resourceType: request.resourceType(), contentType, status: response.status() })
    })
  }

  async storageState(): Promise<unknown> {
    return await this.context.storageState()
  }

  async request(url: string, method: string, timeoutMs: number): Promise<DriverRequestResult> {
    const response = await this.context.request.fetch(url, { method, timeout: timeoutMs, failOnStatusCode: false })
    return { status: response.status(), contentType: response.headers()['content-type'] ?? '', body: await response.text() }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
  }
}

/** The real (playwright) driver: a storage-state context on the SHARED browser. */
export class PlaywrightDriver implements SessionDriver {
  private readonly config: ResolvedConfig
  private readonly resolveProxyCredential: ((name: string) => Promise<string | undefined>) | undefined
  private held = 0

  constructor(config: ResolvedConfig, resolveProxyCredential?: (name: string) => Promise<string | undefined>) {
    this.config = config
    if (resolveProxyCredential !== undefined) this.resolveProxyCredential = resolveProxyCredential
  }

  /** How many browser holders this driver still owns (diagnostics). */
  get holders(): number {
    return this.held
  }

  async openContext(site: ResolvedSite, options: DriverOpenOptions): Promise<DriverContext> {
    const proxy = await this.proxyOptions()
    const browser = await acquireSharedBrowser({
      args: this.config.browserArgs,
      timeoutMs: this.config.navigationTimeoutMs,
      ...(this.config.executablePath === undefined ? {} : { executablePath: this.config.executablePath }),
      ...(proxy === undefined ? {} : { proxy }),
      headless: true,
    }).catch((error: unknown) => {
      throw new SessionError('browser_unavailable', 'chromium could not be launched', {
        site: site.label,
        detail: error instanceof Error ? error.message : String(error),
        hint: 'set executablePath or PLAYWRIGHT_BROWSERS_PATH so the deployment provides chromium',
      })
    })
    this.held += 1
    const contextOptions: Parameters<typeof browser.newContext>[0] = { viewport: { width: 1280, height: 900 } }
    if (options.storageState !== undefined) contextOptions.storageState = options.storageState as never
    if (this.config.userAgent !== undefined) contextOptions.userAgent = this.config.userAgent
    const context = await browser.newContext(contextOptions).catch(async (error: unknown) => {
      this.held -= 1
      await releaseSharedBrowser()
      throw new SessionError('internal', 'the browser context could not be created', {
        site: site.label,
        detail: error instanceof Error ? error.message : String(error),
      })
    })
    const blocked = this.config.blockResourceTypes
    if (blocked.length > 0) {
      // Resource blocking is a cost decision, not a policy: images/fonts/media
      // are never needed by a text read and a page without them settles faster.
      await context
        .route('**/*', (route) => {
          const type = route.request().resourceType()
          if (blocked.includes(type)) return route.abort().catch(() => undefined)
          return route.continue().catch(() => undefined)
        })
        .catch(() => undefined)
    }
    const page = await context.newPage()
    return new PlaywrightContext(context, page)
  }

  /** Resolve the proxy password by NAME (never logged, never persisted). */
  private async proxyOptions(): Promise<{ server: string; username?: string; password?: string } | undefined> {
    const proxy = this.config.proxy
    if (proxy === undefined) return undefined
    const out: { server: string; username?: string; password?: string } = { server: proxy.server }
    if (proxy.username !== undefined) out.username = proxy.username
    if (proxy.credential !== undefined && this.resolveProxyCredential !== undefined) {
      const value = await this.resolveProxyCredential(proxy.credential)
      if (value !== undefined) out.password = value
    }
    return out
  }

  /** Release every browser holder this driver owns (plugin unload). */
  async dispose(): Promise<void> {
    while (this.held > 0) {
      this.held -= 1
      await releaseSharedBrowser()
    }
  }
}
