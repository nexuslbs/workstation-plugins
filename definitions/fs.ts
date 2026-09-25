// definitions/fs.ts - the FILESYSTEM capability (`fs@1`).
//
// WHY THIS MODULE EXISTS: today the only way to reach a file in workbench is the
// `shell@1` transport (plugins/tool-* run `<shell> -c "cat ..."`), which needs a
// shell, a host binary and a command STRING for something that is really a typed
// I/O call. `fs@1` is the seam that lets a consumer read, search and edit files
// WITHOUT a shell:
//
//        Provider  ->  Definition  <-  Consumer
//   core/fs-local                plugins/fs-tools
//   (node:fs)                    (the `fs ...` named tools)
//
// The contract is DECLARED HERE, in the plugins repository: workbench core
// (`nexuslbs/workbench`) keeps the kernel and hosts no filesystem module, so the
// seam lives with its provider and its consumers (docs/SERVICES.md).
//
// SHAPE: modelled on the DeepSeek harness `fs` group (MIT, `packages/fs/{fs,
// fs-local,tool-fs,tool-fs-search}`), whose naming, paging semantics (1-based
// `offset` = first LINE returned, `limit` = max lines, an explicit end-of-file
// note, 2000-line default/max window) and error taxonomy this module follows.
// Unlike DSH this module is CORDIS-FREE and dependency-free: the service base is
// STRUCTURAL, the paging/edit/glob algorithms are PURE functions here (so they
// are unit-testable without a filesystem), and only `node:fs` lives in the
// provider. See THIRD_PARTY.md for the MIT notice.
//
// WHAT IS BACKEND-AGNOSTIC (this module): the identities, the metadata shape, the
// paging math, the edit primitives (exact-match `str_replace`, line `insert`,
// the atomic `apply_patch` batch), the glob matcher, the ripgrep `--json` parser
// and argv builder, and the typed error taxonomy.
// WHAT IS BACKEND-SPECIFIC (the provider): how a path is resolved, which writes
// are allowed (root confinement), and how bytes are read/written.

import { ServiceError, capText, isRecord, positiveInt, serviceOf, requireService } from './support.ts'
import type { ServiceContext, ServiceErrorCode } from './support.ts'

/** The service name of this capability on the host context (`ctx.fs`). */
export const FS = 'fs'
/** The contract version of this capability. */
export const FS_VERSION = 1
/** The versioned contract id every provider declares and every consumer names. */
export const FS_CONTRACT = `${FS}@${FS_VERSION}`

// ---------------------------------------------------------------------------
// Identities and metadata.
// ---------------------------------------------------------------------------

/**
 * Opaque key for a target. The local backend uses a realpath-like string; a
 * future remote backend might use a workspace URI or a file id. Consumers MUST
 * NOT parse it or assume it is a local absolute path.
 */
export type FsTargetKey = string

/**
 * Opaque freshness token. The local backend derives it from the stat identity
 * and freshness fields (`<mtimeMs>:<size>`); a remote backend might use a
 * revision id. Consumers may pass it back as `expectedVersion` to get a
 * conflict error instead of a silent overwrite, and MUST NOT interpret it.
 */
export type FsVersion = string

/** The kind of entry a path resolves to. */
export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other'

/** The permission bits of a target, as booleans (the octal mode is `mode`). */
export interface FsPermissions {
  readable: boolean
  writable: boolean
  executable: boolean
}

/** One authoritative observation of a target. */
export interface FsStat {
  /** Opaque target key (see {@link FsTargetKey}). */
  target: FsTargetKey
  /** The path as the caller wrote it, resolved against the provider's cwd. */
  path: string
  /** The last path segment (`` for a root). */
  name: string
  type: FsEntryType
  /** Size in bytes (directories report their own entry size). */
  size: number
  /** Modification time, epoch milliseconds. */
  mtimeMs: number
  /** Octal permission string, e.g. `0644`. */
  mode: string
  permissions: FsPermissions
  /** The freshness token a guarded write compares against. */
  version: FsVersion
  /** For a symlink: its link target verbatim. */
  symlink?: string
}

/** One directory entry (`list`). */
export interface FsEntry {
  name: string
  /** Path relative to the listed directory (a bare name). */
  path: string
  type: FsEntryType
  size: number
  mtimeMs: number
  symlink?: string
}

/** The result of a `list` call. */
export interface FsListResult {
  path: string
  target: FsTargetKey
  entries: FsEntry[]
  /** The result was cut at the configured entry cap. */
  truncated: boolean
  /** Entries found before the cap. */
  total: number
}

