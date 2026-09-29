# workspace-register (workstation facade plugin)

Registers workstation **cwd roots** as dsh **Workspaces** so the webserver groups every session
under a workspace. The harness workspace registry (`ctx.workspaceRegistry`, hosted in the running
service) groups a session under a Workspace only when both hold:

* the session id is in the workspace record's `sessionIds` account, and
* the session's stored header cwd canonicalizes (`fs.realpath`) to the workspace path
  (`packages/workspace/workspace/src/entity.ts`).

`plugins/agent-run` runs each worker with its cwd set to `<projectsDir>/<project>`, so project
sessions ARE per directory on disk, but the registry was never told about those directories. Legacy
direct-run sessions live outside the projects root under roots such as `/harness`,
`/var/lib/workstation/work/<role>` and `/opt/omni/data`; they need their own Workspaces too. The
registry does **not** backfill existing history: it bootstraps only while its durable state is still
`initialized: false`, and the live state is already committed as `initialized: true` with zero
registrations, so each root needs an explicit `create()` plus one `attachSession()` per matching
stored header.

## The `workspace_register` tool

| parameter | type | required | meaning |
|---|---|---|---|
| `project` | string | no | one project directory name under the projects root (e.g. `workstation`); omitted registers **every** distinct canonical cwd root |

With `project` omitted the tool scans `ctx.sessionPersistence.list()`, canonicalizes each stored
header cwd and registers **one Workspace per distinct canonical root** - project directories and
legacy roots alike. The set of roots is sorted by canonical path for determinism; each workspace is
titled by the **basename** of its canonical path, so two roots that merely share a basename stay two
distinct Workspaces (the registry keys `create()` on the canonical path, never the title). With
`project` given, only `<projectsDir>/<project>` is registered, exactly as before.

For each target it idempotently `registry.create(<canonical dir>, title=<label>)`, then attaches
every stored session header whose canonical cwd equals that path. The answer is raw evidence - per
workspace `{project, id, path, title, sessionCount, sessionIds, createdAt, updatedAt, created,
attached, skipped}` plus totals and per-target errors - never prose.

Idempotent end to end: `create()` reuses a canonical path without retitling and `attachSession()`
skips an already-accounted id, so a re-run only re-reports the same registry state.

## Config

| key | default | meaning |
|---|---|---|
| `projectsDir` | `$WORKSTATION_PROJECTS_DIR` or `/var/lib/workstation/projects` | Root of the project directories; used in single-project mode and to recognize `<projectsDir>/<project>` roots |

## Shared helper

`registration.ts` owns `backfillWorkspaces`, `ensureWorkspace` and `attachSessionIds`. The per
dispatch half in `plugins/agent-run` imports the same helper, so the backfill and the auto
registration cannot drift.

## Credentials

None. The tool never touches a credential.
