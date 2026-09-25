// definitions/spill.ts - the SPILL capability (`spill@1`).
//
// WHY THIS MODULE EXISTS: a bounded answer must never silently lose the bytes it
// cut. Every cap in this repository (a command's output, a grep match list, a web
// page body) has the same two-part answer: the INLINE window the caller receives
// plus a durable file holding the FULL payload, which the caller can page back
// with a RANGE read. That second half is what this seam declares, so the policy
// (where spill files live, how big they may get, how long they are kept) belongs
// to a PROVIDER and every consumer hands its overflow to the same place instead
// of inventing a private directory (as `plugins/web-page/spill.ts` and
// `core/fs-local` had to, before this contract existed).
//
//        Provider  ->  Definition  <-  Consumer
//   core/spill-local                 plugins/spill-tools
//   (node:fs, sha256)                (the `spill ...` named tools)
//                                   + core/subprocess-local (output overflow)
//
// SHAPE: modelled on the DeepSeek harness `spill` group (MIT, `packages/spill/*`),
// whose model this module follows: a payload too large for an inline answer is
// written ONCE to a stable, content-addressed file, the answer carries
// `{path, bytes, sha256, preview}`, and a consumer reads it back in bounded
// RANGES rather than whole. See THIRD_PARTY.md for the MIT notice.
//
// CORDIS-FREE and dependency-free apart from `node:crypto`: the paging math, the
// retention decision and the file naming are PURE functions here (unit-testable
// with no filesystem and no process), while all disk I/O lives in the provider.

import { createHash } from 'node:crypto'
import {
  ServiceError,
  type ServiceErrorCode,
  isRecord,
  positiveInt,
  serviceOf,
  str,
  type ServiceContext,
} from './support.ts'

/** Name of the cordis service (`ctx.spill`). */
export const SPILL = 'spill'

/** Contract version this definition speaks. A provider must implement it. */
export const SPILL_VERSION = 1

/** Contract id including the version, e.g. `spill@1`. */
export const SPILL_CONTRACT = `${SPILL}@${SPILL_VERSION}`

/** Byte cap of ONE payload `write` accepts (64 MiB). */
export const DEFAULT_SPILL_MAX_BYTES = 64 * 1024 * 1024

/** Bytes one `read` range returns when the caller names no `limit` (64 KiB). */
export const DEFAULT_SPILL_PAGE_BYTES = 64 * 1024

/** Hard cap of ONE `read` range: a range read must stay cheap (4 MiB). */
export const MAX_SPILL_PAGE_BYTES = 4 * 1024 * 1024

/** Bytes of the payload copied into the answer as a preview (2 KiB). */
export const DEFAULT_SPILL_PREVIEW_BYTES = 2048

/** Default retention: spilled files older than this are purged (7 days). */
export const DEFAULT_SPILL_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/** Default size ceiling of the whole spill directory (512 MiB). */
export const DEFAULT_SPILL_MAX_TOTAL_BYTES = 512 * 1024 * 1024

/** The reasons a call of this capability can fail (branch on `reason`). */
export type SpillErrorReason =
  /** The caller passed something the contract cannot use. */
  | 'spill.invalid-input'
  /** The payload is larger than the provider's per-payload ceiling. */
  | 'spill.too-large'
  /** The spill file does not exist (or was purged). */
  | 'spill.not-found'
  /** The named path is not inside the spill directory of the provider. */
  | 'spill.outside-dir'
  /** The disk operation itself failed. */
  | 'spill.io'

export interface SpillErrorOptions {
  stage?: string
  details?: Record<string, unknown>
}

/** The one error shape this capability throws (a `ServiceError` subclass). */
export class SpillError extends ServiceError {
  readonly reason: SpillErrorReason

  constructor(reason: SpillErrorReason, message: string, options: SpillErrorOptions = {}) {
    super('invalid-input', message, { stage: options.stage ?? 'spill', details: { reason, ...options.details } })
    this.name = 'SpillError'
    this.reason = reason
  }

