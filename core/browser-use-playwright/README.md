# `browser-use-playwright` - the `browser-use@1` provider `playwright`

The REAL half of the `browser-use@1` seam: it drives a real chromium through
`playwright-core` - session lifecycle, navigate, the compact SNAPSHOT with
SHORT STABLE refs, the full act vocabulary (click/type/fill/select/hover/
scroll/press/upload/check/focus/waitFor/back/forward/reload), `evaluate`,
readable `extract` (text/markdown/html/table/attributes/links/json), FILE
screenshots, tabs, waits, downloads/network observation and storage-state
reuse. The host (`core/browser-use-impl`) owns the registry/selection/bounds;
this plugin owns a chromium and the sessions a caller drives.

## WHERE the browser runs is CONFIG, never code (the himalaya pattern)

The plugin is **location-agnostic**, exactly like the himalaya impl plugin:
it never decides where the browser runs. The config row selects the `backend` -
`local` | `container` | `ssh` | `ssh+container` | `http` - and every non-local
backend reaches the browser THROUGH the `general-service@1` seam under the hood
(probe/start), never through a hard-wired docker/ssh/http call.

| backend | where the browser runs | how the plugin reaches it |
| --- | --- | --- |
| `local` | a chromium launched by the provider process (`executablePath` or the playwright cache) | playwright launch, no seam |
| `container` | a compose browser service of the stack (the DEPLOYED default) | CDP attach to `browserService.endpoint`; probe/start through the seam (`container`) |
| `ssh` | a browser on a REMOTE machine | CDP attach to the endpoint the config names; probe/start through the seam (`ssh`) |
| `ssh+container` | a browser in a container on a REMOTE machine | CDP attach; probe/start through the seam (`ssh+container`, remote docker) |
| `http` | a remote CDP endpoint over http | CDP attach; probe/start through the seam (`http`) |

## Config

```yaml
plugins:
  browser-use-playwright:
    # container: a compose browser service, CDP attach (THE DEPLOYED DEFAULT).
    # The endpoint is where the service answers; the `generalService` instance
    # is the seam that probes/starts it when the endpoint does not answer yet.
    backend: container
    browserService:
      endpoint: http://browser:9222
      image: ghcr.io/nexuslbs/workstation-plugins/browser:0.0.3
      generalService:
        type: container
        params:
          engine: docker-compose
          compose: { project_dir: ${env:OMNI_DIR}, service: browser }
      start: /usr/local/bin/start-browser --background
      startTimeoutMs: 20000
```

Per-backend params: `local` uses the existing `executablePath`/`headless`/
`browserArgs`; `container` uses `browserService` plus an optional `container`
block; `ssh` uses an `ssh` block (host, user, key name, binary); `ssh+container`
uses `ssh` + `container` blocks; `http` uses an `http` block. When
`browserService.generalService` is absent the seam instance is built FROM the
backend (`type` = backend, `params` = the backend's block), so `backend: ssh`
reaches the remote machine through the `ssh@1` transport by default - the seam
decides the transport, the plugin never hard-wires docker or ssh.

**BACKWARDS COMPATIBLE**: `backend` may be omitted. It is then inferred -
`browserService` present -> `container`, a bare `wsEndpoint`/`cdpEndpoint` ->
`http`, otherwise `local` - so the existing
`browserService: { endpoint: http://browser:9222, image: ... }` config keeps
working unchanged as the container-mode default.

## Honesty

A deployment without a browser fails with the typed `browser-use.no-browser`
error naming the exact prerequisite, and an unreachable configured endpoint
fails with the typed `browser-use.endpoint-unreachable` naming the endpoint,
the image and the seam instance - NEVER a silent fallback to a local launch or
to a non-browser HTTP fetch. Every answer carries the provider and the engine
that produced it.

## Reuse

The chromium process comes from the SHARED launcher of the repository
(`shared/browser.ts`, refcounted), so `web-page`, `web-session` and this
provider never launch competing browsers. Storage state uses the SAME
convention as `web-session` (`<stateDir>/<session>.json`, reuse on open,
persist on close).