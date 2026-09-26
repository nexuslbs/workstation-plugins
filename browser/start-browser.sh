#!/bin/sh
# Entrypoint of the browser service image: run the chromium that ships WITH the
# image (the playwright browser cache) behind a tiny TCP forwarder, so that the
# CDP endpoint is reachable from OUTSIDE this container.
#
# WHY A FORWARDER: chromium binds its DevTools server to LOOPBACK only -
# `--remote-debugging-address=0.0.0.0` is ignored by current builds (verified on
# Chromium 153, with and without `--user-data-dir`: `/proc/net/tcp` shows
# `127.0.0.1:<port>`, connections to the container IP are refused). A browser
# SERVICE must be reachable by IP / published port from the container that drives
# it, so the image runs two processes:
#
#   chromium       -> 127.0.0.1:${BROWSER_CDP_INTERNAL_PORT} (default: CDP port + 1)
#   cdp-forward.js -> 0.0.0.0:${BROWSER_CDP_PORT}            (default: 9222) -> chromium
#
# Nothing here knows about workbench.
#
#   start-browser                 foreground (the container entrypoint): start both,
#                                 require the CDP endpoint to answer, then supervise.
#                                 THIS process owns the optional live view and answers
#                                 the runtime switch below.
#   start-browser --background    start it DETACHED, wait until the CDP endpoint
#                                 answers, then exit 0 (bounded, for a launcher run
#                                 through `docker exec` / ssh, which would otherwise
#                                 block forever on a foreground child)
#   start-browser vnc-start       THE LIVE VIEW, ON DEMAND: ask the RUNNING supervisor
#   start-browser vnc-stop        to start/stop x11vnc + websockify on the display the
#   start-browser vnc-status      agent's chromium already draws on. No container
#                                 recreate, no second display, no second browser, and
#                                 the agent's session is untouched either way.
set -eu

MODE="foreground"
case "${1:-}" in
  ""|-f|--foreground) MODE="foreground" ;;
  -d|--background|--detach) MODE="background" ;;
  vnc-start) MODE="vnc-start" ;;
  vnc-stop) MODE="vnc-stop" ;;
  vnc-status) MODE="vnc-status" ;;
  *)
    echo "start-browser: unknown option '$1' (usage: start-browser [--foreground|--background|vnc-start|vnc-stop|vnc-status])" >&2
    exit 2
    ;;
esac

PORT="${BROWSER_CDP_PORT:-9222}"
INTERNAL_PORT="${BROWSER_CDP_INTERNAL_PORT:-$((PORT + 1))}"
WAIT_SECONDS="${BROWSER_START_WAIT_SECONDS:-60}"
LOG="${BROWSER_LOG:-/tmp/start-browser.log}"
FORWARDER="${BROWSER_FORWARDER:-/usr/local/bin/cdp-forward.js}"

# ---------------------------------------------------------------------------
# THE LIVE VIEW (ON DEMAND, OFF by default): the operator watches and drives THE SAME
# chromium the agent uses - no second X server, no second browser, no per-session
# display. The chain is
#
#   chromium on $DISPLAY_NAME -> x11vnc 127.0.0.1:$VNC_PORT (RFB, loopback, NO password)
#                             -> websockify 0.0.0.0:$NOVNC_PORT (noVNC + WebSocket)
#                             -> a tunnel -> the operator's phone
#
# so whatever the agent opens appears in the live view, and whatever the human
# clicks / types / scrolls happens in the agent's browser.
#
#   BROWSER_VNC=0 (default)  nothing extra starts at BOOT: a deployment that does not
#                            opt in runs exactly the processes it ran before, and the
#                            live view is started ONLY when a human is needed:
#                              docker exec <container> start-browser vnc-start
#                            (and stopped again with `start-browser vnc-stop`)
#   BROWSER_VNC=1            start the live view at boot as well (the same code path)
#                            - vnc-start / vnc-stop still work at runtime.
#
# NO PASSWORD OF OUR OWN (operator correction, telegram 2786): x11vnc runs `-nopw`. The
# access-control boundary is the operator's tunnel and its own access policy (OTP), in
# front of the published hostname; the RFB port therefore stays on LOOPBACK and 8080 is
# never published on the host - websockify is the ONLY thing listening on the container
# network. noVNC is full remote control of this container (and of whatever session the
# agent holds in it), so that hostname MUST sit behind the Access policy: see
# browser/README.md.
VNC_ENABLED=""
case "${BROWSER_VNC:-0}" in
  1|true|yes|on) VNC_ENABLED="1" ;;
  0|false|no|off|"") VNC_ENABLED="" ;;
  *)
    echo "start-browser: BROWSER_VNC must be 0 or 1 (got '$BROWSER_VNC')" >&2
    exit 2
    ;;
