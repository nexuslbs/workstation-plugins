// Shared PROJECT -> Workspace registration helper.
//
// ONE project directory (`<projectsDir>/<project>`) is ONE dsh session bucket,
// because the worker's cwd IS the project directory (plugins/agent-run). The
// harness workspace registry (ctx.workspaceRegistry) groups sessions under a
// Workspace only when BOTH facts hold:
//
//   * the session id is in the workspace record's `sessionIds` account, AND
//   * the session's stored header cwd canonicalizes (fs.realpath) to the
//     workspace path (packages/workspace/workspace/src/entity.ts).
//
// The registry does NOT auto-create workspaces for existing history: it
// bootstraps only once, when its durable state is still `initialized: false`.
// The live registry here already committed an empty `initialized: true` state,
// so every project needs an explicit `create()` plus one `attachSession()` per
// matching stored header. `create()` is idempotent (a repeated canonical path
// returns the existing entity without retitling) and `attachSession()` is
// idempotent (an already-accounted id is a no-op), so the whole flow re-runs as
// a no-op.
//
// This module is deliberately CORDIS-FREE and imports only node built-ins: it
// is the ONE helper both consumers share -
//
//   * plugins/workspace-register (the `workspace_register` backfill tool), and
//   * plugins/agent-run (the per-dispatch auto-registration),
//
// so the two never drift. It is structural over the two harness services, not
// coupled to their classes, which is what makes it testable without the harness
// and portable onto a new module URL when a live stage is required.

import { readdirSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The immutable facts of one stored session the registry validates against. */
export interface SessionHeaderLike {
  readonly id: string
  readonly cwd?: string
}

/** One stored-session projection as `ctx.sessionPersistence.list()` returns it. */
export interface SessionSnapshotLike {
  readonly header: SessionHeaderLike
}

/** The `ctx.sessionPersistence` slice this helper reads. */
export interface SessionPersistenceLike {
  list(options?: unknown): Promise<readonly SessionSnapshotLike[]>
}

/** The `Workspace` surface this helper uses (registry entity). */
export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** The `ctx.workspaceRegistry` slice this helper reads. */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
  list?(): WorkspaceLike[]
}

/** One session that could not be attached, with the registry's own reason. */
export interface SkippedSession {
  sessionId: string
  reason: string
}

/** Outcome of one best-effort attach pass. */
export interface AttachOutcome {
  attached: string[]
  skipped: SkippedSession[]
}

/** Raw per-workspace evidence the backfill reports. */
export interface WorkspaceEvidence {
  /** Project directory name under `projectsDir`. */
  project: string
  id: string
  path: string
  title: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  sessionIds: string[]
  /** Whether THIS pass created the registration (false = it already existed). */
  created: boolean
  /** Session ids newly attached by THIS pass. */
  attached: string[]
  /** Matching headers the registry refused (best-effort; never fatal). */
  skipped: SkippedSession[]
}

/** The complete backfill answer (raw evidence, no interpretation). */
export interface BackfillResult {
  projectsDir: string
  project?: string
  workspaces: WorkspaceEvidence[]
  totals: {
    workspaces: number
    sessions: number
    attached: number
    skipped: number
    created: number
  }
  errors: Array<{ project: string; error: string }>
}

/** A project name is ONE path segment: lowercase, short, no traversal. */
export function sanitizeProject(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return cleaned.slice(0, 64)
}

/** The canonical absolute directory path, or `undefined` when it does not resolve to a directory. */
export async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(path)
    return (await stat(resolved)).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Every project directory name directly under `projectsDir`, sorted.
 * Only real directories are returned (symlinks followed); dot-entries skipped.
 */
export function projectNames(projectsDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    try {
      if (statSync(join(projectsDir, entry)).isDirectory()) names.push(entry)
    } catch {
      /* a dangling entry is not a project */
    }
  }
  return names.sort()
}

/** Idempotent `registry.create(path, title)`; repeated canonical paths return the existing entity. */
export async function ensureWorkspace(
  registry: WorkspaceRegistryLike,
  path: string,
  title: string,
): Promise<WorkspaceLike> {
  return await registry.create(path, title)
}

