# The browser service image (a SEPARATE image, never the workbench image)

This directory holds the packaging material of the **browser service image** of the
workbench project. It carries **no workbench code and no workbench dependency**:
chromium (from the official playwright image), a raw TCP forwarder, and a tiny
entrypoint. The workbench core image (`ghcr.io/nexuslbs/workbench`) ships **no
browser at all** - driving a real browser is a *deployment input*, exactly like a
plugin source.

Operator decision (telegram thread 2593): *"the browser image is a separate image,
not the workbench image. It could be accessible using GeneralService"*.

## Files

| file | what it is |
| --- | --- |
| `Dockerfile` | `FROM mcr.microsoft.com/playwright:v1.63.0-noble` + the entrypoint and the forwarder, `EXPOSE 9222` |
| `start-browser.sh` | the entrypoint: finds chromium, runs it on a loopback port, runs the forwarder on `0.0.0.0:9222`, refuses to report success until the CDP endpoint really answers, then supervises both |
| `cdp-forward.js` | a ~60-line raw TCP proxy (`0.0.0.0:9222` -> `127.0.0.1:9223`); it exists because chromium binds loopback only (below) |
| `docker-compose.yml` | runs the image as its OWN compose project (`workbench-browser`) |

## Build and run it

```sh
docker build -t wb-browser:local browser         # or: docker build -t wb-browser:local .
docker run --rm -p 9222:9222 wb-browser:local
curl -fsS http://127.0.0.1:9222/json/version     # {"Browser":"Chrome/153...."}
```

As its own compose project (the published image by default):

```sh
docker compose -f browser/docker-compose.yml -p workbench-browser up -d
```

## Why the image needs a forwarder (why `--remote-debugging-address` is not enough)

Chromium binds its DevTools HTTP/WebSocket server to **loopback only**:
`--remote-debugging-address=0.0.0.0` is **ignored** by current builds. Measured on the
Chromium 153 shipped in `mcr.microsoft.com/playwright:v1.63.0-noble`:

```
$ docker run -d --rm wb-browser:local ; docker exec <ctr> \
    sh -c 'awk \'$4=="0A"{print $2}\' /proc/net/tcp'
0100007F:2406          # 127.0.0.1:9222 - and nothing else
$ docker exec <ctr> curl -s -o /dev/null -w '%{http_code}' http://<container-ip>:9222/json/version
000                    # refused: nothing listens on the container IP
```

Passing `--user-data-dir` makes no difference, and neither does dropping the other
flags. A browser **service** whose CDP endpoint only answers on its own loopback is
useless: the consumer runs in ANOTHER container and reaches this one by IP or
through a published port. So the image runs two processes:

```
chromium       127.0.0.1:${BROWSER_CDP_INTERNAL_PORT:-9223}   (loopback, its own)
cdp-forward.js 0.0.0.0:${BROWSER_CDP_PORT:-9222}  -->  chromium
```

The forwarder is a plain TCP pipe, so the CDP HTTP endpoints *and* the WebSocket
upgrade pass through untouched; it holds no CDP knowledge. `start-browser` verifies
the forwarded endpoint (`/json/version`) before declaring the service up - a
container that cannot be reached never looks healthy.

## Use an IP in the endpoint, not a container hostname

Chromium additionally rejects DevTools HTTP requests whose `Host` header is not an
IP address or `localhost`:

```
$ curl -s -i http://browser:9222/json/version
HTTP/1.1 500 Internal Server Error
Host header is specified and is not an IP address or localhost.
```

So `browserService.endpoint` must name the service by **IP** (`http://127.0.0.1:9222`
when the consumer shares the network namespace, or `http://<container-ip>:9222` on a
shared docker network) - never by its DNS name. This is a chromium policy, not a
property of this image.

A chromium policy is not a user-interface rule though: the workbench PLAYWRIGHT
provider resolves a NAME for you. `browser-use-playwright` turns
`browserService.endpoint` into its IP address (`dns.lookup`) right before it
attaches, so `endpoint: http://browser:9222` - the readable compose service-name
form - attaches exactly like the IP form and needs no operator trick. The
resolution happens once per attach, the RESOLVED IP is what playwright receives,
and the CONFIGURED endpoint (the name) stays the one named in the typed
`browser-use.endpoint-unreachable` error. A name that does not resolve is passed
through unchanged, so the failure stays the typed one instead of degrading into a
resolution error.