// ---------------------------------------------------------------------------
// read - LINE-NUMBERED, paged.
//
// Paging is LINE-MODE (the DSH choice) and 1-based on both ends:
//   * `offset`   = number of the FIRST line returned (default 1);
//   * `limit`    = maximum number of lines returned (default/max 2000);
//   * the result carries the numbered window, `totalLines`, `nextOffset` and
//     `eof`, plus a human `note` (`end of file (N lines total)` or
//     `showing lines X-Y of N; continue with offset Z`).
// A single line is never returned unbounded (`maxLineBytes`, default 2000, cut on
// a UTF-8 boundary and flagged `truncated`), and neither is the whole window
// (`maxBytes` on the call), so a 10 GB log cannot flood a caller.
// ---------------------------------------------------------------------------

/** Default and maximum number of lines one `read` returns. */
export const DEFAULT_READ_LIMIT = 2000
/** Maximum number of lines one `read` may return, whatever the caller asks. */
export const MAX_READ_LIMIT = 2000
/** Default cap in bytes on ONE returned line. */
export const DEFAULT_MAX_LINE_BYTES = 2000
/** Default overall byte cap of one `read` reply. */
export const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024
/** Default cap in bytes on ONE `write`/`append` payload. */
export const DEFAULT_MAX_WRITE_BYTES = 16 * 1024 * 1024

/** One numbered line of a `read` result. */
export interface FsLine {
  /** 1-based line number in the file (NOT in the window). */
  number: number
  text: string
  /** Bytes of `text` after capping. */
  bytes: number
  /** `text` was cut at `maxLineBytes`. */
  truncated?: boolean
}

/** The input of a `read` call. */
export interface FsReadInput {
  path: string
  /** 1-based number of the first line returned (default 1). */
  offset?: number
  /** Maximum number of lines returned (default/max 2000). */
  limit?: number
  /** Per-line byte cap (default 2000). */
  maxLineBytes?: number
}

/** The result of a `read` call. */
export interface FsReadResult {
  path: string
  target: FsTargetKey
  /** The observation taken to resolve the read (type, size, version). */
  stat: FsStat
  offset: number
  limit: number
  lines: FsLine[]
  /** The numbered rendering of `lines` (`<number>:<text>`, newline-joined). */
  text: string
  /** Total lines of the file (not of the window). */
  totalLines: number
  /** The `offset` to pass next; `> totalLines` means the file is exhausted. */
  nextOffset: number
  /** The window reached the end of the file. */
  eof: boolean
  /** The window was cut (per-line and/or overall byte cap). */
  truncated: boolean
  /** Human-readable paging note (see the module comment). */
  note: string
}

/** The paging options {@link paginateLines} accepts. */
export interface FsPagingOptions {
  offset?: number
  limit?: number
  maxLineBytes?: number
  /** Overall byte budget of the returned window (0/omitted = unbounded). */
  maxBytes?: number
}

/** The pure result of {@link paginateLines}. */
export interface FsPagingResult {
  lines: FsLine[]
  text: string
  offset: number
  limit: number
  totalLines: number
  nextOffset: number
  eof: boolean
  truncated: boolean
  note: string
}

// ---------------------------------------------------------------------------
// write / append / edit.
// ---------------------------------------------------------------------------

/** The input of a `write` call (full content, overwrite). */
export interface FsWriteInput {
  path: string
  content: string
  /** Create missing parent directories (default true). */
  createParents?: boolean
  /** Fail with a conflict instead of overwriting a changed file. */
  expectedVersion?: FsVersion
}

/** The input of an `append` call. */
export interface FsAppendInput {
  path: string
  content: string
  createParents?: boolean
}

/** The outcome of `write`/`append`. */
export interface FsWriteOutcome {
  path: string
  target: FsTargetKey
  /** Bytes of `content` written. */
  bytes: number
  /** The file did not exist before this call. */
  created: boolean
  /** `true` for `append`, `false` for a full write. */
  appended: boolean
  /** The observation AFTER the write (its `version` is the new freshness token). */
  stat: FsStat
}

/**
 * One surgical edit. The exact-match rules (DSH `tool-str-replace-editor`):
 * `str_replace` matches the WHOLE `oldText` literally (never a regex); more than
 * one occurrence needs an explicit `occurrence` (1-based, non-overlapping);
 * `insert` puts `content` BEFORE 1-based `line`, where `totalLines + 1` appends.
 */
export type FsEdit =
  | { kind: 'str_replace'; oldText: string; newText: string; occurrence?: number }
  | { kind: 'insert'; line: number; content: string }

/** The input of an `edit` call (`apply_patch` is the batch form of this). */
export interface FsEditInput {
  path: string
  edits: readonly FsEdit[]
  /** Fail with a conflict instead of editing a changed file. */
  expectedVersion?: FsVersion
}

/** Where one edit landed. */
export interface FsEditReport {
  /** 0-based position of the edit in the batch. */
  index: number
  kind: FsEdit['kind']
  /** 1-based line the edit affected. */
  line: number
  /** `str_replace`: occurrences of `oldText` found in the file. */
  occurrences?: number
  /** `insert`: number of lines inserted. */
  insertedLines?: number
}

