# core/web-search-gemini - the `web-search@1` provider host + the Gemini grounded engine

## What it is

One row that makes the capability `web search` WORK, using the Google **GEMINI**
API's native `google_search` grounding instead of a third-party search API.

The seam (`definitions/web-search.ts`) has three roles:

| Role | Who |
|---|---|
| Definition | `definitions/web-search.ts` (`ctx['web-search']`) |
| **Provider (host + engine)** | **this plugin** (`core/web-search-gemini`) |
| Consumer | `plugins/web-search-tools` (`web search`, `web search providers`) |

Before this row the deployment loaded the CONSUMER but no provider host, so every
search answered:

```json
{"ok":false,"error":{"code":"missing-service","stage":"lookup",
 "reason":"web-search.missing-service",
 "error":"no web-search@1 provider is loaded: add a 'web-search-impl' row to the plugins roster"}}
```

(config/workstation.yml DECISION 1, verified raw against the running service.)

## How it answers

`POST {apiBase}/models/{model}:generateContent` with

```json
{"contents":[{"role":"user","parts":[{"text":"<query + filters>"}]}],
 "tools":[{"google_search":{}}],
 "generationConfig":{"temperature":0.2}}
```

and the key in the `x-goog-api-key` header, resolved BY NAME (`apiKeyEnv`,
default `GEMINI_API_KEY`) through `ctx.credentials` at CALL time. The answer
becomes:

* the GROUNDED TEXT (the model's answer, backed by Google Search server side) in
  the answer `note`;
* one normalised result per `candidates[0].groundingMetadata.groundingChunks[].web`
  entry (`url`, `title`, snippet from `groundingSupports[].segment.text`), so the
  caller gets the real SOURCES, not a synthesized list.

Grounding is the Gemini API's own server-side search: no paid search API, no
browser, no local binary, and no request other than the one `generateContent`
call above (READ-ONLY by construction).

## Config row (user repo)

```yaml
- id: web-search-gemini
  name: '/var/lib/workstation/sources/workstation-plugins/core/web-search-gemini/index.ts'
  config:
    apiKeyEnv: GEMINI_API_KEY   # NAME only, resolved through ctx.credentials
    model: gemini-2.5-flash     # a real, API-accepted model id
    provider: gemini
```

## Verify

```bash
curl -sS -X POST http://workstation:8080/api/tool/call \
  -H 'content-type: application/json' \
  -d '{"tool":"web search providers"}' | jq .
curl -sS -X POST http://workstation:8080/api/tool/call \
  -H 'content-type: application/json' \
  -d '{"tool":"web search","params":{"query":"what is the latest release of node.js","count":3}}' | jq .
```

A missing credential is a TYPED failure naming the credential and the config row
(`web-search.provider-unavailable` / `web-search.not-configured`), never an empty
result list.

## Relation to `core/web-search-impl`

The generic host named by DECISION 1 (registry + selection + cap + **spill**,
engines as separate plugins: deepseek, tavily, ...) is still the longer-term
shape. This plugin hosts the same `web-search@1` service object and keeps the
engine swappable through the standard `register()` seam, so the day a generic
`core/web-search-impl` row (plus a second engine) lands, this row is replaced by
CONFIG alone - no consumer changes.