## Wiring a deployment to it

```yaml
plugins:
  general-service-impl: {}      # reaches the service (any transport)
  docker-impl: {}               # type: container
  browser-use-impl: { provider: playwright }
  browser-use-playwright:
    browserService:
      endpoint: http://127.0.0.1:9222      # an IP: chromium refuses Host: hostnames
      image: ghcr.io/nexuslbs/workstation-plugins/browser:0.0.2
      generalService: { type: container, params: { container: workbench-browser } }
      start: '/usr/local/bin/start-browser --background'
      startTimeoutMs: 20000
```

`start-browser --background` starts both processes detached and exits `0` **only
after** `/json/version` answers, so a launcher (`docker exec`, ssh) does not block
on a foreground child and knows the endpoint is usable when the command returns.

The upstream `mcr.microsoft.com/playwright:v1.63.0-noble` image is an equally valid
service if you prefer the vendor artifact - but then YOU must provide the
reachability (it listens on loopback only, see above).

## The backend selector: the browser is a transparent service, like himalaya in the toolbox

`browser-use-playwright` is LOCATION-AGNOSTIC: it never decides where the browser
runs. The plugin config row selects the `backend` - `local` | `container` |
`ssh` | `ssh+container` | `http` - exactly like the himalaya impl plugin's
`general` row selects the transport of the toolbox himalaya. The browser stays a
regular compose service of the stack (this project); the plugin does not need to
know whether the service is local, in a container or on a remote host, the
config tells it where, and every non-local backend reaches the browser through
the `general-service@1` seam under the hood.

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

The five backends:

| backend | where the browser runs | how the plugin reaches it |
| --- | --- | --- |
| `local` | a chromium launched by the provider process (`executablePath` or the playwright cache) | playwright launch, no seam |
| `container` | a compose browser service of the stack (this project) | CDP attach to `browserService.endpoint`; probe/start through the seam (`container`) |
| `ssh` | a browser on a REMOTE machine | CDP attach to the endpoint the config names; probe/start through the seam (`ssh`) |
| `ssh+container` | a browser in a container on a REMOTE machine | CDP attach; probe/start through the seam (`ssh+container`, remote docker) |
| `http` | a remote CDP endpoint over http | CDP attach; probe/start through the seam (`http`) |

