// Configuration of the `web-session` plugin: the `plugins: web-session:` row of
// the deployment config, resolved ONCE at load into the shape the code uses.
//
// The row carries a SITE TABLE (label -> base URL + state file + login flow +
// origin allow-list + optional API read path). No per-site knowledge is
// hardcoded in the plugin: everything a site needs is config (or, later, the
// web-recipe store). NO CREDENTIAL VALUE IS EVER WRITTEN HERE: a login field
// carries a credential NAME (or a `${cred:NAME}` reference the core expands
// BEFORE the plugin loads) which is resolved at call time through
// `ctx.credentials` and never logged, echoed or persisted.
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_BROWSER_ARGS, DEFAULT_BLOCKED_RESOURCES, str } from '../web-page/config.ts'

/** Where the session state (storage state files + spill) lives by default. */
export function defaultStateDir(): string {
  return path.join(os.tmpdir(), 'workbench-web-session')
}

/** One login field: a selector plus the credential NAME (or a literal value). */
export interface LoginFieldConfig {
  /** Readable field name (for diagnostics only, never a value). */
  name?: string
  /** Selector of the input (CSS by default; `xpath=`/`role=` also accepted). */
  selector: string
  /** Credential NAME resolved through ctx.credentials at login time. */
  credential?: string
  /** A literal value (used when `credential` is absent; never a secret). */
  value?: string
}

export interface LoginConfig {
  /** Login page: absolute, or relative to the site's base URL. */
  url: string
  /** Logged-OUT marker: when this matches after a navigation, a (re-)login runs. */
  indicator?: string
  /** Fields to fill, in order. */
  fields: LoginFieldConfig[]
  /** The submit control (optional: Enter is pressed on the last field). */
  submit?: string
  /** What proves the login worked (checked after submit). */
  success?: { selector?: string; urlContains?: string; textContains?: string }
}

export interface SessionSiteConfig {
  /** The site root; a relative `url` in a call resolves against it. */
  baseUrl: string
  /** Storage-state file (cookies + localStorage); default `<stateDir>/state/<label>.json`. */
  stateFile?: string
  /** Extra origins the site's JSON endpoints may live on (same-origin is implicit). */
  allowOrigins?: string[]
  /** The declared login flow (auto re-login when the session looks expired). */
  login?: LoginConfig
  /** API-first read: an endpoint ref (id, path or URL) used by `read` with no selector. */
  readPath?: { api?: string }
}

/** The `plugins: web-session:` row, exactly as an operator writes it. */
export interface WebSessionConfig {
  /** Where the state files and spill files live (default `<tmp>/workbench-web-session`). */
  stateDir?: string
  /** Where an oversized answer spills (default `<stateDir>/spill`). */
  spillDir?: string
  /** Idle seconds after which a live session is evicted (state persisted first; default 900). */
  idleTtlSeconds?: number
  /** How many sessions may be live at once; the idlest is evicted (default 4). */
  maxSessions?: number
  /** The label used when a call omits `site` (default: the only configured site). */
  defaultSite?: string
  /** Default `max_chars` of a returned body/outline (default 6000). */
  maxChars?: number
  /** Hard ceiling a caller can never exceed (default 60000). */
  hardMaxChars?: number
  /** Cap of the `open` outline (default 1200). */
  outlineMaxChars?: number
  /** Cap of a delta payload (default 2500). */
  deltaMaxChars?: number
  /** How many text nodes a delta may report (default 60). */
  maxDeltaNodes?: number
  /** How many nodes a selector-scoped read may return (default 50). */
  maxSelectorNodes?: number
  /** How many endpoints the discovery list may hold (default 30). */
  maxEndpoints?: number
  /** How many `act` steps one call may carry (default 20). */
  maxSteps?: number
  /** `goto` timeout in ms (default 30000). */
  navigationTimeoutMs?: number
  /** Per-step / settle budget in ms (default 10000). */
  actionTimeoutMs?: number
  /** Extra navigation attempts after a transport failure (default 1). */
  retries?: number
  /** Navigation wait strategy (default `domcontentloaded`, then a bounded settle). */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'
  /** Chromium executable. Absent: playwright's own resolution (PLAYWRIGHT_BROWSERS_PATH). */
  executablePath?: string
  /** Extra chromium argv (default `--no-sandbox --disable-dev-shm-usage --disable-gpu`). */
  browserArgs?: string[]
  /** Override the User-Agent. */
  userAgent?: string
  /** Resource types never downloaded (default `image`, `media`, `font`). */
  blockResourceTypes?: string[]
  /** Per-request proxy. `credential` is a credential NAME, never a value. */
  proxy?: { server: string; credential?: string; username?: string }
  /** Extra strings that must never appear in a log line (operator-side redaction). */
  redact?: string[]
  /** The site table (label -> site). At least one entry is needed to call the tool. */
  sites?: Record<string, SessionSiteConfig>
}