/**
 * Best-effort attach of `sessionIds` to `workspace`, in order.
 *
 * The registry's own `attachSession` is the AUTHORITATIVE cwd validator: an id
 * already accounted is skipped, a mismatched/missing/unresolvable cwd is
 * reported in `skipped` and never fails the pass (unless `throwOnError`).
 */
export async function attachSessionIds(
  workspace: WorkspaceLike,
  sessionIds: readonly string[],
  options: { throwOnError?: boolean } = {},
): Promise<AttachOutcome> {
  const outcome: AttachOutcome = { attached: [], skipped: [] }
  const accounted = new Set<string>(workspace.sessionIds)
  const seen = new Set<string>()
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (seen.has(sessionId) || accounted.has(sessionId)) continue
    seen.add(sessionId)
    try {
      await workspace.attachSession(sessionId)
      outcome.attached.push(sessionId)
      for (const current of workspace.sessionIds) accounted.add(current)
    } catch (error) {
      outcome.skipped.push({
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      })
      if (options.throwOnError === true) throw error
    }
  }
  return outcome
}

/**
 * Backfill Workspace registrations for the project directories under
 * `projectsDir`.
 *
 * With `project` omitted every project directory is registered; with it, only
 * that one. For each project: canonicalize the directory, idempotent
 * `create(path, title=<project>)`, then attach every stored session header
 * whose canonical cwd equals that path. One `sessionPersistence.list()` call
 * serves every project. Per-project failures are collected in `errors` instead
 * of aborting the run.
 */
export async function backfillWorkspaces(options: {
  registry: WorkspaceRegistryLike
  persistence: SessionPersistenceLike
  projectsDir: string
  project?: string
}): Promise<BackfillResult> {
  const { registry, persistence, projectsDir } = options
  const requested = options.project === undefined ? undefined : sanitizeProject(options.project)
  const projects = requested === undefined || requested.length === 0
    ? projectNames(projectsDir)
    : [requested]

  // ONE listing for every project: map canonical cwd -> stored session ids.
  const snapshots = await persistence.list()
  const canonicalByCwd = new Map<string, string | undefined>()
  const byPath = new Map<string, string[]>()
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    const cwd = header?.cwd
    if (typeof header?.id !== 'string' || header.id.length === 0) continue
    if (typeof cwd !== 'string' || cwd.length === 0) continue
    if (!canonicalByCwd.has(cwd)) canonicalByCwd.set(cwd, await canonicalDirectory(cwd))
    const canonical = canonicalByCwd.get(cwd)
    if (canonical === undefined) continue
    const bucket = byPath.get(canonical)
    if (bucket === undefined) byPath.set(canonical, [header.id])
    else bucket.push(header.id)
  }

  const knownPaths = new Set<string>((registry.list?.() ?? []).map((workspace) => workspace.path))
  const workspaces: WorkspaceEvidence[] = []
  const errors: Array<{ project: string; error: string }> = []

  for (const project of projects) {
    if (project.length === 0) continue
    const directory = join(projectsDir, project)
    try {
      const path = await canonicalDirectory(directory)
      if (path === undefined) {
        errors.push({ project, error: `project directory does not resolve to a directory: ${directory}` })
        continue
      }
      const created = !knownPaths.has(path)
      const workspace = await ensureWorkspace(registry, path, project)
      knownPaths.add(workspace.path)
      const candidates = byPath.get(workspace.path) ?? []
      const outcome = await attachSessionIds(workspace, candidates)
      workspaces.push({
        project,
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        sessionCount: workspace.sessionIds.length,
        sessionIds: [...workspace.sessionIds],
        created,
        attached: outcome.attached,
        skipped: outcome.skipped,
      })
    } catch (error) {
      errors.push({ project, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const totals = {
    workspaces: workspaces.length,
    sessions: workspaces.reduce((sum, workspace) => sum + workspace.sessionCount, 0),
    attached: workspaces.reduce((sum, workspace) => sum + workspace.attached.length, 0),
    skipped: workspaces.reduce((sum, workspace) => sum + workspace.skipped.length, 0),
    created: workspaces.filter((workspace) => workspace.created).length,
  }
  return {
    projectsDir,
    ...(requested === undefined || requested.length === 0 ? {} : { project: requested }),
    workspaces,
    totals,
    errors,
  }
}
