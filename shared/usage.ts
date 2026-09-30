// shared/usage.ts - per-agent-call usage accounting for the workstation tools.
//
// WHY
// ---
// Every workstation tool that spawns a dsh worker (the facade tool `agent_run`,
// the `role-delegate` family such as `websearcher`/`vision`, and the private
// `captcha_solve`) must return the tokens its child run actually spent, in CALL
// ORDER, with the child's OWN AGGREGATE LAST. A nested agent call (a worker
// calling another worker) contributes its own `_meta.usage` array, which the
// parent splices in at the point of that call.
//
// The only authoritative source is the child's session log:
//
//   $DSH_HOME/sessions/--<project-key>--/session-<uuid>/session.v4.jsonl.zstd
//
// a CONCATENATED-FRAME zstd container. `node:zlib` decodes only the FIRST frame,
// so this module ports the harness' pure-JS structural frame scanner
// (`packages/session/session-persistence-jsonl` `scanZstdFrames`) and decodes
// EVERY frame through supported `zstdDecompressSync`. No native dependency, no
// harness import, no python.
//
// MEASURED EVENT MAP (harness session format v4, verified raw 2026-09-30)
//   `session`          .id, .createdAt, .cwd, .delegationDepth
//   `assistant/message` .data.usage.{inputTokens,outputTokens,cacheReadTokens,
//                       cacheWriteTokens,totalTokens,reasoningTokens?} - ONE per
//                       LLM call - and .data.message.source.{provider,model}
//   `tool/result`      .data.meta._meta.usage: the subagent usage array a nested
//                       agent tool projected (presentationMeta)
//   NO request id exists in the log -> request_id is null, never invented.
//
// COST
// ----
// Cost is computed by THIS MODULE from the fixed PRICE_TABLE below (its source
// of truth), never estimated by an agent: costOf() answers
// `{ amount_usd, is_estimate: true, source: 'price_table_v1', pricing_ref }`
// for a route the table prices, and `cost: null` otherwise. The table is a
// COMPILED CONSTANT; changing a price is a code change with provenance, not a
// runtime guess.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The session log filename of the JSONL v4 backend. */
export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'

/** One per-call cost block. `amount_usd` stays null when unpriced. */
export interface UsageCost {
  amount_usd: number | null
  is_estimate: boolean
  source: string
  pricing_ref: string | null
}

/**
 * The FIXED per-call dict every agent tool appends. Unknown values are null,
 * never invented.
 */
export interface UsageCall {
  /** Role/profile of the agent that made the call. */
  agent: string
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cached_input_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  cost: UsageCost | null
  provider: string | null
  model: string | null
  request_id: string | null
  details: Record<string, unknown>
}

/** One returned usage payload: the array plus what was (not) readable. */
export interface UsageReport {
  usage: UsageCall[]
  /** Set when the child session could not be located or read. */
  error?: string
  /** The session log this report was built from, when one was found. */
  sessionLog?: string
}

/** Version tag of the fixed price table; every computed cost cites it. */
export const PRICE_TABLE_VERSION = 'price_table_v1'

/**
 * FIXED deployment price table, keyed by `<provider>/<model>`, USD per
 * 1,000,000 tokens. This table is the SOURCE OF TRUTH for `cost`: the plugin
 * computes from it and an agent never supplies a price. A route absent from the
 * table answers `cost: null` (unknown price is never guessed).
 *
 * Rates are the vendors' published peak (standard) list prices, rounded, read
 * 2026-09-30:
 *   - DeepSeek V4.1 Flash (`deepseek-official/deepseek-flash` and
 *     `deepseek-official/deepseek-v4.1-flash`): $0.30 input / $1.20 output /
 *     $0.006 cache-hit per 1M (off-peak is half; the table keeps the peak rate).
 *   - DeepSeek V4 Pro (`deepseek-official/deepseek-v4-pro`): $1.32 input /
 *     $3.96 output / $0.044 cache-hit per 1M.
 *   - Gemini 2.5 Flash (`google/gemini-2.5-flash`): $0.30 input / $2.50 output /
 *     $0.03 cached input per 1M.
 */
export const PRICE_TABLE: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
  'deepseek-official/deepseek-flash': { input: 0.3, output: 1.2, cache_read: 0.006 },
  'deepseek-official/deepseek-v4-flash': { input: 0.3, output: 1.2, cache_read: 0.006 },
  'deepseek-official/deepseek-v4.1-flash': { input: 0.3, output: 1.2, cache_read: 0.006 },
  'deepseek-official/deepseek-v4-pro': { input: 1.32, output: 3.96, cache_read: 0.044 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5, cache_read: 0.03 },
}

