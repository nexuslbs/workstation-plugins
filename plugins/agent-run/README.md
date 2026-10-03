# agent-run (workstation facade plugin)

The **orchestrator delegation seam** of the workstation facade: ONE facade call runs ONE
`dsh` worker agent.

```
workstation__tool {"tool": "agent_run", "params": {
  "role": "developer",
  "project": "workstation",
  "objective": "<goal + success criteria + evidence to return>",
  "template": "/opt/omni/workstation/templates/<project>-<role>.md"
}}
```

## What one call does

1. provisions the ROLE once: if `$DSH_HOME/profiles/<role>/package.json` does not exist it is
   created from the harness' `headless` default profile, and the role's `cordis.patch.yml`
   (`<roleProfilesDir>/<role>/cordis.patch.yml`, shipped in the user repo at
   `/opt/omni/workstation/profiles/<role>/`) is copied into it. Without that patch a one-shot run
   has no usable shell sandbox and no approval channel, so `bash` would be refused and the worker
   would return no artifact;
2. runs the worker as its own process, with its own context window and model route:
   `node <harnessDir>/apps/cli/lib/bin.js <role> "<briefing>"` with cwd
   `<projectsDir>/<project>` (the PROJECT workspace);
3. returns `{role, project, sessionId, workspace, sessionBucket, sessionDir, sessionDirs,
   objective, template, command, exitCode, timedOut, durationSecs, provisioningNotes, stdoutTail,
   stderrTail, workspaceRegistration}` so the orchestrator verifies the ARTIFACT the briefing asked
   for instead of trusting prose. `stdoutTail` keeps the END of the run, which is where the worker's
   final answer is.

## Workspace auto-registration (webserver grouping)

The webserver groups sessions per project through the harness workspace registry
(`ctx.workspaceRegistry`, hosted in the same process as this plugin). A session appears under a
Workspace only when its id is in the workspace record AND its stored header cwd canonicalizes to
the workspace path. So every dispatch:

* **before** the run, idempotently `registry.create(<projectsDir>/<project>, title=<project>)`, so
  the project's Workspace exists when the session lands;
* **after** the run, attaches each created `session-<uuid>` directory name (the bucket diff yields
  exactly the dsh session ids) with `workspace.attachSession(id)`. The worker is a SEPARATE CLI
  process, so NO session-created event fires here: this attach in pid=1 is what makes the group
  appear. `attachSession` re-validates the stored header cwd against the workspace path.

Both halves share the helper `../workspace-register/registration.ts` with the
`workspace_register` backfill tool (`plugins/workspace-register`). Registration is BEST EFFORT: if
this composition does not expose the registry (or an attach is refused) the worker run still
succeeds and the notes are reported in `workspaceRegistration.notes`.

## Session layout (per project)

dsh stores every session as
`$DSH_HOME/sessions/--<normalized-cwd>--/session-<uuid>/session.v4.jsonl.zstd`, i.e. the cwd of the
run IS the project bucket (`packages/session/session-persistence-jsonl`; agent note
`2026-07-24-project-session-directories`). This tool therefore runs the worker with its cwd set to
the PROJECT workspace, so:

* one PROJECT = one readable bucket: `--var-lib-workstation-projects-<project>--` (default
  `projectsDir` `/var/lib/workstation/projects`), instead of every run piling into `--harness--`;
* every worker of ONE project shares that workspace's session history:
  `dsh-tool-session-query` authorizes cross-session search ONLY on exact cwd equality, so a worker
  can search its predecessors' sessions inside its project and nothing outside it;
* the structured id `<role>-<project>-<timestamp>-<suffix>` leads the FIRST prompt
  (`[dsh-session role=<role> project=<project> id=<structured-id>]`), which is what the LLM session
  title is derived from and what the FTS session-query index stores, so role AND project stay
  readable in the title and findable by search;
* the answer and the per-project dispatch record
  `<projectsDir>/<project>/dsh-sessions.jsonl` map that structured id to the REAL session directory
  the run created (dsh generates `session-<uuid>`, which no flag can set).

MEASURED CAVEAT (`--session-id`): the harness CLI's `--session-id` only RESUMES an existing session
(an unknown id fails with `session "<id>" does not exist; omit --session-id to start a new Session`,
`apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts`), it can never NAME a new one. The
structured id is therefore carried by the project bucket + the first prompt + the dispatch record,
never by `--session-id`.

### Dispatch record `dsh-sessions.jsonl`

