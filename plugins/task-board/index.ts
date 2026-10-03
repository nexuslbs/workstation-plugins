// External workstation plugin: SHARED TASK BOARD for dsh workers.
//
// WHY THIS EXISTS
// The workstation worker plane had NO board/queue. `jobs` (@deepseek-ai/dsh-jobs-local)
// is an in-memory, session-scoped background handle, so a job created by one
// worker is invisible to a SEPARATE worker process. The harness ships an
// EXPERIMENTAL agent-team task board, but it is mounted nowhere and it persists
// into the LEAD session log, not a shared store. This plugin gives the worker
// plane a small, file-backed, bounded board that several SEPARATE processes can
// read and write: a worker posts a task for a peer role, the peer claims it,
// completes it with raw evidence and an artifact, and anyone scoped to it can
// read the entry back. That is the worker<->worker and worker<->orchestrator
// hand-off seam.
//
// STORAGE AND CONCURRENCY
// The board is ONE JSON document on disk (`queuePath`, default
// `$DSH_HOME/task-board/board.json`, i.e. /var/lib/workstation/task-board/board.json
// when DSH_HOME is unset - outside every repository working tree). Every write
// goes to a temp file in the same directory and is moved into place with
// rename(2), so a reader never observes a half-written file. A read-modify-write
// sequence additionally holds an advisory lock file (`<queuePath>.lock`) so two
// workers cannot lose each other's posts; a lock older than 10s is treated as
// stale and reclaimed.
//
// BOUNDED QUEUE (deterministic overflow policy)
// When a post would exceed `maxEntries` (default 100) the plugin EVICTS the
// OLDEST SETTLED entry: the completed entry with the smallest `completed_at`
// (ties broken by the smaller `seq`). If the board is full and NO entry is
// settled, the post is REJECTED with a clear error. The policy is deterministic:
// it never depends on wall-clock of the caller beyond the recorded timestamps.
//
// ROLE SCOPING
// `role` is THIS worker's own role, injected per profile. An entry is visible to
// a caller if and only if one of these holds:
//   * caller.role === entry.assignee_role
//   * entry.assignee_role === '*' (any role)
//   * caller.role === entry.from_role (the poster can always follow up)
//   * caller.role is in `orchestratorRoles` (default ['orchestrator','researcher'])
//
// EVIDENCE CONTRACT
// `task_board_complete` refuses to settle an entry unless BOTH `evidence` (the
// exact raw proof, non-empty) and `artifact` (a pointer: a path, a sha, a URL)
// are supplied and non-empty. A completion without both is an error, never a
// silent success.
//
// NO SECRETS, NO HARDCODED SERVICE TARGET: every path is config (or an env
// default); the plugin never touches a credential.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

/** One declared tool parameter (the property map the core publishes). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

type ToolParameters = Record<string, ToolParameter>

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

export const name = 'task-board'

export interface Config {
  /** THIS worker's own role (injected per profile). Empty means an unknown caller. */
  role?: string
  /** Roles that see every entry regardless of assignee (default orchestrator + researcher). */
  orchestratorRoles?: string[]
  /** Hard bound on retained entries (default 100). */
  maxEntries?: number
  /** Board JSON path (default <dataDir>/board.json). */
  queuePath?: string
  /** Data directory when queuePath is not given (default $DSH_HOME/task-board). */
  dataDir?: string
  /** Bounded wait for the advisory lock, milliseconds (default 2000). */
  lockTimeoutMs?: number
}

type TaskStatus = 'open' | 'claimed' | 'completed'

/** One board entry (the persisted shape). */
interface TaskEntry {
  id: string
  seq: number
  title: string
  objective: string
  assignee_role: string
  from_role: string
  evidence_required: string
  project?: string
  timeoutSecs?: number
  status: TaskStatus
  claimant?: string
  created_at: string
  claimed_at?: string
  completed_at?: string
  evidence?: string
  artifact?: string
}

