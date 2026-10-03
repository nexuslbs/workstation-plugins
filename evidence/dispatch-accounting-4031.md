# Evidence: dispatch accounting in `dsh-sessions.jsonl` (item 3 of `task_workstation_workstation_dsh_close_the_3`)

Change: `plugins/agent-run/index.ts` wraps the dispatch boundary in `try/catch/finally`. The
`finally` ALWAYS appends one per-project `dsh-sessions.jsonl` record, so a dispatch that crashes,
times out, aborts or exits non-zero keeps its accounting. Every existing field is kept; the record
now also carries `usage` (the child's per-call array with its own aggregate LAST, `[]` when the log
could not be read), `usage_error` / `usage_session_log` when present, and `error` (the RAW thrown
error when the dispatch crashed, else the worker's stderr tail on a non-zero exit / timeout / abort).
The `_meta` block returned to the caller and the model-facing rendering are unchanged.

Raw records below were produced by running the REAL plugin against a fake harness (a scratch
capture script, no model, no network); the scratch script and its fake CLI mirror the test fixture.

## 1. RAW FORCED-FAILURE dispatch record (non-zero exit, raw error, usage array)

Command (scratch capture; the fake worker exits 1 with the real MISSING_CREDENTIAL text):

```
node /opt/workspace/tmp/dispatch-accounting-4031-capture.mjs
```

Raw `dsh-sessions.jsonl` last line of the forced-failure dispatch (project `failed-x`):

```
{"sessionId":"developer-failed-x-20261003-160325-apng5","role":"developer","project":"failed-x","workspace":"/tmp/accounting-4031-lLfKpI/projects/failed-x","bucket":"--tmp-accounting-4031-lLfKpI-projects-failed-x--","startedAt":"2026-10-03T16:03:25.285Z","durationSecs":0,"exitCode":1,"timedOut":false,"aborted":false,"sessions":[],"usage":[],"usage_error":"no child session carrying the usage marker [dsh-session role=developer project=failed-x id=developer-failed-x-20261003-160325-apng5] was found in /tmp/accounting-4031-lLfKpI/dsh-home/sessions/--tmp-accounting-4031-lLfKpI-projects-failed-x--","error":"dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route \"deepseek-official\"\n"}
```

## 2. RAW SUCCESSFUL dispatch record (usage array, aggregate LAST, no error field)

Raw `dsh-sessions.jsonl` last line of the successful dispatch (project `game-x`):

```
{"sessionId":"developer-game-x-20261003-160325-4tfdo","role":"developer","project":"game-x","workspace":"/tmp/accounting-4031-lLfKpI/projects/game-x","bucket":"--tmp-accounting-4031-lLfKpI-projects-game-x--","startedAt":"2026-10-03T16:03:25.225Z","durationSecs":0,"exitCode":0,"timedOut":false,"aborted":false,"sessions":["session-96fa03f1"],"usage":[{"agent":"developer","input_tokens":120,"output_tokens":30,"total_tokens":150,"cached_input_tokens":0,"cache_write_tokens":0,"reasoning_tokens":null,"cost":null,"provider":"deepseek-official","model":"deepseek-chat","request_id":null,"details":{"kind":"llm-call","session_id":"session-96fa03f1","seq":1,"message_id":"msg-1"}},{"agent":"developer","input_tokens":120,"output_tokens":30,"total_tokens":150,"cached_input_tokens":0,"cache_write_tokens":0,"reasoning_tokens":0,"cost":null,"provider":null,"model":null,"request_id":null,"details":{"kind":"agent-aggregate","session_id":"session-96fa03f1","llm_calls":1,"tool_calls":0,"delegation_depth":1,"cwd":"/tmp/accounting-4031-lLfKpI/projects/game-x"}}],"usage_session_log":"/tmp/accounting-4031-lLfKpI/dsh-home/sessions/--tmp-accounting-4031-lLfKpI-projects-game-x--/session-96fa03f1/session.v4.jsonl.zstd"}
```

## 3. RAW `node --test` output

Command and exit status:

```
cd /opt/workspace/workstation-plugins && node --test plugins/agent-run/test/agent-run.test.mjs
[exit code: 0]
```

Raw output (13 tests, 13 pass, 0 fail):

```
TAP version 13
# Subtest: the plugin is the agent-run seam and registers the typed "agent_run" tool
ok 1 - the plugin is the agent-run seam and registers the typed "agent_run" tool
  ---
  duration_ms: 4.3169
  type: 'test'
  ...
# Subtest: a dispatch runs the worker in its PROJECT workspace and records the structured session id
ok 2 - a dispatch runs the worker in its PROJECT workspace and records the structured session id
  ---
  duration_ms: 117.662613
  type: 'test'
  ...
# Subtest: a dispatch AUTO-REGISTERS the project workspace before the run and attaches the created session after it
ok 3 - a dispatch AUTO-REGISTERS the project workspace before the run and attaches the created session after it
  ---
  duration_ms: 72.764208
  type: 'test'
  ...
# Subtest: a dispatch still runs when the workspace registry is NOT composed (best effort)
ok 4 - a dispatch still runs when the workspace registry is NOT composed (best effort)
  ---
  duration_ms: 75.096908
  type: 'test'
  ...
# Subtest: a NEW role is provisioned on the FIRST call (no mkdir before the CLI init)
ok 5 - a NEW role is provisioned on the FIRST call (no mkdir before the CLI init)
  ---
  duration_ms: 84.11021
  type: 'test'
  ...
# Subtest: a manifest-less LEFTOVER dir (interrupted boot) is replaced, not fatal
ok 6 - a manifest-less LEFTOVER dir (interrupted boot) is replaced, not fatal
  ---
  duration_ms: 76.199008
  type: 'test'
  ...
# Subtest: the second call to the same role is IDEMPOTENT (no second init)
ok 7 - the second call to the same role is IDEMPOTENT (no second init)
  ---
  duration_ms: 118.134513
  type: 'test'
  ...
# Subtest: an init that exits NON-ZERO after writing the manifest still provisions (manifest decides)
ok 8 - an init that exits NON-ZERO after writing the manifest still provisions (manifest decides)
  ---
  duration_ms: 75.688608
  type: 'test'
  ...
# Subtest: a role that genuinely cannot be provisioned stays LOUD
ok 9 - a role that genuinely cannot be provisioned stays LOUD
  ---
  duration_ms: 38.373904
  type: 'test'
  ...
# Subtest: a provisioned profile resolves role-patch package rows (node_modules symlink to the harness)
ok 10 - a provisioned profile resolves role-patch package rows (node_modules symlink to the harness)
  ---
  duration_ms: 124.657114
  type: 'test'
  ...
# Subtest: a worker that dies at the model is returned with its exit code, not swallowed
ok 11 - a worker that dies at the model is returned with its exit code, not swallowed
  ---
  duration_ms: 72.931108
  type: 'test'
  ...
# Subtest: a FAILED dispatch still records its exit code, raw error and usage array
ok 12 - a FAILED dispatch still records its exit code, raw error and usage array
  ---
  duration_ms: 78.530908
  type: 'test'
  ...
# Subtest: a dispatch that throws BEFORE the run still writes its record with the raw error
ok 13 - a dispatch that throws BEFORE the run still writes its record with the raw error
  ---
  duration_ms: 41.507005
  type: 'test'
  ...
1..13
# tests 13
# suites 0
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1137.398624
```

Full repo suite, same change (command `node --test`, exit 0):

```
# tests 96
# suites 0
# pass 95
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 7432.192769
```