/** The outcome of an `edit` call. */
export interface FsEditOutcome {
  path: string
  target: FsTargetKey
  applied: FsEditReport[]
  /** The observation BEFORE the edit (its `version` was checked). */
  before: FsStat
  /** The observation AFTER the edit. */
  after: FsStat
  /** Bytes written. */
  bytes: number
}

/** The pure result of {@link applyFsEdits}. */
export interface FsEditResult {
  text: string
  applied: FsEditReport[]
}

// ---------------------------------------------------------------------------
// search - file NAME glob (`glob`) and file CONTENT regex (`grep`).
// ---------------------------------------------------------------------------

/** Default cap on the matches of one `glob` call. */
export const DEFAULT_GLOB_LIMIT = 200
/** Default cap on the matches retained INLINE by one `grep` call. */
export const DEFAULT_GREP_MAX_RESULTS = 250
/** Default cap in bytes on one matched-line preview. */
export const DEFAULT_GREP_MAX_LINE_BYTES = 2000
/** Default cap on the size of a file `grep` will read. */
export const DEFAULT_GREP_MAX_FILE_BYTES = 4 * 1024 * 1024
/** Hard ceiling on the matches one `grep` call collects before it stops walking. */
export const DEFAULT_GREP_MAX_TOTAL = 20000

/** The input of a `glob` call (file NAME search). */
export interface FsGlobInput {
  /** The glob, e.g. `**\\/*.ts` (no `/` in the pattern matches a basename at any depth). */
  pattern: string
  /** The directory to walk (default: the provider's cwd). */
  path?: string
  /** Cap on the matches returned (default 200). */
  limit?: number
  /** Also return matching DIRECTORIES (default false). */
  includeDirs?: boolean
}

/** The result of a `glob` call. */
export interface FsGlobResult {
  path: string
  pattern: string
  /** Matches, relative to `path` when it is inside it, POSIX separators. */
  matches: string[]
  /** Matches found before the cap. */
  total: number
  truncated: boolean
}

/** The input of a `grep` call (file CONTENT regex search). */
export interface FsGrepInput {
  /** A regular expression (RE2-style subset: ripgrep accepts it, `node` too). */
  pattern: string
  /** The directory to walk (default: the provider's cwd). */
  path?: string
  /** Only search files matching this glob. */
  glob?: string
  /** Cap on the matches retained INLINE (default 250); the rest is spilled. */
  maxResults?: number
  /** Cap in bytes on one matched-line preview (default 2000). */
  maxLineBytes?: number
  /** Skip files larger than this (default 4 MiB). */
  maxFileBytes?: number
  /** Case-insensitive match. */
  ignoreCase?: boolean
}

/** One content match: `path:line: text`. */
export interface FsGrepMatch {
  path: string
  line: number
  text: string
  truncated?: boolean
}

/**
 * Where the FULL match list was written when it did not fit inline. The spill
 * file is a plain text file with one `path:line: text` record per match, so it
 * is readable with `read`/`grep` and nothing is lost when the inline cap cuts.
 */
export interface FsSpillRef {
  path: string
  bytes: number
  /** Records in the spill file (the match count). */
  matches: number
}

