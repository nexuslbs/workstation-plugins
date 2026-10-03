// shared/pricing.ts - the SHARED LLM price definition (peak / off-peak).
//
// WHY (operator, telegram 2026-10-02 + 2026-10-03)
// ------------------------------------------------
// The dsh/workstation cost accounting used to price every call from a COMPILED
// `PRICE_TABLE` at the vendors' PEAK (standard) rates, so inside DeepSeek's
// off-peak window the reported `cost.amount_usd` was about 2x the real charge.
// The operator asked whether off-peak hours are taken into account, and the
// same external-file pricing was made configurable for the omniagent core
// (task_omnidev_make_llm_token_pricing_configurable). This module is the dsh
// side of the SAME definition file, so the two tables cannot drift:
//
//   {OMNI_DIR}/config/model_prices.yml
//
// ONE provider -> model hierarchy, ONE set of canonical field names
// (`input` / `cached_input` / `output` / `cache_write` / optional `reasoning`),
// plus the time-aware `off_peak:` block and the per-route `off_peak_factor`.
// The dsh-internal spelling `cache_read` is gone: it is MAPPED to the canonical
// `cached_input` at the call sites.
//
// ABSENT / EMPTY / INVALID FILE -> cost 0, NEVER AN ERROR (operator contract,
// same as the core): a missing, empty or unparseable file answers a NUMERIC 0
// cost block whose `pricing_ref` says why (`#missing` / `#empty` / `#invalid`).
// A route absent from a VALID file stays UNPRICED (`cost: null`), never
// fabricated as 0.
//
// RELOAD SEMANTICS: the file is re-read when its path/mtime/size changes, so
// editing a rate or a window takes effect on the next call with no rebuild, no
// restart and no release. `source` names the file, `pricing_ref` is
// `config/model_prices.yml@<version>#<content-hash>` - the SAME identity the
// omniagent core records.
//
// TIME-AWARE COST
// ---------------
// The rate class of a call is selected from the CALL time in UTC (never the
// container's local time). The applied class is recorded on every priced entry
// (`rate_class: 'peak' | 'off-peak'`) together with `call_time`, and the
// multiplier when it applied (`off_peak_factor`), so a cost can be audited
// against its call time. A call with NO time at all falls back to PEAK and
// never errors. A route WITHOUT `off_peak_factor` is always peak, whatever the
// calendar says (flat-priced providers such as Google).

import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The definition file's name inside `{OMNI_DIR}/config/`. */
export const PRICES_FILE = 'model_prices.yml'

/** The definition file's path relative to the omni dir. */
export const PRICES_RELATIVE = `config/${PRICES_FILE}`

/** The `source` of every computed cost (the external file, never a module). */
export const PRICES_SOURCE = PRICES_FILE

/** The rate class applied to one call. */
export type RateClass = 'peak' | 'off-peak'

/** One per-call cost block. `amount_usd` is null only for an unpriced route. */
export interface UsageCost {
  amount_usd: number | null
  is_estimate: boolean
  source: string
  pricing_ref: string | null
  /** The rate class actually applied (audit against `call_time`). */
  rate_class?: RateClass
  /** The UTC call time the class was derived from (null when unknown). */
  call_time?: string | null
  /** The multiplier applied, present only when the class is `off-peak`. */
  off_peak_factor?: number
}