/** The pricing_ref every computed cost cites: the table and its version. */
export const PRICE_TABLE_REF = `shared/usage.ts#PRICE_TABLE@${PRICE_TABLE_VERSION}`

/** The USD price of one model route, or undefined when unpriced. */
export function priceOf(provider: string | null, model: string | null): { input: number; output: number; cache_read?: number; cache_write?: number } | undefined {
  if (provider === null || model === null) return undefined
  return PRICE_TABLE[`${provider}/${model}`]
}

/** The cost block for one call: computed from PRICE_TABLE, or null when unpriced. */
export function costOf(provider: string | null, model: string | null, tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }): UsageCost | null {
  const price = priceOf(provider, model)
  if (price === undefined) return null
  const per = 1_000_000
  const input = (tokens.input ?? 0) / per * price.input
  const output = (tokens.output ?? 0) / per * price.output
  const cacheRead = (tokens.cacheRead ?? 0) / per * (price.cache_read ?? price.input)
  const cacheWrite = (tokens.cacheWrite ?? 0) / per * (price.cache_write ?? price.input)
  return {
    amount_usd: Math.round((input + output + cacheRead + cacheWrite) * 1e9) / 1e9,
    is_estimate: true,
    source: PRICE_TABLE_VERSION,
    pricing_ref: PRICE_TABLE_REF,
  }
}

/** A short unique token embedded in a child briefing so its session is identifiable. */
export function usageToken(): string {
  return randomBytes(8).toString('hex')
}

/** The briefing marker carrying a usage token. */
export function usageMarker(token: string): string {
  return `[dsh-usage-run=${token}]`
}

// ---------------------------------------------------------------------------
// Session-bucket naming (the harness `projectKey`, ported exactly)
// ---------------------------------------------------------------------------

/**
 * The session PROJECT BUCKET directory name for one cwd, matching the harness
 * `projectKey`: `/`, `\` and `:` collapse to a single `-`; `[A-Za-z0-9._-]`
 * survive; anything else becomes `~XXXX`; a fully consumed path becomes `root`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** The session directory names currently present in one project bucket. */
export function listSessionIds(sessionsDir: string, bucket: string): Set<string> {
  try {
    return new Set(readdirSync(join(sessionsDir, bucket)))
  } catch {
    return new Set()
  }
}