/** The result of a `grep` call. */
export interface FsGrepResult {
  pattern: string
  path: string
  /** The matches retained inline (at most `maxResults`). */
  matches: FsGrepMatch[]
  /** Matches found in total (inline + spilled). */
  total: number
  /** Files that contained at least one match. */
  files: number
  /** `total` exceeded `maxResults` (or the hard ceiling was reached). */
  truncated: boolean
  maxResults: number
  /** Present when `truncated`: the full list, on disk. */
  spill?: FsSpillRef
  /** Files skipped because they exceeded `maxFileBytes` or looked binary. */
  skipped?: number
  /** Human note (the inline window, the spill location, or the hard ceiling). */
  note?: string
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

/**
 * The optional SANDBOX policy handle (requirement "sandbox-aware, extension
 * point only"): a future `sandbox@1` provider may narrow the roots the `fs`
 * provider is allowed to WRITE into (and, with `readOnly`, to read at all). The
 * `fs` provider does NOT depend on the sandbox capability: it asks for the
 * policy only when one is present in the context and otherwise uses its own
 * configured roots. `ss` is a label naming the policy owner (diagnostics only).
 */
export interface FsSandboxPolicy {
  /**
   * Write roots for this capability; intersected with the provider's roots. The
   * contract defines an EMPTY array as "no write is allowed", so an explicit
   * `[]` NARROWS to nothing, while an ABSENT (`undefined`) `writeRoots` leaves
   * the configured roots untouched (thread 2556).
   */
  writeRoots?: readonly string[]
  /** Read roots; when present, reads outside them are refused too (`[]` = no read confinement). */
  readRoots?: readonly string[]
  /** Refuse every write (a read-only deployment). */
  readOnly?: boolean
  /**
   * The `sandbox@1` provider DENIED this capability outright (`deny: true` on the
   * resource rule or on the defaults, or `unconfigured: 'deny'` with no rule and
   * no defaults): READ and WRITE are both refused. A consumer that can read this
   * field MUST refuse, never ignore it (requirement R1.2).
   */
  denied?: boolean
  /** Who declared the policy (diagnostics only). */
  source?: string
}

/** The `sandbox@1` constraint view as this seam reads it (`SandboxConstraints`). */
export interface FsSandboxViewLike extends FsSandboxPolicy {
  /** Which rule produced the view; `unconfigured` = no rule and no defaults for this resource. */
  from?: 'resource' | 'defaults' | 'unconfigured'
}

/** The structural view of a future `sandbox@1` provider the `fs` provider may use. */
export interface FsSandboxProviderLike {
  policyFor?(capability: string): FsSandboxViewLike | undefined
  /** The active policy; its `unconfigured` switch says whether a resource with NO rule is refused. */
  activePolicy?(): { unconfigured?: 'deny' | 'allow' } | undefined
}

/** The filesystem capability, as a consumer sees it (never a backend detail). */
export interface FsService {
  readonly contract: string
  /** The roots writes are confined to (diagnostics; not a security boundary by itself). */
  readonly roots: readonly string[]
  /** The working directory relative paths resolve against. */
  readonly cwd: string
  /** Observe a target; `fs.not-found` when it does not exist. */
  stat(path: string): Promise<FsStat>
  /** Line-numbered, paged read (see {@link FsReadResult}). */
  read(input: FsReadInput): Promise<FsReadResult>
  /** Full-content overwrite (with an optional version guard). */
  write(input: FsWriteInput): Promise<FsWriteOutcome>
  /** Append to a file (creates it, with an optional version guard). */
  append(input: FsAppendInput): Promise<FsWriteOutcome>
  /** Apply one or more surgical edits ATOMICALLY (all or nothing). */
  edit(input: FsEditInput): Promise<FsEditOutcome>
  /** List a directory. */
  list(path?: string, options?: { limit?: number }): Promise<FsListResult>
  /** File NAME glob search. */
  glob(input: FsGlobInput): Promise<FsGlobResult>
  /** File CONTENT regex search, with caps + spill. */
  grep(input: FsGrepInput): Promise<FsGrepResult>
  /**
   * Narrow the policy at runtime (extension point). The provider intersects the
   * policy roots with its configured roots; it can only ever make the seam
   * STRICTER, never wider.
   */
  setSandboxPolicy(policy?: FsSandboxPolicy): void
}

// ---------------------------------------------------------------------------
// The error taxonomy. A caller branches on `error.reason` (stable, fs-specific)
// and/or on `error.code` (the shared ServiceError code), never on a message.
// ---------------------------------------------------------------------------

/** Every failure of this capability, with a stable reason. */
export type FsErrorReason =
  /** The target does not exist. */
  | 'fs.not-found'
  /** A WRITE (or a read under a read policy) left the allowed roots. */
  | 'fs.outside-root'
  /** The target exists but is not a regular file. */
  | 'fs.not-a-file'
  /** The target exists but is not a directory. */
  | 'fs.not-a-directory'
  /** A write was asked to replace a file whose `expectedVersion` is stale. */
  | 'fs.edit-conflict'
  /** `str_replace` found no exact match. */
  | 'fs.edit-not-found'
  /** `str_replace` found several matches and the caller named none. */
  | 'fs.edit-ambiguous'
  /** The edit request itself is malformed (bad kind, empty text, line out of range). */
  | 'fs.edit-invalid'
  /** The payload exceeds the configured byte cap. */
  | 'fs.too-large'
  /** A glob is malformed (unterminated class/brace). */
  | 'fs.invalid-glob'
  /** A content regex does not compile. */
  | 'fs.invalid-pattern'
  /** The call arguments are unusable (missing path, bad paging). */
  | 'fs.invalid-input'
  /** The host refused the I/O (permissions, ENOSPC, ...). */
  | 'fs.io'

/** How each fs reason maps onto the shared {@link ServiceErrorCode} union. */
export const FS_ERROR_CODES: Record<FsErrorReason, ServiceErrorCode> = {
  'fs.not-found': 'unreachable',
  'fs.outside-root': 'policy',
  'fs.not-a-file': 'invalid-input',
  'fs.not-a-directory': 'invalid-input',
  'fs.edit-conflict': 'invalid-input',
  'fs.edit-not-found': 'invalid-input',
  'fs.edit-ambiguous': 'invalid-input',
  'fs.edit-invalid': 'invalid-input',
  'fs.too-large': 'unsupported',
  'fs.invalid-glob': 'invalid-input',
  'fs.invalid-pattern': 'invalid-input',
  'fs.invalid-input': 'invalid-input',
  'fs.io': 'unreachable',
}

/** The one error shape this capability throws (`details.reason` is always set). */
export class FsError extends ServiceError {
  readonly reason: FsErrorReason

