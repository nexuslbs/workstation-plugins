# agent-run (workstation facade plugin)

The **orchestrator delegation seam** of the workstation facade: ONE facade call runs ONE
`dsh` worker agent.

```
workstation__tool {"tool": "agent run", "params": {
  "role": "developer",
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
   `node <harnessDir>/apps/cli/lib/bin.js <role> "<briefing>"` (cwd `<harnessDir>`);
3. returns `{role, objective, template, workdir, command, exitCode, timedOut, durationSecs,
   provisioningNotes, stdoutTail, stderrTail}` so the orchestrator verifies the ARTIFACT the
   briefing asked for instead of trusting prose. `stdoutTail` keeps the END of the run, which is
   where the worker's final answer is.

## Parameters

| name | type | required | meaning |
|---|---|---|---|
| `role` | string | no (default from config) | worker role/profile, e.g. `developer` |
| `objective` | string | yes | the task: goal + success criteria + the evidence to return |
| `template` | string | no | absolute path of the project briefing the worker must READ first (pass the pointer, never the content) |
| `workdir` | string | no | working directory handed to the worker (default `$DSH_HOME/work/<role>`) |
| `timeoutSecs` | integer | no | wall-clock bound of this ONE run (default 1200, clamped 30..7200) |

## Config

| key | default | meaning |
|---|---|---|
| `harnessDir` | `$WORKSTATION_DIR` or `/harness` | harness checkout root (the CLI lives at `apps/cli/lib/bin.js`) |
| `dshHome` | `$DSH_HOME` or `/var/lib/workstation` | harness home (profiles + credential store) |
| `roleProfilesDir` | `/opt/omni/workstation/profiles` | role definitions shipped in the user repo |
| `defaultRole` | `developer` | role used when a caller omits `role` |
| `timeoutSecs` | `1200` | default wall-clock bound of one run |
| `maxOutputChars` | `12000` | tail of stdout/stderr kept in the answer, per stream |

## Credentials

The plugin never touches a credential. The WORKER resolves `DEEPSEEK_API_KEY` through the harness
credentials service, from the launching environment or from `$DSH_HOME/.credentials.yaml` (a
versioned document: `version: 1` plus a `refs` section, nothing else). A missing key fails LOUDLY
with `dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`
and a non-zero `exitCode`, after ZERO work.

## Deployment note (binding)

A `--patch` overlay is read ONCE at boot, so a row is live only after the workstation service is
(re)started: config changes to this plugin's row reach a RUNNING service through the release path.
The row lives in `omni-root` `config/workstation.yml` (id `agent-run`), next to the capability
rows; the raw evidence of the full chain (facade dispatch -> worker -> verified artifact) is
committed in omni-root `workstation/evidence/gate3-orchestrator-hop.md`.
