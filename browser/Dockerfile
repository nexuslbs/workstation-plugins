# The BROWSER SERVICE image of the workbench project - a SEPARATE image from the
# workbench core image (`ghcr.io/nexuslbs/workbench`).
#
# Operator decision (2026-09-20): "the browser image is a separate image, not the
# workbench image. It could be accessible using GeneralService". The core image
# ships NO browser; a deployment runs THIS image (or the upstream
# `mcr.microsoft.com/playwright` it is built FROM) and points the
# `browser-use-playwright` provider at it with `browserService.endpoint`.
#
# It contains NO workbench code and NO workbench dependency: chromium, a raw TCP
# forwarder that publishes chromium's loopback CDP endpoint on 0.0.0.0, a live-view
# (x11vnc + websockify + noVNC) that is OFF unless a deployment asks for it, and a
# tiny entrypoint (start-browser / cdp-forward.js).
#
# Published from THIS repository (nexuslbs/workstation-plugins) by
# `.github/workflows/browser-publish.yml` on a `browser-*` tag as
# `ghcr.io/nexuslbs/workstation-plugins/browser:<version>`.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# The port CALLERS use (bound 0.0.0.0 by cdp-forward.js) and the port chromium
# itself listens on (loopback only - see cdp-forward.js for why the forwarder is
# required, not optional).
ENV BROWSER_CDP_PORT=9222
ENV BROWSER_CDP_INTERNAL_PORT=9223

# THE LAUNCH MODE of the deployed browser: `0` (the default) is a REAL HEADFUL
# chromium on the Xvfb display the entrypoint starts, which is what an origin
# that checks for a real browser serves; `1` is the old `--headless=new` launch, an
# explicit opt-in (see start-browser.sh for the measurement behind this default).
# BROWSER_DISPLAY / BROWSER_SCREEN / BROWSER_WINDOW_SIZE shape the Xvfb display.
ENV BROWSER_HEADLESS=0
ENV BROWSER_DISPLAY=:99
ENV BROWSER_SCREEN=1440x1000x24
ENV BROWSER_WINDOW_SIZE=1440,1000

# THE LIVE VIEW: the operator watches and drives THE SAME chromium the agent uses
# (telegram 2026-09-21, thread 2785), i.e. chromium -> X display :99 -> x11vnc ->
# websockify + noVNC -> a tunnel -> a phone browser. It is OFF by
# default (`BROWSER_VNC=0`): a deployment that does not opt in runs exactly the
# processes it ran before. See browser/README.md for the full env contract and the
# security note (noVNC = full remote control of this container, so the published
# hostname needs the tunnel's own access policy, or an unguessable path).
ENV BROWSER_VNC=0
ENV BROWSER_VNC_PORT=5900
ENV BROWSER_NOVNC_PORT=8080
ENV BROWSER_NOVNC_WEB=/usr/share/novnc

COPY start-browser.sh /usr/local/bin/start-browser
COPY cdp-forward.js /usr/local/bin/cdp-forward.js
RUN chmod 0755 /usr/local/bin/start-browser /usr/local/bin/cdp-forward.js

# A headful default needs an X server and a JS runtime: Xvfb is what the
# entrypoint starts, node runs the CDP forwarder and the readiness probes. Fail
# the BUILD when a base-image change removes either, instead of a runtime that
# cannot start.
RUN command -v Xvfb >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || { echo "the base image must ship Xvfb (headful default) and node (CDP forwarder)" >&2; exit 1; }

# ---------------------------------------------------------------------------
# THE LIVE-VIEW PACKAGES (apt, from the distribution the base image pins).
#
#   x11vnc          the VNC server that attaches to the EXISTING X display the
#                   agent's chromium draws on - a real pointer/keyboard, so the
#                   human can click, type, scroll and drag in the agent's browser
#   websockify      the TCP<->WebSocket bridge that serves noVNC and proxies to
#                   x11vnc's RFB port (noVNC cannot speak raw TCP from a browser)
#   novnc           the static noVNC client under /usr/share/novnc (vnc.html)
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      x11vnc \
      novnc \
      websockify \
 && rm -rf /var/lib/apt/lists/*

# FAIL THE BUILD when a base-image/package change drops a live-view piece: a
# container that starts and silently has no live view is worse than a failed
# build.
RUN command -v x11vnc >/dev/null 2>&1 \
 && command -v websockify >/dev/null 2>&1 \
 && [ -f "$BROWSER_NOVNC_WEB/vnc.html" ] \
 || { echo "the live view needs x11vnc + websockify + $BROWSER_NOVNC_WEB/vnc.html (BROWSER_VNC=1 deployments would start with no live view)" >&2; exit 1; }

# PHONE-FRIENDLY DEFAULT PAGE. The noVNC client is `vnc.html`, and its mobile-usable
# defaults are URL parameters, which nobody types on a phone: autoconnect (no
# "Connect" prompt), resize=scale (the 1440x1000 screen FITS the phone viewport
# instead of forcing the human to pan a desktop-sized framebuffer), and a view-only
# default of OFF (the point is to be able to solve a captcha). `/` therefore lands
# on the same client with those parameters already set. There is NO password of ours
# (x11vnc runs `-nopw`), so the page asks for none: the access policy in front of
# the tunnel hostname is the boundary, not an RFB password. `quality=` and
# `compression=` are deliberately NOT set either (see browser/README.md): the noVNC
# client's own defaults are the mobile-data stance, and a human can still raise the
# quality for one session through the URL.
RUN printf '%s\n' \
    '<!doctype html>' \
    '<html lang="en"><head><meta charset="utf-8">' \
    '<meta name="viewport" content="width=device-width, initial-scale=1">' \
    '<title>workbench browser live view</title>' \
    '<meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1">' \
    '</head><body>' \
    '<p>Opening the live view of the browser the agent drives... ' \
    '<a href="vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1">continue</a></p>' \
    '</body></html>' \
    > "$BROWSER_NOVNC_WEB/index.html" \
 && chmod 0644 "$BROWSER_NOVNC_WEB/index.html" \
 && grep -q 'autoconnect=1' "$BROWSER_NOVNC_WEB/index.html"

# 9222 = CDP (what the workbench provider attaches to);
# 8080 = the noVNC page, ON THE CONTAINER NETWORK ONLY. A deployment publishes it
#        through its own tunnel (which reaches `browser:8080` by service name);
#        never publish it to the open internet directly.
EXPOSE 9222 8080
ENTRYPOINT ["/usr/local/bin/start-browser"]
