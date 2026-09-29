# JEV integration research — dsh workstation

- Thread: 3251. Author: agent (research only; no code changed, no credential seeded).
- Question: what is "Jev", what is its public API/auth surface, and how should it be
  added to this dsh workstation as credential-gated typed tools for the staff agents.
- Method + confidence: product IDENTIFIED with high confidence (several independent
  public sources agree it is TypeSafe AI's "System One" decision model). The VENDOR's
  own pages (`typesafe.ai`, `docs.typesafe.ai`, `console.typesafe.ai`) and the OpenRouter
  and npm pages were NOT directly fetchable from this workstation (fetch failed with
  `getaddrinfo ENOTFOUND ipv4only.arpa` for those hosts). The endpoint/model detail
  below therefore rests on a third-party tutorial ([apidog](https://apidog.com/blog/jev-api-key/),
  fetched successfully) plus search-result metadata; it MUST be re-verified against the
  official reference once the operator has console access. Rate limits are NOT published
  in any source reachable from here and are marked unknown on purpose — not invented.
- Disambiguation performed: "Jev" here is NOT FaZe Jev (the YouTuber), NOT Japanese
  encephalitis virus (JEV vaccine), and NOT "Jevons". The apidog guide says explicitly:
  "this is Jev the TypeSafe AI model, not FaZe Jev the YouTuber and not the JEV vaccine."

---

## 1. What Jev is (with sources)

**Jev is TypeSafe AI's decision model.** You submit a piece of *state* (a ticket, a JSON
record, a message history) and a set of *typed questions*, and it answers with
**probabilities and typed labels instead of prose**. It is a served API model, not a
library and not a search engine.

Source evidence (quoted snippets):

- [apidog — *How to Get a Jev API Key (TypeSafe AI)*](https://apidog.com/blog/jev-api-key/)
  (fetched 2026-09, HTTP 200):
  > "Jev is TypeSafe AI's decision model. You send it a piece of state and a set of typed
  > questions, and it answers with probabilities instead of prose."
  > "Direct API access is in early access, so step one is getting off the waitlist."
- [OpenRouter — *Jev Documentation - TypeSafe Decision Model on OpenRouter*](https://openrouter.ai/docs/guides/community/jev)
  and [Jev Tutorial on OpenRouter](https://openrouter.ai/docs/guides/community/jev-tutorial)
  (identified from search-result metadata; page body not fetchable from this host):
  Jev is listed as a decision model reachable through OpenRouter.
- [Vercel changelog — *AI Gateway now supports TypeSafe clients and an HTTP API for Jev*](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)
  (fetched, title confirmed): the same model is reachable through Vercel AI Gateway as
  `typesafe-ai/jev`.
- [LiteLLM — *TypeSafe Jev*](https://docs.litellm.ai/blog/typesafe_jev) and
  [DigitalOcean — *What is Jev (2026)? TypeSafe AI's System One model*](https://www.digitalocean.com/resources/articles/what-is-jev)
  and [LangChain — *Connect to a TypeSafe-compatible model provider*](https://docs.langchain.com/langsmith/typesafe-compatible-model)
  (search-result metadata): corroborate the product identity and the "System One" name.
- Third-party clients/tooling already exist (search metadata): [npm `mcp-server-jev`](https://www.npmjs.com/package/mcp-server-jev),
  [`ajayk/jev-go-sdk`](https://github.com/ajayk/jev-go-sdk), [`HomayoonAlimohammadi/jev-sdk-go`](https://pkg.go.dev/github.com/HomayoonAlimohammadi/jev-sdk-go),
  [CometAPI — Jev](https://www.cometapi.com/models/typesafe-ai/jev/).

**Answer model.** Each question is one of three primitives (apidog, quoting the official
request shape):

| Primitive | Request criteria | Response fields |
| --- | --- | --- |
| `noul` (yes/no) | optional `{"true": "...", "false": "..."}` | `noul`: 0 (no) to 1 (yes) |
| `choice` | required map of option to description, up to 255 options | `choice`, `confidence`, `probabilities` per option |
| `score` | required ordered array of 2–10 level descriptions | `score`, `confidence`, `legend`, `probabilities` per level |

Questions of different types can share one state and return in one round trip.

**Integrity note on reachability.** `https://typesafe.ai/`, `https://docs.typesafe.ai/`,
`https://console.typesafe.ai/`, the OpenRouter page and the npm page all failed to fetch
from this workstation (DNS `ipv4only.arpa`), so the exact base path, model tags and
any quota terms could not be confirmed against the vendor. The one fully fetched
source is the apidog tutorial, which names the [TypeSafe API reference](https://docs.typesafe.ai/api)
as its authority. Re-verify section 2 there before writing code.

---

## 2. API surface (base URL, endpoints worth exposing, auth model, rate limits)

### Base URL and endpoint
- Base: `https://api.typesafe.ai/v1`
- One endpoint worth exposing today: `POST https://api.typesafe.ai/v1/systemone`
  (apidog: "Every Jev call is a single `POST https://api.typesafe.ai/v1/systemone`
  with three body fields").
- Request body: `{ "model": <string>, "state": <string|object|array>, "questions": <map> }`.
- Models: `jev-latest` ("resolves to `jev-1.13.0` today") and `jev-preview`
  ("the newest build").
- Response: `{ "model": <resolved string>, "answers": { <name>: <typed answer> }, "usage": { "input_tokens": n, "output_tokens": n } }`.
  The apidog example answers carry `noul`; `choice` carries `choice`/`confidence`/`probabilities`;
  `score` carries `score`/`confidence`/`legend`/`probabilities`.

### Auth model
- Bearer token in the `Authorization` header: `Authorization: Bearer <key>`
  (apidog: "A Jev API key works like any other bearer token").
- The guide uses the environment variable name **`TYPESAFE_API_KEY`**
  ("The official curl examples and the Python SDK both read `TYPESAFE_API_KEY` from the
  environment"). This workstation's convention is to name the credential in the dsh store
  instead; see section 5 (we choose `JEV_API_KEY`).
- Key creation requires console access after early-access approval:
  "go to console.typesafe.ai/settings/keys and create a key" (apidog). There is currently
  no self-serve signup.
- Alternative key sources, if the operator prefers no TypeSafe waitlist (apidog + Vercel):
  Vercel AI Gateway (`typesafe-ai/jev`, "with no waitlist listed"), OpenRouter, LiteLLM.
  These change the base URL/auth; the plugin must keep the base URL configurable.

### Rate limits
- **Unknown from reachable sources.** No reachable page states a per-minute/per-day quota;
  the vendor docs were unreachable from this host. Do not hardcode a limit. Design the
  plugin to surface HTTP 429 as a typed `rate-limited` error with the `Retry-After` header
  when present, and confirm the real quota in the TypeSafe console during activation.

### Endpoints NOT worth exposing now
- No write/mutate operations are documented for System One; the plugin is read-only
  (one `generate`-style POST), which is why it is safe on the tool plane.

---

## 3. Chosen integration

### Placement (react to the existing plugin set)
Add ONE native dsh plugin to `nexuslbs/workstation-plugins`, matching the mounted source
tree and the code template in `plugins/web-search-tools/index.ts` and
`core/gemini-grounded-search/index.ts`:

```
/var/lib/workstation/sources/workstation-plugins/plugins/jev-tools/index.ts
```

`apply(ctx)` registers the tools with `ctx.tools.register(defineTool({...}))` inside
`ctx.effect(...)`, resolves the credential by NAME through `ctx.credentials`, and never
imports cordis (structural `PluginContext`, exactly like the template). A separate
`definitions/jev.ts` is OPTIONAL and only worth adding if a second provider (OpenRouter /
Vercel / LiteLLM base URL) is ever needed as a config swap; today one provider exists, so
the client stays inside `plugins/jev-tools`.

Config (the patch row's `config` block):
```yaml
- id: jev-tools
  name: '/var/lib/workstation/sources/workstation-plugins/plugins/jev-tools/index.ts'
  config:
    apiKeyEnv: JEV_API_KEY            # credential NAME, never a value
    apiBase: https://api.typesafe.ai/v1
    model: jev-latest                 # jev-latest | jev-preview
    timeoutMs: 30000
    maxStateChars: 200000
```

### Exact tool names and typed parameters

Two tools, both gated (section 5). Names follow the existing snake_case
`web_search_grounded` / `web_search_providers` convention.

**Tool A — `jev evaluate`** (the workhorse)

| Param | Type | Required | Meaning |
| --- | --- | --- | --- |
| `state` | `json` | yes | the content to evaluate: string, JSON object, or array of messages |
| `questions` | `json` | yes | map of `name` -> `{type: "noul"\|"choice"\|"score", instructions: string, criteria: ...}` |
| `model` | `string` enum `["jev-latest","jev-preview"]` | no | overrides the configured model |

Declared `parameters` use the repo's author form (`{ type, description, required, enum }`)
and are compiled to JSON Schema by `defineTool`; the harness validates before `execute`.

**Tool B — `jev providers`** (introspection / health, mirrors `web_search_providers`)

No parameters. Reports the credential NAME, whether it resolved, the configured model and
base URL, and the last observed failure reason. It exists to separate "Jev answered
`ok:false`" from "the credential is not configured" once the tools are active.

### Response shape (typed, returned not thrown)

`jev evaluate` success:
```json
{
  "ok": true,
  "model": "jev-1.13.0",
  "answers": {
    "needs_review": { "type": "noul", "noul": 0.97 },
    "route": { "type": "choice", "choice": "billing", "confidence": 0.98,
               "probabilities": { "billing": 0.98, "shipping": 0.01, "technical": 0.01 } },
    "urgency": { "type": "score", "score": 1.6, "confidence": 0.62,
                 "legend": { "0": "low", "1": "medium", "2": "high" },
                 "probabilities": { "0": 0.02, "1": 0.36, "2": 0.62 } }
  },
  "usage": { "input_tokens": 190, "output_tokens": 0 },
  "took_ms": 812
}
```

Failure (never a thrown generic `tool-failed`; the reason survives the tools seam, exactly
like `web-search-tools`):
```json
{ "ok": false,
  "error": { "error": "TypeSafe answered HTTP 401: ...", "code": "auth-failed",
             "stage": "jev", "details": { "model": "jev-latest", "status": 401 },
             "hint": "add the credential JEV_API_KEY to the harness credential store" } }
```
Typed `code` values: `invalid-input`, `not-configured`, `auth-failed`, `rate-limited`,
`timeout`, `network`, `bad-response`, `provider-error`.

`jev providers` success: `{ "ok": true, "credential": "JEV_API_KEY", "configured": true,
"available": true, "model": "jev-latest", "api_base": "https://api.typesafe.ai/v1" }`.

### Which existing role profiles gain what

The workstation capability tools register in the harness `tools` runtime, which
`plugins/http-surface` serves to the omni facade (`GET /api/tools`, `POST /api/tool/call`).
So the PRIMARY gain is the facade/orchestrator plane: every staff agent that calls
`workstation__tool` gains `jev evaluate` and `jev providers` the moment the tools register.
A dsh WORKER role only sees them natively if its own `cordis.patch.yml` is patched (the
same mechanism `gemini-researcher` uses for `web`). Mapping:

| Role profile | Gains | Concrete use |
| --- | --- | --- |
| `researcher` | `jev evaluate` | typed relevance/stance (`noul`) and source-class (`choice`) labels over gathered evidence, with probabilities |
| `gemini-researcher` | `jev evaluate` | same, on the Gemini route already pinned by its profile |
| `author` | `jev evaluate` | choose among outline options (`choice`); score tone/reading level (`score`) |
| `designer` | `jev evaluate` | rank design options (`choice`/`score`) with an explicit threshold |
| `developer` | `jev evaluate` | triage a request (`choice`) and gate risky paths (`noul` >= threshold) |
| `tester` | `jev evaluate` | classify borderline results against a named criterion instead of prose |
| `devops` | `jev evaluate`, `jev providers` | incident triage plus capability health/credential check |

No role loses anything; adding the row is additive.

---

## 4. Why as a TOOL (alternatives rejected)

1. **LLM provider route** (patch `llm-pi-ai` / `agent-default-model` to `typesafe-ai/jev`).
   REJECTED: Jev is not a chat-completion endpoint. It takes typed `questions` and returns
   distributions; forcing it through a chat route would discard the typed schema, require a
   bespoke provider, and burden every agent with prompt-shaped question construction.
2. **A new `web-search@1` engine.** REJECTED: wrong capability. Jev evaluates supplied state;
   it does not retrieve sources, and `web_search_grounded` promises ranked URLs — Jev answers none.
3. **A skill that shells out to `curl`.** REJECTED: needs the credential inside the skill body,
   bypasses the harness credential service, and gives no typed parameter validation or
   structured failure (`missing-service` vs `auth-failed` vs `rate-limited`) that a caller can branch on.
4. **A separate MCP/external process** (e.g. `mcp-server-jev`). REJECTED: adds a second
   process, a second credential path, and a transport hop the workstation does not need; the
   native `ctx.tools.register(defineTool(...))` seam already gives typed schemas, the facade
   surface, and per-fiber disposal.
5. **Ad-hoc `http`/`fetch` from each agent.** REJECTED: duplicates the request shape and
   error taxonomy in every briefing and bypasses the credential NAME convention.
6. **A harness base-bundle tool** (change `/harness`). REJECTED: this is a deployment
   capability; the plugin set is the extension point (`AGENTS.md`: "Plugins, not loop changes"),
   and adding it here keeps it config-swappable and live-addable via `plugin-live`.

The tool seam also makes the capability removable live (`plugin_remove jev-tools`), which a
provider-route or base-bundle change would not.

---

## 5. Credential name and the credential-GATED activation mechanism

### Credential name
- Use the dsh-store NAME **`JEV_API_KEY`** (the task's example and this workstation's style:
  `GEMINI_API_KEY`, `TWILIO_AUTH_TOKEN`, `HIMALAYA_HERMES_PASSWORD`).
- TypeSafe's own convention is `TYPESAFE_API_KEY`; a deployment that prefers it can set
  `apiKeyEnv: TYPESAFE_API_KEY` in the row config — the plugin never hardcodes the value and
  never reads the environment directly.
- The value lives ONLY in `$DSH_HOME/.credentials.yaml` (resolved at call time through
  `ctx.credentials`). NO value, and no key-looking placeholder, appears in the plugin, the
  row config, this doc, or any log. Logs carry the NAME and the resolved `source` only.

### Gate: tools must not exist until the credential does
Requirement: the plugin is fully implemented and its row may be declared, but **no `jev*`
tool is visible to any agent until `JEV_API_KEY` exists.** Mechanism:

1. `apply(ctx)` calls `ctx.credentials.resolve({ name: apiKeyEnv })` (async) as a one-shot
   gate. `describe()` is not used: only a real, non-empty `value` opens the gate, matching
   the credentials service rule that "an empty stored value is absent everywhere".
2. **Only when the gate opens** does `apply` call `ctx.tools.register(defineTool(...))` for
   `jev evaluate` and `jev providers`. When the gate is closed it registers ZERO tools, so
   `GET /api/tools` and every agent's tool list contain no `jev*` entry. Registering a tool
   that internally answers "not configured" is explicitly NOT done — that would make it visible.
3. Disposal stays per-fiber: `ctx.effect` is called synchronously at the start of `apply` and
   returns a disposer that unregisters whatever the async gate registered (stored in a local
   array). A `plugin_remove` disposes both cleanly.
4. The gate logs exactly one line on load: either
   `jev-tools: gate open (JEV_API_KEY configured, source=file); registered [jev evaluate, jev providers]`
   or
   `jev-tools: gate closed (JEV_API_KEY not configured); registered 0 tools`.
   Names/source only — never a value. This log is the operator's signal when no jev tool exists.
5. Each `execute` RE-RESOLVES the credential at call time (harness rule: "consumers
   re-resolve at each operation"). The apply-time resolve is only the visibility gate; a
   rotated key reaches the next call with no reload.

**Consequence for `plugin_add`.** `plugin_add` waits until either the row is mounted or new
tools appear (`plugins/plugin-live/index.ts`, `execute`). With the key absent the row mounts,
`tools_added` is `[]`, and it returns `mounted: true` — correct and expected. With the key
present it returns `tools_added: ["jev evaluate","jev providers"]`. Either way no restart.

---

## 6. Ordered activation checklist (go live once the operator supplies the key)

1. **Obtain access.** Join the TypeSafe early-access waitlist / open the console invite;
   create the key at `console.typesafe.ai/settings/keys` per the apidog guide. (Alternative:
   a Vercel AI Gateway / OpenRouter / LiteLLM key and an `apiBase` override.)
2. **Verify the API against the official reference** (`docs.typesafe.ai/api`): confirm
   `POST /v1/systemone`, the `model` tags, the three question primitives, and the response
   fields; confirm the rate-limit terms. If any differ from section 2, fix the plugin before
   seeding. (This doc's section 2 came from a third-party tutorial, not the vendor page.)
3. **Seed the credential by NAME.** Add `JEV_API_KEY` to `$DSH_HOME/.credentials.yaml` via the
   repeatable seeder (`node /opt/omni/services/workstation/seed-dsh-credentials.mjs`) or the
   harness credential write path. Confirm NAMES only (e.g. `credentials describe`), never the value.
4. **Deploy the plugin source** to the named volume: clone/pull
   `nexuslbs/workstation-plugins` so
   `/var/lib/workstation/sources/workstation-plugins/plugins/jev-tools/index.ts` exists
   (entrypoint clone or `git -C ... pull`). No image rebuild.
5. **Declare and mount the row live** through the facade, with the config block:
   `POST /api/tool/call {"tool":"plugin_add","params":{"id":"jev-tools","module":"/var/lib/workstation/sources/workstation-plugins/plugins/jev-tools/index.ts","layer":"config","config":{"apiKeyEnv":"JEV_API_KEY","apiBase":"https://api.typesafe.ai/v1","model":"jev-latest","timeoutMs":30000,"maxStateChars":200000}}}`
   (`layer: "config"` persists it in `/opt/omni/config/workstation.yml` with a backup; use
   `layer: "live"` for a first trial that only touches the watched HOME patch.)
6. **Verify the gate opened.** Expect `tools_added: ["jev evaluate","jev providers"]` in the
   `plugin_add` answer (no warning). If it is `[]`, the row mounted with the gate closed: read
   the gate log line, confirm the credential NAME, then `plugin_remove jev-tools` and repeat
   step 5 (re-running `apply` re-evaluates the gate).
7. **Smoke-test the tool itself** (state is non-secret): one `jev evaluate` call over a sample
   ticket/message with one `noul`, one `choice` and one `score` question; assert
   `ok:true` and that `answers.<name>.type` matches, plus `usage.input_tokens`. Run
   `jev providers` and confirm `available:true` and the expected model.
8. **Confirm the gating contract stays true.** Temporarily unset the credential (or check a
   node without it) and confirm `GET /api/tools` lists NO `jev*` name until it is restored,
   then reload the row. Record raw evidence next to the thread.
9. **Update the roster note / DECISION block** in `/opt/omni/config/workstation.yml` (source
   of truth) with the new row and the credential NAME, and note that section 2's API detail
   must be re-verified against `docs.typesafe.ai/api`.
10. **Rollback:** `POST /api/tool/call {"tool":"plugin_remove","params":{"id":"jev-tools"}}`
    (disposes the row from both layers); optionally unset `JEV_API_KEY`.

---

## Appendix — source list

Fetched successfully:
- apidog — How to Get a Jev API Key (TypeSafe AI): https://apidog.com/blog/jev-api-key/
- Vercel changelog — AI Gateway + TypeSafe/Jev HTTP API: https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev
  (title/lead only; body truncated by the fetch)

Identified from search metadata (page body not reachable from this host):
- OpenRouter Jev docs: https://openrouter.ai/docs/guides/community/jev
- OpenRouter Jev tutorial: https://openrouter.ai/docs/guides/community/jev-tutorial
- LiteLLM TypeSafe Jev: https://docs.litellm.ai/blog/typesafe_jev
- LangChain TypeSafe-compatible provider: https://docs.langchain.com/langsmith/typesafe-compatible-model
- DigitalOcean What is Jev: https://www.digitalocean.com/resources/articles/what-is-jev
- npm mcp-server-jev: https://www.npmjs.com/package/mcp-server-jev
- Go SDK: https://github.com/ajayk/jev-go-sdk and https://pkg.go.dev/github.com/HomayoonAlimohammadi/jev-sdk-go
- CometAPI Jev: https://www.cometapi.com/models/typesafe-ai/jev/
- TypeSafe register tool (community): https://github.com/2951461586/Jev-Register-Tool

Unreachable from this workstation (official authority; verify on activation):
- https://typesafe.ai/ , https://docs.typesafe.ai/api , https://console.typesafe.ai/
