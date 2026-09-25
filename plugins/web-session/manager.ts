// The session manager: the ONE tool's behaviour. It owns
//
//   * the LIVE session table (one playwright context per site label, persisted
//     storage state, TTL + LRU eviction, process-restart survival),
//   * the ACTION DISPATCH of the `session` tool (open/act/read/close),
//   * the AUTO (RE-)LOGIN from credential NAMEs when a configured indicator says
//     the session is expired (the login flow is config, never hardcoded),
//   * the DELTA reporter (what changed after an `act`/`navigate`, never a dump),
//   * the selector-scoped `read` (CSS / XPath / role+name) and the bounded
//     outline when no selector is given,
//   * the API DISCOVERY + direct endpoint call path (cheaper than a re-render),
//   * the hard budgets and the structured error envelope (every failure is a
//     code + message, and the process keeps serving).
//
// It talks to the browser through the small `SessionDriver` interface, so the
// dispatch/delta/budget/error logic is unit-tested without chromium, and it
// reaches the shared chromium through `PlaywrightDriver`.
import type { LoggerHandle } from '../../definitions/logger.ts'
import { str } from '../web-page/config.ts'
import { extractMain, renderOutline } from '../web-page/extract.ts'
import { messageOf } from '../web-page/errors.ts'
import { capText, estimateTokens } from '../web-page/spill.ts'
import { absoluteUrl } from './config.ts'
import type { ResolvedConfig, ResolvedLogin, ResolvedSite } from './config.ts'
import { diffSnapshots } from './delta.ts'
import type { Snapshot } from './delta.ts'
import { PlaywrightDriver } from './driver.ts'
import type { DriverContext, DriverPage, SessionDriver } from './driver.ts'
import { SessionError } from './errors.ts'
import type { SessionErrorCode } from './errors.ts'
import { EndpointRecorder, originAllowed, sanitizeUrl } from './intercept.ts'
import type { Endpoint } from './intercept.ts'
import { parseSelectorSpec } from './selectors.ts'
import type { ParsedSelector } from './selectors.ts'
import { isIdle, pickEvictions, readStateFile, stateContains, stateSummary, stateUsable, writeStateFile } from './store.ts'

/** The `act` step types (a SMALL closed set, documented in the README). */
export const STEP_TYPES = ['click', 'fill', 'select', 'press', 'waitFor', 'navigate'] as const
export type StepType = (typeof STEP_TYPES)[number]

const WAIT_STATES = ['visible', 'hidden', 'attached', 'detached']
const FORMATS = ['text', 'markdown', 'html', 'json']

/** Collaborators a test can replace (the real ones are the playwrght driver). */
export interface SessionDeps {
  driver?: SessionDriver
  now?: () => number
  /** The typed logger SERVICE handle the plugin passes in (docs/LOGGING.md). */
  logger?: LoggerHandle
}

/** The handle a manager built without a host logger gets: it prints NOTHING. */
const SILENT_LOGGER: LoggerHandle = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

export type CredentialResolver = (name: string) => Promise<string | undefined>

interface LiveSession {
  label: string
  site: ResolvedSite
  context: DriverContext
  page: DriverPage
  recorder: EndpointRecorder
  lastUsedAt: number
  /** The last text snapshot (the delta baseline of the next act). */
  snapshot: Snapshot | undefined
  /** Was a usable stored state file found when the session was opened? */
  stateUsableAtOpen: boolean
  /** How many (re-)logins this live session performed. */
  logins: number
  /** Was the site's base URL loaded on this context yet? */
  ready: boolean
  /** The URL the session was last on (resume point after a re-login). */
  currentUrl: string
}

function intOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

/**
 * Normalize one `act` step. The README documents TWO forms:
 *
 *   { type: 'click', selector: '#save', value: 'x', timeout_ms: 5000 }
 *   { click: '#save' }                       // compact: the key IS the type
 *
 * The compact form accepts a string (the selector, or - for `press`/`navigate`/
 * a numeric `waitFor` - the value/url/milliseconds) or an object merged into the
 * step. Anything else is returned untouched so the caller gets the named
 * `invalid_input` error instead of a crash.
 */
function normalizeStep(raw: Record<string, unknown>): Record<string, unknown> {
  if (str(raw.type) !== undefined) return raw
  for (const candidate of STEP_TYPES) {
    const shorthand = raw[candidate]
    if (shorthand === undefined) continue
    if (typeof shorthand !== 'string') {
      return { ...raw, type: candidate, ...(shorthand as Record<string, unknown>) }
    }
    if (candidate === 'navigate') return { ...raw, type: candidate, url: shorthand }
    if (candidate === 'press') return { ...raw, type: candidate, value: shorthand }
    if (candidate === 'waitFor' && /^[0-9]+$/.test(shorthand)) return { ...raw, type: candidate, value: shorthand }
    return { ...raw, type: candidate, selector: shorthand }
  }
  return raw
}