/** The token counts one cost is computed from (`cacheRead` = cache-hit). */
export interface UsageTokens {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/** The canonical per-route rates, USD per 1,000,000 tokens (PEAK rates). */
export interface Rates {
  input: number
  cached_input: number
  output: number
  cache_write: number
  reasoning: number | null
  /** `null`/absent = this route is never discounted. */
  off_peak_factor: number | null
}

/** One `[start, end)` UTC window, in minutes since midnight. */
export interface OffPeakWindow {
  start: number
  end: number
  class: RateClass
}

/** The validated `off_peak:` calendar. */
export interface OffPeak {
  defaultClass: RateClass
  weekdaysOnly: boolean
  holidayDates: string[]
  windows: OffPeakWindow[]
}

/** Why a table has no usable rates (or `loaded`). */
export type PriceStatus = 'loaded' | 'missing' | 'empty' | 'invalid'

/** One parsed definition file (or the status that says why there are no rates). */
export interface PriceTable {
  status: PriceStatus
  version: string
  hash: string
  path: string
  providers: Record<string, Record<string, Rates>>
  aliases: Record<string, string>
  offPeak: OffPeak | null
  /** `config/model_prices.yml@<version>#<hash>` or `...#missing|#empty|#invalid`. */
  pricingRef: string
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * The definition file's path: `{OMNI_DIR}/config/model_prices.yml`.
 *
 * `OMNI_DIR` is what the compose stack exports into the workstation container;
 * `/opt/omni` is the deployed default. Tests (and callers holding their own omni
 * dir) pass the path explicitly instead.
 */
export function priceFilePath(env: NodeJS.ProcessEnv = process.env, omniDir?: string): string {
  const dir = omniDir ?? nonEmpty(env.OMNI_DIR) ?? nonEmpty(env.OMNI_ROOT) ?? '/opt/omni'
  return join(dir, 'config', PRICES_FILE)
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// Content hash (FNV-1a 64-bit hex) - the SAME digest the core computes
// ---------------------------------------------------------------------------

/** FNV-1a 64-bit hex of a UTF-8 string; changes exactly when the file changes. */
export function contentHash(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

// ---------------------------------------------------------------------------
// Parsing: the documented YAML subset (js-yaml when the harness ships it)
// ---------------------------------------------------------------------------

interface ParsedFile {
  version: string
  providers: Record<string, Record<string, Rates>>
  aliases: Record<string, string>
  offPeak: OffPeak | null
}

interface YamlLine {
  indent: number
  text: string
  line: number
}

/** Drop a trailing `# comment` (never inside quotes). */
function stripComment(line: string): string {
  let single = false
  let double = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !double) single = !single
    else if (ch === '"' && !single) double = !double
    else if (ch === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** The index of the `key:` separator, or -1. */
function keyEnd(text: string): number {
  let single = false
  let double = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" && !double) single = !single
    else if (ch === '"' && !single) double = !double
    else if (ch === ':' && !single && !double) {
      const next = text[i + 1]
      if (next === undefined || next === ' ') return i
    }
  }
  return -1
}

function unquote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

function parseScalar(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner.length === 0) return []
    return splitTopLevel(inner).map((part) => parseScalar(part))
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim()
    const map: Record<string, unknown> = {}
    if (inner.length === 0) return map
    for (const part of splitTopLevel(inner)) {
      const colon = keyEnd(part)
      if (colon < 0) throw new Error(`bad flow mapping entry: ${part}`)
      map[unquote(part.slice(0, colon))] = parseScalar(part.slice(colon + 1))
    }
    return map
  }
  if (trimmed === '' || trimmed === '~' || trimmed.toLowerCase() === 'null') return null
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true'
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed)
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return unquote(trimmed)
  const asNumber = Number(trimmed)
  if (trimmed.length > 0 && Number.isFinite(asNumber)) return asNumber
  return trimmed
}

/** Split a flow-collection body on top-level commas (quotes and nesting respected). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  let single = false
  let double = false
  for (const ch of text) {
    if (ch === "'" && !double) single = !single
    else if (ch === '"' && !single) double = !double
    if (!single && !double) {
      if (ch === '[' || ch === '{') depth += 1
      else if (ch === ']' || ch === '}') depth -= 1
      else if (ch === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += ch
  }
  if (current.trim().length > 0) parts.push(current)
  return parts
}

function yamlLines(text: string): YamlLine[] {
  const out: YamlLine[] = []
  const raw = text.split(/\r?\n/)
  for (let index = 0; index < raw.length; index += 1) {
    const line = stripComment(raw[index])
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length
    if (line.trimStart().startsWith('\t')) throw new Error(`tab indentation at line ${index + 1}`)
    out.push({ indent, text: line.trim(), line: index + 1 })
  }
  return out
}

function parseMapping(lines: YamlLine[], start: number, indent: number): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) throw new Error(`unexpected indentation at line ${line.line}`)
    if (line.text === '-' || line.text.startsWith('- ')) throw new Error(`unexpected sequence item at line ${line.line}`)
    const colon = keyEnd(line.text)
    if (colon < 0) throw new Error(`expected 'key: value' at line ${line.line}`)
    const key = unquote(line.text.slice(0, colon))
    const rest = line.text.slice(colon + 1).trim()
    if (rest.length === 0) {
      const next = lines[index + 1]
      if (next === undefined || next.indent <= indent) {
        map[key] = null
        index += 1
        continue
      }
      const [value, nextIndex] = parseBlock(lines, index + 1, next.indent)
      map[key] = value
      index = nextIndex
      continue
    }
    map[key] = parseScalar(rest)
    index += 1
  }
  return [map, index]
}

function parseSequence(lines: YamlLine[], start: number, indent: number): [unknown[], number] {
  const items: unknown[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) throw new Error(`unexpected indentation at line ${line.line}`)
    if (!(line.text === '-' || line.text.startsWith('- '))) break
    const rest = line.text === '-' ? '' : line.text.slice(2).trim()
    if (rest.length === 0) {
      const next = lines[index + 1]
      if (next === undefined || next.indent <= indent) {
        items.push(null)
        index += 1
        continue
      }
      const [value, nextIndex] = parseBlock(lines, index + 1, next.indent)
      items.push(value)
      index = nextIndex
      continue
    }
    if (keyEnd(rest) >= 0) {
      // `- start: '01:00'` : the item is a map whose first key sits on the dash.
      const spliced = lines.slice()
      spliced[index] = { indent: indent + 2, text: rest, line: line.line }
      const [value, nextIndex] = parseMapping(spliced, index, indent + 2)
      items.push(value)
      index = nextIndex
      continue
    }
    items.push(parseScalar(rest))
    index += 1
  }
  return [items, index]
}

function parseBlock(lines: YamlLine[], start: number, indent: number): [unknown, number] {
  const first = lines[start]
  if (first === undefined) return [null, start]
  if (first.text === '-' || first.text.startsWith('- ')) return parseSequence(lines, start, first.indent)
  return parseMapping(lines, start, first.indent)
}

/**
 * Parse the DOCUMENTED subset of `model_prices.yml` with the built-in parser:
 * block maps by indentation, sequences of maps, scalars, `[]` / `{}`. Anchors,
 * tags, block scalars and flow collections WITH content are not supported and
 * make the document unusable (`status: 'invalid'` -> zero costs, never an
 * error). When the harness ships js-yaml it is tried FIRST, so real YAML
 * remains usable; this parser only has to cover the documented file.
 */
export function parsePriceYaml(text: string): ParsedFile | undefined {
  const lines = yamlLines(text)
  // A comment-only (or blank) document defines NO rate at all: it is EMPTY,
  // exactly like the core treats it (numeric 0 costs), never "invalid".
  if (lines.length === 0) return { version: '', providers: {}, aliases: {}, offPeak: null }
  if (lines[0].indent !== 0) return undefined
  let document: unknown
  try {
    const [value, index] = parseBlock(lines, 0, 0)
    if (index !== lines.length) return undefined
    document = value
  } catch {
    return undefined
  }
  return normaliseDocument(document)
}

function normaliseDocument(document: unknown): ParsedFile | undefined {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const record = document as Record<string, unknown>
  const providersRaw = record.providers
  if (providersRaw === null || typeof providersRaw !== 'object' || Array.isArray(providersRaw)) return undefined
  const providers: Record<string, Record<string, Rates>> = {}
  for (const [provider, modelsRaw] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (provider.trim().length === 0) return undefined
    if (modelsRaw === null || typeof modelsRaw !== 'object' || Array.isArray(modelsRaw)) return undefined
    const models: Record<string, Rates> = {}
    for (const [model, ratesRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
      if (model.trim().length === 0) return undefined
      const rates = toRates(ratesRaw)
      if (rates === undefined) return undefined
      models[model] = rates
    }
    providers[provider] = models
  }
  const aliases: Record<string, string> = {}
  const aliasesRaw = record.aliases
  if (aliasesRaw !== null && aliasesRaw !== undefined) {
    if (typeof aliasesRaw !== 'object' || Array.isArray(aliasesRaw)) return undefined
    for (const [alias, canonical] of Object.entries(aliasesRaw as Record<string, unknown>)) {
      if (typeof canonical !== 'string' || canonical.trim().length === 0) return undefined
      aliases[alias] = canonical
    }
  }
  const version = typeof record.version === 'string' ? record.version : ''
  return { version, providers, aliases, offPeak: toOffPeak(record.off_peak) }
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('a rate must be a finite number')
}

function toRates(raw: unknown): Rates | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  try {
    return {
      input: numOrNull(record.input) ?? 0,
      cached_input: numOrNull(record.cached_input) ?? 0,
      output: numOrNull(record.output) ?? 0,
      cache_write: numOrNull(record.cache_write) ?? 0,
      reasoning: numOrNull(record.reasoning),
      off_peak_factor: numOrNull(record.off_peak_factor),
    }
  } catch {
    return undefined
  }
}

function classOf(raw: unknown): RateClass {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === 'peak' || text === 'standard') return 'peak'
  if (text === 'off-peak' || text === 'offpeak' || text === 'off_peak') return 'off-peak'
  throw new Error(`unknown rate class ${String(raw)}`)
}