esac
VNC_PORT="${BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${BROWSER_NOVNC_PORT:-8080}"
NOVNC_WEB="${BROWSER_NOVNC_WEB:-/usr/share/novnc}"
# THE CONTROL CHANNEL of the runtime switch: a request/response pair in a shared
# directory (a `docker exec` sees the container's /tmp), so `vnc-start` / `vnc-stop`
# reach the RUNNING supervisor that owns - and keeps supervising - x11vnc/websockify.
VNC_CTL_DIR="${BROWSER_VNC_CTL_DIR:-/tmp/browser-vnc-ctl}"
VNC_REQ="$VNC_CTL_DIR/request"
VNC_RSP="$VNC_CTL_DIR/response"
VNC_CTL_WAIT="${BROWSER_VNC_CTL_WAIT_SECONDS:-120}"
# The live view needs all its pieces IN THE IMAGE (the Dockerfile asserts them at build
# time too). A boot-time opt-in that cannot deliver refuses to start; a runtime
# vnc-start reports the error to the caller and leaves the browser running.
VNC_READY=""
if command -v x11vnc >/dev/null 2>&1 && command -v websockify >/dev/null 2>&1 && [ -f "$NOVNC_WEB/vnc.html" ]; then
  VNC_READY="1"
fi
if [ -n "$VNC_ENABLED" ] && [ -z "$VNC_READY" ]; then
  echo "start-browser: BROWSER_VNC=1 but the live view is incomplete: x11vnc / websockify / $NOVNC_WEB/vnc.html missing from this image" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# THE LAUNCH MODE - the DEPLOYED DEFAULT is a REAL, HEADFUL browser.
#
# A headless chromium is REFUSED by an origin that checks for a real browser:
# the verification step passes (the cookie such an origin sets appears) and the
# origin STILL answers 403 "Just a moment..." on the next navigation. The SAME
# image served the page directly (HTTP 200, no verification step at all) as soon
# as chromium ran HEADFUL under Xvfb (measured on a public page, threads 2607 and
# 2688). That is why the default here is headful: not a fingerprint trick but an
# ordinary desktop chromium on a real X display.
#
#   BROWSER_HEADLESS=0 (default) headful chromium on the Xvfb display below
#   BROWSER_HEADLESS=1           the old `--headless=new` launch (opt-in; a
#                                deployment that must not run an X server)
HEADLESS=""
case "${BROWSER_HEADLESS:-0}" in
  1|true|yes|on) HEADLESS="1" ;;
  0|false|no|off|"") HEADLESS="" ;;
  *)
    echo "start-browser: BROWSER_HEADLESS must be 0 or 1 (got '$BROWSER_HEADLESS')" >&2
    exit 2
    ;;
esac
# A live view attaches to the X display the browser draws on; the headless launch
# has no display at all, so there is nothing to stream - refuse instead of serving
# an empty VNC screen.
if [ -n "$HEADLESS" ] && [ -n "$VNC_ENABLED" ]; then
  echo "start-browser: BROWSER_VNC=1 needs the X display a headful browser runs on, and BROWSER_HEADLESS=1 starts no X server (set BROWSER_HEADLESS=0 or BROWSER_VNC=0)" >&2
  exit 2
