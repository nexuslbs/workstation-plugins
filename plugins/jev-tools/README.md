# jev-tools - Jev (TypeSafe System One) as credential-gated dsh tools

`plugins/jev-tools/index.ts` exposes **Jev**, TypeSafe AI's System One decision
model, as native deepseek-harness tools, so a dsh agent (facade call or worker
role profile) can ask for a **structured, calibrated decision** instead of a
free-text judgement: a yes/no probability, one option out of a closed set with
the full distribution, or a level on an ordered rubric, each with the model's own
confidence.

The plugin is **fully implemented but credential GATED**: while the Jev
credential is not defined, **no `jev*` tool is registered anywhere** (see *The
credential gate*). Activation, once the operator provides the key, is one live
facade call and one role-patch line, with **no container restart**.

Research origin: the `researcher` dsh worker (task 3251 step 1) produced
`docs/research-3251.md`; its API claims were re-verified against the vendor's own
markdown docs, and the implementation below corrects two of its assumptions
(tool NAMING and parameter SCHEMA, section 4).

## 1. What Jev is

Jev is TypeSafe AI's **System One** decision model: you submit a piece of *state*
(a ticket, a diff, a record, a message history) plus a set of **typed questions**
and it answers with **probabilities and typed labels instead of prose**. It is a
hosted HTTP API, not a library, not a search engine, not a chat route.

Sources (verified 2026-09-26):

- <https://docs.typesafe.ai/introduction> - "Jev is TypeSafe's flagship model and
  the first System One model. Send state and typed questions; get structured
  answers your code can use directly."
- <https://docs.typesafe.ai/api> - the full HTTP reference quoted in section 2.
- <https://docs.typesafe.ai/introduction/quickstart> - the same endpoint in a
  `curl` sample; API keys from <https://console.typesafe.ai/keys>.
- Vendors SDKs: `@typesafe-ai/sdk` (JS, reads `TYPESAFE_API_KEY`), `typesafe-sdk`
  (Python). Disambiguation (research doc): this is NOT FaZe Jev and NOT the
  Japanese encephalitis vaccine.

Rate limits are not published in the reachable docs: `429`/`529` are reported as
typed errors and the caller decides whether to back off.

## 2. API surface

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

| request field | type | meaning |
| --- | --- | --- |
| `state` | string \| object \| array | the content to evaluate |
| `model` | string | `jev-latest` (resolves to `jev-1.13.x` today) |
| `questions` | map<id, Question> | one entry per question; answers come back under the same ids |

| question type | criteria | answer |
| --- | --- | --- |
| `noul` | optional `{ true, false }` descriptions | `{ type, noul }`, the probability that the answer is yes |
| `choice` | map `{ option: description \| null }`, max 255 options | `{ type, choice, probabilities, confidence }` |
| `score` | ordered array of 2..10 level descriptions | `{ type, score, legend, probabilities, confidence }` |

Response: `{ model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }`.
Errors: `401` (key), `422` (body), `429` (rate limit), `529` (overloaded).
Two facts the docs stress and this plugin relies on: **batching** several
questions into ONE call is the intended pattern (vendor: ~12x cheaper, ~10x
faster than separate calls), and **confidence** is a second axis you threshold in
code.

## 3. The tools

Six tools, registered with `ctx.tools.register(defineTool({...}))` and rendered
with `renderValue`. Every failure is a **typed body**
(`{ ok: false, error: { reason, code, stage, message, details } }`), never a
throw and never a stack flood, so a caller can branch on the reason.

| tool | parameters | answer |
| --- | --- | --- |
| `jev_providers` | none | credential NAME + whether it resolves, base URL, endpoint, model, gate, registered tools (never a value) |
| `jev_evaluate` | `state`, `questions` (JSON string: the id -> question map), `model?` | every answer keyed by the caller's ids - the canonical API shape / fan-out |
| `jev_noul` | `state`, `instructions`, `criteria_yes?`, `criteria_no?` | P(yes) |
| `jev_choice` | `state`, `instructions`, `options` (array of option names, or a JSON object string for rubrics) | chosen option + probabilities + confidence |
| `jev_score` | `state`, `instructions`, `levels` (2..10 ordered descriptions) | score + legend + probabilities + confidence |
| `jev_batch` | `state`, `questions` (JSON string: an array of `{ id, type, instructions, criteria? }`) | every answer keyed by id |

Stable failure reasons: `jev.credentials-missing`, `jev.invalid-arguments`,
`jev.unauthorized`, `jev.invalid-request`, `jev.rate-limited`, `jev.overloaded`,
`jev.upstream-error`, `jev.invalid-response`, `jev.transport-error`,
`jev.timeout`.

Row config (all optional; these are the defaults):