/** `HH:MM` (UTC) -> minutes since midnight. Also accepts `H:MM`. */
export function parseHhMm(raw: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(raw)
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function looksLikeDate(raw: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
}

/**
 * Validate the `off_peak:` block. `null` means "no usable calendar": the block
 * is absent or unusable, so every call is priced at PEAK exactly as if it were
 * absent - a bad calendar NEVER invalidates the rates themselves.
 */
function toOffPeak(raw: unknown): OffPeak | null {
  if (raw === null || raw === undefined) return null
  try {
    if (typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    const defaultClass = classOf(record.default_class ?? 'peak')
    const weekdaysOnly = record.weekdays_only === true
    const holidaysRaw = record.holiday_dates
    const holidayDates: string[] = []
    if (Array.isArray(holidaysRaw)) {
      for (const entry of holidaysRaw) {
        if (typeof entry === 'string' && looksLikeDate(entry)) holidayDates.push(entry.trim())
      }
    }
    const windowsRaw = record.windows ?? []
    if (!Array.isArray(windowsRaw)) return null
    const windows: OffPeakWindow[] = []
    for (const entry of windowsRaw) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
      const window = entry as Record<string, unknown>
      const start = parseHhMm(String(window.start ?? ''))
      const end = parseHhMm(String(window.end ?? ''))
      if (start === null || end === null || start === end) return null
      windows.push({ start, end, class: classOf(window.class) })
    }
    return { defaultClass, weekdaysOnly, holidayDates, windows }
  } catch {
    return null
  }
}

/** The js-yaml `load` resolved once (undefined = not tried yet, null = unavailable). */
let resolvedJsYaml: ((text: string) => unknown) | null | undefined

/** Try js-yaml (the parser the harness ships) before the built-in subset. */
function jsYamlLoad(): ((text: string) => unknown) | undefined {
  if (resolvedJsYaml !== undefined) return resolvedJsYaml ?? undefined
  const anchors = [
    process.argv[1],
    join(dirname(fileURLToPath(import.meta.url)), 'pricing.ts'),
    '/harness/apps/cli/lib/bin.js',
  ]
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || anchor.length === 0) continue
    try {
      const module = createRequire(anchor)('js-yaml') as { load?: (text: string) => unknown }
      if (typeof module?.load === 'function') {
        const load = module.load.bind(module)
        resolvedJsYaml = load
        return load
      }
    } catch {
      /* try the next anchor */
    }
  }
  resolvedJsYaml = null
  return undefined
}