fi
DISPLAY_NAME="${BROWSER_DISPLAY:-:99}"
SCREEN="${BROWSER_SCREEN:-1440x1000x24}"
WINDOW_SIZE="${BROWSER_WINDOW_SIZE:-1440,1000}"
PROFILE_DIR="${BROWSER_PROFILE_DIR:-/tmp/chrome-profile}"
XVFB_PID=""

# Does the CDP HTTP endpoint answer on a given port?
cdp_answers() {
  node -e '
    const http = require("http");
    const req = http.get({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/json/version", timeout: 2000 }, (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' "$1" 2>/dev/null
}

# Does the noVNC page answer? The live-view readiness probe, same shape as the CDP
# one: a live view is up when the page a phone will open is really served.
novnc_answers() {
  node -e '
    const http = require("http");
    const req = http.get({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/vnc.html", timeout: 2000 }, (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' "$1" 2>/dev/null
}

# Is a TCP port of THIS container open (something listening)? Proves the live view is
# really up (RFB) and, after a stop, really gone.
tcp_open() {
  node -e '
    const net = require("net");
    const s = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
    s.setTimeout(2000);
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    s.on("timeout", () => { s.destroy(); process.exit(1); });
  ' "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# THE RUNTIME SWITCH of the live view (CLIENT side). The RUNNING supervisor (this same
# script in foreground mode, i.e. the container entrypoint) owns x11vnc and websockify,
# so `docker exec <container> start-browser vnc-start` turns the stream ON around a
# captcha and `vnc-stop` turns it OFF again - no stack recreate, no second display, no
# second browser, and the agent's page/session survives either way.
if [ "$MODE" = "vnc-start" ] || [ "$MODE" = "vnc-stop" ] || [ "$MODE" = "vnc-status" ]; then
  VERB="${MODE#vnc-}"
  if [ ! -d "$VNC_CTL_DIR" ]; then
    echo "start-browser: no live-view control channel at $VNC_CTL_DIR - is the browser service running (the container entrypoint owns the channel)? Use BROWSER_VNC=1 to have the live view at boot" >&2
    exit 1
  fi
  RID="$$-$(date +%s)"
  printf '%s %s\n' "$VERB" "$RID" >"$VNC_REQ.tmp.$$"
  mv "$VNC_REQ.tmp.$$" "$VNC_REQ"
  waited=0
  RSTATUS=""
  RID_SEEN=""
  RMSG=""
  while [ "$waited" -lt "$VNC_CTL_WAIT" ]; do
    if [ -f "$VNC_RSP" ]; then
      RSTATUS=""
      RID_SEEN=""
      RMSG=""
      read RSTATUS RID_SEEN RMSG <"$VNC_RSP" || true
      if [ "${RID_SEEN:-}" = "$RID" ]; then break; fi
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "${RID_SEEN:-}" != "$RID" ]; then
    echo "start-browser: the live-view supervisor did not answer '$VERB' within ${VNC_CTL_WAIT}s" >&2
    exit 1
  fi
  echo "start-browser: ${RMSG:-$VERB}"
  if [ "${RSTATUS:-}" != "ok" ]; then exit 1; fi
  # THE END STATE IS VERIFIED HERE, not taken from the supervisor's word: the switch
  # either really answers, or it really is gone.
  case "$VERB" in
    start)
      if novnc_answers "$NOVNC_PORT" && tcp_open "$VNC_PORT"; then
        echo "start-browser: verified 127.0.0.1:$VNC_PORT (RFB, no password) and 127.0.0.1:$NOVNC_PORT (noVNC /vnc.html) both answer"
      else
        echo "start-browser: the supervisor reported the live view up, but the endpoints do not answer" >&2
        exit 1
      fi
      ;;
    stop)
      if novnc_answers "$NOVNC_PORT" || tcp_open "$VNC_PORT"; then
        echo "start-browser: the supervisor reported the live view stopped, but a listener is still there" >&2
        exit 1
      fi
      echo "start-browser: verified that nothing listens on 127.0.0.1:$VNC_PORT (RFB) nor on $NOVNC_PORT (noVNC)"
      ;;
  esac
  exit 0
fi

# Background mode: detach the FOREGROUND supervisor (this same script) and wait for
# the CDP endpoint it must bring up. One startup path, two behaviours - the exit
# code is the proof that the service is up, no sleep-and-hope.
if [ "$MODE" = "background" ]; then
  echo "start-browser: starting detached, waiting for CDP on 127.0.0.1:$PORT"
  nohup "$0" --foreground >>"$LOG" 2>&1 &
  SUPERVISOR_PID=$!
  waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    if cdp_answers "$PORT"; then
      echo "start-browser: CDP endpoint answering on 0.0.0.0:$PORT (after ${waited}s)"
      # With the live view enabled, exit 0 only once the noVNC page answers too: the
      # supervisor starts it right after the CDP endpoint comes up, and a launcher
      # that gets exit 0 must know BOTH endpoints are usable.
      if [ -n "$VNC_ENABLED" ]; then
        while [ "$waited" -lt "$WAIT_SECONDS" ]; do
          if novnc_answers "$NOVNC_PORT"; then
            echo "start-browser: live view answering on 0.0.0.0:$NOVNC_PORT (noVNC, after ${waited}s)"
            exit 0
          fi
          sleep 1
          waited=$((waited + 1))
        done
        echo "start-browser: no answer on 127.0.0.1:$NOVNC_PORT (noVNC) within ${WAIT_SECONDS}s - log tail:" >&2
        tail -n 20 "$LOG" >&2 2>/dev/null || true
        kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
        exit 1
      fi
      exit 0
    fi
    if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
      echo "start-browser: the supervisor exited before the CDP endpoint answered - log tail:" >&2
      tail -n 20 "$LOG" >&2 2>/dev/null || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "start-browser: no answer on 127.0.0.1:$PORT within ${WAIT_SECONDS}s - log tail:" >&2
  tail -n 20 "$LOG" >&2 2>/dev/null || true
  kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
  exit 1
fi

# The playwright image keeps its builds under /ms-playwright/<name>-<rev>/.
# HEADFUL needs the FULL chromium: `chromium_headless_shell` is a separate binary
# that can only ever run headless. In headless mode the shell stays an acceptable
# fallback, and an image carrying no browser at all fails LOUDLY either way.
BIN=""
CANDIDATES="
  /ms-playwright/chromium-*/chrome-linux/chrome
  /ms-playwright/chromium-*/chrome-linux64/chrome
  /usr/bin/chromium /usr/bin/google-chrome"
if [ -n "$HEADLESS" ]; then
  CANDIDATES="$CANDIDATES
  /ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell
  /ms-playwright/chromium_headless_shell-*/chrome-linux64/headless_shell"
fi
for candidate in $CANDIDATES; do
  for path in $candidate; do
    if [ -x "$path" ]; then BIN="$path"; break 2; fi
  done
done
if [ -z "$BIN" ]; then
  echo "start-browser: no usable browser binary found (headful mode refuses the headless shell): this is not a browser image" >&2
  exit 1
fi

CHROME_PID=""
FWD_PID=""
VNC_PID=""
WS_PID=""
stop_children() {
  if [ -n "$CHROME_PID" ]; then kill -TERM "$CHROME_PID" 2>/dev/null || true; fi
  if [ -n "$FWD_PID" ]; then kill -TERM "$FWD_PID" 2>/dev/null || true; fi
  if [ -n "$WS_PID" ]; then kill -TERM "$WS_PID" 2>/dev/null || true; fi
  if [ -n "$VNC_PID" ]; then kill -TERM "$VNC_PID" 2>/dev/null || true; fi
  if [ -n "$XVFB_PID" ]; then kill -TERM "$XVFB_PID" 2>/dev/null || true; fi
}
trap 'stop_children; exit 143' TERM INT

fail_loudly() {
  echo "start-browser: $1" >&2
  echo "start-browser: log tail ($LOG):" >&2
  tail -n 20 "$LOG" >&2 2>/dev/null || true
  stop_children
  exit 1
}

# THE CHROMIUM SWITCH SET: the SAME stock automation switches playwright's own
# chromium launcher spawns (playwright-core chromiumSwitches - i.e. the browser
# the provider would launch itself, with the version of the library the plugin
# already depends on). A SHORTER hand-rolled list is not neutral: measured
# (thread 2755, same binary + display + egress IP) the shortened list made the
# origin serve a DIFFERENT document than this set, while spawning with these
# switches got the same document bare playwright gets. Keep it in sync with
# node_modules/playwright-core when playwright is upgraded.
STOCK_FLAGS="\
--disable-field-trial-config \
--disable-background-networking \
--disable-background-timer-throttling \
--disable-backgrounding-occluded-windows \
--disable-back-forward-cache \
--disable-breakpad \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-component-update \
--no-default-browser-check \
--disable-default-apps \
--disable-edgeupdater \
--disable-extensions \
--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion \
--enable-features=CDPScreenshotNewSurface \
--allow-pre-commit-input \
--disable-hang-monitor \
--disable-ipc-flooding-protection \
--disable-popup-blocking \
--disable-prompt-on-repost \
--disable-renderer-backgrounding \
--disable-updater-scheduler \
--force-color-profile=srgb \
--metrics-recording-only \
--no-first-run \
--password-store=basic \
--use-mock-keychain \
--no-service-autorun \
--export-tagged-pdf \
--disable-search-engine-choice-screen \
--unsafely-disable-devtools-self-xss-warnings \
--edge-skip-compat-layer-relaunch \
--disable-infobars \
--disable-sync \
--enable-unsafe-swiftshader"

# The X DISPLAY: started and owned HERE in headful mode. Readiness is the X
# socket, not a sleep: chromium refuses to start against a display that is not
# there yet, and a container that half-started must never look healthy.
if [ -z "$HEADLESS" ]; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    fail_loudly "Xvfb is not installed in this image: a headful chromium needs an X server (set BROWSER_HEADLESS=1 to run headless instead)"
  fi
  export DISPLAY="$DISPLAY_NAME"
  XNUM="${DISPLAY_NAME#:}"
  XNUM="${XNUM%%.*}"
  XSOCK="/tmp/.X11-unix/X${XNUM}"
  XLOCK="/tmp/.X${XNUM}-lock"
  # A RESTARTED container keeps its /tmp: the previous Xvfb is gone but its lock
  # file survives, and Xvfb then REFUSES to start ("Server is already active for
  # display :99", exit 1) so the browser never comes up - a container that looks
  # alive and answers nothing. This script starts the ONLY Xvfb in the container
  # and runs once per container start, so a lock file with no live Xvfb behind it
  # is always stale: clear it. `pgrep` may be absent; then the socket check below
  # still decides, only the stale lock is left alone.
  if [ -e "$XLOCK" ] && ! pgrep -x Xvfb >/dev/null 2>&1; then
    rm -f "$XLOCK"
  fi
  rm -f "$XSOCK" 2>/dev/null || true
  Xvfb "$DISPLAY_NAME" -screen 0 "$SCREEN" -nolisten tcp >>"$LOG" 2>&1 &
  XVFB_PID=$!
  xwaited=0
  while [ "$xwaited" -lt "$WAIT_SECONDS" ]; do
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
      fail_loudly "Xvfb exited during startup"
    fi
    if [ -S "$XSOCK" ]; then break; fi
    sleep 1
    xwaited=$((xwaited + 1))
  done
  if [ ! -S "$XSOCK" ]; then
    fail_loudly "no X display on $DISPLAY_NAME (socket $XSOCK) within ${WAIT_SECONDS}s"
  fi
  MODE="headful on $DISPLAY_NAME ($SCREEN), window $WINDOW_SIZE"
  # NO GPU-DISABLING FLAG. `--disable-gpu` (and `--use-gl=disabled`) leave the
  # browser with NO WebGL renderer at all: `canvas.getContext('webgl')` returns a
  # context whose UNMASKED_RENDERER_WEBGL is null, which is not what an ordinary
  # desktop browser exposes on a machine that has any GL stack. This container
  # has no GPU, so ANGLE falls back to software rendering on this display;
  # `--enable-unsafe-swiftshader` only ALLOWS that fallback (recent chromium
  # refuses software WebGL without it) and is inert where real GL exists.
  LAUNCH_ARGS="$STOCK_FLAGS --window-size=$WINDOW_SIZE --user-data-dir=$PROFILE_DIR"
else
  MODE="headless (--headless=new, BROWSER_HEADLESS=1)"
  LAUNCH_ARGS="$STOCK_FLAGS --headless=new --window-size=$WINDOW_SIZE --user-data-dir=$PROFILE_DIR"
fi

echo "start-browser: mode=$MODE, chromium $BIN ($($BIN --version 2>/dev/null || echo version-unknown)) on 127.0.0.1:$INTERNAL_PORT, CDP forwarded on 0.0.0.0:$PORT"

# shellcheck disable=SC2086
"$BIN" \
  $LAUNCH_ARGS \
  --no-sandbox \
  --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$INTERNAL_PORT" \
  ${BROWSER_EXTRA_ARGS:-} \
  about:blank >>"$LOG" 2>&1 &
CHROME_PID=$!

CDP_LISTEN_HOST=0.0.0.0 CDP_LISTEN_PORT="$PORT" \
CDP_UPSTREAM_HOST=127.0.0.1 CDP_UPSTREAM_PORT="$INTERNAL_PORT" \
  node "$FORWARDER" >>"$LOG" 2>&1 &
FWD_PID=$!

waited=0
while [ "$waited" -lt "$WAIT_SECONDS" ]; do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    fail_loudly "chromium exited during startup"
  fi
  if ! kill -0 "$FWD_PID" 2>/dev/null; then
    fail_loudly "the CDP forwarder exited during startup"
  fi
  if cdp_answers "$PORT"; then
    echo "start-browser: CDP endpoint answering on 0.0.0.0:$PORT (after ${waited}s)"
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if ! cdp_answers "$PORT"; then
  fail_loudly "no answer on 127.0.0.1:$PORT within ${WAIT_SECONDS}s"
fi

# ---------------------------------------------------------------------------
# THE LIVE VIEW, ON THE SAME DISPLAY the agent's chromium draws on. These functions are
# used from BOTH entry points - the boot-time opt-in (BROWSER_VNC=1) and the runtime
# switch - so both start and stop the very same processes on the very same display.
VNC_ERR=""

vnc_is_up() {
  [ -n "$VNC_PID" ] && [ -n "$WS_PID" ] || return 1
  kill -0 "$VNC_PID" 2>/dev/null || return 1
  kill -0 "$WS_PID" 2>/dev/null || return 1
  novnc_answers "$NOVNC_PORT" || return 1
  tcp_open "$VNC_PORT" || return 1
  return 0
}

# Start x11vnc (attached to $DISPLAY_NAME, LOOPBACK only, NO PASSWORD: `-nopw`, because
# the access-control boundary is the tunnel and its own access policy (OTP), see
# browser/README.md) and websockify (the WebSocket bridge serving noVNC on the container
# network). 0 = both endpoints answer; 1 = failed, nothing left running, $VNC_ERR says why.
start_vnc() {
  VNC_ERR=""
  if [ -z "$VNC_READY" ]; then
    VNC_ERR="the live view is incomplete: x11vnc / websockify / $NOVNC_WEB/vnc.html missing from this image"
    return 1
  fi
  if [ -n "$HEADLESS" ]; then
    VNC_ERR="the live view needs the X display a headful browser draws on, and this container runs headless (BROWSER_HEADLESS=1): there is nothing to stream"
    return 1
  fi
  x11vnc -display "$DISPLAY_NAME" -forever -shared -localhost -nopw \
    -rfbport "$VNC_PORT" >>"$LOG" 2>&1 &
  VNC_PID=$!
  websockify --web="$NOVNC_WEB" "0.0.0.0:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >>"$LOG" 2>&1 &
  WS_PID=$!
  vwaited=0
  while [ "$vwaited" -lt "$WAIT_SECONDS" ]; do
    if ! kill -0 "$VNC_PID" 2>/dev/null; then
      VNC_ERR="x11vnc exited during startup (see $LOG)"
      stop_vnc
      return 1
    fi
    if ! kill -0 "$WS_PID" 2>/dev/null; then
      VNC_ERR="websockify exited during startup (see $LOG)"
      stop_vnc
      return 1
    fi
    if novnc_answers "$NOVNC_PORT" && tcp_open "$VNC_PORT"; then
      return 0
    fi
    sleep 1
    vwaited=$((vwaited + 1))
  done
  VNC_ERR="no answer on 127.0.0.1:$NOVNC_PORT (noVNC) within ${WAIT_SECONDS}s"
  stop_vnc
  return 1
}

# Stop both and WAIT until the ports are really closed again: "stopped" must mean the
# listeners are gone, not that a signal was sent.
stop_vnc() {
  if [ -n "$WS_PID" ]; then kill -TERM "$WS_PID" 2>/dev/null || true; fi
  if [ -n "$VNC_PID" ]; then kill -TERM "$VNC_PID" 2>/dev/null || true; fi
  closed_after=0
  while [ "$closed_after" -lt 15 ]; do
    if ! tcp_open "$VNC_PORT" && ! tcp_open "$NOVNC_PORT"; then
      WS_PID=""
      VNC_PID=""
      return 0
    fi
    if [ "$closed_after" = "5" ]; then
      if [ -n "$WS_PID" ]; then kill -KILL "$WS_PID" 2>/dev/null || true; fi
      if [ -n "$VNC_PID" ]; then kill -KILL "$VNC_PID" 2>/dev/null || true; fi
    fi
    sleep 1
    closed_after=$((closed_after + 1))
  done
  WS_PID=""
  VNC_PID=""
  return 1
}

# Answer the client that asked (see the runtime switch above); written atomically so a
# client can never read a half-written line.
vnc_respond() { # $1 = ok|error, $2 = request id, $3 = message
  printf '%s %s %s\n' "$1" "$2" "$3" >"$VNC_RSP.tmp.$$"
  mv "$VNC_RSP.tmp.$$" "$VNC_RSP"
}

# ONE pending request per supervise iteration. The supervisor stays the ONLY owner of
# x11vnc/websockify (they are its children and it keeps checking them), while a `docker
# exec` switch can turn the stream on and off around a captcha.
vnc_handle_request() {
  [ -f "$VNC_REQ" ] || return 0
  req_verb=""
  req_id=""
  req_extra=""
  read req_verb req_id req_extra <"$VNC_REQ" || true
  rm -f "$VNC_REQ"
  [ -n "${req_verb:-}" ] || return 0
  [ -n "${req_id:-}" ] || req_id="-"
  case "$req_verb" in
    start)
      if vnc_is_up; then
        vnc_respond ok "$req_id" "live view already up: noVNC 0.0.0.0:$NOVNC_PORT -> x11vnc 127.0.0.1:$VNC_PORT on $DISPLAY_NAME (no password)"
      elif start_vnc; then
        vnc_respond ok "$req_id" "live view UP: noVNC 0.0.0.0:$NOVNC_PORT -> x11vnc 127.0.0.1:$VNC_PORT on $DISPLAY_NAME (loopback RFB, -nopw)"
      else
        vnc_respond error "$req_id" "$VNC_ERR"
      fi
      ;;
    stop)
      if [ -z "$VNC_PID" ] && [ -z "$WS_PID" ] && ! tcp_open "$VNC_PORT" && ! tcp_open "$NOVNC_PORT"; then
        vnc_respond ok "$req_id" "live view already stopped: nothing listens on $VNC_PORT (RFB) nor $NOVNC_PORT (noVNC)"
      elif stop_vnc; then
        vnc_respond ok "$req_id" "live view STOPPED: nothing listens on $VNC_PORT (RFB) nor $NOVNC_PORT (noVNC)"
      else
        vnc_respond error "$req_id" "the live view did not release $VNC_PORT/$NOVNC_PORT within 15s"
      fi
      ;;
    status)
      if vnc_is_up; then
        vnc_respond ok "$req_id" "live view up: noVNC 0.0.0.0:$NOVNC_PORT, x11vnc 127.0.0.1:$VNC_PORT on $DISPLAY_NAME"
      else
        vnc_respond ok "$req_id" "live view down"
      fi
      ;;
    *)
      vnc_respond error "$req_id" "unknown live-view request '$req_verb' (start|stop|status)"
      ;;
  esac
  return 0
}