/** The whole persisted document. */
interface Board {
  version: number
  nextSeq: number
  entries: TaskEntry[]
}

const STATUSES: readonly TaskStatus[] = ['open', 'claimed', 'completed']

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function int(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Read the board; a missing file means an empty board. A malformed file THROWS. */
function readBoard(queuePath: string): Board {
  if (!existsSync(queuePath)) return { version: 1, nextSeq: 1, entries: [] }
  const parsed = JSON.parse(readFileSync(queuePath, 'utf8')) as Partial<Board> | null
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error(`task-board: malformed board file at ${queuePath}`)
  }
  const entries = parsed.entries as TaskEntry[]
  return {
    version: int(parsed.version) ?? 1,
    nextSeq: int(parsed.nextSeq) ?? entries.length + 1,
    entries,
  }
}

/** Atomic write: temp file in the same directory, then rename(2). */
function writeBoard(queuePath: string, board: Board): void {
  mkdirSync(dirname(queuePath), { recursive: true })
  const tmp = `${queuePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, 'utf8')
  renameSync(tmp, queuePath)
}

/** Serialize one read-modify-write across processes with an advisory lock file. */
async function withLock<T>(lockPath: string, timeoutMs: number, action: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
      closeSync(fd)
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { at?: unknown }
        const stamp = typeof owner.at === 'string' ? Date.parse(owner.at) : NaN
        if (Number.isFinite(stamp) && Date.now() - stamp > 10000) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // The lock file vanished or is not fully written yet: just retry.
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`task-board: could not acquire the board lock at ${lockPath} within ${timeoutMs}ms`)
      }
      await sleep(25)
    }
  }
  try {
    return await action()
  } finally {
    try { unlinkSync(lockPath) } catch { /* the lock is already gone */ }
  }
}

/** Role-scoped visibility of one entry (the exact rule from the header). */
function isVisible(entry: TaskEntry, role: string, orchestrators: readonly string[]): boolean {
  if (entry.assignee_role === '*') return true
  if (role.length === 0) return false
  return entry.assignee_role === role || entry.from_role === role || orchestrators.includes(role)
}

/** Timestamp used to pick the oldest settled entry (missing time sorts first). */
function settledAt(entry: TaskEntry): number {
  const parsed = entry.completed_at === undefined ? NaN : Date.parse(entry.completed_at)
  return Number.isFinite(parsed) ? parsed : 0
}

function required(params: Record<string, unknown>, key: string): string {
  const value = str(params[key])
  if (value === undefined) throw new Error(`task-board: '${key}' must be a non-empty string`)
  return value
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const role = str(config.role) ?? ''
  const orchestrators = Array.isArray(config.orchestratorRoles)
    ? config.orchestratorRoles.map((value) => String(value).trim()).filter((value) => value.length > 0)
    : ['orchestrator', 'researcher']
  const maxEntries = Math.max(int(config.maxEntries) ?? 100, 1)
  const dataDir = str(config.dataDir) ?? str(process.env.WORKSTATION_TASK_BOARD_DIR) ?? join(str(process.env.DSH_HOME) ?? '/var/lib/workstation', 'task-board')
  const queuePath = str(config.queuePath) ?? join(dataDir, 'board.json')
  const lockPath = `${queuePath}.lock`
  const lockTimeoutMs = Math.max(int(config.lockTimeoutMs) ?? 2000, 100)

  ctx.logger?.info?.(`task-board: role='${role || '(unset)'}' queue=${queuePath} maxEntries=${maxEntries} orchestrators=[${orchestrators.join(', ')}]`)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_board_post',
    description:
      'post ONE task to the shared worker task board for a peer role (or assignee_role "*" for any role). ' +
      'Required: title, objective, assignee_role, evidence_required (the EXACT raw proof a completion must carry). ' +
      'Returns the new entry with its id; a peer claims it with task_board_claim and settles it with task_board_complete.',
    parameters: {
      title: { type: 'string', required: true, description: 'short one-line task title' },
      objective: { type: 'string', required: true, description: 'the exact task statement: what to do and what to return' },
      assignee_role: { type: 'string', required: true, description: "the peer role this task is FOR, or '*' for any role" },
      evidence_required: { type: 'string', required: true, description: 'the exact raw proof (command + output, url, sha) a completion must carry' },
      project: { type: 'string', description: 'optional project/workspace tag for the task' },
      timeoutSecs: { type: 'integer', description: 'optional suggested wall-clock bound for the peer, seconds' },
    },
    output: { schema: {}, render: renderValue },
    execute: async (params) => {
      const title = required(params, 'title')
      const objective = required(params, 'objective')
      const assigneeRole = required(params, 'assignee_role')
      const evidenceRequired = required(params, 'evidence_required')
      const project = str(params.project)
      const timeoutSecs = int(params.timeoutSecs)
      return await withLock(lockPath, lockTimeoutMs, () => {
        const board = readBoard(queuePath)
        if (board.entries.length >= maxEntries) {
          const settled = board.entries
            .filter((entry) => entry.status === 'completed')
            .sort((left, right) => (settledAt(left) - settledAt(right)) || (left.seq - right.seq))
          const oldest = settled[0]
          if (oldest === undefined) {
            throw new Error(`task-board: queue is full (maxEntries=${maxEntries}) and no settled entry can be evicted; post rejected`)
          }
          board.entries = board.entries.filter((entry) => entry.id !== oldest.id)
        }
        const entry: TaskEntry = {
          id: `tb-${String(board.nextSeq).padStart(6, '0')}`,
          seq: board.nextSeq,
          title,
          objective,
          assignee_role: assigneeRole,
          from_role: role,
          evidence_required: evidenceRequired,
          ...(project === undefined ? {} : { project }),
          ...(timeoutSecs === undefined ? {} : { timeoutSecs }),
          status: 'open',
          created_at: new Date().toISOString(),
        }
        board.nextSeq += 1
        board.entries.push(entry)
        writeBoard(queuePath, board)
        return { posted: true, entry, queue: { path: queuePath, size: board.entries.length, maxEntries } }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_board_list',
    description:
      'list the shared task board entries VISIBLE TO THIS CALLER ROLE only, oldest first. ' +
      'Filters: assignee_role, status (open|claimed|completed), limit. Each item carries its status and claimant.',
    parameters: {
      assignee_role: { type: 'string', description: 'only entries whose assignee_role is exactly this value' },
      status: { type: 'string', enum: STATUSES, description: 'only entries in this status' },
      limit: { type: 'integer', description: 'maximum entries to return (default 50, capped by maxEntries)' },
    },
    output: { schema: {}, render: renderValue },
    execute: (params) => {
      const board = readBoard(queuePath)
      const filterRole = str(params.assignee_role)
      const filterStatus = str(params.status)
      const limit = Math.min(Math.max(int(params.limit) ?? 50, 1), maxEntries)
      const entries = board.entries
        .filter((entry) => isVisible(entry, role, orchestrators))
        .filter((entry) => filterRole === undefined || entry.assignee_role === filterRole)
        .filter((entry) => filterStatus === undefined || entry.status === filterStatus)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit)
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          objective: entry.objective,
          assignee_role: entry.assignee_role,
          from_role: entry.from_role,
          status: entry.status,
          claimant: entry.claimant ?? null,
          evidence_required: entry.evidence_required,
          project: entry.project ?? null,
          timeoutSecs: entry.timeoutSecs ?? null,
          created_at: entry.created_at,
          claimed_at: entry.claimed_at ?? null,
          completed_at: entry.completed_at ?? null,
        }))
      return { role, count: entries.length, queue: { path: queuePath, maxEntries }, entries }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_board_claim',
    description:
      "claim one OPEN entry for THIS caller role. Allowed only when the entry's assignee_role equals the caller role or is '*'.",
    parameters: {
      id: { type: 'string', required: true, description: 'the entry id returned by task_board_post' },
    },
    output: { schema: {}, render: renderValue },
    execute: async (params) => {
      const id = required(params, 'id')
      if (role.length === 0) throw new Error('task-board: this profile has no configured role; claim is not allowed')
      return await withLock(lockPath, lockTimeoutMs, () => {
        const board = readBoard(queuePath)
        const entry = board.entries.find((candidate) => candidate.id === id)
        if (entry === undefined) throw new Error(`task-board: no entry '${id}'`)
        if (!isVisible(entry, role, orchestrators)) throw new Error(`task-board: entry '${id}' is not visible to role '${role}'`)
        if (entry.assignee_role !== '*' && entry.assignee_role !== role) {
          throw new Error(`task-board: entry '${id}' is assigned to '${entry.assignee_role}' and cannot be claimed by '${role}'`)
        }
        if (entry.status !== 'open') throw new Error(`task-board: entry '${id}' is '${entry.status}'; only an open entry can be claimed`)
        entry.status = 'claimed'
        entry.claimant = role
        entry.claimed_at = new Date().toISOString()
        writeBoard(queuePath, board)
        return { claimed: true, entry }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_board_complete',
    description:
      'settle one entry with the EVIDENCE CONTRACT: BOTH evidence (the exact raw proof, non-empty) and artifact ' +
      '(a pointer: path, sha or url) are REQUIRED; the call fails without both. Stores them on the entry.',
    parameters: {
      id: { type: 'string', required: true, description: 'the entry id to complete' },
      evidence: { type: 'string', required: true, description: 'the exact raw proof the completion carries (required, non-empty)' },
      artifact: { type: 'string', required: true, description: 'a pointer to the produced artifact: a path, a sha or a URL (required, non-empty)' },
    },
    output: { schema: {}, render: renderValue },
    execute: async (params) => {
      const id = required(params, 'id')
      const evidence = required(params, 'evidence')
      const artifact = required(params, 'artifact')
      if (role.length === 0) throw new Error('task-board: this profile has no configured role; complete is not allowed')
      return await withLock(lockPath, lockTimeoutMs, () => {
        const board = readBoard(queuePath)
        const entry = board.entries.find((candidate) => candidate.id === id)
        if (entry === undefined) throw new Error(`task-board: no entry '${id}'`)
        if (!isVisible(entry, role, orchestrators)) throw new Error(`task-board: entry '${id}' is not visible to role '${role}'`)
        if (entry.status === 'completed') throw new Error(`task-board: entry '${id}' is already completed`)
        if (entry.assignee_role !== '*' && entry.assignee_role !== role && entry.claimant !== role && !orchestrators.includes(role)) {
          throw new Error(`task-board: entry '${id}' is not assigned to or claimed by '${role}'`)
        }
        entry.status = 'completed'
        entry.evidence = evidence
        entry.artifact = artifact
        entry.completed_at = new Date().toISOString()
        entry.claimant = entry.claimant ?? role
        writeBoard(queuePath, board)
        return { completed: true, entry }
      })
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'task_board_get',
    description: 'read ONE board entry, including its evidence and artifact, if it is visible to THIS caller role.',
    parameters: {
      id: { type: 'string', required: true, description: 'the entry id to read' },
    },
    output: { schema: {}, render: renderValue },
    execute: (params) => {
      const id = required(params, 'id')
      const board = readBoard(queuePath)
      const entry = board.entries.find((candidate) => candidate.id === id)
      if (entry === undefined) throw new Error(`task-board: no entry '${id}'`)
      if (!isVisible(entry, role, orchestrators)) throw new Error(`task-board: entry '${id}' is not visible to role '${role}'`)
      return { role, entry }
    },
  })))
}

export default { name, inject: ['tools'], apply }