/** The parser used when nothing is injected: js-yaml when available, else the subset parser. */
function parseWithBestParser(text: string): ParsedFile | undefined {
  const jsYaml = jsYamlLoad()
  if (jsYaml !== undefined) {
    try {
      const parsed = normaliseDocument(jsYaml(text))
      if (parsed !== undefined) return parsed
    } catch {
      /* fall through to the built-in subset */
    }
  }
  return parsePriceYaml(text)
}

// ---------------------------------------------------------------------------
// Loading + cache
// ---------------------------------------------------------------------------

function tableShell(status: PriceStatus, path: string, hash: string, version: string): PriceTable {
  const suffix = status === 'loaded' ? `@${version.length > 0 ? version : 'unversioned'}#${hash}` : `#${status}`
  return {
    status,
    version,
    hash,
    path,
    providers: {},
    aliases: {},
    offPeak: null,
    pricingRef: `${PRICES_RELATIVE}${suffix}`,
  }
}

interface CacheEntry {
  path: string
  mtimeMs: number
  size: number
  table: PriceTable
}

let cache: CacheEntry | null = null

/**
 * Read, parse and cache the definition file. Never throws: a missing, empty or
 * malformed file answers a table whose `status` explains it (costs are 0).
 */
export function loadPriceTable(path: string = priceFilePath(), parser: (text: string) => ParsedFile | undefined = parseWithBestParser): PriceTable {
  let mtimeMs = -1
  let size = -1
  try {
    const stats = statSync(path)
    mtimeMs = stats.mtimeMs
    size = stats.size
  } catch {
    return tableShell('missing', path, '', '')
  }
  if (cache !== null && cache.path === path && cache.mtimeMs === mtimeMs && cache.size === size) return cache.table
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return tableShell('missing', path, '', '')
  }
  const hash = contentHash(text)
  let table: PriceTable
  if (text.trim().length === 0) {
    table = tableShell('empty', path, hash, '')
  } else {
    const parsed = parser(text)
    if (parsed === undefined) {
      table = tableShell('invalid', path, hash, '')
    } else if (Object.values(parsed.providers).every((models) => Object.keys(models).length === 0)) {
      table = tableShell('empty', path, hash, '')
    } else {
      table = { ...tableShell('loaded', path, hash, parsed.version), providers: parsed.providers, aliases: parsed.aliases, offPeak: parsed.offPeak }
    }
  }
  cache = { path, mtimeMs, size, table }
  return table
}

