# core/gemini-web-search - the Gemini-grounded SEARCH PROVIDER for the harness web seam

One row that gives a dsh AGENT's own `web_search` the **Google Search grounding
of the Gemini models** instead of the harness base bundle's DeepSeek provider.

## Why it exists

The harness BASE bundle mounts the web seam together with a DeepSeek search
provider (`packages/bundle/base/cordis.patch.yml`):

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config: { searchProvider: deepseek-official, fetchProvider: http }
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config: { apiKeyEnv: DEEPSEEK_API_KEY }
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'      # the model-facing `web_search` tool
```

Without a Gemini provider registered in the SAME seam, every worker's
`web_search` is DeepSeek native search (`DEEPSEEK_API_KEY`) - even inside the
`gemini-researcher` role, whose LLM route is Gemini. `core/gemini-grounded-search`
cannot fix that: it hosts the FACADE capability seam (`web-search@1`), which a
dsh worker's toolset does not contain.

## What it does

Registers `ctx.web.registerSearchProvider({ id: 'gemini', available, search })`.
One search is one `generateContent` call with the native grounding tool:

```json
{ "contents": [{ "role": "user", "parts": [{ "text": "Search the web for ..." }] }],
  "generationConfig": { "temperature": 0.2 },
  "tools": [{ "google_search": {} }] }
```

* the grounded answer text becomes the result `content` (rendered by
  `dsh-tool-web` inside the model-facing tool result);
* the sources are read from
  `candidates[0].groundingMetadata.groundingChunks[].web` (uri + title), with the
  `groundingSupports` segment text as the snippet - real Google-grounded source
  URLs, never scraped prose;
* the key is resolved BY NAME at CALL time through `ctx.credentials`
  (`$DSH_HOME/.credentials.yaml`) with the process environment as the fallback,
  and travels only in the `x-goog-api-key` header.

No paid search API, no browser, no local binary: the only request is
`POST {apiBase}/models/{model}:generateContent`.

## Row

```yaml
- insert:
    - id: gemini-web-search
      name: '/var/lib/workstation/sources/workstation-plugins/core/gemini-web-search/index.ts'
      config:
        apiKeyEnv: GEMINI_API_KEY   # NAME only, resolved through ctx.credentials
        model: gemini-2.5-flash     # a real, API-accepted model id
        providerId: gemini
```

Pin it for ONE role by patching the seam selection in that role's patch (the
harness web seam takes the configured id and never falls back silently):

```yaml
- id: web
  config:
    searchProvider: gemini
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `GEMINI_API_KEY` | Credential NAME resolved per search through `ctx.credentials`, else the process environment. A NAME only, never a value |
| `model` | `gemini-2.5-flash` | Real, API-accepted Gemini model id |
| `apiBase` | `https://generativelanguage.googleapis.com/v1beta` | API root; a proxy or stub may override it |
| `providerId` | `gemini` | Provider id registered with the seam (the value `web.searchProvider` names) |
| `grounded` | `true` | Send the native `google_search` grounding tool |
| `timeoutMs` | `30000` | Per-call deadline in ms (max 120000) |

## Failures

Errors carry the seam's machine-routable codes structurally: a missing key is
`WEB_PROVIDER_CREDENTIAL_MISSING`, caller cancellation is `WEB_ABORTED`, and a
transport, HTTP or unparseable-response failure is `WEB_PROVIDER_ERROR`.

## Live application

The row is a config row, so it takes effect without a container recreate: the
module only has to be reachable at the `name:` path. `plugin add --layer config`
(a config patch) or an edited role profile patch, followed by a fresh dispatch,
is enough.