  constructor(reason: FsErrorReason, message: string, options: { stage?: string; details?: Record<string, unknown> } = {}) {
    super(FS_ERROR_CODES[reason], message, {
      stage: options.stage ?? 'fs',
      details: { reason, ...(options.details ?? {}) },
    })
    this.name = 'FsError'
    this.reason = reason
  }
}

/** Narrows an unknown error to {@link FsError}. */
export function isFsError(error: unknown): error is FsError {
  return error instanceof FsError
}

/** The reason of an error, or `undefined` when it is not an fs failure. */
export function fsErrorReason(error: unknown): FsErrorReason | undefined {
  return isFsError(error) ? error.reason : undefined
}

// ---------------------------------------------------------------------------
// The pure algorithms (no `node:fs`, no host access: unit-testable as such).
// ---------------------------------------------------------------------------

/**
 * Split text into lines WITHOUT rewriting it: the newline character is the
 * separator and CR is preserved inside a line (so editing never silently
 * converts a CRLF file). `trailingNewline` records whether the text ended with
 * one, so {@link joinTextLines} can round-trip it byte for byte.
 */
export function splitTextLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text.length === 0) return { lines: [], trailingNewline: false }
  const lines = text.split('\n')
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

/** The inverse of {@link splitTextLines}. */
export function joinTextLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? '\n' : ''
  return lines.join('\n') + (trailingNewline ? '\n' : '')
}