Every dispatch appends ONE JSON line to `<projectsDir>/<project>/dsh-sessions.jsonl` in a `finally`,
so the accounting survives a crash, a timeout or a non-zero exit: a throw between dispatch start and
the write (objective validation, role provisioning, workspace `mkdir`) would otherwise lose the
record. The line keeps the original identity fields and adds the accounting:

| field | meaning |
|---|---|
| `sessionId` | the structured `<role>-<project>-<timestamp>-<suffix>` id |
| `role`, `project`, `workspace`, `bucket` | the dispatch identity and the dsh session bucket |
| `startedAt`, `durationSecs` | UTC stamp and wall-clock seconds of the run (elapsed when the dispatch threw) |
| `exitCode`, `timedOut`, `aborted` | the worker process outcome (`exitCode: null` when the dispatch threw before the run) |
| `sessions` | the created `session-<uuid>` directory names (the bucket diff) |
| `usage` | the child's per-call usage array with its own aggregate LAST; `[]` when the log could not be read |
| `usage_error` | why the usage scan found no readable child log (omitted when usage was read) |
| `usage_session_log` | the child session log the scan read (omitted when none was found) |
| `error` | the RAW thrown error (message plus stack head) when the dispatch crashed, else the worker's stderr tail on a non-zero exit / timeout / abort (omitted on a clean run) |

The record is written BEST EFFORT: it never replaces or masks the dispatch outcome. The additive
`_meta` block returned to the caller is unchanged and never becomes model-facing content.

## Parameters

| name | type | required | meaning |
|---|---|---|---|
| `role` | string | no (default from config) | worker role/profile, e.g. `developer` |
| `project` | string | no (default `default`) | the project the worker belongs to (`omnidev`, `workstation`, `demo`, `research`, `my-project-x`, ...): it selects the workspace `<projectsDir>/<project>`, hence the dsh session bucket and the shared session-search authority |
| `objective` | string | yes | the task: goal + success criteria + the evidence to return |
| `template` | string | no | absolute path of the project briefing the worker must READ first (pass the pointer, never the content) |
| `briefing` | string | no | the FULL composed worker briefing TEXT (the orchestrator has no write tool, so this is text, not a path). When provided it REPLACES the objective prompt: the worker receives this text with the `[dsh-session ...]` header prepended, it is materialised under `<workspace>/.briefings/<sessionId>.md`, and it is validated against the dispatch-briefing contract BEFORE the role is provisioned. `evidence_artifact` becomes required |
| `evidence_artifact` | string | no | absolute path of the RAW artifact the briefing requires the worker to produce; required when `briefing` is provided. After a clean run (`exitCode 0`, no timeout, no abort) a missing artifact fails the dispatch |
| `workdir` | string | no | ADVISORY only (compatibility): recorded as `requestedWorkdir`, never used as the process cwd, because the cwd must be the project workspace for the session to group (and be searchable) per project |
| `timeoutSecs` | integer | no | wall-clock bound of this ONE run (default 1200, clamped 30..7200) |

## Dispatch-briefing contract

The orchestrator composes the worker briefing per
`/opt/omni/workstation/skills/ops/dispatch-briefing/SKILL.md` (role, template, objective, context,
prior session, success evidence, bounds). There is no write tool on the orchestrator side, so the TEXT
is passed in `briefing`, and `agent_run` is the single mechanical choke point that enforces the
contract:

* **pre-dispatch** (active only when `briefing` is provided, so existing dispatches are unchanged):
  `evidence_artifact` is required; the text is materialised under
  `<workspace>/.briefings/<sessionId>.md`; it is validated for the seven required `## ` sections
  (Role, Template, Objective, Context, Prior session, Success evidence, Bounds); every `/opt/...` path
  it names must exist; the `## Template` value must exist; a credential-VALUE scan
  (`PRIVATE KEY|ghp_|ghs_|sk-|AKIA|api_key:|password:`) must be clean and the matched value is never
  echoed; and `evidence_artifact` must appear literally in the text. Any problem throws
  `agent_run: briefing rejected: <problems>` BEFORE the role is provisioned and BEFORE the child is
  spawned. When the gate passes, the briefing TEXT is the worker's first prompt (with the
  `[dsh-session ...]` header prepended); `objective` is still required but no longer composes the
  prompt.