/** True when the file exists and parsed: only then can a route be priced. */
export function isLoaded(table: PriceTable): boolean {
  return table.status === 'loaded'
}

/** The USD price of one route (PEAK rates), or undefined when unpriced. */
export function priceOf(table: PriceTable, provider: string | null, model: string | null): Rates | undefined {
  if (table.status !== 'loaded' || provider === null || model === null) return undefined
  if (provider.trim().length === 0 || model.trim().length === 0) return undefined
  const exact = table.providers[provider]?.[model]
  if (exact !== undefined) return exact
  const canonical = table.aliases[provider]
  if (canonical !== undefined) {
    const aliased = table.providers[canonical]?.[model]
    if (aliased !== undefined) return aliased
  }
  // Last resort: the model name exists under some provider (an unlisted
  // gateway spelling). Never a wrong-model guess.
  for (const models of Object.values(table.providers)) {
    const hit = models[model]
    if (hit !== undefined) return hit
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Rate class
// ---------------------------------------------------------------------------

/** The rate class of one call, judged on its UTC time of day. */
export function rateClassAt(table: PriceTable, atMs: number | null | undefined): RateClass {
  const off = table.offPeak
  if (off === null) return 'peak'
  if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return 'peak'
  return classFor(off, atMs)
}

function classFor(off: OffPeak, atMs: number): RateClass {
  const at = new Date(atMs)
  const weekday = at.getUTCDay() // 0 = Sunday .. 6 = Saturday
  if (off.weekdaysOnly && (weekday === 0 || weekday === 6)) return off.defaultClass
  if (off.holidayDates.includes(at.toISOString().slice(0, 10))) return off.defaultClass
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes()
  for (const window of off.windows) {
    const hit = window.start < window.end
      ? minute >= window.start && minute < window.end
      : minute >= window.start || minute < window.end // wraps midnight
    if (hit) return window.class
  }
  return off.defaultClass
}

/** `2026-10-05T20:00:00Z` (second precision, exactly like the core). */
function callTimeOf(atMs: number | null | undefined): string | null {
  if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return null
  return new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The cost block for one call, priced from the shared file at the CALL time.
 *
 * * usable file + known route -> `amount_usd` (+ `rate_class` / `call_time`);
 * * usable file + unknown route -> `null` (never a fabricated price);
 * * missing/empty/invalid file -> numeric 0 with the reason in `pricing_ref`.
 */
export function costOf(
  provider: string | null,
  model: string | null,
  tokens: UsageTokens,
  atMs: number | null = null,
  table: PriceTable = loadPriceTable(),
): UsageCost | null {
  if (table.status !== 'loaded') {
    return { amount_usd: 0, is_estimate: true, source: PRICES_SOURCE, pricing_ref: table.pricingRef, rate_class: 'peak', call_time: callTimeOf(atMs) }
  }
  const rates = priceOf(table, provider, model)
  if (rates === undefined) return null
  const calendar = rateClassAt(table, atMs)
  const discount = calendar === 'off-peak' && rates.off_peak_factor !== null ? rates.off_peak_factor : null
  const factor = discount ?? 1
  const per = 1_000_000
  const amount = ((tokens.input ?? 0) / per * rates.input
    + (tokens.output ?? 0) / per * rates.output
    + (tokens.cacheRead ?? 0) / per * (rates.cached_input ?? rates.input)
    + (tokens.cacheWrite ?? 0) / per * (rates.cache_write ?? rates.input)) * factor
  const cost: UsageCost = {
    amount_usd: Math.round(amount * 1e9) / 1e9,
    is_estimate: true,
    source: PRICES_SOURCE,
    pricing_ref: table.pricingRef,
    rate_class: discount === null ? 'peak' : 'off-peak',
    call_time: callTimeOf(atMs),
  }
  if (discount !== null) cost.off_peak_factor = discount
  return cost
}

/** The provenance of an AGGREGATE cost block (same file, same version). */
export function aggregateProvenance(table: PriceTable): { source: string; pricing_ref: string | null } {
  return { source: PRICES_SOURCE, pricing_ref: table.pricingRef }
}
