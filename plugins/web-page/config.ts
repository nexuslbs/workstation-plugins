// Configuration of the `web-page` plugin: one object the core hands over from
// the `plugins: web-page:` row of the deployment config, resolved ONCE at load
// into the shape the code uses.
import os from 'node:os'
import path from 'node:path'
import { resolveRecipeConfig } from './recipe.ts'
import type { RecipeConfig } from './recipe.ts'

/** The `plugins: web-page:` row, exactly as an operator writes it. */
export interface WebPageConfig {
  /** Where the page cache lives (default: `<tmp>/workbench-web-page`). */
  cacheDir?: string
  /** How long a cache entry counts as fresh, in seconds (default 900). */
  cacheTtlSeconds?: number
  /** Default `max_chars` of a returned body (default 8000). */
  maxChars?: number
  /** Hard ceiling a caller can never exceed (default 60000). */
  hardMaxChars?: number
  /** Where an oversized body is spilled (default: `<cacheDir>/spill`). */
  spillDir?: string
  /** `page.goto` timeout in ms (default 20000). */
  navigationTimeoutMs?: number
  /** Bounded secondary wait budget in ms (network-idle / first paint, default 6000). */
  actionTimeoutMs?: number
  /** Extra navigation attempts after a transport failure (default 1). */
  retries?: number
  /** Navigation wait strategy (default `domcontentloaded`, then a bounded settle). */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'
  /** Chromium executable. Absent: playwright's own resolution (PLAYWRIGHT_BROWSERS_PATH). */
  executablePath?: string
  /** Extra chromium argv (default `--no-sandbox --disable-dev-shm-usage`). */
  browserArgs?: string[]
  /** Override the User-Agent. */
  userAgent?: string
  /** Reusable browser contexts kept warm (default 2). */
  maxContexts?: number
  /** Resource types never downloaded (default `image`, `media`, `font`). */
  blockResourceTypes?: string[]
  /** Per-request proxy. `credential` is a credential NAME, never a value. */
  proxy?: { server: string; credential?: string; username?: string }
  /** Default cap of the `page map` outline (default 4000). */
  mapMaxChars?: number
  /** Extra strings that must never appear in a log line (values are NOT put in config). */
  redact?: string[]
  /**
   * Read-through of the `web-recipe` store (plugins/web-recipe): a stored recipe
   * for the domain is consulted BEFORE the page is rendered. `record` writes a
   * discovered read path back into the store and is OFF by default, so recipes
   * stay curated rather than accidental.
   */
  recipes?: {
    enabled?: boolean
    record?: boolean
    sourceThread?: string
  }
}

/** The resolved configuration: every field concrete, nothing optional. */
export interface ResolvedConfig {
  cacheDir: string
  cacheTtlSeconds: number
  maxChars: number
  hardMaxChars: number
  spillDir: string
  navigationTimeoutMs: number
  actionTimeoutMs: number
  retries: number
  waitUntil: 'domcontentloaded' | 'load' | 'networkidle'
  executablePath: string | undefined
  browserArgs: string[]
  userAgent: string | undefined
  maxContexts: number
  blockResourceTypes: string[]
  proxy: { server: string; credential?: string; username?: string } | undefined
  mapMaxChars: number
  redact: string[]
  recipes: RecipeConfig
}

export const DEFAULT_BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
export const DEFAULT_BLOCKED_RESOURCES = ['image', 'media', 'font']

/** The cache dir used when the config omits `cacheDir`. */
export function defaultCacheDir(): string {
  return path.join(os.tmpdir(), 'workbench-web-page')
}

/** Clamp an integer option into `[min, max]`, falling back on a non-number. */
function boundInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Resolve the operator row into the config the code uses (never throws). */
export function resolveConfig(raw: WebPageConfig | undefined): ResolvedConfig {
  const config: WebPageConfig = raw ?? {}
  const cacheDir = str(config.cacheDir) ?? defaultCacheDir()
  const maxChars = boundInt(config.maxChars, 8000, 200, 200000)
  return {
    cacheDir,
    cacheTtlSeconds: boundInt(config.cacheTtlSeconds, 900, 0, 86400),
    maxChars,
    hardMaxChars: boundInt(config.hardMaxChars, 60000, maxChars, 400000),
    spillDir: str(config.spillDir) ?? path.join(cacheDir, 'spill'),
    navigationTimeoutMs: boundInt(config.navigationTimeoutMs, 20000, 1000, 120000),
    actionTimeoutMs: boundInt(config.actionTimeoutMs, 6000, 100, 60000),
    retries: boundInt(config.retries, 1, 0, 3),
    waitUntil: waitUntilOf(config.waitUntil),
    executablePath: str(config.executablePath),
    browserArgs: stringList(config.browserArgs) ?? DEFAULT_BROWSER_ARGS,
    userAgent: str(config.userAgent),
    maxContexts: boundInt(config.maxContexts, 2, 1, 8),
    blockResourceTypes: stringList(config.blockResourceTypes) ?? DEFAULT_BLOCKED_RESOURCES,
    proxy: proxyOf(config.proxy),
    mapMaxChars: boundInt(config.mapMaxChars, 4000, 200, 200000),
    redact: stringList(config.redact) ?? [],
    recipes: resolveRecipeConfig(config.recipes),
  }
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

/** A trimmed non-empty string, or `undefined`. */
export function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A non-empty list of trimmed non-empty strings, or `undefined`. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.map((item) => str(item)).filter((item): item is string => item !== undefined)
  return list.length === 0 ? undefined : list
}