  /** A JSON-safe view (what a tool answers, what a log line carries). */
  override toJSON(): { error: string; code: ServiceErrorCode; stage: string; reason: SpillErrorReason; details: Record<string, unknown> } {
    return { error: this.message, code: this.code, stage: this.stage, reason: this.reason, details: this.details }
  }
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

/** The provider's retention/limits policy, as `policy()` reports it. */
export interface SpillPolicy {
  /** Directory every spill file of this provider lives in. */
  dir: string
  /** Byte ceiling of ONE payload (a larger one is `spill.too-large`). */
  maxBytes: number
  /** Byte ceiling of the whole directory (purge trims to it, oldest first). */
  maxTotalBytes: number
  /** Age after which a spill file is eligible for the automatic purge. */
  maxAgeSeconds: number
  /** Bytes copied into `preview` on `write`. */
  previewBytes: number
}

/** The body of a `write` call: the FULL payload plus how to label it. */
export interface SpillWriteInput {
  /** The full payload (text; a provider writes it verbatim as UTF-8). */
  content: string
  /** Short label used in the file name, e.g. `subprocess-stdout` (sanitised). */
  label?: string
  /** File extension for the spill file, `txt` by default (no dot needed). */
  extension?: string
  /** Owner hint recorded in `info()` (e.g. the plugin/job that spilled). */
  source?: string
}

/** The durable reference a spilled payload is addressed by. */
export interface SpillRef {
  /** Absolute path of the spill file. */
  path: string
  /** Size of the file in bytes. */
  bytes: number
  /** SHA-256 of the payload (hex), the content address of the file. */
  sha256: string
  /** The first `previewBytes` of the payload, as text. */
  preview: string
  /** How many bytes `preview` covers (a hint for the caller). */
  previewBytes: number
  /** ISO timestamp of the write. */
  wroteAt: string
  /** What wrote it, when the caller said so. */
  source?: string
}

/** A RANGE read of a spill file: byte paging, line-safe. */
export interface SpillReadInput {
  /** The spill file (absolute, inside the provider directory). */
  path: string
  /** Byte offset of the FIRST returned byte (0-based, default 0). */
  offset?: number
  /** Maximum bytes returned (default 64 KiB, hard max 4 MiB). */
  limit?: number
  /**
   * `line` (default) starts the window at the beginning of the line that
   * contains `offset` and ends at the last complete line inside the window;
   * `byte` returns exactly `[offset, offset+limit)`.
   */
  align?: 'line' | 'byte'
}

/** What a range read answers. */
export interface SpillReadResult {
  path: string
  /** Total size of the file in bytes (so the caller can page deterministically). */
  bytes: number
  /** Byte offset of the FIRST returned byte. */
  offset: number
  /** Bytes returned. */
  returnedBytes: number
  /** The window, as text. */
  text: string
  /** Byte offset of the NEXT window (equals `bytes` at the end). */
  nextOffset: number
  /** True when this window reached the end of the file. */
  eof: boolean
  /** True when the read was cut by `limit` (the window is not the whole rest). */
  truncated: boolean
  /** SHA-256 of the WHOLE file (a caller can verify what it paged). */
  sha256: string
  /** Human note: which window of how many bytes this is. */
  note: string
}

/** Metadata of one spill file (`info` / `list`). */
export interface SpillInfo {
  path: string
  bytes: number
  sha256: string
  /** ISO modification time. */
  modifiedAt: string
  /** Age in seconds at the moment of the call. */
  ageSeconds: number
  /** True when the file is older than `maxAgeSeconds` (purge would remove it). */
  expired: boolean
}

/** The body of a `purge` call: what to remove. */
export interface SpillPurgeInput {
  /** Remove every file older than this (default: the provider's policy). */
  maxAgeSeconds?: number
  /** Trim the directory to this many bytes, oldest file first (default: policy). */
  maxTotalBytes?: number
  /** Report what WOULD be removed without removing anything. */
  dryRun?: boolean
}

/** What a purge removed (or would remove). */
export interface SpillPurgeResult {
  /** Files removed (or, with `dryRun`, the files that would be removed). */
  removed: string[]
  /** Bytes reclaimed. */
  freedBytes: number
  /** Files the purge looked at. */
  scanned: number
  /** True when nothing was deleted (dry run). */
  dryRun: boolean
  /** Human note (how many files, how many bytes, which policy applied). */
  note: string
}

/**
 * The capability a consumer reaches as `ctx.spill`. Everything is bounded: a
 * `write` refuses an oversized payload, a `read` always returns a window, and a
 * `purge` is the only call that removes files.
 */
export interface SpillService {
  /** Writes a payload ONCE (content-addressed) and returns its reference. */
  write(input: SpillWriteInput): Promise<SpillRef>
  /** Reads a bounded RANGE of a spill file (offset/limit, line-aligned by default). */
  read(input: SpillReadInput): Promise<SpillReadResult>
  /** Metadata of one spill file. */
  info(path: string): Promise<SpillInfo>
  /** The spill files of this provider, newest first (capped by `limit`). */
  list(limit?: number): Promise<SpillInfo[]>
  /** Applies the retention policy: max age and/or max total size. */
  purge(input?: SpillPurgeInput): Promise<SpillPurgeResult>
  /** The policy in effect (dir, caps, retention) - never a secret. */
  policy(): SpillPolicy
}

// ---------------------------------------------------------------------------
// Config + pure helpers (no filesystem here: the provider does the I/O).
// ---------------------------------------------------------------------------

/** The config of a spill provider. */
export interface SpillConfig {
  /** Directory spill files live in (default: `<tmpdir>/workbench-spill`). */
  dir?: string
  /** Byte ceiling of ONE payload (default 64 MiB). */
  maxBytes?: number
  /** Byte ceiling of the directory (default 512 MiB). */
  maxTotalBytes?: number
  /** Retention age in SECONDS (default 7 days; 0 disables the age purge). */
  maxAgeSeconds?: number
  /** Preview bytes carried by a `write` answer (default 2 KiB). */
  previewBytes?: number
  /** Purge expired files automatically on every `write` (default true). */
  purgeOnWrite?: boolean
}

/** The normalised policy of a spill provider (what `policy()` reports). */
export interface NormalizedSpillConfig extends SpillPolicy {
  purgeOnWrite: boolean
}

/** Normalises a spill config; `tmpdir` is passed in so this stays pure. */
export function normalizeSpillConfig(config: SpillConfig = {}, tmpdir: string): NormalizedSpillConfig {
  const dir = str(config.dir) ?? `${tmpdir.replace(/\/+$/, '')}/workbench-spill`
  const maxBytes = positiveInt(config.maxBytes, DEFAULT_SPILL_MAX_BYTES)
  const maxTotalBytes = positiveInt(config.maxTotalBytes, DEFAULT_SPILL_MAX_TOTAL_BYTES)
  const previewBytes = positiveInt(config.previewBytes, DEFAULT_SPILL_PREVIEW_BYTES, maxBytes)
  // `maxAgeSeconds: 0` is MEANINGFUL here (keep forever), so it is not run
  // through positiveInt: only a negative/absent value falls back to the default.
  const rawAge = config.maxAgeSeconds
  const maxAgeSeconds =
    typeof rawAge === 'number' && Number.isFinite(rawAge) && rawAge >= 0 ? Math.floor(rawAge) : DEFAULT_SPILL_MAX_AGE_SECONDS
  return { dir, maxBytes, maxTotalBytes, maxAgeSeconds, previewBytes, purgeOnWrite: config.purgeOnWrite !== false }
}

/** SHA-256 (hex) of a payload: the content address of a spill file. */
export function sha256Of(payload: string | Buffer): string {
  return createHash('sha256').update(payload).digest('hex')
}

/** `label` reduced to a safe file-name fragment (`subprocess-stdout` -> as-is). */
export function sanitizeLabel(label: string | undefined, fallback = 'spill'): string {
  const raw = (label ?? '').trim().toLowerCase()
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned.length === 0 ? fallback : cleaned).slice(0, 48)
}

