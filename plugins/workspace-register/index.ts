// External workstation plugin: PROJECT -> Workspace registration (the
// `workspace_register` backfill tool).
//
// WHY THIS EXISTS (operator requirement, 2026-09-29): the dsh webserver groups
// sessions per project, and the grouping is a WORKSPACE REGISTRY record
// (`ctx.workspaceRegistry`, packages/workspace/workspace): a session appears
// under a Workspace only when its id is in the record's `sessionIds` AND its
// stored header cwd canonicalizes to the workspace path. dsh stores sessions
// per project bucket already (plugins/agent-run runs each worker with its cwd
// set to `<projectsDir>/<project>`), but the registry was never told about
// those directories, so the webserver showed no projects.
//
// This plugin owns the BACKFILL half of the fix: `workspace_register` registers
// EVERY project directory (or one named project) and attaches the stored
// sessions whose canonical cwd matches it. The per-dispatch half lives in
// plugins/agent-run (`apply()` ensures the workspace before a run and attaches
// the created session after it); both import the SAME helper,
// `./registration.ts`, so they cannot drift.
//
// IDEMPOTENT END TO END: `registry.create()` reuses a canonical path without
// retitling and `attachSession()` is a no-op for an already-accounted id, so
// re-running the tool only re-reports the same registry state.
//
// The answer is RAW EVIDENCE - per workspace `{id, path, title, sessionCount,
// sessionIds, createdAt, updatedAt, created, attached, skipped}` plus totals -
// never prose, so a caller verifies the registry instead of trusting a claim.

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'
import {
  backfillWorkspaces,
  projectNames,
  type BackfillResult,
  type SessionPersistenceLike,
  type WorkspaceRegistryLike,
} from './registration.ts'

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

/**
 * The live cordis context slice this plugin needs. `workspaceRegistry` and
 * `sessionPersistence` are declared in the `inject` list, so cordis activates
 * the plugin only once both services are loaded and property access is legal.
 */
interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
  workspaceRegistry: WorkspaceRegistryLike
  sessionPersistence: SessionPersistenceLike
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

export const name = 'workspace-register'

export interface Config {
  /**
   * Root of the PROJECT directories (default $WORKSTATION_PROJECTS_DIR or
   * /var/lib/workstation/projects). One subdirectory per project; each becomes
   * one Workspace whose path is the canonical directory.
   */
  projectsDir?: string
}

/** Trim a string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const projectsDir = str(config.projectsDir) ?? str(process.env.WORKSTATION_PROJECTS_DIR) ?? '/var/lib/workstation/projects'

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'workspace_register',
      description:
        'Registers the workstation PROJECT workspaces in the dsh workspace registry (ctx.workspaceRegistry) so the webserver groups sessions per project. With no parameter it registers EVERY project directory under the projects root (idempotent: repeat calls reuse the registration) and attaches the stored sessions whose canonical cwd equals each workspace path. Pass project=<name> to register exactly one. Returns raw registry evidence per workspace (id, path, title, full sessionIds list, timestamps, what this call created/attached) plus totals.',
      parameters: {
        project: {
          type: 'string',
          description: 'one project directory name under the projects root (e.g. workstation, asset-pipeline); omit to register ALL project directories',
        },
      },
      execute: async (params): Promise<BackfillResult> => {
        const project = str(params.project)
        ctx.logger?.info?.(`workspace-register: backfilling ${project ?? 'ALL'} project(s) under ${projectsDir}`)
        const result = await backfillWorkspaces({
          registry: ctx.workspaceRegistry,
          persistence: ctx.sessionPersistence,
          projectsDir,
          ...(project === undefined ? {} : { project }),
        })
        ctx.logger?.info?.(
          `workspace-register: ${result.totals.workspaces} workspace(s), ${result.totals.sessions} session(s), `
          + `${result.totals.attached} newly attached, ${result.errors.length} error(s)`,
        )
        return result
      },
      output: { schema: {}, render: renderValue },
    })),
  )
}

/** Exposed for the regression test: the project names the tool would enumerate. */
export { projectNames }

export default { name, inject: ['tools', 'workspaceRegistry', 'sessionPersistence'], apply }
