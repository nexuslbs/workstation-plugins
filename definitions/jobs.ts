// definitions/jobs.ts - the BACKGROUND JOBS capability (`jobs@1`).
//
// WHY THIS MODULE EXISTS: `subprocess@1` answers within ONE bounded call, which is
// the right shape for a command that finishes. Long work (a build, a deploy, a
// watch loop) has the opposite shape: START it, come back later, read the NEW
// output since last time, stop it when it is done. That lifecycle is this seam:
//
//        Provider  ->  Definition  <-  Consumer
//   core/jobs-local                  plugins/jobs-tools
//   (node:child_process + log files) (the `jobs ...` named tools)
//
// THE THREE PROPERTIES THAT MATTER:
//
//   1. CURSOR-PAGED LOGS: `logs({id, cursor})` returns the bytes from `cursor`
//      onward and the NEXT cursor. A poller never re-reads the whole log and never
//      loses a line between two calls; when nothing new arrived the answer is
//      empty with the SAME cursor (`eof: true`).
//   2. DURABLE LOG ON DISK: a job's output lives in a file under the jobs
//      directory, so the job survives the client that started it (a disconnect, a
//      new process reading the same directory). Nothing is kept only in memory.
//   3. OWNED RESOURCES: jobs belong to the plugin. Unloading it (or a config
//      reconcile dropping its row) stops and cleans its jobs through the cordis
//      `effect()` disposer - no orphan process, no leaked log file, and a running
//      job never keeps a REQUEST alive.
//
// SHAPE: modelled on the DeepSeek harness `jobs` group (MIT, `packages/jobs/*`),
// whose model this module follows: a registry contract, process-local storage, an
// owning session, and completion delivered in-session instead of polled. What
// workbench deliberately does NOT take from DSH: the agent-session scoping and the
// model-facing wait/cancel presentation. See THIRD_PARTY.md for the MIT notice.
//
// CORDIS-FREE: the cursor math, the state machine and the retention decision are
// PURE functions here; every child process and every file lives in the provider.

import { ServiceError, type ServiceErrorCode, isRecord, positiveInt, serviceOf, str, type ServiceContext } from './support.ts'

/** Name of the cordis service (`ctx.jobs`). */
export const JOBS = 'jobs'

/** Contract version this definition speaks. A provider must implement it. */
export const JOBS_VERSION = 1

/** Contract id including the version, e.g. `jobs@1`. */
export const JOBS_CONTRACT = `${JOBS}@${JOBS_VERSION}`

/** Default maximum number of jobs one provider keeps (32). */
export const DEFAULT_JOBS_MAX = 32

/** Default byte ceiling of ONE job log (8 MiB): reaching it STOPS the job. */
export const DEFAULT_JOB_MAX_LOG_BYTES = 8 * 1024 * 1024

/** Default deadline of a job (0 = no deadline; a job is stopped explicitly). */
export const DEFAULT_JOB_TIMEOUT_MS = 0

/** Default byte window one `logs` page returns (64 KiB). */
export const DEFAULT_JOB_PAGE_BYTES = 64 * 1024

/** Hard ceiling of one `logs` page (1 MiB). */
export const MAX_JOB_PAGE_BYTES = 1024 * 1024

/** Default grace between SIGTERM and SIGKILL when stopping (500 ms). */
export const DEFAULT_JOB_GRACE_MS = 500

/** Where a job is in its lifecycle. */
export type JobState =
  /** The process is alive (or is about to be reaped). */
  | 'running'
  /** It exited with code 0. */
  | 'exited'
  /** It exited with a non-zero code. */
  | 'failed'
  /** It was killed (stop / log cap / deadline). */
  | 'killed'

/** The reasons a call of this capability can fail (branch on `reason`). */
export type JobsErrorReason =
  | 'jobs.invalid-input'
  | 'jobs.not-found'
  | 'jobs.limit'
  | 'jobs.spawn-failed'
  | 'jobs.shell-disabled'
  | 'jobs.reference-unresolved'
  | 'jobs.io'