/**
 * The file name of a spill payload: `<label>-<sha256 prefix>.<ext>`. It is
 * CONTENT-ADDRESSED on purpose: spilling the same payload twice reuses the same
 * file (no duplicated disk), and a caller that kept an old path still finds the
 * identical bytes.
 */
export function spillFileName(label: string | undefined, sha256: string, extension?: string): string {
  const ext = sanitizeLabel(extension, 'txt').replace(/\./g, '')
  return `${sanitizeLabel(label)}-${sha256.slice(0, 16)}.${ext}`
}

/** A byte range clamped to the file, with the paging metadata of the answer. */
export interface ClampedRange {
  offset: number
  limit: number
  eof: boolean
  truncated: boolean
  nextOffset: number
}

/**
 * Clamps a requested range to `[0, totalBytes]`. A request at/after the end is a
 * well-defined answer (`offset = totalBytes`, zero bytes, `eof`) - never an
 * error, so a caller can page until `eof` without special-casing the end.
 */
export function clampRange(totalBytes: number, offset?: number, limit?: number): ClampedRange {
  const total = Math.max(0, Math.floor(totalBytes))
  const start = Math.min(total, Math.max(0, Math.floor(offset ?? 0)))
  const wanted = positiveInt(limit, DEFAULT_SPILL_PAGE_BYTES, MAX_SPILL_PAGE_BYTES)
  const available = total - start
  const size = Math.min(wanted, available)
  const nextOffset = start + size
  return {
    offset: start,
    limit: size,
    eof: nextOffset >= total,
    truncated: available > size,
    nextOffset,
  }
}