```yaml
- id: jev-tools
  name: '<module path>/plugins/jev-tools/index.ts'
  config:
    credential: JEV_API_KEY            # credential NAME, never a value
    baseUrl: https://api.typesafe.ai
    model: jev-latest
    timeoutMs: 60000
    maxStateChars: 200000
    gate: credential                    # credential | always (diagnostic)
    debugLog: /tmp/jev.log              # optional gate/call diagnostics (never a value)
```

### Roles that gain what

| role | use |
| --- | --- |
| `researcher`, `gemini-researcher` | relevance/stance/reliability judgements over gathered sources (`noul`/`choice`/`score`) with probabilities instead of prose |
| `tester` | borderline-result classification against an explicit threshold, severity bands |
| `developer` | intent routing of a change request, risk/urgency scoring, batched in one call |
| `designer`, `author` | picking among candidate outlines/labels, intensity/quality rubrics |
| `devops` | incident triage, impact scoring, capability health via `jev_providers` |

## 4. What the implementation had to get right (verified live)

Three constraints that are NOT obvious and that a naive version of this plugin
gets wrong. Each cost a live experiment; each is now proven.

1. **Tool names must match `^[a-zA-Z0-9_-]+$`** because the chat API validates
   every tool name. A spaced name (`jev noul`) makes the WHOLE worker request
   fail (`dsh: INVALID_REQUEST: Invalid 'tools[8].name': string does not match
   pattern`) even though the facade plane (which never talks to the model API)
   accepts it. Hence the underscore names.
2. **Parameter schemas must be valid JSON Schema for a chat tool.** The DSH
   `json` parameter kind compiles to `{"type":"json"}`, which the API rejects
   (`Invalid schema for function 'jev_batch': "json" is not valid under any of
   the schemas listed in the 'anyOf' keyword`). Structured parameters are
   therefore declared `string` (a JSON string) and parsed by the plugin
   (`jsonOf`), while arrays of strings stay real arrays.
3. **The credential reference has to be the NAME STRING.** The harness resolves
   `ctx.credentials.resolve(NAME)` (as every sibling provider of this repo calls
   it); with a `{ name }` object the call silently answered *undefined* for every
   name - including known-good ones - and the gate could never open. The object
   form is kept only as a fallback.

Also load-bearing: the plugin **injects `credentials`**, so cordis activates it
only after the harness credentials service is ready; without the injection the
apply-time probe ran ~28 ms after `apply` and saw `credentialsService=ABSENT`.

## 5. Why as a tool (alternatives rejected)