export interface JobsErrorOptions {
  stage?: string
  details?: Record<string, unknown>
}

/** The one error shape this capability throws (a `ServiceError` subclass). */
export class JobsError extends ServiceError {
  readonly reason: JobsErrorReason

  constructor(reason: JobsErrorReason, message: string, options: JobsErrorOptions = {}) {
    super('invalid-input', message, { stage: options.stage ?? 'jobs', details: { reason, ...options.details } })
    this.name = 'JobsError'
    this.reason = reason
  }

  /** A JSON-safe view (what a tool answers, what a log line carries). */
  override toJSON(): { error: string; code: ServiceErrorCode; stage: string; reason: JobsErrorReason; details: Record<string, unknown> } {
    return { error: this.message, code: this.code, stage: this.stage, reason: this.reason, details: this.details }
  }
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

/** The body of a `start` call (the same command shape as `subprocess@1`). */
export interface JobStartInput {
  /** The command as an ARGV ARRAY (preferred); started directly, no shell. */
  argv?: readonly string[]
  /** The command as ONE STRING; requires `shell: true`. */
  command?: string
  /** Explicit shell escape hatch: `<shell> -c <command>`. */
  shell?: boolean
  /** Working directory of the job. */
  cwd?: string
  /** LITERAL environment overrides (never logged). */
  env?: Record<string, string>
  /** Environment entries resolved by the credentials/process environment. */
  envRefs?: Record<string, string>
  /** A short human label (used in `list`; not an identifier). */
  label?: string
  /** Optional deadline in ms (0/absent = no deadline). */
  timeoutMs?: number
  /** Byte ceiling of THIS job's log (default: the provider policy). */
  maxLogBytes?: number
}

/** Everything known about one job. */
export interface JobInfo {
  /** Stable job id (`job_<12 hex>`), the handle every other call takes. */
  id: string
  label?: string
  /** Display form of the command (reference values masked). */
  display: string
  argv: string[]
  shell: boolean
  cwd: string
  state: JobState
  /** Process id of the job's process GROUP leader, while known. */
  pid?: number
  /** ISO timestamp of the start. */
  startedAt: string
  /** ISO timestamp of the end (absent while running). */
  endedAt?: string
  /** Exit code, when the process exited. */
  exitCode?: number | null
  /** Signal that ended it, when it was killed. */
  signal?: string | null
  /** Wall-clock duration in ms (live while running). */
  durationMs: number
  /** The log file on disk (always present; it is the durable half). */
  logPath: string
  /** Bytes written to the log so far. */
  logBytes: number
  /** True when the log reached its ceiling (the job was stopped because of it). */
  truncated: boolean
  /** Human note: state, exit, log location. */
  note: string
}

/** The body of a `logs` call: a byte CURSOR and a window size. */
export interface JobLogsInput {
  id: string
  /** Byte cursor returned by the previous call (default 0 = from the start). */
  cursor?: number
  /** Maximum bytes returned (default 64 KiB, hard max 1 MiB). */
  limit?: number
  /** Also return the WHOLE log from the start (ignores `cursor`). */
  fromStart?: boolean
  /**
   * How long a call may WAIT for new bytes while the job is still running and
   * the page is empty (default 1000 ms, hard max 10000 ms). A follower gets the
   * next line instead of a busy "no lines" answer; `0` polls immediately.
   */
  waitMs?: number
}

/** One page of a job's log, with the cursor of the next page. */
export interface JobLogPage {
  id: string
  state: JobState
  /** The byte cursor this page started at. */
  cursor: number
  /** The cursor to pass to the NEXT call (never moves backwards). */
  nextCursor: number
  /** Total bytes of the log at the moment of the call. */
  bytes: number
  /** Bytes returned in this page. */
  returnedBytes: number
  /** Complete lines of this page (a trailing partial line stays for the next page). */
  lines: string[]
  /**
   * True when the page reached the end of the log of a job that has FINISHED:
   * nothing more can arrive, the caller is up to date. A running job is never
   * `eof` (its log grows), so a follower knows to call again.
   */
  eof: boolean
  /** Human note: how many lines, how many bytes, whether there is more. */
  note: string
}

/** The body of a `stop` call. */
export interface JobStopInput {
  id: string
  /** Signal sent first (default SIGTERM, followed by SIGKILL after the grace). */
  signal?: NodeJS.Signals
  /** Grace in ms between the first signal and SIGKILL (default 500). */
  graceMs?: number
}

/** The body of a `cleanup` call. */
export interface JobCleanupInput {
  /** Also remove jobs that are still RUNNING (they are stopped first). */
  all?: boolean
  /** Remove only jobs that ended more than this many seconds ago. */
  olderThanSeconds?: number
  /** Report what would be removed without removing anything. */
  dryRun?: boolean
  /** Also delete the log files of the removed jobs (default true). */
  removeLogs?: boolean
}

/** What a cleanup removed. */
export interface JobCleanupResult {
  /** Job ids removed from the registry. */
  removed: string[]
  /** Job ids stopped first (still running when cleanup ran with `all`). */
  stopped: string[]
  /** Log files deleted. */
  removedLogs: string[]
  /** True when nothing was removed (dry run). */
  dryRun: boolean
  note: string
}

/** The policy a provider reports (never a secret). */
export interface JobsPolicy {
  /** Directory holding the job logs. */
  dir: string
  /** Maximum number of jobs kept at once. */
  maxJobs: number
  /** Default byte ceiling of one job log. */
  maxLogBytes: number
  /** Default deadline in ms (0 = none). */
  timeoutMs: number
  /** Grace between SIGTERM and SIGKILL. */
  graceMs: number
  /** Whether `shell: true` is allowed. */
  allowShell: boolean
  /** Default byte window of one `logs` page. */
  pageBytes: number
}

/**
 * The capability a consumer reaches as `ctx.jobs`. Every job is started once,
 * identified by a stable id, logged to disk and stoppable; `logs` is a byte
 * cursor page, never a re-read of the whole log.
 */
export interface JobsService {
  start(input: JobStartInput): Promise<JobInfo>
  list(): Promise<JobInfo[]>
  status(id: string): Promise<JobInfo>
  logs(input: JobLogsInput): Promise<JobLogPage>
  stop(input: JobStopInput): Promise<JobInfo>
  cleanup(input?: JobCleanupInput): Promise<JobCleanupResult>
  /** The policy in effect (dir, caps, defaults). */
  policy(): JobsPolicy
}

// ---------------------------------------------------------------------------
// Config + pure helpers (no process, no filesystem).
// ---------------------------------------------------------------------------

/** The config of a jobs provider. */
export interface JobsConfig {
  /** Directory for job logs (default: `<subprocess spill dir>/jobs`). */
  dir?: string
  /** Maximum number of jobs kept (default 32). */
  maxJobs?: number
  /** Byte ceiling of one job log (default 8 MiB). */
  maxLogBytes?: number
  /** Default deadline in ms (default 0 = none). */
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL (default 500 ms). */
  graceMs?: number
  /** Whether `shell: true` is allowed (default true). */
  allowShell?: boolean
  /** Default page size of `logs` (default 64 KiB). */
  pageBytes?: number
  /** Whether the provider stops its jobs when the plugin unloads (default true). */
  stopOnUnload?: boolean
}

/** The normalised policy of a jobs provider. */
export interface NormalizedJobsConfig extends JobsPolicy {
  stopOnUnload: boolean
}

/** Folds defaults and caps into a jobs config. */
export function normalizeJobsConfig(config: JobsConfig = {}, defaultDir = '/tmp/workbench-jobs'): NormalizedJobsConfig {
  return {
    dir: str(config.dir) ?? defaultDir,
    maxJobs: positiveInt(config.maxJobs, DEFAULT_JOBS_MAX),
    maxLogBytes: positiveInt(config.maxLogBytes, DEFAULT_JOB_MAX_LOG_BYTES),
    timeoutMs: typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? Math.floor(config.timeoutMs) : DEFAULT_JOB_TIMEOUT_MS,
    graceMs: positiveInt(config.graceMs, DEFAULT_JOB_GRACE_MS),
    allowShell: config.allowShell !== false,
    pageBytes: positiveInt(config.pageBytes, DEFAULT_JOB_PAGE_BYTES, MAX_JOB_PAGE_BYTES),
    stopOnUnload: config.stopOnUnload !== false,
  }
}

/** True when the state is terminal (the process is gone and the exit is known). */
export function isTerminalState(state: JobState): boolean {
  return state !== 'running'
}

/**
 * The state of a finished process: 0 -> `exited`, anything else -> `failed`, a
 * killed process -> `killed` (a signal that was ASKED for is not a failure).
 */
export function stateOfExit(exitCode: number | null, signal: string | null, killed: boolean): JobState {
  if (killed || (exitCode === null && signal !== null)) return 'killed'
  return exitCode === 0 ? 'exited' : 'failed'
}

/**
 * The window of a log a `logs` call returns, as a PURE function: it starts at the
 * beginning of the line containing `cursor` and ends after the last COMPLETE line
 * inside `[cursor, cursor + limit)`. A trailing partial line is left for the next
 * call, so no cursor ever splits a line in half. When there is nothing new, the
 * cursor does not move.
 */
export function readLogWindow(
  buffer: Buffer,
  cursor: number,
  limit: number,
): { cursor: number; nextCursor: number; lines: string[]; returnedBytes: number; eof: boolean } {
  const start = Math.min(Math.max(0, Math.floor(cursor)), buffer.length)
  const wanted = positiveInt(limit, DEFAULT_JOB_PAGE_BYTES, MAX_JOB_PAGE_BYTES)
  const slice = buffer.subarray(start, Math.min(buffer.length, start + wanted))
  const lastNewline = slice.lastIndexOf(0x0a)
  if (lastNewline < 0) {
    // No complete line in the window: nothing is returned and the cursor HOLDS,
    // unless the window reaches the end of the log (then the partial tail is the
    // only content there is and it is returned as a line of its own).
    if (slice.length === buffer.length - start) {
      const text = slice.toString('utf8')
      return { cursor: start, nextCursor: buffer.length, lines: text.length === 0 ? [] : [text], returnedBytes: slice.length, eof: true }
    }
    return { cursor: start, nextCursor: start, lines: [], returnedBytes: 0, eof: false }
  }
  const consumed = slice.subarray(0, lastNewline + 1)
  const text = consumed.toString('utf8')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const nextCursor = start + consumed.length
  return { cursor: start, nextCursor, lines, returnedBytes: consumed.length, eof: nextCursor >= buffer.length }
}

/** The log file name of a job id (the id is validated, so this stays safe). */
export function logFileName(jobId: string): string {
  return `${jobId}.log`
}

/** A job id is a handle: `job_` plus hex, never a path. */
export function isValidJobId(value: unknown): value is string {
  return typeof value === 'string' && /^job_[0-9a-f]{8,32}$/.test(value)
}

/** Narrows an unknown value to a job-start input record (used by consumers). */
export function isJobInput(value: unknown): value is JobStartInput {
  return isRecord(value)
}

/** Structural lookup of the jobs capability (`ctx.jobs`). */
export function jobsOf(ctx: ServiceContext): JobsService | undefined {
  return serviceOf<JobsService>(ctx, JOBS)
}

/** The jobs capability, or a structured error naming the missing provider. */
export function requireJobs(ctx: ServiceContext): JobsService {
  const service = jobsOf(ctx)
  if (service === undefined) {
    throw new JobsError('jobs.invalid-input', 'no jobs@1 provider is loaded: enable a provider plugin (core/jobs-local) in the roster', {
      stage: 'jobs.lookup',
    })
  }
  return service
}