# THE CONTROL CHANNEL exists exactly as long as the supervisor does, so a client that
# finds no channel knows the service is not up (never a silent success).
mkdir -p "$VNC_CTL_DIR"
rm -f "$VNC_REQ" "$VNC_RSP" "$VNC_RSP.tmp.$$"

if [ -n "$VNC_ENABLED" ]; then
  if start_vnc; then
    echo "start-browser: live view on 0.0.0.0:$NOVNC_PORT (noVNC) -> 127.0.0.1:$VNC_PORT (x11vnc on $DISPLAY_NAME, -nopw, loopback only; the operator's tunnel and its own access policy are the boundary)"
  else
    fail_loudly "$VNC_ERR"
  fi
fi
echo "start-browser: the live view is ON DEMAND: start-browser vnc-start | vnc-stop | vnc-status (control channel $VNC_CTL_DIR)"

# Foreground (the container entrypoint): supervise the browser children AND answer the
# live-view switch. The BROWSER dying is fatal - a half-dead browser service must not
# look healthy. The LIVE VIEW is an ON-DEMAND accessory: if it dies while up it is
# reported DOWN (and can be started again with `start-browser vnc-start`) instead of
# taking the agent's browser session down with it.
while kill -0 "$CHROME_PID" 2>/dev/null && kill -0 "$FWD_PID" 2>/dev/null; do
  vnc_handle_request
  if [ -n "$XVFB_PID" ] && ! kill -0 "$XVFB_PID" 2>/dev/null; then
    fail_loudly "Xvfb exited"
  fi
  if [ -n "$VNC_PID" ] && ! kill -0 "$VNC_PID" 2>/dev/null; then
    echo "start-browser: x11vnc exited - live view DOWN (start it again with: start-browser vnc-start)" >&2
    VNC_PID=""
    if [ -n "$WS_PID" ]; then kill -TERM "$WS_PID" 2>/dev/null || true; WS_PID=""; fi
  fi
  if [ -n "$WS_PID" ] && ! kill -0 "$WS_PID" 2>/dev/null; then
    echo "start-browser: websockify exited - live view DOWN (start it again with: start-browser vnc-start)" >&2
    WS_PID=""
    if [ -n "$VNC_PID" ]; then kill -TERM "$VNC_PID" 2>/dev/null || true; VNC_PID=""; fi
  fi
  sleep 5
done
fail_loudly "a child process exited"