* **post-run**: after a clean exit (`exitCode 0`, no timeout, no abort), the declared
  `evidence_artifact` must exist on disk or the dispatch throws
  `agent_run: evidence artifact missing: <path> (exitCode 0, no artifact on disk)`. A prose-only result
  with no raw artifact is rejected.

The answer and the `dsh-sessions.jsonl` record both carry `briefingGate: {provided, ok, problems}` and
`evidence: {artifact, exists, validated}`. The briefing content itself is never echoed beyond the
worker's own output.

## Config

| key | default | meaning |
|---|---|---|
| `harnessDir` | `$WORKSTATION_DIR` or `/harness` | harness checkout root (the CLI lives at `apps/cli/lib/bin.js`) |
| `dshHome` | `$DSH_HOME` or `/var/lib/workstation` | harness home (profiles + credential store + session store) |
| `roleProfilesDir` | `/opt/omni/workstation/profiles` | role definitions shipped in the user repo |
| `projectsDir` | `$WORKSTATION_PROJECTS_DIR` or `/var/lib/workstation/projects` | root of the PROJECT workspaces (one subdirectory per project; the worker cwd) |
| `defaultRole` | `developer` | role used when a caller omits `role` |
| `timeoutSecs` | `1200` | default wall-clock bound of one run |
| `maxOutputChars` | `12000` | tail of stdout/stderr kept in the answer, per stream |

## Credentials

The plugin never touches a credential, and it hands the worker its `DSH_HOME` explicitly (never the
ambient environment). The WORKER resolves `DEEPSEEK_API_KEY` through the harness credentials
service, from the launching environment or from `$DSH_HOME/.credentials.yaml` (a versioned document:
`version: 1` plus a `refs` section, nothing else). A missing key fails LOUDLY with
`dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"` and a
non-zero `exitCode`, after ZERO work.

## Deployment note (binding)

A `--patch` overlay is read ONCE at boot, so a row is live only after the workstation service is
(re)started - EXCEPT through the `plugin-live` control plane, which is how a CODE change to this
plugin is rolled out with NO container restart:

1. place the new `index.ts` on the plugin-source volume (production source of truth,
   `/var/lib/workstation/sources/workstation-plugins/plugins/agent-run/index.ts`);
2. `plugin_remove {"id":"agent-run"}` then
   `plugin_add {"id":"agent-run","module":"<that path>","layer":"config","config":{...}}`:
   the row is disposed and re-imported in the RUNNING process (the module URL is unchanged, so the
   code change is what the re-import must pick up - verify the new fields in the next answer).

The row itself lives in `omni-root` `config/workstation.yml` (id `agent-run`); the raw evidence of
the full chain (facade dispatch -> worker -> verified artifact) is committed in omni-root
`workstation/evidence/gate3-orchestrator-hop.md`.

## Session layout (per project, per role)

dsh stores every session under `$DSH_HOME/sessions/--<normalized-cwd>--/session-<uuid>/`, and that
DIRECTORY is the cwd of the run. Because this tool runs each worker in
`<projectsDir>/<project>` (default `/var/lib/workstation/projects/<project>`), one project = one
session bucket:

```
$DSH_HOME/projects/<project>/dsh-sessions.jsonl                       # dispatch record
$DSH_HOME/sessions/--var-lib-workstation-projects-<project>--/session-<uuid>/session.v4.jsonl.zstd
```

The harness CLI's `--session-id` only RESUMES an existing session (an unknown id is refused), so it
can never NAME a new one. The STRUCTURED id `<role>-<project>-<timestamp>-<suffix>` is therefore
placed where it helps: it leads the first prompt (the LLM session title is derived from that prompt
and the text is full-text searchable), it is returned in the answer, and it is written into the
per-project `dsh-sessions.jsonl` dispatch record that maps it to the real `session-<uuid>` directory.

A WORKER dispatch additionally requires the profile to resolve the packages a role patch inserts by
NAME (`tool-session-query`, `session-query-sqlite`, ...). A role patch resolves from the PROFILE
directory, which owns no modules, so provisioning links `<profileDir>/node_modules` to the harness'
own `<harnessDir>/node_modules`. Without that link the row fails to activate:

```
dsh: warning: 1 entry did not activate
tool-session-query (@deepseek-ai/dsh-tool-session-query): failed to import
```

Layout, retention and archive are documented in the user-repo wiki
`Reference/Omniagent/Workstation-DSH-Sessions.md` and implemented by
`services/workstation/dsh-sessions.mjs` (layout | retention | archive | restore).