/** The 1-based line number of a character index (`index = 0` -> 1). */
export function lineOfIndex(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** The numbered rendering of a window: `<number>:<text>`, newline-joined. */
export function renderNumberedLines(lines: readonly FsLine[]): string {
  return lines.map((line) => `${line.number}:${line.text}`).join('\n')
}

/**
 * THE paging math of `read`: slice `lines[offset-1 .. offset-1+limit)`, number
 * every line by its position in the FILE, cap each line on a UTF-8 boundary, stop
 * when `maxBytes` is reached, and describe where the caller is (`nextOffset`,
 * `eof`, `note`). Pure: the provider supplies the file text.
 */
export function paginateLines(text: string, options: FsPagingOptions = {}): FsPagingResult {
  const offset = positiveInt(options.offset, 1)
  const limit = Math.min(positiveInt(options.limit, DEFAULT_READ_LIMIT), MAX_READ_LIMIT)
  const maxLineBytes = positiveInt(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES)
  const maxBytes = positiveInt(options.maxBytes, 0)
  const { lines: all } = splitTextLines(text)
  const totalLines = all.length
  const window = all.slice(offset - 1, offset - 1 + limit)
  const lines: FsLine[] = []
  let bytes = 0
  let capped = false
  for (let i = 0; i < window.length; i += 1) {
    const raw = window[i] as string
    // display-only: a CRLF file must not print a stray CR at every line end
    const display = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const cut = capText(display, maxLineBytes)
    const entry: FsLine = { number: offset + i, text: cut.text, bytes: Buffer.byteLength(cut.text) }
    if (cut.truncated) entry.truncated = true
    if (maxBytes > 0 && lines.length > 0 && bytes + entry.bytes > maxBytes) {
      capped = true
      break
    }
    bytes += entry.bytes
    lines.push(entry)
  }
  const last = lines[lines.length - 1]
  const nextOffset = last ? last.number + 1 : offset
  const truncated = capped || lines.some((line) => line.truncated === true)
  const eof = nextOffset > totalLines
  const note = eof
    ? `end of file (${totalLines} line(s) total)`
    : `showing lines ${offset}-${nextOffset - 1} of ${totalLines}; continue with offset ${nextOffset}`
  return {
    lines,
    text: renderNumberedLines(lines),
    offset,
    limit,
    totalLines,
    nextOffset,
    eof,
    truncated,
    note: capped ? `${note} [window capped at ${maxBytes} bytes]` : note,
  }
}

/** A short, single-line preview of a needle for an error message. */
function previewOf(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ')
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`
}

/** Builds an fs error carrying the batch position of the failing edit. */
function editError(
  reason: FsErrorReason,
  message: string,
  index: number,
  details: Record<string, unknown> = {},
): FsError {
  return new FsError(reason, `edit #${index + 1}: ${message}`, { stage: 'fs.edit', details: { index, ...details } })
}

/**
 * `str_replace`: literal, whole-text replacement. Every non-overlapping
 * occurrence is counted; one occurrence is replaced unconditionally, several
 * require `occurrence` (1-based), none is `fs.edit-not-found`. Pure.
 */
export function applyStrReplace(
  text: string,
  edit: { oldText: string; newText: string; occurrence?: number },
  index = 0,
): { text: string; line: number; occurrences: number } {
  const needle = edit.oldText
  if (typeof needle !== 'string' || needle.length === 0) {
    throw editError('fs.edit-invalid', 'str_replace needs a non-empty oldText (an empty needle matches everywhere)', index)
  }
  const indices: number[] = []
  let at = text.indexOf(needle)
  while (at >= 0) {
    indices.push(at)
    at = text.indexOf(needle, at + needle.length)
  }
  if (indices.length === 0) {
    throw editError('fs.edit-not-found', `str_replace did not find the exact text "${previewOf(needle)}"`, index, {
      occurrences: 0,
      preview: previewOf(needle),
    })
  }
  let pick = 0
  if (edit.occurrence !== undefined) {
    if (!Number.isInteger(edit.occurrence) || edit.occurrence < 1 || edit.occurrence > indices.length) {
      throw editError('fs.edit-invalid', `str_replace occurrence must be an integer in 1..${indices.length}`, index, {
        occurrences: indices.length,
      })
    }
    pick = edit.occurrence - 1
  } else if (indices.length > 1) {
    throw editError(
      'fs.edit-ambiguous',
      `str_replace found ${indices.length} occurrences: pass occurrence=1..${indices.length} to pick one (or split it into several edits)`,
      index,
      { occurrences: indices.length },
    )
  }
  const start = indices[pick] as number
  const next = text.slice(0, start) + edit.newText + text.slice(start + needle.length)
  return { text: next, line: lineOfIndex(text, start), occurrences: indices.length }
}

/**
 * `insert`: put `content` BEFORE the 1-based `line`; `totalLines + 1` appends.
 * The inserted block keeps the file's trailing-newline convention. Pure.
 */
export function applyInsert(
  text: string,
  edit: { line: number; content: string },
  index = 0,
): { text: string; line: number; insertedLines: number } {
  if (typeof edit.content !== 'string' || edit.content.length === 0) {
    throw editError('fs.edit-invalid', 'insert needs a non-empty content', index)
  }
  const { lines, trailingNewline } = splitTextLines(text)
  const at = edit.line
  if (!Number.isInteger(at) || at < 1 || at > lines.length + 1) {
    throw editError('fs.edit-invalid', `insert line must be an integer in 1..${lines.length + 1} (the file has ${lines.length} line(s))`, index, {
      totalLines: lines.length,
    })
  }
  const { lines: block } = splitTextLines(edit.content)
  const next = [...lines.slice(0, at - 1), ...block, ...lines.slice(at - 1)]
  return { text: joinTextLines(next, trailingNewline), line: at, insertedLines: block.length }
}

/** Applies ONE edit to `text`, returning the new text and where it landed. Pure. */
export function applyFsEdit(text: string, edit: FsEdit, index = 0): { text: string; report: FsEditReport } {
  if (!isRecord(edit)) throw editError('fs.edit-invalid', 'an edit must be an object', index)
  const kind = (edit as { kind?: unknown }).kind
  if (kind === 'str_replace') {
    const out = applyStrReplace(text, edit as { oldText: string; newText: string; occurrence?: number }, index)
    return { text: out.text, report: { index, kind: 'str_replace', line: out.line, occurrences: out.occurrences } }
  }
  if (kind === 'insert') {
    const out = applyInsert(text, edit as { line: number; content: string }, index)
    return { text: out.text, report: { index, kind: 'insert', line: out.line, insertedLines: out.insertedLines } }
  }
  throw editError(
    'fs.edit-invalid',
    `unknown edit kind ${JSON.stringify(kind ?? null)}: use 'str_replace' or 'insert'`,
    index,
  )
}

/**
 * THE atomic batch: every edit is applied IN ORDER to an in-memory copy; the
 * first failure aborts the whole batch and NOTHING is written (the caller only
 * writes when this returns). The reports carry the affected line and the new
 * text's size is the caller's `bytes`. Pure.
 */
export function applyFsEdits(text: string, edits: readonly FsEdit[]): FsEditResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new FsError('fs.edit-invalid', 'edits must be a non-empty array of edits', {
      stage: 'fs.edit',
      details: { edits: Array.isArray(edits) ? edits.length : null },
    })
  }
  let current = text
  const applied: FsEditReport[] = []
  for (let i = 0; i < edits.length; i += 1) {
    const out = applyFsEdit(current, edits[i] as FsEdit, i)
    current = out.text
    applied.push(out.report)
  }
  return { text: current, applied }
}

/**
 * Parse the `edits` argument of `apply_patch` (which travels as JSON, so a tool
 * cannot rely on a typed signature). Every rejection is a typed `fs.edit-invalid`
 * with the offending index, BEFORE any byte is written.
 */