/** Map a browser/transport failure text onto a named error code. */
export function codeFor(text: string, fallback: SessionErrorCode): SessionErrorCode {
  if (/strict mode violation/i.test(text)) return 'bad_selector'
  if (/waiting for (locator|selector|element)/i.test(text) && /timeout/i.test(text)) return 'no_match'
  if (/timeout [0-9]+ms exceeded/i.test(text)) return 'timeout'
  if (/selector|querySelector|xpath|unexpected token|is not a valid selector/i.test(text)) return 'bad_selector'
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(text)) return 'dns'
  if (/ERR_CERT|SSL|TLS/i.test(text)) return 'tls'
  if (/ERR_CONNECTION|ECONNREFUSED|ECONNRESET|socket hang up/i.test(text)) return 'connection'
  if (/browser has been closed|Target (page|closed)|crashed/i.test(text)) return 'browser_unavailable'
  if (/executable doesn't exist|browserType\.launch/i.test(text)) return 'browser_unavailable'
  if (/HTTP [45][0-9][0-9]/.test(text)) return 'http_status'
  return fallback
}

/** `payload` plus the char/token size of the payload BEFORE the counters. */
function withMeasure<T extends Record<string, unknown>>(payload: T): T & { chars: number; estimatedTokens: number } {
  const chars = JSON.stringify(payload)?.length ?? 0
  return { ...payload, chars, estimatedTokens: estimateTokens(chars) }
}

export class SessionManager {
  private readonly config: ResolvedConfig
  private readonly driver: SessionDriver
  private readonly ownedDriver: PlaywrightDriver | undefined
  private readonly resolveCredential: CredentialResolver
  private readonly now: () => number
  private readonly live = new Map<string, LiveSession>()

  /**
   * The typed logger SERVICE handle (docs/LOGGING.md): the manager PRINTS
   * nothing itself, every operator-visible line is a Message through the
   * service, and a test that builds the manager without one gets silence.
   */
  private readonly log: LoggerHandle

  constructor(config: ResolvedConfig, resolveCredential: CredentialResolver, deps: SessionDeps = {}) {
    this.config = config
    this.resolveCredential = resolveCredential
    this.now = deps.now ?? ((): number => Date.now())
    this.log = deps.logger ?? SILENT_LOGGER
    if (deps.driver !== undefined) {
      this.driver = deps.driver
    } else {
      const owned = new PlaywrightDriver(config, resolveCredential)
      this.ownedDriver = owned
      this.driver = owned
    }
  }

  /** The live session labels (diagnostics; never a credential). */
  liveLabels(): string[] {
    return [...this.live.keys()]
  }

  // -------------------------------------------------------------------------
  // The single dispatch of the `session` tool.
  // -------------------------------------------------------------------------
  async execute(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = str(params.action)
    switch (action) {
      case 'open':
        return await this.open(params)
      case 'act':
        return await this.act(params)
      case 'read':
        return await this.read(params)
      case 'close':
        return await this.close(params)
      default:
        throw new SessionError('invalid_input', `unknown action '${String(params.action)}'`, {
          hint: 'action must be one of: open, act, read, close',
        })
    }
  }

  // -------------------------------------------------------------------------
  // open
  // -------------------------------------------------------------------------
  private async open(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { label, site } = this.siteOf(params.site)
    await this.evictAllIdle()
    await this.evict(label, 1)
    const live = await this.ensureLive(label, site)
    live.lastUsedAt = this.now()
    const requested = str(params.url)
    const target = requested === undefined ? site.baseUrl : absoluteUrl(site.baseUrl, requested)
    const status = await this.goto(live, target)
    live.ready = true
    const login = await this.ensureAuthenticated(live, { resumeUrl: target })
    live.currentUrl = live.page.url()
    const snapshot = await live.page.snapshot()
    live.snapshot = snapshot
    const outline = await this.outlineOf(live)
    const state = await this.stateOf(live)
    const endpoints = this.endpointsOf(live)
    const delta = withMeasure(diffSnapshots(undefined, snapshot, this.budget()))
    return {
      status: 'ok',
      action: 'open',
      site: label,
      url: live.page.url(),
      title: snapshot.title,
      httpStatus: status ?? null,
      session: { stateFile: site.stateFile, state, live: true, logins: live.logins },
      ...(login === undefined ? {} : { login }),
      outline,
      endpoints,
      delta,
    }
  }