/** The session log path under one session directory, or undefined when absent. */
export function sessionLogPath(sessionDir: string): string | undefined {
  const exact = join(sessionDir, SESSION_LOG_NAME)
  if (existsSync(exact)) return exact
  try {
    const hit = readdirSync(sessionDir).find((entry) => entry.endsWith('.jsonl.zstd') || entry.endsWith('.jsonl'))
    return hit === undefined ? undefined : join(sessionDir, hit)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Multi-frame zstd decode (ported from the harness scanner)
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xFD2FB528

/** One structurally complete zstd frame range. */
interface FrameRange {
  start: number
  end: number
}

/** Locate every complete frame of a concatenated zstd container without decoding. */
export function scanZstdFrames(buffer: Buffer): { frames: FrameRange[]; tornStart?: number } {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Yield every decoded JSONL record of one session log, in file order. */
export function* sessionEvents(logPath: string): Generator<Record<string, unknown>> {
  let buffer: Buffer
  try {
    buffer = readFileSync(logPath)
  } catch {
    return
  }
  if (buffer.length === 0) return
  let frames: FrameRange[]
  try {
    frames = scanZstdFrames(buffer).frames
  } catch {
    return
  }
  let carry = ''
  for (const frame of frames) {
    let text: string
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    carry += text
    const lines = carry.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      const raw = line.trim()
      if (raw.length === 0) continue
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>
      } catch {
        /* torn line: ignore */
      }
    }
  }
  const tail = carry.trim()
  if (tail.length > 0) {
    try {
      const parsed = JSON.parse(tail) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>
    } catch {
      /* torn tail: ignore */
    }
  }
}

/** The session header facts and the first user text of one log (best effort). */
export function readSessionIntro(logPath: string): { createdAt: number | null; depth: number | null; cwd: string | null; firstUserText: string | null } {
  let createdAt: number | null = null
  let depth: number | null = null
  let cwd: string | null = null
  let firstUserText: string | null = null
  for (const event of sessionEvents(logPath)) {
    if (event.type === 'session') {
      if (typeof event.createdAt === 'number') createdAt = event.createdAt
      if (typeof event.delegationDepth === 'number') depth = event.delegationDepth
      if (typeof event.cwd === 'string') cwd = event.cwd
    } else if (event.type === 'user/message' && firstUserText === null) {
      firstUserText = messageText(event.data)
    }
    if (createdAt !== null && firstUserText !== null) break
  }
  return { createdAt, depth, cwd, firstUserText }
}

/** The concatenated text blocks of one message payload. */
function messageText(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const record = data as { message?: unknown; content?: unknown }
  // `user/message` carries the blocks at `data.content`; the assistant/other
  // surfaces wrap the message at `data.message.content`. Accept both.
  const holder = record.message !== null && typeof record.message === 'object'
    ? (record.message as Record<string, unknown>)
    : (record as Record<string, unknown>)
  const content = holder.content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.length === 0 ? null : parts.join('')
}

/**
 * The direct child session log among the sessions a run created, identified by
 * the unique marker embedded in the child's briefing. A worker that delegates
 * creates GRANDCHILD sessions in the same bucket, so the marker is what tells
 * the child apart from its own descendants.
 */
export function identifyChildSession(sessionsDir: string, bucket: string, before: ReadonlySet<string>, marker: string): string | undefined {
  let after: Set<string>
  try {
    after = new Set(readdirSync(join(sessionsDir, bucket)))
  } catch {
    return undefined
  }
  const candidates: Array<{ log: string; createdAt: number }> = []
  for (const id of after) {
    if (before.has(id)) continue
    const log = sessionLogPath(join(sessionsDir, bucket, id))
    if (log === undefined) continue
    const intro = readSessionIntro(log)
    if (intro.firstUserText === null || !intro.firstUserText.includes(marker)) continue
    candidates.push({ log, createdAt: intro.createdAt ?? Number.MAX_SAFE_INTEGER })
  }
  candidates.sort((a, b) => a.createdAt - b.createdAt)
  return candidates[0]?.log
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

/** A finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sum(...values: Array<number | null>): number | null {
  let total = 0
  let seen = false
  for (const value of values) {
    if (value !== null) {
      total += value
      seen = true
    }
  }
  return seen ? total : null
}

/** Build one per-call dict from one `assistant/message` usage block. */
export function callOf(
  agent: string,
  usage: Record<string, unknown>,
  provider: string | null,
  model: string | null,
  details: Record<string, unknown>,
): UsageCall {
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  const declaredTotal = num(usage.totalTokens)
  return {
    agent,
    input_tokens: input,
    output_tokens: output,
    total_tokens: declaredTotal ?? sum(input, output, cacheRead, cacheWrite),
    cached_input_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: num(usage.reasoningTokens),
    cost: costOf(provider, model, { input, output, cacheRead, cacheWrite }),
    provider,
    model,
    request_id: null,
    details,
  }
}

/**
 * The subagent usage array a nested agent tool projected into its `tool/result`
 * payload, or undefined. Accepts `data.meta._meta.usage` (the projected shape),
 * the legacy `data.meta.usage`, and a rendered-content `_meta.usage` fallback.
 */
export function toolResultUsage(event: Record<string, unknown>): UsageCall[] | undefined {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const meta = (data as { meta?: unknown }).meta
  const fromMeta = usageArrayFromMeta(meta)
  if (fromMeta !== undefined) return fromMeta
  const message = (data as { message?: unknown }).message
  if (message !== null && typeof message === 'object') {
    const content = (message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const text = (block as { text?: unknown }).text
        if (typeof text !== 'string') continue
        const parsed = tryJson(text)
        if (parsed === undefined) continue
        const hit = usageArrayFromMeta(parsed)
        if (hit !== undefined) return hit
      }
    }
  }
  return undefined
}

/** Pull a usage array out of `{_meta:{usage}}` or `{usage}`. */
function usageArrayFromMeta(value: unknown): UsageCall[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const inner = record._meta
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    const usage = (inner as { usage?: unknown }).usage
    if (Array.isArray(usage)) return usage as UsageCall[]
  }
  const direct = record.usage
  if (Array.isArray(direct) && direct.every((entry) => entry !== null && typeof entry === 'object' && 'agent' in entry && 'total_tokens' in entry)) {
    return direct as UsageCall[]
  }
  return undefined
}

function tryJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed[0] !== '{') return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Walk ONE session log in call order and build its usage array: one dict per
 * `assistant/message`, each nested `tool/result` usage array spliced in at the
 * call point, and the agent's OWN aggregate LAST.
 */
