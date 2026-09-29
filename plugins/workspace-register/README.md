# workspace-register (workstation facade plugin)

Registers the workstation PROJECT directories as dsh **Workspaces** so the webserver groups
sessions per project. The harness workspace registry (`ctx.workspaceRegistry`, hosted in the
running service) groups a session under a Workspace only when both hold:

* the session id is in the workspace record's `sessionIds` account, and
* the session's stored header cwd canonicalizes (`fs.realpath`) to the workspace path
  (`packages/workspace/workspace/src/entity.ts`).

`plugins/agent-run` already runs each worker with its cwd set to `<projectsDir>/<project>`, so the
sessions ARE per project on disk, but the registry was never told about the project directories.
The registry does **not** backfill existing history: it bootstraps only while its durable state is
still `initialized: false`, and the live state is already committed as `initialized: true` with
zero registrations.

## The `workspace_register` tool

| parameter | type | required | meaning |
|---|---|---|---|
| `project` | string | no | one project directory name under the projects root (e.g. `workstation`); omitted registers **all** project directories |

For each project it canonicalizes the directory, idempotently
`registry.create(<canonical dir>, title=<project>)`, then attaches every stored session header
(`ctx.sessionPersistence.list()`) whose canonical cwd equals that path. The answer is raw
evidence - per workspace `{id, path, title, sessionCount, sessionIds, createdAt, updatedAt,
created, attached, skipped}` plus totals and per-project errors - never prose.

Idempotent end to end: `create()` reuses a canonical path without retitling and `attachSession()`
skips an already-accounted id, so a re-run only re-reports the same registry state.

## Config

| key | default | meaning |
|---|---|---|
| `projectsDir` | `$WORKSTATION_PROJECTS_DIR` or `/var/lib/workstation/projects` | Root of the project directories; each subdirectory becomes one Workspace |

## Shared helper

`registration.ts` owns `backfillWorkspaces`, `ensureWorkspace` and `attachSessionIds`. The per
dispatch half in `plugins/agent-run` imports the same helper, so the backfill and the auto
registration cannot drift.

## Credentials

None. The tool never touches a credential.