  // -------------------------------------------------------------------------
  // act
  // -------------------------------------------------------------------------
  private async act(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { label, site } = this.siteOf(params.site)
    await this.evictAllIdle()
    const live = await this.ensureLive(label, site)
    live.lastUsedAt = this.now()
    await this.ensureReady(live)
    const before = live.snapshot
    const endpointsBefore = live.recorder.list().length
    const rawSteps = params.steps
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new SessionError('invalid_input', 'the `act` action needs a non-empty `steps` array', {
        site: label,
        hint: `each step is {type: ${STEP_TYPES.join('|')}, selector?, value?, url?, timeout_ms?}`,
      })
    }
    if (rawSteps.length > this.config.maxSteps) {
      throw new SessionError('budget', `the call carries ${rawSteps.length} steps, the limit is ${this.config.maxSteps}`, { site: label })
    }
    const results: Record<string, unknown>[] = []
    for (let index = 0; index < rawSteps.length; index += 1) {
      const step = rawSteps[index]
      if (step === null || typeof step !== 'object') {
        throw new SessionError('invalid_input', `step ${index} must be an object`, { site: label })
      }
      const result = await this.runStep(live, index, step as Record<string, unknown>)
      results.push(result)
      live.currentUrl = live.page.url()
    }
    // Let the UI react to the steps before sampling: a click that triggers an
    // XHR must show up in THIS delta, not only on the next call (the fixture
    // SPA updates `#total` from the response of the click).
    await live.page.settle(this.config.actionTimeoutMs)
    const after = await live.page.snapshot()
    live.snapshot = after
    const delta = withMeasure(diffSnapshots(before, after, this.budget()))
    const newlyDiscovered = live.recorder.since(endpointsBefore)
    return {
      status: 'ok',
      action: 'act',
      site: label,
      url: live.page.url(),
      title: after.title,
      steps: results,
      delta,
      endpoints: {
        total: live.recorder.list().length,
        discovered: newlyDiscovered.map((endpoint) => this.publicEndpoint(endpoint)),
        blocked: live.recorder.blocked,
        dropped: live.recorder.dropped,
      },
    }
  }

  private async runStep(live: LiveSession, index: number, rawStep: Record<string, unknown>): Promise<Record<string, unknown>> {
    const step = normalizeStep(rawStep)
    const type = str(step.type)
    if (type === undefined || !STEP_TYPES.includes(type as StepType)) {
      throw new SessionError('invalid_input', `step ${index} has no usable type`, {
        site: live.label,
        hint: `step types: ${STEP_TYPES.join(', ')}`,
      })
    }
    const timeout = intOf(step.timeout_ms) ?? this.config.actionTimeoutMs
    const value = str(step.value)
    const selectorText = str(step.selector)
    const parsed = selectorText === undefined ? undefined : parseSelectorSpec(selectorText)
    const target = parsed === undefined ? type : `${type} ${parsed.raw}`
    try {
      switch (type as StepType) {
        case 'click': {
          await live.page.click(this.requireSelector(parsed, index, type, live), timeout)
          break
        }
        case 'fill': {
          if (value === undefined) throw new SessionError('invalid_input', `step ${index} (fill) needs a value`, { site: live.label })
          await live.page.fill(this.requireSelector(parsed, index, type, live), value, timeout)
          break
        }
        case 'select': {
          if (value === undefined) throw new SessionError('invalid_input', `step ${index} (select) needs a value`, { site: live.label })
          await live.page.select(this.requireSelector(parsed, index, type, live), value, timeout)
          break
        }
        case 'press': {
          await live.page.press(parsed, value ?? 'Enter', timeout)
          break
        }
        case 'waitFor': {
          if (parsed === undefined) await live.page.waitForTimeout(intOf(value) ?? intOf(step.timeout_ms) ?? 250)
          else await live.page.waitFor(parsed, this.waitState(value), timeout)
          break
        }
        case 'navigate': {
          const rawUrl = str(step.url) ?? value
          if (rawUrl === undefined) throw new SessionError('invalid_input', `step ${index} (navigate) needs a url`, { site: live.label })
          const url = absoluteUrl(live.site.baseUrl, rawUrl)
          await this.goto(live, url, true)
          await this.ensureAuthenticated(live, { resumeUrl: url, force: true })
          break
        }
      }
    } catch (error) {
      if (error instanceof SessionError && error.code === 'invalid_input') throw error
      const text = messageOf(error)
      throw new SessionError(codeFor(text, 'step_failed'), `step ${index} (${target}) failed`, {
        site: live.label,
        step: target,
        ...(parsed === undefined ? {} : { selector: parsed.raw }),
        detail: text,
        retryable: codeFor(text, 'step_failed') === 'timeout',
        hint: 'check the selector, the value and the page state; `read` reports what the page currently contains',
      })
    }
    return { index, type, ...(parsed === undefined ? {} : { selector: parsed.raw }), ...(value === undefined ? {} : { value }), ok: true }
  }

  private waitState(value: string | undefined): string {
    return value !== undefined && WAIT_STATES.includes(value) ? value : 'visible'
  }

  private requireSelector(parsed: ParsedSelector | undefined, index: number, type: string, live: LiveSession): ParsedSelector {
    if (parsed === undefined) {
      throw new SessionError('invalid_input', `step ${index} (${type}) needs a selector`, { site: live.label })
    }
    return parsed
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------
  private async read(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { label, site } = this.siteOf(params.site)
    await this.evictAllIdle()
    const live = await this.ensureLive(label, site)
    live.lastUsedAt = this.now()
    await this.ensureReady(live)
    const maxChars = this.clampChars(params.max_chars)
    const api = str(params.api)
    if (api === 'list') return this.endpointListResponse(live, maxChars)
    if (api !== undefined && api !== '') return await this.callApi(live, api, maxChars, false)
    const selectorText = str(params.selector)
    if (selectorText !== undefined) return await this.readSelector(live, selectorText, this.formatOf(params.format), maxChars)
    if (site.readPath !== undefined) return await this.callApi(live, site.readPath.api, maxChars, true)
    return await this.readOutline(live, maxChars)
  }

  private formatOf(value: unknown): string {
    const format = str(value)
    return format !== undefined && FORMATS.includes(format) ? format : 'text'
  }

  private async readSelector(live: LiveSession, selectorText: string, format: string, maxChars: number): Promise<Record<string, unknown>> {
    const parsed = parseSelectorSpec(selectorText)
    let matched = 0
    try {
      matched = await live.page.count(parsed)
    } catch (error) {
      const text = messageOf(error)
      throw new SessionError(codeFor(text, 'bad_selector'), `the selector '${parsed.raw}' is not usable`, {
        site: live.label,
        selector: parsed.raw,
        detail: text,
      })
    }
    if (matched === 0) {
      throw new SessionError('no_match', `the selector '${parsed.raw}' matched nothing on the page`, {
        site: live.label,
        url: live.page.url(),
        selector: parsed.raw,
        hint: 'read with no selector to get the page outline, or re-check the selector form',
      })
    }
    const limit = Math.min(matched, this.config.maxSelectorNodes)
    const elements = await live.page.elements(parsed, limit)
    if (format === 'json') {
      const items = elements.map((element) => ({ tag: element.tag, attrs: element.attrs, text: element.text.slice(0, 2000) }))
      const trimmed = this.trimJson(items, maxChars)
      return withMeasure({
        status: 'ok',
        action: 'read',
        via: 'selector',
        site: live.label,
        url: live.page.url(),
        selector: parsed.raw,
        kind: parsed.kind,
        format,
        matched,
        returned: trimmed.items.length,
        items: trimmed.items,
        ...(trimmed.dropped === 0 ? {} : { truncation: { dropped: trimmed.dropped } }),
      })
    }
    const body = elements
      .map((element, index) => {
        if (format === 'html') return element.html
        if (format === 'markdown') return extractMain(element.html, { url: live.page.url(), maxLinks: 0 }).markdown
        return element.text
      })
      .join('\n')
      .trim()
    const capped = await capText(body, maxChars, this.config.spillDir, `${live.label}-${parsed.kind}`)
    return {
      status: 'ok',
      action: 'read',
      via: 'selector',
      site: live.label,
      url: live.page.url(),
      selector: parsed.raw,
      kind: parsed.kind,
      format,
      matched,
      returned: elements.length,
      body: capped.text,
      chars: capped.shownChars,
      estimatedTokens: capped.estimatedTokens,
      ...(capped.capped ? { truncation: { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } } : {}),
    }
  }

  private trimJson(items: Record<string, unknown>[], maxChars: number): { items: Record<string, unknown>[]; dropped: number } {
    const kept = [...items]
    let dropped = 0
    while (kept.length > 0 && JSON.stringify(kept).length > maxChars) {
      kept.pop()
      dropped += 1
    }
    return { items: kept, dropped }
  }

  private async readOutline(live: LiveSession, maxChars: number): Promise<Record<string, unknown>> {
    const outline = (await this.outlineOf(live)) as {
      title: string
      headings: Parameters<typeof renderOutline>[0]['headings']
      links: Parameters<typeof renderOutline>[0]['links']
      chars: number
    }
    const markdown = renderOutline({
      title: outline.title,
      headings: outline.headings,
      links: outline.links,
      sections: [],
      chars: outline.chars,
    })
    const capped = await capText(markdown, maxChars, this.config.spillDir, `${live.label}-outline`)
    return {
      status: 'ok',
      action: 'read',
      via: 'outline',
      site: live.label,
      url: live.page.url(),
      title: outline.title,
      outline,
      endpoints: this.endpointsOf(live),
      body: capped.text,
      chars: capped.shownChars,
      estimatedTokens: capped.estimatedTokens,
      ...(capped.capped ? { truncation: { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // API discovery + direct endpoint calls
  // -------------------------------------------------------------------------
  private async endpointListResponse(live: LiveSession, maxChars: number): Promise<Record<string, unknown>> {
    const endpoints = this.endpointsOf(live)
    const payload = withMeasure({
      status: 'ok',
      action: 'read',
      via: 'api-list',
      site: live.label,
      url: live.page.url(),
      hint: 'call one with read {api: "E1"} (or its path) and get its JSON without re-rendering',
      endpoints,
    })
    void maxChars
    return payload
  }

  private publicEndpoint(endpoint: Endpoint): Record<string, unknown> {
    return {
      id: endpoint.id,
      method: endpoint.method,
      url: endpoint.url,
      path: endpoint.path,
      name: endpoint.name,
      ...(endpoint.contentType.length === 0 ? {} : { contentType: endpoint.contentType }),
      ...(endpoint.status === undefined ? {} : { status: endpoint.status }),
      hits: endpoint.hits,
    }
  }

  private endpointsOf(live: LiveSession): Record<string, unknown> {
    return {
      count: live.recorder.list().length,
      blocked: live.recorder.blocked,
      dropped: live.recorder.dropped,
      list: live.recorder.list().map((endpoint) => this.publicEndpoint(endpoint)),
    }
  }

  private async callApi(live: LiveSession, ref: string, maxChars: number, configured: boolean): Promise<Record<string, unknown>> {
    const endpoint = live.recorder.resolve(ref)
    if (endpoint === undefined) {
      throw new SessionError('api_failed', `no discovered endpoint matches '${ref}'`, {
        site: live.label,
        hint: `read {api: "list"} lists the discovered endpoints (ids E1, E2, ...)`,
      })
    }
    const method = endpoint.method === '' ? 'GET' : endpoint.method
    if (method !== 'GET' && method !== 'POST') {
      throw new SessionError('api_failed', `the endpoint '${endpoint.id}' uses ${method}, only GET/POST may be called`, { site: live.label })
    }
    if (!originAllowed(endpoint.url, live.site.origin, live.site.allowOrigins)) {
      throw new SessionError('blocked_origin', `the endpoint '${endpoint.url}' is not on the site's origin nor on its allow-list`, {
        site: live.label,
        hint: `add the origin to allowOrigins of site '${live.label}' if it is trusted`,
      })
    }
    const url = sanitizeUrl(endpoint.url)
    let result: { status: number; contentType: string; body: string }
    try {
      result = await live.context.request(url, method, this.config.navigationTimeoutMs)
    } catch (error) {
      const text = messageOf(error)
      throw new SessionError(codeFor(text, 'api_failed'), `the endpoint '${endpoint.id}' could not be called`, {
        site: live.label,
        url,
        detail: text,
      })
    }
    const looksJson = /json/i.test(result.contentType)
    let data: unknown
    if (looksJson) {
      try {
        data = JSON.parse(result.body)
      } catch {
        data = undefined
      }
    }
    const text = data === undefined ? result.body : JSON.stringify(data)
    const capped = await capText(text, maxChars, this.config.spillDir, `${live.label}-${endpoint.name}`)
    if (result.status >= 400) {
      throw new SessionError('api_failed', `the endpoint '${endpoint.id}' answered HTTP ${result.status}`, {
        site: live.label,
        url,
        detail: capped.text.slice(0, 300),
        retryable: result.status >= 500,
      })
    }
    return {
      status: 'ok',
      action: 'read',
      via: 'api',
      configured,
      site: live.label,
      api: endpoint.id,
      method,
      url,
      path: endpoint.path,
      httpStatus: result.status,
      ...(endpoint.contentType.length === 0 ? {} : { contentType: endpoint.contentType }),
      chars: capped.shownChars,
      estimatedTokens: capped.estimatedTokens,
      ...(looksJson && data !== undefined && !capped.capped ? { data } : { body: capped.text }),
      ...(capped.capped ? { truncation: { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------
  private async close(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { label, site } = this.siteOf(params.site)
    const live = this.live.get(label)
    if (live === undefined) {
      const stored = await readStateFile(site.stateFile)
      return {
        status: 'ok',
        action: 'close',
        site: label,
        closed: false,
        note: 'no live session for this site (the stored state file is untouched)',
        stateFile: site.stateFile,
        state: stored.state === undefined ? null : stateSummary(stored.state),
      }
    }
    const state = await this.detach(label)
    return {
      status: 'ok',
      action: 'close',
      site: label,
      closed: true,
      stateFile: site.stateFile,
      state,
    }
  }

  // -------------------------------------------------------------------------
  // Site resolution, live table, eviction, persistence
  // -------------------------------------------------------------------------
  private siteOf(rawSite: unknown): { label: string; site: ResolvedSite } {
    const requested = str(rawSite) ?? this.config.defaultSite
    const labels = [...this.config.sites.keys()]
    if (requested === undefined) {
      throw new SessionError('unknown_site', 'no site was given and no default site is configured', {
        hint: labels.length === 0 ? 'configure at least one site under `plugins: web-session: sites:`' : `pass one of: ${labels.join(', ')}`,
      })
    }
    const site = this.config.sites.get(requested)
    if (site === undefined) {
      throw new SessionError('unknown_site', `no site named '${requested}' is configured${labels.length === 0 ? '' : ` (known sites: ${labels.join(', ')})`}`, {
        hint: labels.length === 0 ? 'configure at least one site under `plugins: web-session: sites:`' : `configured sites: ${labels.join(', ')}`,
      })
    }
    return { label: requested, site }
  }

  private async ensureLive(label: string, site: ResolvedSite): Promise<LiveSession> {
    const existing = this.live.get(label)
    if (existing !== undefined) {
      existing.lastUsedAt = this.now()
      return existing
    }
    const stored = await readStateFile(site.stateFile)
    const usable = stateUsable(stored.state)
    const context = await this.driver.openContext(site, usable ? { storageState: stored.state } : {})
    // Operator-visible, secret-free: WHICH state file was used, and whether it
    // was usable (an unusable state is what triggers the re-login below).
    this.log.info(
      `site '${label}': ${usable ? 'storage state restored from' : 'no usable storage state at'} ${site.stateFile}`,
    )
    const live: LiveSession = {
      label,
      site,
      context,
      page: context.page,
      recorder: new EndpointRecorder({ origin: site.origin, allowOrigins: site.allowOrigins, max: this.config.maxEndpoints }),
      lastUsedAt: this.now(),
      snapshot: undefined,
      stateUsableAtOpen: usable,
      logins: 0,
      ready: false,
      currentUrl: '',
    }
    context.onResponse((observed) => {
      live.recorder.observe(observed)
    })
    this.live.set(label, live)
    return live
  }

  /** Load the site's base URL once, so `read`/`act` work after a restart. */
  private async ensureReady(live: LiveSession): Promise<void> {
    if (live.ready) return
    const url = live.site.baseUrl
    await this.goto(live, url)
    await this.ensureAuthenticated(live, { resumeUrl: url })
    live.currentUrl = live.page.url()
    live.snapshot = await live.page.snapshot()
    // Only now is the session usable: a failure above must not leave `ready`
    // set, or the next action would trust a half-initialized live session.
    live.ready = true
  }

  private budget(): { maxNodes: number; maxChars: number } {
    return { maxNodes: this.config.maxDeltaNodes, maxChars: this.config.deltaMaxChars }
  }

  private clampChars(raw: unknown): number {
    const requested = intOf(raw)
    if (requested === undefined) return this.config.maxChars
    return Math.min(Math.max(requested, 200), this.config.hardMaxChars)
  }

  private async outlineOf(live: LiveSession): Promise<Record<string, unknown>> {
    const outline = await live.page.outline({ headings: 40, links: 30 })
    const title = await live.page.title().catch(() => '')
    const headings = [...outline.headings]
    const links = [...outline.links]
    let chars = JSON.stringify({ headings, links }).length
    while (chars > this.config.outlineMaxChars && links.length > 0) {
      links.pop()
      chars = JSON.stringify({ headings, links }).length
    }
    while (chars > this.config.outlineMaxChars && headings.length > 0) {
      headings.pop()
      chars = JSON.stringify({ headings, links }).length
    }
    return {
      title,
      headings,
      links,
      shown: { headings: outline.headings.length, links: outline.links.length },
      chars,
    }
  }

  private async stateOf(live: LiveSession): Promise<Record<string, unknown>> {
    const stored = await readStateFile(live.site.stateFile)
    const summary = stored.state === undefined ? { cookies: 0, origins: 0, localStorage: 0 } : stateSummary(stored.state)
    return { ...summary, file: live.site.stateFile, exists: stored.exists }
  }

  /** Persist the live context's storage state to disk (0600, git-ignored dir). */
  private async persist(live: LiveSession): Promise<void> {
    try {
      const state = await live.context.storageState()
      await writeStateFile(live.site.stateFile, state)
    } catch {
      // A session that cannot be persisted still works in this process; the
      // failure is reported on `close`/`open` through the state summary.
    }
  }

  /** Persist + close + release one live session; returns its state summary. */
  private async detach(label: string): Promise<Record<string, unknown>> {
    const live = this.live.get(label)
    if (live === undefined) return { cookies: 0, origins: 0, localStorage: 0 }
    this.live.delete(label)
    await this.persist(live)
    const stored = await readStateFile(live.site.stateFile)
    const summary = stored.state === undefined ? { cookies: 0, origins: 0, localStorage: 0 } : stateSummary(stored.state)
    await live.page.close()
    await live.context.close()
    return summary
  }

  /** Evict idle sessions, then the LRU ones while `reserve` new ones must fit. */
  private async evict(except: string | undefined, reserve: number): Promise<string[]> {
    const now = this.now()
    const candidates = [...this.live.values()].filter((session) => session.label !== except)
    const max = Math.max(1, this.config.maxSessions - reserve)
    const victims = pickEvictions(
      candidates.map((session) => ({ label: session.label, lastUsedAt: session.lastUsedAt })),
      now,
      this.config.idleTtlSeconds,
      max,
    )
    for (const label of victims) await this.detach(label)
    return victims
  }

  /**
   * Detach EVERY idle session (called at the start of an action). The action's
   * own site is included on purpose: an idle session is dropped and a fresh
   * context is established lazily from the PERSISTED state, which is exactly
   * what a TTL means - and the state file is what makes the fresh context
   * authenticated again. Returns the evicted labels.
   */
  private async evictAllIdle(): Promise<string[]> {
    const now = this.now()
    const victims = [...this.live.values()]
      .filter((session) => isIdle(session.lastUsedAt, now, this.config.idleTtlSeconds))
      .map((session) => session.label)
    for (const label of victims) await this.detach(label)
    return victims
  }

  // -------------------------------------------------------------------------
  // Navigation + auto (re-)login
  // -------------------------------------------------------------------------
  private async goto(live: LiveSession, url: string, force = false): Promise<number | undefined> {
    const attempts = this.config.retries + 1
    let last: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const status = await live.page.goto(url, this.config.navigationTimeoutMs, this.config.waitUntil)
        await live.page.settle(this.config.actionTimeoutMs)
        if (status !== undefined && status >= 400 && !force) {
          throw new SessionError('http_status', `the page answered HTTP ${status}`, {
            site: live.label,
            url,
            retryable: status >= 500,
          })
        }
        live.currentUrl = live.page.url()
        return status
      } catch (error) {
        last = error
        if (error instanceof SessionError && !error.retryable) break
        const text = messageOf(error)
        const code = codeFor(text, 'connection')
        if (attempt === attempts || code === 'bad_selector' || code === 'http_status') break
      }
    }
    if (last instanceof SessionError) throw last
    const text = messageOf(last)
    throw new SessionError(codeFor(text, 'connection'), 'the page could not be opened', {
      site: live.label,
      url,
      detail: text,
      retryable: codeFor(text, 'connection') === 'timeout',
    })
  }

  /** `undefined` when the site declares no login flow at all. */
  private async ensureAuthenticated(
    live: LiveSession,
    options: { resumeUrl?: string; force?: boolean },
  ): Promise<Record<string, unknown> | undefined> {
    const login = live.site.login
    if (login === undefined) return undefined
    const expired = options.force === true || (await this.loggedOut(live, login))
    if (!expired) return { required: true, performed: false, detected: false, fields: login.fields.length }
    const resume = options.resumeUrl ?? live.page.url() ?? live.site.baseUrl
    const startedAt = this.now()
    const info = await this.performLogin(live, login)
    if (resume.length > 0) await this.goto(live, resume, true)
    await this.persist(live)
    live.logins += 1
    // Credential NAMES only: the resolved VALUES never reach a log line, a tool
    // response or the state file (the state file holds cookies, not passwords).
    this.log.info(
      `site '${live.label}': session was expired, re-login performed from credentials [${login.fields
        .map((field) => field.credential ?? `literal:${field.name}`)
        .join(', ')}]`,
    )
    live.ready = true
    return {
      required: true,
      performed: true,
      detected: true,
      fields: info.fields,
      submit: info.submit,
      credentialMissing: info.missing,
      durationMs: this.now() - startedAt,
    }
  }

  /**
   * Is the session logged out? Two signals, in order:
   *   1. the configured `indicator` selector matches (the page says so), or
   *   2. there was NO usable stored state when the session opened and no login
   *      ran yet - a site that DECLARES a login flow wants one established, so
   *      a deleted state file deterministically triggers the re-login instead of
   *      depending on the page's mood.
   */
  private async loggedOut(live: LiveSession, login: ResolvedLogin): Promise<boolean> {
    const indicator = login.indicator
    if (indicator !== undefined) {
      try {
        if ((await live.page.count(parseSelectorSpec(indicator))) > 0) return true
      } catch {
        // An unusable indicator must not fail the call; signal 2 still applies.
      }
    }
    return !live.stateUsableAtOpen && live.logins === 0
  }

  private async performLogin(live: LiveSession, login: ResolvedLogin): Promise<{ fields: number; submit: string; missing: string[] }> {
    await this.goto(live, login.url, true)
    const missing: string[] = []
    for (const field of login.fields) {
      let value = field.value
      if (field.credential !== undefined) {
        const resolved = await this.resolveCredential(field.credential)
        value = resolved
        if (value === undefined || value.length === 0) {
          missing.push(field.credential)
          continue
        }
      }
      if (value === undefined) {
        if (!missing.includes(field.name)) missing.push(field.name)
        continue
      }
      try {
        await live.page.fill(parseSelectorSpec(field.selector), value, this.config.actionTimeoutMs)
      } catch (error) {
        const text = messageOf(error)
        throw new SessionError(codeFor(text, 'login_failed'), `the login field '${field.name}' could not be filled`, {
          site: live.label,
          selector: field.selector,
          detail: text,
          hint: 'check the login field selector in the site config',
        })
      } finally {
        // The resolved value is only ever a local: never logged, never persisted.
        value = ''
      }
    }
    if (missing.length > 0) {
      throw new SessionError('login_failed', `the login flow could not resolve ${missing.length} credential(s): ${missing.join(', ')}`, {
        site: live.label,
        hint: `declare these credential NAMEs in the configured credentials provider (or in the login field's literal value): ${missing.join(', ')}`,
      })
    }
    const submit = login.submit ?? '(Enter on the last field)'
    if (login.submit !== undefined) await live.page.click(parseSelectorSpec(login.submit), this.config.actionTimeoutMs)
    else await live.page.press(undefined, 'Enter', this.config.actionTimeoutMs)
    await live.page.settle(this.config.actionTimeoutMs)
    const verdict = await this.loginVerdict(live, login)
    if (!verdict.ok) {
      throw new SessionError('login_failed', `the login did not appear to succeed (${verdict.checked})`, {
        site: live.label,
        url: live.page.url(),
        hint: 'check the login URL, the field selectors and the `success` conditions of the site config',
      })
    }
    return { fields: login.fields.length, submit, missing }
  }

  private async loginVerdict(live: LiveSession, login: ResolvedLogin): Promise<{ ok: boolean; checked: string }> {
    const success = login.success
    if (success !== undefined) {
      if (success.selector !== undefined) {
        const count = await live.page.count(parseSelectorSpec(success.selector)).catch(() => 0)
        return { ok: count > 0, checked: `success selector ${success.selector}` }
      }
      if (success.urlContains !== undefined) {
        return { ok: live.page.url().includes(success.urlContains), checked: `success urlContains ${success.urlContains}` }
      }
      if (success.textContains !== undefined) {
        const present = await live.page.hasText(success.textContains, this.config.actionTimeoutMs)
        return { ok: present, checked: `success textContains ${success.textContains}` }
      }
    }
    if (login.indicator !== undefined) {
      const still = await live.page.count(parseSelectorSpec(login.indicator)).catch(() => 0)
      return { ok: still === 0, checked: `the logged-out indicator ${login.indicator} is gone` }
    }
    return { ok: true, checked: 'no success conditions declared (accepted)' }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  /** Persist + close every live session and drop the browser holders. */
  async dispose(): Promise<void> {
    for (const label of [...this.live.keys()]) await this.detach(label)
    if (this.ownedDriver !== undefined) await this.ownedDriver.dispose()
  }

  /** Diagnostics used by the tests and by README examples (never a secret). */
  inspect(): Record<string, unknown> {
    return {
      sites: [...this.config.sites.keys()],
      stateDir: this.config.stateDir,
      live: [...this.live.values()].map((session) => ({
        site: session.label,
        url: session.page.url(),
        logins: session.logins,
        endpoints: session.recorder.list().length,
        stateFile: session.site.stateFile,
      })),
    }
  }
}

/** Exported for the tests: the store never leaks a credential into a delta. */
export { stateContains }