Per-backend params: `local` uses the existing `executablePath`/`headless`/
`browserArgs`; `container` uses `browserService` plus an optional `container`
block; `ssh` uses an `ssh` block (host, user, key name, binary); `ssh+container`
uses `ssh` + `container` blocks; `http` uses an `http` block. When
`browserService.generalService` is absent the seam instance is built FROM the
backend (`type` = backend, `params` = the backend's block), so `backend: ssh`
reaches the remote machine through the `ssh@1` transport by default - the seam
decides the transport, the plugin never hard-wires docker or ssh.

BACKWARDS COMPATIBLE: `backend` may be omitted. It is then inferred -
`browserService` present -> `container`, a bare `wsEndpoint`/`cdpEndpoint` ->
`http`, otherwise `local` - so the existing
`browserService: { endpoint: http://browser:9222, image: ... }` config keeps
working unchanged as the container-mode default.

An unreachable browser is a TYPED error (`browser-use.endpoint-unreachable`
naming the endpoint, the image and the seam instance; `browser-use.no-browser`
naming the exact prerequisite), never a silent fallback to a non-browser fetch.
## Publishing

`.github/workflows/browser-publish.yml` is the ONLY publisher of this image, and it
triggers ONLY on a `browser-*` tag:

```sh
git tag browser-0.0.2 && git push origin browser-0.0.2
# -> ghcr.io/nexuslbs/workstation-plugins/browser:0.0.2  and  :latest
```

The workflow builds the image once, **smoke-tests the built image** (it must answer
`/json/version` on the CDP port), and pushes only the tested image. The image tag is
the git tag with the `browser-` prefix stripped. Nothing else publishes this image:
a branch push and a `v*` (core) tag build nothing here.
## The real-browser acceptance gate

One command measures the DEPLOYED service (the repository README documents it as
"The DEPLOYED gate"): the suite attaches to THIS running container over CDP and
asserts the RAW observations of each load - a real launch (no headless flag, a
display, plugins, a WebGL renderer), the frame tree from the ENGINE rather than
the page DOM, real pointer input inside an offered cross-origin control, and
BOTH loads when the browser navigates itself:

```sh
BROWSER_USE_CDP_ENDPOINT=http://<host>:9222 npm test -- browser-real-page
```

Its deterministic half serves its own origins on loopback (a refusal with
`retry-after`, an off-origin control, the landing page the control navigates to)
and needs no third party and no endpoint at all. Without
`BROWSER_USE_CDP_ENDPOINT` the DEPLOYED half SKIPS, naming the prerequisite;
`BROWSER_USE_REQUIRE_CDP=1` turns that skip into a failure, which is what the
one-command gate above sets.

## The live view: watch and drive THE SAME browser from a phone (noVNC)

The agent drives this container's chromium over CDP. The **live view** streams that
**same** X display out as a phone-usable noVNC page, so a human can watch - and, when
an origin asks for a captcha, solve it - in the browser the agent is driving:

```
chromium (headful, display :99) -> x11vnc -> websockify + noVNC (:8080)
                                            -> your tunnel (cloudflared) -> phone
```

It is **off by default** AND **on demand**: a deployment that does not opt in starts
exactly the processes it started before (`BROWSER_VNC=0`), and the stream is turned on
only while a human is needed - around a captcha, for supervised browsing, or for "show
me the browser" - WITHOUT recreating the stack:

```sh
docker exec <browser-container> start-browser vnc-start    # stream ON
docker exec <browser-container> start-browser vnc-stop     # stream OFF again
docker exec <browser-container> start-browser vnc-status   # is it up?
```

`vnc-start` starts `x11vnc` on the display the agent's chromium already draws on plus
`websockify`, waits until the RFB port answers AND `/vnc.html` returns 200, and exits 0
only then (a failed start exits 1 and leaves the browser running). `vnc-stop` stops both
and waits until neither port answers. The **agent's chromium, its profile, its tabs and
its session are untouched** by either: the live view is an accessory process, not a
browser lifecycle.

| variable | default | meaning |
| --- | --- | --- |
| `BROWSER_VNC` | `0` | `1` starts the live view at BOOT as well (the same code path as `vnc-start`). Anything else than `0/1` (and `true/yes/on`, `false/no/off`) is refused (exit 2). `0` does not disable the runtime switch: `start-browser vnc-start` still works. |
| `BROWSER_VNC_PASSWORD` | (none) | **Not needed and not read.** x11vnc runs with `-nopw` (no password of our own); the access boundary is the operator's Cloudflare tunnel + Cloudflare Access OTP policy in front of the published hostname. A leftover value in an existing deployment is ignored. |
| `BROWSER_VNC_PORT` | `5900` | x11vnc's RFB port, bound on **loopback only** inside the container. |
| `BROWSER_NOVNC_PORT` | `8080` | websockify's port (`--web` serves noVNC), bound on the container network so a tunnel can reach `browser:8080`. |
| `BROWSER_NOVNC_WEB` | `/usr/share/novnc` | the noVNC static files (`vnc.html`). |
| `BROWSER_VNC_CTL_DIR` | `/tmp/browser-vnc-ctl` | the request/response directory of the runtime switch: the running entrypoint owns it, so a `docker exec` reaches the process that owns x11vnc/websockify. |

### What the entrypoint does (and what it refuses)

* After Xvfb (`BROWSER_DISPLAY`, default `:99`), chromium and the CDP forwarder are
  really up, it starts `x11vnc -display :99 -forever -shared -localhost -nopw
  -rfbport 5900` and `websockify --web=/usr/share/novnc 0.0.0.0:8080 127.0.0.1:5900`
  whenever the live view is on - at boot (`BROWSER_VNC=1`) or at runtime
  (`start-browser vnc-start`). `-nopw` is deliberate: there is no password of our own,
  the tunnel and its Access OTP policy are the boundary.
* `-localhost` is deliberate: x11vnc is reachable only from inside the container,
  websockify is the single thing listening on the container network.
* **One display, one chromium, one profile.** No second Xvfb, no second chromium, no
  per-session display: what the agent opens appears in your view, and your clicks,
  keys, scrolls and drags are `XTEST` events into *its* session.
* It **refuses loudly** instead of serving something broken: `BROWSER_VNC=1` together
  with `BROWSER_HEADLESS=1` exits 2 (that launch has no X display to stream); a missing
  `x11vnc`/`websockify`/`vnc.html` fails the **build**; a boot-time `BROWSER_VNC=1` whose
  live view never answers exits 1 with the log tail, and a runtime `vnc-start` reports
  the same error to the caller while the browser keeps running.
* Readiness is a real HTTP response, in BOTH run modes: the live view is reported up
  only once `GET /vnc.html` returns 200. `start-browser --background` exits 0 only
  after that, so a launcher that gets exit 0 knows both endpoints are usable. The
  foreground supervisor keeps owning x11vnc/websockify: if the live view dies while it
  is up it is reported DOWN (start it again with `start-browser vnc-start`) and the
  agent's browser session keeps running.

### Opening it from a phone

The container's `/` is a tiny page that redirects to
`vnc.html?autoconnect=1&resize=scale&reconnect=1`, which is the phone-friendly
default: it connects immediately (no button to hunt for), scales the 1440x1000 screen
into the phone viewport instead of forcing you to pan a desktop-sized framebuffer, and
reconnects after a mobile network stall. Nothing else is asked: the VNC server runs
without a password of ours (`-nopw`), because the tunnel hostname sits behind the
Cloudflare Access policy.

**Quality and compression are deliberately left at the noVNC client's own defaults**:
the landing page passes only `autoconnect`, `resize=scale` and `reconnect`, never
`quality=` or `compression=`. Those client defaults are the mobile-data stance: they
already trade image fidelity against bandwidth, while forcing a high quality level is
what makes a phone connection struggle on a 1440x1000 framebuffer. Both are ordinary
noVNC URL parameters, so a human on wifi can raise the quality for one session by
appending them to the page URL (e.g. `&quality=8`); nothing here needs a rebuild or a
stack recreate.

A deployment that shares a network with `cloudflared` publishes this as a Public
Hostname route in the Cloudflare Zero Trust dashboard, e.g.

```
browser-live.<your-domain>  ->  http://browser:8080
```

`EXPOSE 8080` is documentation, not a publication: **never publish 8080 to the open
internet directly.** noVNC is full remote control of this container (and therefore of
whatever session the agent holds in it) and there is no password of ours in front of
it: the tunnel hostname **MUST** sit behind a Cloudflare Access policy (OTP). That
policy, not the image, is the access boundary.

This is a way to SEE and TOUCH the real browser the agent uses. It is not a stealth or
anti-bot feature and it does not solve captchas for you: a human does, in a normal
chromium on a normal X display. No patched chromium, no proxy rotation, no challenge
service is involved, and the browser stays free of any site-specific knowledge.

### Verifying a deployment

```sh
# the switch is the deployment's own health check (no stack recreate):
docker exec <browser-container> start-browser vnc-status
# the page a phone opens, once the live view is on (inside the container / its network):
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/vnc.html   # 200
# OFF again: both listeners must be gone, so this curl fails to connect:
docker exec <browser-container> start-browser vnc-stop
```

Measured on the built image (throwaway compose projects, threads 2791 and 2795,
2026-09-21): `/vnc.html` -> 200, `/` -> 200, `/vnc_lite.html` -> 200; the RFB
handshake (`RFB 003.008`) offers exactly ONE security type (`security_types [1]`),
the client chooses `1 (None)` and **no password is sent at all** (`security_result_raw
00 00 00 00`, success without authentication), so there is nothing to type and nothing
to leak; `ServerInit` reports `1440x1000` with desktop name `<container-id>:99` (i.e.
the SAME display the agent's chromium draws on); a page opened over CDP was visible in
the captured framebuffer (`frame-before-click.png`), and a click + key injected through
the VNC session changed that page (`frame-after-click.png`; `document.title` became
`click 710,403` / `keydown t`).