| alternative | why rejected |
| --- | --- |
| a second LLM provider route (pi-ai / OpenAI-compatible) | Jev is a decision endpoint, not chat-completions; a route would hide the typed answers and the confidence, and put the key in the model config instead of the capability plane |
| a `web-search` engine row | that seam is query -> results; Jev returns probabilities for caller-defined typed questions |
| a "curl it" skill or free-form `bash` | no typed schema, no credential seam, no gate; every use hand-rolls HTTP and JSON |
| an MCP server process | adds a process and a second protocol hop where a native dsh plugin already exists (this repo's rule: native plugins, no shim) |
| adding it to a harness base bundle | the harness fork is third-party/upstream; feature code belongs in the plugin source |
| ad-hoc fetch inside a worker briefing | no reuse, no gate, no typed errors, key in the prompt |

## 6. Credential NAME and the credential gate

**NAME: `JEV_API_KEY`** (row config `credential`). The vendor SDK spells the same
value `TYPESAFE_API_KEY`; the NAME here is a config choice - switching is a
one-line config edit plus seeding the same NAME, nothing else changes. Values
live ONLY in the non-versioned dsh store `$DSH_HOME/.credentials.yaml`; this
repo, the row config and every tool answer carry the NAME only (the `debugLog`
line says *resolved YES/NO*, never the value).

Two gates, both implemented, so "agents do not see Jev yet" holds even if one is
bypassed:

- **(a) no row in any roster.** `config/workstation.yml` has no `jev-tools` row,
  and no role patch declares it, so neither plane loads the plugin.
- **(b) the plugin registers nothing without its credential.** `apply` probes the
  NAME through `ctx.credentials` before registering: unresolved (or empty) means
  ZERO tools plus the log line `jev-tools: GATED - the 'JEV_API_KEY' credential is
  not defined; no jev tool registered`. `gate: always` is a documented
  diagnostic mode that registers the tools anyway so the
  `jev.credentials-missing` path can be demonstrated without a real key; it is
  never a resting state.

The two planes are wired separately (verified live):

- **Facade plane** (omniagent calls the tools over `POST /api/tool/call`): a live
  row, `plugin_add {..., "layer":"config"}` to persist it in
  `config/workstation.yml`.
- **Agent plane** (dsh workers): the profile patch file may only OVERRIDE bundle
  rows (`patch: entry "jev-tools" not found`), so a role gains the tools through
  an explicit `insert:` entry in
  `/opt/omni/workstation/profiles/<role>/cordis.patch.yml` - which `agent_run`
  copies into `$DSH_HOME/profiles/<role>/` on every dispatch. The facade overlay
  (`WORKSTATION_CONFIG_FILE`) is NOT composed by a worker CLI run, so a roster row
  alone never reaches a worker.

## 7. Verification (raw evidence)

Test suite - no real key, no network (fetch is stubbed):

```sh
docker compose -p omni-stack -f /opt/omni/docker-compose.yml exec -T workstation \
  sh -lc 'cd /opt/workspace/workstation-plugins && node --test plugins/jev-tools/test/jev-tools.test.mjs'
# -> # tests 10 / # pass 10 / # fail 0
```

Live, against the RUNNING service (container id and pid1 start time unchanged
across every add/remove cycle, so no restart happened):

```sh
curl -s http://workstation:8080/api/tools          # 23 tools, no jev*
POST /api/tool/call {"tool":"plugin_add","params":{"id":"...","module":".../plugins/jev-tools/index.ts",
  "config":{"credential":"JEV_API_KEY"}}}
# {"declared":true,"mounted":true,"tools_added":[]}      <- GATE CLOSED without the credential
# with a resolvable credential NAME:
# {"tools_added":["jev_batch","jev_choice","jev_evaluate","jev_noul","jev_providers","jev_score"]}
POST /api/tool/call {"tool":"jev_noul","params":{"state":"Help! My payouts have been failing for 3 days.",
  "instructions":"Does this convey urgency?"}}
# -> {"ok":false,"error":{"reason":"jev.unauthorized", ... "httpStatus":401,
#     "upstream":"{\"error_type\":\"authentication_error\", ...}"}}   <- a REAL API round trip
```

The same request flow was exercised by a dispatched WORKER (role `tester`, with
the role-patch row and a throwaway credential value seeded in the store): the
worker listed `jev_providers ... jev_batch`, called `jev_providers`
(`credentialConfigured: true`) and called `jev_noul` (the 401 body above) with
exit code 0. Raw transcripts: `services/workstation/evidence/live/jev-tools-3251.md`
in the omni-root checkout and the wiki page `Projects/Omniagent/Jev-Integration.md`.

Because the operator has not supplied the real key yet, the **real-key call is
still pending**: every call above used a throwaway credential value, so the
endpoint answered `401 authentication_error` on purpose. The failing path, the
request shape, the response normalization and the error mapping are all proven;
only the `ok: true` answer awaits the key.

## 8. Activation checklist (once the operator provides the key)

1. **Seed the NAME** into the deployment's credential source for
   `$DSH_HOME/.credentials.yaml` (container `omni-stack-workstation-1`), value
   only, never in a repo. Seed it the way the deployment already seeds its other
   names (`services/workstation/entrypoint.sh` + the seeding step) so it is
   present the next time the credentials provider reads the document; the store
   is read by the provider per process, so a name added to a RUNNING process's
   document is not automatically re-read by that process.
2. **Facade plane**: mount the row live and persist it -
   `POST /api/tool/call {"tool":"plugin_add","params":{"id":"jev-tools","layer":"config","module":"/var/lib/workstation/sources/workstation-plugins/plugins/jev-tools/index.ts","config":{"credential":"JEV_API_KEY"}}}`.
   (Use the SOURCE-CACHE path in production - the named volume the entrypoint
   clones into; `/opt/workspace/...` works for a live demo but is not a
   deployment path.)
3. **Agent plane**: add a `- insert:` entry with the same id/name/config to
   `/opt/omni/workstation/profiles/<role>/cordis.patch.yml` for every role that
   should see Jev (the file is copied into the role profile on each dispatch).
4. **Verify**: `curl -s http://workstation:8080/api/tools` lists the six `jev_`
   tools; `plugin_list` shows the row mounted; `jev_providers` answers
   `credentialConfigured: true`.
5. **Make ONE real call** (`jev_noul` with a small state) and expect
   `{"ok":true,...}`. A `jev.unauthorized` means the seeded value is not a valid
   Jev key; `jev.credentials-missing` means the row's NAME and the seeded NAME
   differ.
6. **Rollback**: `plugin_remove {"id":"jev-tools"}` (and drop the role-patch
   insert) returns both planes to the pre-activation tool list; deleting the NAME
   closes the gate even if a row stays mounted.

No step needs a container restart, a service recreate or a DB write: the harness
recomposes the plugin tree live.