export interface ResolvedSite {
  label: string
  baseUrl: string
  /** Implicit allow-list entry: the site's own origin. */
  origin: string
  /** Extra origins allowed for endpoint calls. */
  allowOrigins: string[]
  stateFile: string
  login: ResolvedLogin | undefined
  readPath: { api: string } | undefined
}

export interface ResolvedLogin {
  url: string
  indicator: string | undefined
  fields: { name: string; selector: string; credential: string | undefined; value: string | undefined }[]
  submit: string | undefined
  success: { selector?: string; urlContains?: string; textContains?: string } | undefined
}

export interface ResolvedConfig {
  stateDir: string
  spillDir: string
  idleTtlSeconds: number
  maxSessions: number
  defaultSite: string | undefined
  maxChars: number
  hardMaxChars: number
  outlineMaxChars: number
  deltaMaxChars: number
  maxDeltaNodes: number
  maxSelectorNodes: number
  maxEndpoints: number
  maxSteps: number
  navigationTimeoutMs: number
  actionTimeoutMs: number
  retries: number
  waitUntil: 'domcontentloaded' | 'load' | 'networkidle'
  executablePath: string | undefined
  browserArgs: string[]
  blockResourceTypes: string[]
  userAgent: string | undefined
  proxy: { server: string; credential?: string; username?: string } | undefined
  redact: string[]
  sites: Map<string, ResolvedSite>
}

function boundInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.map((item) => str(item)).filter((item): item is string => item !== undefined)
  return list.length === 0 ? undefined : list
}

function waitUntilOf(value: unknown): 'domcontentloaded' | 'load' | 'networkidle' {
  return value === 'load' || value === 'networkidle' ? value : 'domcontentloaded'
}

function proxyOf(value: unknown): { server: string; credential?: string; username?: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const proxy = value as { server?: unknown; credential?: unknown; username?: unknown }
  const server = str(proxy.server)
  if (server === undefined) return undefined
  const out: { server: string; credential?: string; username?: string } = { server }
  const credential = str(proxy.credential)
  if (credential !== undefined) out.credential = credential
  const username = str(proxy.username)
  if (username !== undefined) out.username = username
  return out
}

/** `new URL(url, base).toString()` for an absolute or site-relative reference. */
export function absoluteUrl(baseUrl: string, url: string): string {
  return new URL(url, baseUrl).toString()
}

/** The default storage-state file of a site label. */
export function statePathFor(stateDir: string, label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return path.join(stateDir, 'state', `${safe}.json`)
}

/** Resolve one site row (a row without a usable baseUrl is skipped). */
export function resolveSite(label: string, raw: SessionSiteConfig, stateDir: string): ResolvedSite | undefined {
  const baseUrl = str(raw.baseUrl)
  if (baseUrl === undefined) return undefined
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return undefined
  }
  const login = resolveLogin(raw.login, baseUrl)
  return {
    label,
    baseUrl,
    origin,
    allowOrigins: (stringList(raw.allowOrigins) ?? []).map((value) => {
      try {
        return new URL(value).origin
      } catch {
        return value
      }
    }),
    stateFile: str(raw.stateFile) ?? statePathFor(stateDir, label),
    login,
    readPath: raw.readPath !== undefined && str(raw.readPath.api) !== undefined ? { api: str(raw.readPath.api) as string } : undefined,
  }
}