export function parseFsEdits(value: unknown): FsEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FsError('fs.edit-invalid', 'edits must be a non-empty array', {
      stage: 'fs.edit',
      details: { edits: Array.isArray(value) ? value.length : null },
    })
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw editError('fs.edit-invalid', 'an edit must be an object', index)
    const kind = entry.kind
    if (kind === 'str_replace') {
      if (typeof entry.oldText !== 'string' || entry.oldText.length === 0) {
        throw editError('fs.edit-invalid', "str_replace needs a string 'oldText'", index)
      }
      if (typeof entry.newText !== 'string') throw editError('fs.edit-invalid', "str_replace needs a string 'newText'", index)
      if (entry.occurrence !== undefined && (!Number.isInteger(entry.occurrence) || (entry.occurrence as number) < 1)) {
        throw editError('fs.edit-invalid', "'occurrence' must be a positive integer", index)
      }
      return { kind: 'str_replace', oldText: entry.oldText, newText: entry.newText, ...(entry.occurrence !== undefined ? { occurrence: entry.occurrence as number } : {}) }
    }
    if (kind === 'insert') {
      if (!Number.isInteger(entry.line) || (entry.line as number) < 1) {
        throw editError('fs.edit-invalid', "'line' must be a positive integer (1-based)", index)
      }
      if (typeof entry.content !== 'string' || entry.content.length === 0) {
        throw editError('fs.edit-invalid', "insert needs a non-empty string 'content'", index)
      }
      return { kind: 'insert', line: entry.line as number, content: entry.content }
    }
    throw editError('fs.edit-invalid', `unknown edit kind ${JSON.stringify(kind ?? null)}: use 'str_replace' or 'insert'`, index)
  })
}

// ---------------------------------------------------------------------------
// Glob (file NAME search) - the DSH/ripgrep semantics a caller expects:
//   * `*` matches inside one path segment, `**` spans segments, `?` one char;
//   * `[abc]` / `[!abc]` are character classes, `{a,b}` a closed alternation;
//   * a pattern with no `/` matches a BASENAME at any depth;
//   * matching is case-sensitive and anchored at both ends.
// ---------------------------------------------------------------------------

/** Translate a glob to its regex SOURCE (no anchors). Throws on a malformed glob. */
export function globSource(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end < 0) throw new FsError('fs.invalid-glob', `unterminated character class in glob '${pattern}'`, { stage: 'fs.glob', details: { pattern } })
      let body = pattern.slice(i + 1, end)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      out += `[${body}]`
      i = end + 1
      continue
    }
    if (ch === '{') {
      const end = pattern.indexOf('}', i + 1)
      if (end < 0) throw new FsError('fs.invalid-glob', `unterminated brace group in glob '${pattern}'`, { stage: 'fs.glob', details: { pattern } })
      const alternatives = pattern
        .slice(i + 1, end)
        .split(',')
        .map((alternative) => globSource(alternative))
      out += `(?:${alternatives.join('|')})`
      i = end + 1
      continue
    }
    out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
    i += 1
  }
  return out
}

/** A glob with no `/` matches a basename at any depth (the ripgrep rule). */
export function normalizeGlob(pattern: string): string {
  const trimmed = pattern.replace(/^\.\//, '')
  return trimmed.includes('/') ? trimmed : `**/${trimmed}`
}

/** Compile a glob into an anchored regex. Throws `fs.invalid-glob` when malformed. */
export function globToRegExp(pattern: string): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new FsError('fs.invalid-glob', 'a glob pattern must be a non-empty string', { stage: 'fs.glob', details: { pattern } })
  }
  return new RegExp(`^${globSource(normalizeGlob(pattern))}$`)
}

/** Does a POSIX relative path match a glob? Throws `fs.invalid-glob` when malformed. */
export function globMatches(pattern: string, relPath: string): boolean {
  return globToRegExp(pattern).test(relPath.split('\\').join('/'))
}

// ---------------------------------------------------------------------------
// ripgrep: the optional CONTENT engine of the provider.
//
// The default engine is Node (`fs` + `RegExp`): no binary, no spawn, identical
// answers on every deployment. When an operator configures an `rg` binary the
// provider uses DSH's approach instead: `rg --json` with a fixed argv vector and
// NDJSON parsing (never a shell, never colon-splitting).
// ---------------------------------------------------------------------------

/** The argv of ONE `rg --json` call (no shell: an argv vector). */
export function buildRipgrepArgv(
  pattern: string,
  options: { base: string; glob?: string; ignoreCase?: boolean } ,
): string[] {
  return [
    '--json',
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--with-filename',
    ...(options.ignoreCase ? ['--ignore-case'] : []),
    ...(options.glob ? ['--glob', options.glob] : []),
    '--regexp',
    pattern,
    '--',
    options.base,
  ]
}

/** The subset of the `rg --json` stream this capability reads. */
export interface FsRipgrepParseResult {
  matches: FsGrepMatch[]
  /** Files with at least one match (`type: "begin"` records). */
  files: number
  /** Matches seen, including the ones dropped by `limit` / `maxLineBytes`. */
  total: number
  /** Malformed lines (diagnostics; never fatal). */
  errors: string[]
}