export function usageFromSession(logPath: string, agent: string): UsageReport {
  const usage: UsageCall[] = []
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  let total = 0
  let llmCalls = 0
  let toolCalls = 0
  let pricedCalls = 0
  let costSum = 0
  let sessionId: string | null = null
  let depth: number | null = null
  let cwd: string | null = null
  for (const event of sessionEvents(logPath)) {
    if (event.type === 'session') {
      sessionId = str(event.id) ?? sessionId
      depth = num(event.delegationDepth) ?? depth
      cwd = str(event.cwd) ?? cwd
      continue
    }
    if (event.type === 'assistant/message') {
      const data = event.data
      const usageBlock = data !== null && typeof data === 'object' ? (data as { usage?: unknown }).usage : undefined
      if (usageBlock === null || typeof usageBlock !== 'object' || Array.isArray(usageBlock)) continue
      llmCalls += 1
      const source = sourceOf(event)
      const details: Record<string, unknown> = { kind: 'llm-call', session_id: sessionId }
      const seq = num(event.seq)
      if (seq !== null) details.seq = seq
      const dataRecord = data as Record<string, unknown>
      const turn = num(dataRecord.turn)
      if (turn !== null) details.turn = turn
      const step = num(dataRecord.step)
      if (step !== null) details.step = step
      const message = dataRecord.message
      if (message !== null && typeof message === 'object') {
        const messageId = str((message as { id?: unknown }).id)
        if (messageId !== null) details.message_id = messageId
      }
      const call = callOf(agent, usageBlock as Record<string, unknown>, source.provider, source.model, details)
      usage.push(call)
      if (call.cost !== null) {
        pricedCalls += 1
        costSum += call.cost.amount_usd ?? 0
      }
      input += call.input_tokens ?? 0
      output += call.output_tokens ?? 0
      cacheRead += call.cached_input_tokens ?? 0
      cacheWrite += call.cache_write_tokens ?? 0
      reasoning += call.reasoning_tokens ?? 0
      total += call.total_tokens ?? 0
      continue
    }
    if (event.type === 'tool/result') {
      toolCalls += 1
      const nested = toolResultUsage(event)
      if (nested !== undefined && nested.length > 0) usage.push(...nested)
    }
  }
  // The aggregate cost is the sum of THIS agent's OWN priced calls (nested
  // subagent arrays are separate entries and are never folded in). It stays
  // null when any own call is unpriced, so a partial sum is never presented as
  // the total.
  const aggregateCost: UsageCost | null = llmCalls > 0 && pricedCalls === llmCalls
    ? { amount_usd: Math.round(costSum * 1e9) / 1e9, is_estimate: true, source: PRICE_TABLE_VERSION, pricing_ref: PRICE_TABLE_REF }
    : null
  const aggregate: UsageCall = {
    agent,
    input_tokens: llmCalls === 0 ? 0 : input,
    output_tokens: llmCalls === 0 ? 0 : output,
    total_tokens: total,
    cached_input_tokens: llmCalls === 0 ? 0 : cacheRead,
    cache_write_tokens: llmCalls === 0 ? 0 : cacheWrite,
    reasoning_tokens: llmCalls === 0 ? 0 : reasoning,
    cost: aggregateCost,
    provider: null,
    model: null,
    request_id: null,
    details: {
      kind: 'agent-aggregate',
      session_id: sessionId,
      llm_calls: llmCalls,
      tool_calls: toolCalls,
      delegation_depth: depth,
      cwd,
    },
  }
  usage.push(aggregate)
  return { usage, sessionLog: logPath }
}

/** The provider/model of one `assistant/message` event. */
function sourceOf(event: Record<string, unknown>): { provider: string | null; model: string | null } {
  const data = event.data
  if (data === null || typeof data !== 'object') return { provider: null, model: null }
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return { provider: null, model: null }
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return { provider: null, model: null }
  return { provider: str((source as { provider?: unknown }).provider), model: str((source as { model?: unknown }).model) }
}

/**
 * The whole read path for one tool call: locate the direct child session by its
 * marker, then build its usage array. Never throws: a missing/unreadable log
 * answers an empty array plus an error note.
 */
export function collectUsage(options: {
  sessionsDir: string
  bucket: string
  before: ReadonlySet<string>
  marker: string
  agent: string
}): UsageReport {
  const log = identifyChildSession(options.sessionsDir, options.bucket, options.before, options.marker)
  if (log === undefined) {
    return { usage: [], error: `no child session carrying the usage marker ${options.marker} was found in ${join(options.sessionsDir, options.bucket)}` }
  }
  try {
    return usageFromSession(log, options.agent)
  } catch (error) {
    return { usage: [], error: `child session ${log} could not be read: ${error instanceof Error ? error.message : String(error)}`, sessionLog: log }
  }
}

/** A stable shallow clone of a usage array (so a caller cannot mutate the report). */
export function cloneUsage(usage: readonly UsageCall[]): UsageCall[] {
  return usage.map((entry) => ({
    ...entry,
    cost: entry.cost === null ? null : { ...entry.cost },
    details: { ...entry.details },
  }))
}