function resolveLogin(raw: LoginConfig | undefined, baseUrl: string): ResolvedLogin | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const url = str(raw.url)
  if (url === undefined) return undefined
  const rawFields = Array.isArray(raw.fields) ? raw.fields : []
  const fields = rawFields
    .filter((field): field is LoginFieldConfig => field !== null && typeof field === 'object' && str((field as LoginFieldConfig).selector) !== undefined)
    .map((field) => ({
      name: str(field.name) ?? 'field',
      selector: str(field.selector) as string,
      credential: str(field.credential),
      value: str(field.value),
    }))
  if (fields.length === 0) return undefined
  const success = raw.success !== undefined && raw.success !== null && typeof raw.success === 'object' ? raw.success : undefined
  const successSelectors =
    success === undefined
      ? undefined
      : {
          ...(str(success.selector) === undefined ? {} : { selector: str(success.selector) as string }),
          ...(str(success.urlContains) === undefined ? {} : { urlContains: str(success.urlContains) as string }),
          ...(str(success.textContains) === undefined ? {} : { textContains: str(success.textContains) as string }),
        }
  return {
    url: absoluteUrl(baseUrl, url),
    indicator: str(raw.indicator),
    fields,
    submit: str(raw.submit),
    success: successSelectors === undefined || Object.keys(successSelectors).length === 0 ? undefined : successSelectors,
  }
}

/** Resolve the operator row into the config the code uses (never throws). */
export function resolveConfig(raw: WebSessionConfig | undefined): ResolvedConfig {
  const config: WebSessionConfig = raw ?? {}
  const stateDir = str(config.stateDir) ?? defaultStateDir()
  const maxChars = boundInt(config.maxChars, 6000, 200, 200000)
  const sites = new Map<string, ResolvedSite>()
  for (const [label, siteRaw] of Object.entries(config.sites ?? {})) {
    if (siteRaw === null || typeof siteRaw !== 'object') continue
    const site = resolveSite(label, siteRaw, stateDir)
    if (site !== undefined) sites.set(label, site)
  }
  const defaultSite = str(config.defaultSite)
  return {
    stateDir,
    spillDir: str(config.spillDir) ?? path.join(stateDir, 'spill'),
    idleTtlSeconds: boundInt(config.idleTtlSeconds, 900, 0, 604800),
    maxSessions: boundInt(config.maxSessions, 4, 1, 32),
    defaultSite: defaultSite ?? (sites.size === 1 ? [...sites.keys()][0] : undefined),
    maxChars,
    hardMaxChars: boundInt(config.hardMaxChars, 60000, maxChars, 400000),
    outlineMaxChars: boundInt(config.outlineMaxChars, 1200, 200, 200000),
    deltaMaxChars: boundInt(config.deltaMaxChars, 2500, 200, 200000),
    maxDeltaNodes: boundInt(config.maxDeltaNodes, 60, 1, 500),
    maxSelectorNodes: boundInt(config.maxSelectorNodes, 50, 1, 500),
    maxEndpoints: boundInt(config.maxEndpoints, 30, 1, 500),
    maxSteps: boundInt(config.maxSteps, 20, 1, 100),
    navigationTimeoutMs: boundInt(config.navigationTimeoutMs, 30000, 1000, 180000),
    actionTimeoutMs: boundInt(config.actionTimeoutMs, 10000, 100, 60000),
    retries: boundInt(config.retries, 1, 0, 3),
    waitUntil: waitUntilOf(config.waitUntil),
    executablePath: str(config.executablePath),
    browserArgs: stringList(config.browserArgs) ?? DEFAULT_BROWSER_ARGS,
    blockResourceTypes: stringList(config.blockResourceTypes) ?? DEFAULT_BLOCKED_RESOURCES,
    userAgent: str(config.userAgent),
    proxy: proxyOf(config.proxy),
    redact: stringList(config.redact) ?? [],
    sites,
  }
}
