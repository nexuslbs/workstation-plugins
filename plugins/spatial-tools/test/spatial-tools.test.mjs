// Regression test for the spatial-tools consumer (task T3, plan section 6.2).
//
//   node --test plugins/spatial-tools/test/spatial-tools.test.mjs
//
// It needs NO harness, NO model call, NO network and NO container: it applies the
// plugin against a fake tool registry and a stubbed fetch, then asserts the
// registered names are legal model-facing names and that each tool returns the
// required `source` block / verbatim honesty fields / raw error envelope.

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.ts'

const LEGAL = /^[a-zA-Z0-9_-]+$/
const EXPECTED = ['spatial_cameras', 'spatial_contacts', 'spatial_events', 'spatial_status'].sort()

/** Apply the plugin against a capturing registry, returning name -> tool. */
function register(config = { baseUrl: 'http://gev.test:4173', timeoutMs: 5000 }, deps = {}) {
  const tools = new Map()
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx, config, deps)
  return tools
}

/** A stub fetch that answers a route -> { status, body } table. */
function stubFetch(table) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const path = new URL(url).pathname
    const entry = table[path]
    if (entry === undefined) return { ok: false, status: 404, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'not found' }) }
    const bodyText = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body)
    return {
      ok: entry.status < 400,
      status: entry.status,
      headers: { get: (name) => entry.headers?.[name] ?? null },
      text: async () => bodyText,
    }
  }
  return { impl, calls }
}

test('registers EXACTLY the four legal snake_case tools', () => {
  const tools = register()
  assert.deepEqual([...tools.keys()].sort(), EXPECTED)
  for (const name of tools.keys()) assert.match(name, LEGAL, `'${name}' is not a legal model-facing tool name`)
})

test('refuses to register without config.baseUrl (fail loudly, no hardcoded URL)', () => {
  assert.throws(() => register({}), /baseUrl is required/)
  assert.throws(() => register({ baseUrl: '' }), /baseUrl is required/)
  assert.throws(() => register({ baseUrl: 'not a url' }), /absolute http\(s\) URL/)
})

test('spatial_status returns the key registry + liveness honesty fields, with a source block', async () => {
  const { impl } = stubFetch({
    '/api/setup/status': { status: 200, body: { keys: [], setCount: 0, total: 8 } },
    '/api/cyclones': { status: 200, body: { source: 'NOAA NHC / CPHC', fetchedAt: null, stale: true, unavailable: true, reason: 'Cyclone data unavailable', storms: [] } },
  })
  const tools = register(undefined, { fetchImpl: impl })
  const answer = await tools.get('spatial_status').execute({})
  assert.equal(answer.ok, true)
  assert.equal(answer.keys.setCount, 0)
  assert.equal(answer.liveness.stale, true)
  assert.equal(answer.liveness.reason, 'Cyclone data unavailable')
  assert.equal(answer.source.route, '/api/setup/status')
  assert.equal(answer.source.status, 200)
  assert.ok(answer.source.fetchedAt)
})

test('spatial_events selects a subset of verbatim records and surfaces total/returned', async () => {
  const { impl } = stubFetch({
    '/api/fire-perimeters': {
      status: 200,
      body: {
        fetchedAt: 1790724891492,
        rows: [
          { stableId: 'a', polygons: [[[[-122.5, 37.7]]]] },
          { stableId: 'b', polygons: [[[[-70.0, 42.0]]]] },
        ],
      },
    },
  })
  const tools = register(undefined, { fetchImpl: impl })
  const answer = await tools.get('spatial_events').execute({ kind: 'fires', bbox: [-123, 37, -122, 38], limit: 5 })
  assert.equal(answer.ok, true)
  assert.equal(answer.total, 2)
  assert.equal(answer.returned, 1)
  assert.equal(answer.data.rows[0].stableId, 'a')
  assert.equal(answer.source.route, '/api/fire-perimeters')
  assert.equal(answer.source.upstreamFetchedAt, 1790724891492)
})

test('spatial_events quakes is a typed absence (no invented route)', async () => {
  const tools = register()
  const answer = await tools.get('spatial_events').execute({ kind: 'quakes' })
  assert.equal(answer.ok, false)
  assert.equal(answer.status, null)
  assert.match(answer.error, /no local \/api route for earthquakes/)
})

test('spatial_contacts filters OpenSky state vectors to the radius and reports provenance headers', async () => {
  const { impl, calls } = stubFetch({
    '/api/opensky': {
      status: 200,
      headers: { 'x-flight-source': 'adsb.lol', 'x-opensky-auth-mode-used': 'anon' },
      body: { time: 1, states: [['abc123', 'X', 'US', 1, 1, -122.4, 37.8, 1000, false, 200, 90, 0, null, null, null, false, 0], ['def456', 'Y', 'US', 1, 1, -70.0, 42.0, 1000, false, 200, 90, 0, null, null, null, false, 0]] },
    },
    '/api/opensky-track': { status: 200, body: { icao24: 'abc123', path: [] } },
  })
  const tools = register(undefined, { fetchImpl: impl })
  const answer = await tools.get('spatial_contacts').execute({ lat: 37.8, lon: -122.4, radius_nm: 50, kind: 'aircraft', trace: true })
  assert.equal(answer.ok, true)
  assert.equal(answer.matched, 1)
  assert.equal(answer.data.states[0][0], 'abc123')
  assert.equal(answer.source.headers['x-flight-source'], 'adsb.lol')
  assert.equal(answer.tracks.length, 1)
  assert.equal(answer.tracks[0].icao24, 'abc123')
  assert.ok(calls.some((url) => url.includes('/api/opensky?lat=37.8&lon=-122.4')))
})

test('spatial_cameras returns an empty catalog without inventing entries and never fetches a frame', async () => {
  const { impl } = stubFetch({
    '/api/cctv/sources': { status: 200, body: { sources: [{ id: 'cam1', name: 'X', provider: 'austin', lat: 30.27, lon: -97.74, feedType: 'image', license: 'public' }] } },
  })
  const tools = register(undefined, { fetchImpl: impl })
  const answer = await tools.get('spatial_cameras').execute({ lat: 30.27, lon: -97.74, radius_km: 10 })
  assert.equal(answer.ok, true)
  assert.equal(answer.matched, 1)
  assert.equal(answer.frames_fetched, false)
  assert.equal(answer.cameras[0].id, 'cam1')
  assert.equal(answer.source.route, '/api/cctv/sources')
})

test('an upstream failure returns the RAW {error,status,body,source} envelope', async () => {
  const { impl } = stubFetch({
    '/api/cyclones': { status: 503, body: { stale: true, reason: 'upstream down' } },
  })
  const tools = register(undefined, { fetchImpl: impl })
  const answer = await tools.get('spatial_events').execute({ kind: 'cyclones' })
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 503)
  assert.deepEqual(answer.body, { stale: true, reason: 'upstream down' })
  assert.equal(answer.source.route, '/api/cyclones')
  assert.equal(answer.source.status, 503)
})
