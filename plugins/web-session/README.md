# `web-session` - ONE multiplexed browser tool with an action enum

`web-session` registers **exactly one tool, `session`**, whose `action` enum
covers the whole authenticated-browser workflow:

| action  | what it does                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------- |
| `open`  | start (or attach) the session of a configured **site label** and land on an authenticated page   |
| `act`   | run an ordered list of steps and answer a **DELTA** (what changed), never the page again         |
| `read`  | a selector-scoped slice, the bounded page **outline**, the **discovered endpoints**, or one endpoint called **directly** |
| `close` | persist the storage state to disk and drop the live browser context                              |

Why one tool: every tool schema is paid for in **every prompt**, and a
per-verb browser driver (24 tools in the reference deployment) is both expensive
and a source of wrong-tool choices. The second tax is the snapshot dump - a full
page can be ~14.4k chars (~3.6k tokens); `act` therefore answers with a bounded
delta and `read` with the 50 tokens the caller asked for.

It is a **consumer** plugin: the core stays a host/registry/contract, the browser
comes from the shared launcher in `plugins/web-shared` (the same one `web-page`
uses, so the two plugins never launch two chromiums), and per-site knowledge is
**config**, never plugin code (a later recipe store may provide it).

## Wiring

`workbench.plugin.json` + one roster row in the config that the service boots
with (`config.yml` in this repo, `config/workbench.yml` in production):

```yaml
plugins:
  web-session:
    stateDir: /opt/workspace/workbench-plugins/.workbench/web-session
    idleTtlSeconds: 900
    maxSessions: 4
    defaultSite: demo
    sites:
      demo:
        baseUrl: http://127.0.0.1:12538/
        login:
          url: /login
          indicator: '#login-form'
          fields:
            - { name: user, selector: '#user', credential: WBSESSION_USER }
            - { name: pass, selector: '#pass', credential: WBSESSION_PASSWORD }
          submit: '#submit'
          success: { selector: '#app' }
```

The tool is reachable through the shipped tools seam (same one the omniagent
`workbench` MCP plugin uses):

```bash
curl -s localhost:8080/api/tools | jq '.tools[] | select(.name=="session")'   # schema + owner
curl -s -X POST localhost:8080/api/tool/call -H 'content-type: application/json' \
     -d '{"tool":"session","params":{"action":"read","api":"list"}}'
```

A **schema violation** (missing/invalid `action`, unknown parameter, wrong type)
is answered by the core's own seam with **HTTP 400** and a `violations` list -
the plugin is never called. Every failure *inside* the plugin is a **structured
envelope** with HTTP 200:

```json
{ "status": "error",
  "error": { "code": "unknown_site", "message": "web-session: unknown_site: no site named 'nope' is configured", "hint": "configured sites: demo", "retryable": false } }
```

## The action contract

### `open`

```json
{ "action": "open", "site": "demo", "url": "/items?page=2" }
```

`url` is optional and may be relative to the site's `baseUrl`. The response
reports the resolved URL/title, whether a stored state file was used, whether a
(re-)login ran, how many login fields were filled, and the endpoint counter:

```json
{ "status": "ok", "action": "open", "site": "demo", "url": "http://127.0.0.1:12538/",
  "title": "Demo SPA", "stateFile": "demo.json", "restored": true, "loggedIn": false,
  "login": null, "authenticated": true, "chars": 4021, "estimatedTokens": 1006 }
```

### `act`

```json
{ "action": "act", "site": "demo",
  "steps": [ { "type": "click", "selector": "role=button[name=\"Load more\"]" },
             { "type": "waitFor", "selector": "#total", "value": "visible" },
             { "type": "fill", "selector": "#q", "value": "lamp" },
             { "type": "press", "selector": "#q", "value": "Enter" },
             { "type": "navigate", "url": "/docs" } ] }
```

Step types are the closed set `click | fill | select | press | waitFor | navigate`.
Each step takes an optional `selector` (the three forms below), an optional
`value` and an optional `timeout_ms`. The **compact form** the tests pin is also
accepted - the key is the type: `{ "click": "#total" }`,
`{ "press": "Enter" }`, `{ "navigate": "/docs" }`, `{ "waitFor": "500" }`.

The response is the **delta** of `act`:

```json
{ "status": "ok", "action": "act", "steps": [ { "index": 0, "type": "click", "target": "role=button[name=\"Load more\"]", "ms": 63 } ],
  "delta": { "urlChanged": false, "url": "...", "titleChanged": false,
             "added": [ { "ref": "#item-61", "tag": "li", "text": "..." } ],
             "removed": [], "changed": [ { "ref": "#total", "before": "60 items", "after": "120 items" } ],
             "counts": { "added": 60, "removed": 0, "changed": 1, "total": 61 }, "truncated": false,
             "chars": 1733, "estimatedTokens": 434 } }
```

`added`/`removed`/`changed` are capped by `maxDeltaNodes` (default 60) and the
whole payload by `deltaMaxChars` (default 2500); when it does not fit, the
overflow spills to a file and `truncated: true` + `spillFile` are reported.

### `read`

| call                                                        | answer                                              |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `{ "action": "read", "selector": "#total" }`                 | just that slice (`text`, default)                    |
| `{ "action": "read", "selector": "role=button[name=\"Save\"]", "format": "json" }` | one object per match (`ref`, `tag`, `text`, `html`, `attrs`) |
| `{ "action": "read" }`                                       | the bounded page **outline** (headings + links + sections), never the whole DOM |
| `{ "action": "read", "api": "list" }`                        | the **discovered** JSON/XHR endpoints (method, path, content type, count) |
| `{ "action": "read", "api": "/api/items?page=1&size=60" }`   | that endpoint called **directly**, its JSON returned - no re-render |

`max_chars` caps the body; the cap spills to `<stateDir>/spill/` and the
response carries `truncation: { capped, shownChars, totalChars, spillFile }`.
`format` is one of `text | markdown | html | json`.

### `close`

```json
{ "status": "ok", "action": "close", "site": "demo", "stateFile": "demo.json",
  "state": { "cookies": 1, "origins": 1, "localStorage": 2 }, "closed": true }
```

`close` writes the storage state (0600) and drops the live context. `close`
without a live session is not an error (it is a no-op answer), so a caller can
always clean up.

## Selectors

`selector` and the step `selector` accept three forms, parsed by
`selectors.ts` (`parseSelectorSpec`):

* **CSS** - `#total`, `main .card`, `[data-id="7"]`;
* **XPath** - `//div[@id="x"]` (an implicit one) or `xpath=//div`;
* **role+name** - `role=button[name="Save"]` (the playwright role locator).

An unusable selector is a named `bad_selector` error before any browser call
(and a selector that resolves to nothing is `no_match`), so the caller learns
which of the two happened.

## Config schema

| key                    | default                       | meaning                                                     |
| ---------------------- | ----------------------------- | ----------------------------------------------------------- |
| `stateDir`             | `<repo>/.workbench/web-session` | root of the session state (`state/` + `spill/`), git-ignored |
| `spillDir`             | `<stateDir>/spill`             | where capped bodies are spilled                             |
| `defaultSite`          | the only site when there is 1  | the label used when `site` is omitted                        |
| `idleTtlSeconds`       | `900`                          | idle live contexts are evicted (0 = never)                   |
| `maxSessions`          | `4` (1..32)                    | LRU cap of live contexts                                     |
| `maxChars`             | `6000`                         | default `read` body cap                                      |
| `hardMaxChars`         | `60000`                        | absolute cap (floored at `maxChars`)                         |
| `outlineMaxChars`      | `1200`                         | cap of the no-selector outline                               |
| `deltaMaxChars`        | `2500`                         | cap of one delta payload                                     |
| `maxDeltaNodes`        | `60`                           | added/removed/changed nodes listed per delta                 |
| `maxSelectorNodes`     | `50`                           | matches returned by one `read`                               |
| `maxEndpoints`         | `30`                           | discovered endpoints kept (deduplicated)                     |
| `maxSteps`             | `20`                           | steps accepted in one `act`                                  |
| `navigationTimeoutMs`  | `30000`                        | per navigation                                               |
| `actionTimeoutMs`      | `10000`                        | per step / login field                                       |
| `retries`              | `1` (0..3)                     | retries of an idempotent navigation                          |
| `redact`               | `[]`                           | extra strings scrubbed from every message                    |
| `sites`                | `{}`                           | the whole site table (below)                                 |

A site row:

| key            | meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `baseUrl`      | required; the origin the session belongs to (also the navigation base of relative URLs)     |
| `stateFile`    | optional override; default `<stateDir>/state/<label>.json`                                 |
| `allowOrigins` | extra origins the endpoint recorder may list/call (default: the site origin only)          |
| `login`        | optional declared login flow (see below) - absent, `open` never logs in                    |

`login`: `url` (absolute or site-relative), `indicator` (a selector that is
present on the LOGIN page and absent once authenticated; when omitted, the
"no usable state file and no login ran yet" rule decides), `fields` (each
`{ name, selector, value?, credential? }`), `submit` (a selector submitted
after the fields are filled, or a key name such as `Enter`) and an optional
`success` map of selectors expected after the submit.

## The state dir: what is persisted

```
<stateDir>/
  state/<label>.json     # playwright storageState: cookies + origins[].localStorage, mode 0600
  spill/<label>-*.txt    # capped bodies (read/delta/endpoint paylods), never secrets
```

* Only the **storage-state shape** is written: a state file whose input carries
  anything else (`headers`, `password`, ...) has those keys **dropped** by
  `sanitizeState`, so a password can never be persisted through this path.
* A state file holds **cookies**, never a credential value. Credential values
  are resolved through `ctx.credentials` at login time, used for one `fill`, and
  never logged, echoed or written.
* `.workbench/` is git-ignored in this repo; the session state is local runtime
  state and must never be committed.
* Sessions **survive a process restart**: the next `open` hands the stored state
  to a fresh context, so an authenticated read needs no re-login. When the
  declared `indicator` is visible (or the state file was missing/unusable and no
  login ran yet), the declared flow runs again from the `credential` NAMEs.

## Network interception + API discovery

The plugin subscribes to every response of the live context and keeps a
**deduplicated, bounded** list of the site's JSON/XHR endpoints: `id`, `method`,
`url`, `path`, `contentType`, `status`, `count`, `size`. It never follows or
lists an endpoint **off the site's origin** unless the origin is in the site's
`allowOrigins`; blocked ones are counted in `blocked`, over-budget ones in
`dropped`. Credentials never enter that list - the endpoints are URLs, and
`sanitizeUrl` strips userinfo/query secrets from what is reported.

`read { "api": "list" }` shows the list; `read { "api": "<id|path|url>" }` calls
one **directly** through the context's request API (same cookies, same origin
rules) and returns its JSON body, so a follow-up read costs the JSON instead of a
full re-render (the 10-50x cheaper path of the design). A blocked origin is a
`blocked_origin` error, a non-2xx status a `http_status`, a transport failure an
`api_failed`.

## Budgets and error codes

Every failure is a `SessionError` with a code, a message and (where it helps) a
`site`, `selector`, `step`, `detail`, `retryable` and `hint` - rendered as the
`{ status: "error", error: {...} }` envelope, so the process keeps serving:

| code                 | cause                                                        |
| -------------------- | ------------------------------------------------------------ |
| `invalid_input`      | unknown action, unknown step type, a step missing its value, too many steps |
| `unknown_site`       | no `site` and no `defaultSite`, or a label that is not configured |
| `session_missing` / `session_expired` | no live session / the stored state is unusable and re-login is impossible |
| `login_failed`       | a declared login field could not be filled/submitted, or a credential NAME did not resolve |
| `bad_selector`       | the selector text is not usable (CSS/XPath/role)              |
| `no_match`           | the selector is valid but resolved to nothing                 |
| `step_failed`        | a step did not apply                                          |
| `timeout`            | a per-action/navigation timeout expired                        |
| `blocked_origin`     | an endpoint off the site origin/allow-list                     |
| `api_failed`         | a direct endpoint call failed transport-side                   |
| `http_status`        | the page/endpoint answered 4xx/5xx                             |
| `dns`, `tls`, `connection` | the network path to the site failed                     |
| `browser_unavailable`| chromium is missing (the deployment provides it)               |
| `budget`             | a hard budget (`hardMaxChars`, `maxSteps`, ...) was hit        |
| `internal`           | anything unmapped; still an envelope, never a crash            |

## Out of scope

No screenshot/vision (the model is gated), no LLM summariser inside the plugin,
no per-site scraping in plugin code, no second browser (chromium is shared with
`web-page` through `plugins/web-shared`), no omniagent internals, no MCP server,
no core feature: the core stays a host/registry/contract.
