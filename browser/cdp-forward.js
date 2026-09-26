#!/usr/bin/env node
// The CDP FORWARDER of the browser service image.
//
// WHY THIS EXISTS: chromium binds its DevTools HTTP/WebSocket server to the
// LOOPBACK address only. `--remote-debugging-address=0.0.0.0` is IGNORED by
// current builds - verified on the Chromium 153 shipped in
// `mcr.microsoft.com/playwright:v1.63.0-noble`: with and without
// `--user-data-dir`, `/proc/net/tcp` shows a single listener on
// `127.0.0.1:<port>` (0100007F), and a connection to the container's own IP is
// refused. A browser SERVICE whose CDP endpoint only answers on its own loopback
// is useless to a deployment: the consumer (the workbench core, or anything else
// driving the browser) runs in ANOTHER container and reaches this one by IP /
// published port.
//
// So the image runs chromium on a loopback port and THIS process on
// 0.0.0.0:<BROWSER_CDP_PORT>, piping every accepted connection to chromium. It is
// a raw TCP proxy: both the CDP HTTP endpoints (/json/version, /json/list, ...)
// and the WebSocket upgrade travel through it unchanged, and it holds no CDP
// knowledge whatsoever.
//
//   CDP_LISTEN_HOST    default 0.0.0.0
//   CDP_LISTEN_PORT    default 9222
//   CDP_UPSTREAM_HOST  default 127.0.0.1
//   CDP_UPSTREAM_PORT  default = CDP_LISTEN_PORT
//
// Started (and supervised) by `start-browser`. Nothing here knows about workbench.
'use strict';

const net = require('net');

const listenHost = process.env.CDP_LISTEN_HOST || '0.0.0.0';
const upstreamHost = process.env.CDP_UPSTREAM_HOST || '127.0.0.1';
const listenPort = Number(process.env.CDP_LISTEN_PORT || 9222);
const upstreamPort = Number(process.env.CDP_UPSTREAM_PORT || listenPort);

if (!Number.isInteger(listenPort) || listenPort <= 0 || !Number.isInteger(upstreamPort) || upstreamPort <= 0) {
  console.error(`cdp-forward: invalid port configuration (listen=${process.env.CDP_LISTEN_PORT}, upstream=${process.env.CDP_UPSTREAM_PORT})`);
  process.exit(2);
}
if (listenHost === upstreamHost && listenPort === upstreamPort) {
  // A forwarder to itself would accept connections forever and never reach a
  // browser: refuse instead of pretending to serve CDP.
  console.error(`cdp-forward: listen and upstream are the same endpoint (${listenHost}:${listenPort})`);
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: upstreamHost, port: upstreamPort });
  // Errors on either side tear the PAIR down: a half-open pipe would look like a
  // hung CDP client instead of a failure.
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (err) => {
  console.error(`cdp-forward: ${err.message}`);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  console.error(`cdp-forward: ${listenHost}:${listenPort} -> ${upstreamHost}:${upstreamPort}`);
});
