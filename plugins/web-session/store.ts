// The session store: WHERE a session's state lives, WHAT is persisted, and WHEN
// a session is evicted.
//
// The persisted artefact is a playwright STORAGE STATE file (cookies +
// localStorage) under the configured state dir - the `PW_STATE_FILE` /
// `storageState` recipe that already runs in production. Two properties matter:
//
//   1. the file is OUTSIDE any repository (`<stateDir>/state/<label>.json`,
//      git-ignored) and written 0600, because cookies are live credentials;
//   2. only cookies/localStorage are written. A LOGIN PASSWORD is never part of
//      a storage state: it is resolved from the credentials service at login
//      time, used, and dropped. `sanitizeState` enforces the shape on write, so
//      a future caller cannot accidentally persist something else.
//
// The decision functions here are pure (`isIdle`, `pickEvictions`), so the TTL
// and the eviction order are unit-tested without a browser.
import fs from 'node:fs'
import path from 'node:path'
import { str } from '../web-page/config.ts'
import { SessionError } from './errors.ts'

export interface StorageStateCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface StorageStateOrigin {
  origin: string
  localStorage?: { name: string; value: string }[]
}

export interface StorageState {
  cookies: StorageStateCookie[]
  origins: StorageStateOrigin[]
}

export function emptyState(): StorageState {
  return { cookies: [], origins: [] }
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => str(item)).filter((item): item is string => item !== undefined)
}

/**
 * Keep ONLY the storage-state shape (cookies + origins/localStorage): anything
 * else a caller hands over is dropped, so no other object can ever be persisted.
 */
export function sanitizeState(raw: unknown): StorageState {
  if (raw === null || typeof raw !== 'object') return emptyState()
  const source = raw as { cookies?: unknown; origins?: unknown }
  const cookies: StorageStateCookie[] = []
  if (Array.isArray(source.cookies)) {
    for (const item of source.cookies) {
      if (item === null || typeof item !== 'object') continue
      const cookie = item as Record<string, unknown>
      const name = str(cookie.name)
      const domain = str(cookie.domain)
      if (name === undefined || domain === undefined) continue
      cookies.push({
        name,
        value: typeof cookie.value === 'string' ? cookie.value : '',
        domain,
        path: str(cookie.path) ?? '/',
        ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
        ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
        ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
        ...(str(cookie.sameSite) === undefined ? {} : { sameSite: str(cookie.sameSite) as string }),
      })
    }
  }
  const origins: StorageStateOrigin[] = []
  if (Array.isArray(source.origins)) {
    for (const item of source.origins) {
      if (item === null || typeof item !== 'object') continue
      const origin = str((item as { origin?: unknown }).origin)
      if (origin === undefined) continue
      const rawStorage = (item as { localStorage?: unknown }).localStorage
      const localStorage: { name: string; value: string }[] = []
      if (Array.isArray(rawStorage)) {
        for (const entry of rawStorage) {
          if (entry === null || typeof entry !== 'object') continue
          const name = str((entry as { name?: unknown }).name)
          if (name === undefined) continue
          const value = (entry as { value?: unknown }).value
          localStorage.push({ name, value: typeof value === 'string' ? value : '' })
        }
      }
      origins.push({ origin, ...(localStorage.length === 0 ? {} : { localStorage }) })
    }
  }
  return { cookies, origins }
}

/** Parse a state file body; a corrupt file is `undefined` (never fatal). */
export function parseState(text: string): StorageState | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    const state = sanitizeState(parsed)
    return state
  } catch {
    return undefined
  }
}

export interface ReadStateResult {
  exists: boolean
  state: StorageState | undefined
  error: string | undefined
}

/** Read a state file (missing file is normal: it just means "not logged in yet"). */
export async function readStateFile(file: string): Promise<ReadStateResult> {
  try {
    const text = await fs.promises.readFile(file, 'utf8')
    const state = parseState(text)
    return { exists: true, state, ...(state === undefined ? { error: 'the state file is not valid JSON and was ignored' } : { error: undefined }) }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as { code?: string }).code : undefined
    if (code === 'ENOENT') return { exists: false, state: undefined, error: undefined }
    return { exists: false, state: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Write a state file atomically and 0600: a reader never sees a partial file and
 * only the owner can read the cookies. The directory is created 0700.
 */
export async function writeStateFile(file: string, raw: unknown): Promise<StorageState> {
  const state = sanitizeState(raw)
  const dir = path.dirname(file)
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${String(process.pid)}.tmp`
    await fs.promises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(tmp, file)
    await fs.promises.chmod(file, 0o600).catch(() => undefined)
  } catch (error) {
    throw new SessionError('internal', `could not write the session state file ${file}`, {
      detail: error instanceof Error ? error.message : String(error),
      hint: 'check the permissions of the configured stateDir',
    })
  }
  return state
}

/** Cookie/origin/localStorage counts of a state (never a value). */
export function stateSummary(state: StorageState): { cookies: number; origins: number; localStorage: number } {
  return {
    cookies: state.cookies.length,
    origins: state.origins.length,
    localStorage: state.origins.reduce((total, origin) => total + (origin.localStorage?.length ?? 0), 0),
  }
}

/** `true` when the state carries anything at all (a usable stored login). */
export function stateUsable(state: StorageState | undefined): boolean {
  return state !== undefined && (state.cookies.length > 0 || state.origins.some((origin) => (origin.localStorage?.length ?? 0) > 0))
}

/** The names of the cookies in a state (for diagnostics; never a value). */
export function cookieNames(state: StorageState): string[] {
  return state.cookies.map((cookie) => cookie.name)
}

/** `true` when a session has been idle longer than the TTL (ttl 0 = never idle). */
export function isIdle(lastUsedAt: number, now: number, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false
  return now - lastUsedAt > ttlSeconds * 1000
}

export interface LiveSessionInfo {
  label: string
  lastUsedAt: number
}

/**
 * Which live sessions to evict: first every IDLE one, then - while more than
 * `maxSessions` remain - the least recently used. Pure, so the order is pinned
 * by a test without a browser.
 */
export function pickEvictions(live: LiveSessionInfo[], now: number, ttlSeconds: number, maxSessions: number): string[] {
  const idle = live.filter((session) => isIdle(session.lastUsedAt, now, ttlSeconds)).map((session) => session.label)
  const remaining = live.filter((session) => !idle.includes(session.label)).sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  const evictions = [...idle]
  let overflow = remaining.length - maxSessions
  for (const session of remaining) {
    if (overflow <= 0) break
    evictions.push(session.label)
    overflow -= 1
  }
  // A deterministic order helps the tests and the logs.
  return evictions.sort()
}

/** A human label of a state file location, for logs (never a value). */
export function stateLabel(file: string): string {
  return path.basename(file)
}

/** `true` when `needle` appears anywhere in the serialized state (test guard). */
export function stateContains(state: StorageState, needle: string): boolean {
  return needle.length > 0 && JSON.stringify(state).includes(needle)
}

/** The declared credential NAMES of a site's login flow (never a value). */
export function loginCredentialNames(fields: { credential: string | undefined }[]): string[] {
  return fields.map((field) => field.credential).filter((name): name is string => name !== undefined)
}
