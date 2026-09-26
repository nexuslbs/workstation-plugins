# core/data-write-fence - the EXACT write grant of a read-only research role

## What it is

A tool-policy **guard** that turns a wide sandbox workspace into a two-directory
write grant. `ctx.tools.guard(...)` is a MONOTONIC gate evaluated after every
`tools/pre-execute` listener and before the tool body: returning a reason denies
the call and **no later listener, escalation or retry can turn that denial back
into a permission**. That is what makes "this role may write ONLY
`<omni_dir>/data/research/` and `<omni_dir>/data/report/`" enforceable rather than
advisory.

## Why it is needed on top of the sandbox

The harness file sandbox (`@deepseek-ai/dsh-fs-sandbox`) fences writes to the
SESSION WORKSPACE under `workspace-write`, and that workspace is exactly ONE
primary root per session (`SandboxExecutionPolicy`, the immutable
`SessionHeader.cwd`). For a read-only researcher whose outputs are two
directories, the honest sandbox configuration is `workspaceRoot: <omni_dir>/data`
- which also makes the REST of `data/` writable. This plugin closes that gap
without touching the image or the harness:

| layer | what it fences |
|---|---|
| `sandbox-policy` + `fs-sandbox` | every write outside the session workspace (raw `FS_SANDBOX_DENIED`) |
| `data-write-fence` (this plugin) | every `write`/`edit` call whose resolved target is not under an `allow` root |

Both are visible to a caller: the sandbox answers
`[sandbox: file access denied under workspace-write mode]`, the guard answers
`data-write-fence: write to "<target>" (resolved <path>) is outside this role's
writable directories (...)`.

## Scope (stated honestly)

* It fences the TOOL surface: the model-facing mutations (`write`, `edit`, and
  any names a deployment adds). It does NOT fence a shell command - only the
  harness shell sandbox can, and on the workstation image `bash` is refused
  outright under `workspace-write` (no shell-sandbox backend), so the file
  surface IS the writable surface of the role.
* Reads are never touched.
* A mutating call whose target cannot be resolved from the known path arguments
  is DENIED (fail-closed): an unknown target is not a permitted one.
* Targets are compared on the CANONICAL path of the deepest existing ancestor, so
  a symlinked data dir compares equal and a lexical escape
  (`data/research/../../etc`) cannot pass.

## Config row (role patch, user repo)

```yaml
- insert:
    - id: data-write-fence
      name: '/var/lib/workstation/sources/workstation-plugins/core/data-write-fence/index.ts'
      config:
        allow:
          - /opt/omni/data/research
          - /opt/omni/data/report
```

An empty/absent `allow` mounts nothing (and says so on the logger): the sandbox
policy then stays the only fence, which is the deliberate default for a coding
role.

## Verify

The plugin also registers a read-only introspection tool, so a worker can prove
WHICH roots are writable without attempting a write:

```bash
docker compose --project-directory /opt/omni exec -T workstation sh -c \
  'export DSH_HOME=/var/lib/workstation; cd /opt/omni/data && \
   node /harness/apps/cli/lib/bin.js <role> --json "call the tool `write fence` and print it"'
```

A write inside `allow` succeeds; a write outside it - even inside the sandbox
workspace - answers the `data-write-fence:` reason.