/**
 * Aligns a window to LINE boundaries: the window starts at the beginning of the
 * line containing `offset` and ends at the last newline inside
 * `[offset, offset+limit)` (a window with no newline is returned as-is, so a
 * single enormous line still makes progress).
 */
export function alignToLines(
  buffer: Buffer,
  window: ClampedRange,
): { offset: number; length: number; text: string } {
  const slice = buffer.subarray(window.offset, window.offset + window.limit)
  const firstNewline = buffer.subarray(0, window.offset).lastIndexOf(0x0a)
  const start = window.offset === 0 || firstNewline < 0 ? window.offset : firstNewline + 1
  const leading = start - window.offset
  const relativeEnd = Math.max(0, slice.length - leading)
  const lastNewline = slice.lastIndexOf(0x0a, leading + relativeEnd - 1)
  const length = lastNewline >= leading ? lastNewline - leading + 1 : relativeEnd
  const text = slice.subarray(leading, leading + length).toString('utf8')
  return { offset: start, length, text }
}

/** One candidate of a retention decision. */
export interface SpillCandidate {
  path: string
  bytes: number
  ageSeconds: number
}

/**
 * The retention decision, as a PURE function: which files an expired/size purge
 * removes. Ordering is stable and deterministic (the caller sorts by age):
 * every file older than `maxAgeSeconds` goes first, then the oldest files until
 * the remaining total fits `maxTotalBytes`.
 */
export function selectForPurge(
  candidates: readonly SpillCandidate[],
  policy: { maxAgeSeconds: number; maxTotalBytes: number },
): string[] {
  const ordered = [...candidates].sort((a, b) => b.ageSeconds - a.ageSeconds)
  const removed: string[] = []
  let total = ordered.reduce((sum, entry) => sum + entry.bytes, 0)
  const keep: SpillCandidate[] = []
  for (const entry of ordered) {
    // `maxAgeSeconds: 0` means "no age purge" (an explicit policy, not an
    // accident): only a POSITIVE ceiling expires a file.
    if (policy.maxAgeSeconds > 0 && entry.ageSeconds > policy.maxAgeSeconds) {
      removed.push(entry.path)
      total -= entry.bytes
      continue
    }
    keep.push(entry)
  }
  if (policy.maxTotalBytes > 0) {
    for (const entry of keep) {
      if (total <= policy.maxTotalBytes) break
      removed.push(entry.path)
      total -= entry.bytes
    }
  }
  return removed
}

/** Structural lookup of the spill capability (`ctx.spill`), or undefined. */
export function spillOf(ctx: ServiceContext): SpillService | undefined {
  return serviceOf<SpillService>(ctx, SPILL)
}

/** The spill capability, or a structured error naming the missing provider. */
export function requireSpill(ctx: ServiceContext): SpillService {
  const service = spillOf(ctx)
  if (service === undefined) {
    throw new SpillError('spill.invalid-input', 'no spill@1 provider is loaded: enable a provider plugin (core/spill-local) in the roster', {
      stage: 'spill.lookup',
    })
  }
  return service
}

/**
 * The `preview` of a payload: the first `previewBytes` bytes, as text. The cut
 * never splits a multi-byte UTF-8 sequence: an incomplete trailing sequence is
 * dropped (no replacement character), so the preview is always valid text of the
 * original payload.
 */
export function previewOf(content: string, previewBytes: number): string {
  const buffer = Buffer.from(content, 'utf8')
  const cap = Math.max(0, Math.floor(previewBytes))
  if (buffer.byteLength <= cap) return content
  let end = Math.min(buffer.byteLength, cap)
  while (end > 0) {
    let start = end - 1
    while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1
    const lead = buffer[start] ?? 0
    const length = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1
    if (start + length <= end) break
    end = start
  }
  return buffer.subarray(0, end).toString('utf8')
}

/** Narrows an unknown value to a spill policy-ish record (used by consumers). */
export function isSpillPolicy(value: unknown): value is SpillPolicy {
  return isRecord(value) && typeof value.dir === 'string' && typeof value.maxBytes === 'number'
}