/**
 * Parse an `rg --json` stream (one JSON object per line) into matches. Pure, so
 * the ripgrep path is testable without the binary; a truncated chunk line is
 * reported in `errors` instead of being guessed at.
 */
export function parseRipgrepJson(
  chunk: string,
  options: { maxLineBytes?: number; limit?: number; collect?: boolean } = {},
): FsRipgrepParseResult {
  const maxLineBytes = positiveInt(options.maxLineBytes, DEFAULT_GREP_MAX_LINE_BYTES)
  const limit = positiveInt(options.limit, DEFAULT_GREP_MAX_RESULTS)
  const collect = options.collect ?? true
  const out: FsRipgrepParseResult = { matches: [], files: 0, total: 0, errors: [] }
  for (const line of chunk.split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(text) as Record<string, unknown>
    } catch {
      out.errors.push(`unparsable rg record (${text.slice(0, 80)})`)
      continue
    }
    const type = record.type
    if (type === 'begin') {
      out.files += 1
      continue
    }
    if (type !== 'match') continue
    const data = record.data as { path?: { text?: string }; lines?: { text?: string }; line_number?: number } | undefined
    const path = data?.path?.text
    const lineNumber = data?.line_number
    const rawLine = data?.lines?.text
    if (typeof path !== 'string' || typeof lineNumber !== 'number' || typeof rawLine !== 'string') {
      out.errors.push('rg match record without data.path/data.line_number/data.lines')
      continue
    }
    out.total += 1
    if (!collect || out.matches.length >= limit) continue
    const cut = capText(rawLine.replace(/\r?\n$/, ''), maxLineBytes)
    out.matches.push({
      path: path.split('\\').join('/'),
      line: lineNumber,
      text: cut.text,
      ...(cut.truncated ? { truncated: true } : {}),
    })
  }
  return out
}

/** Render a match list as the spill file body (`path:line: text` per line). */
export function formatGrepMatches(matches: readonly FsGrepMatch[]): string {
  return matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') + (matches.length > 0 ? '\n' : '')
}

// ---------------------------------------------------------------------------
// Service lookup: a consumer resolves `fs@1` by NAME at call time, so swapping
// the provider (`fs-local` today, an ssh/container-backed one tomorrow) is a
// config edit and this module never changes.
// ---------------------------------------------------------------------------

/** The `fs@1` service of the context, or `undefined` when no provider is loaded. */
export function fsOf(ctx: ServiceContext): FsService | undefined {
  return serviceOf<FsService>(ctx, FS)
}

/** The `fs@1` service of the context, as a hard requirement of the caller. */
export function requireFs(ctx: ServiceContext, hint?: string): FsService {
  return requireService<FsService>(ctx, FS, hint ?? 'the filesystem capability (fs@1)')
}

/**
 * The sandbox policy in effect for this capability, when a `sandbox@1` provider
 * is present (the OPTIONAL extension point; no dependency on it).
 *
 * A `sandbox@1` DENY must be EXPRESSIBLE to this seam (requirement R1.2: a
 * consumer that cannot enforce a constraint must ask for a decision and honour a
 * deny, never silently ignore it), so the constraint view is translated with the
 * provider's own fail-closed switch:
 *   * `denied` (the resource rule or the defaults refuse the capability) becomes
 *     `denied: true`, which refuses the READ and the WRITE;
 *   * a fail-closed provider (`unconfigured: 'deny'`) whose view comes from no
 *     rule and no defaults becomes `denied: true` too - that is what
 *     `sandbox.no-policy` decides;
 *   * the view's `writeRoots` is ALWAYS carried (an empty one included), because
 *     the contract defines an empty `writeRoots` as "no write is allowed": a
 *     policy that grants no write root must reach the consumer as `[]`, not as
 *     "no narrowing" (the thread-2556 hole).
 */
export function sandboxPolicyFrom(ctx: ServiceContext): FsSandboxPolicy | undefined {
  const sandbox = serviceOf<FsSandboxProviderLike>(ctx, 'sandbox')
  if (sandbox === undefined || typeof sandbox.policyFor !== 'function') return undefined
  try {
    const view = sandbox.policyFor(FS)
    if (view === undefined) return undefined
    // Only the fail-closed switch needs the active policy, so a provider is
    // asked for it ONLY when the view comes from no rule and no defaults.
    const active = view.from === 'unconfigured' && typeof sandbox.activePolicy === 'function'
      ? sandbox.activePolicy()
      : undefined
    const failClosed = view.from === 'unconfigured' && active?.unconfigured !== 'allow'
    return {
      writeRoots: view.writeRoots,
      readRoots: view.readRoots,
      readOnly: view.readOnly === true,
      ...(view.denied === true || failClosed ? { denied: true } : {}),
      ...(view.source === undefined ? {} : { source: view.source }),
    }
  } catch {
    return undefined
  }
}
