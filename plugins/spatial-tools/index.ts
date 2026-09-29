// plugins/spatial-tools - thin, keyless client of the `gods-eye-view` service.
//
// The service is a SEPARATE container (operator rule: an external service never
// boots inside the workstation image). This plugin is a pure HTTP GET client of
// its already-normalized JSON routes; it holds no GEV code and no credential.
//
// Contract (v1, exactly four tools):
//   * every tool is read-only GET, no POST, no recognition, no persistence;
//   * every answer carries a `source` block: upstream route + HTTP status +
//     `fetchedAt` (+ the honesty headers of the answering upstream, verbatim);
//   * upstream honesty fields (`stale`, `unavailable`, `reason`, `degraded`) are
//     surfaced verbatim inside `data`, never classified;
//   * an upstream/server error answers `{error, status, body, source}` with the
//     RAW upstream status and body - no keyword mapping, no invented reason;
//   * `config.baseUrl` is REQUIRED and has NO default: `apply` throws when it is
//     unset, so a misconfigured row fails loudly instead of probing a guess.
//
// MODEL-FACING NAMES: the research plan labels the tools `spatial status`,
// `spatial events`, `spatial contacts`, `spatial cameras`, but the model provider
// rejects a model-facing tool name outside `^[a-zA-Z0-9_-]+$` (`Invalid
// 'tools[0].name'`) - see `tests/worker-facing-tool-names.test.mjs`, whose stated
// purpose is that "a regression that reintroduces a space-named tool fails here
// instead of crashing every dispatched worker at boot". Live evidence: the
// running workstation's `GET /api/tools` lists only snake_case names. This plugin
// therefore registers the four legal snake_case names; the plan's space-named
// labels are the human descriptions only.
//
// Deliberately NOT here (see the research plan §6.2): the Google/Cesium visual
// layer, the imagery CLI tools, the OpenAI voice path, routing/geocoding, and any
// camera frame fetch. `spatial_cameras` reads the catalog metadata only.

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'spatial-tools'

export interface Config {
  /** Base URL of the gods-eye-view service, e.g. `http://gods-eye-view:4173`. REQUIRED. */
  baseUrl?: string
  /** Per-request timeout in ms (default 45000, clamped to 1000..120000). */
  timeoutMs?: number
  /** Cap on the per-aircraft track lookups a `trace=true` call makes (default 3). */
  maxTraceContacts?: number
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
  effect(callback: () => () => void): void
}

/** The minimal fetch surface this plugin uses. A test seam; defaults to global fetch. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export interface Deps {
  fetchImpl?: FetchLike
}

const DEFAULT_TIMEOUT_MS = 45_000
const MAX_RADIUS_NM = 250
const DEFAULT_RADIUS_NM = 250
const DEFAULT_RADIUS_KM = 50
const DEFAULT_MAX_TRACE_CONTACTS = 3
const EARTH_RADIUS_NM = 3440.065
const CONFIG_HINT =
  'set config.baseUrl on the spatial-tools row, e.g. '
  + '{"insert":[{"id":"spatial-tools","name":".../plugins/spatial-tools/index.ts","config":{"baseUrl":"http://gods-eye-view:4173"}}]}'

/** The upstream routes this plugin wraps (pinned SHA; see the image README). */
const ROUTES = {
  status: '/api/setup/status',
  cyclones: '/api/cyclones',
  fires: '/api/fire-perimeters',
  launches: '/api/launches',
  opensky: '/api/opensky',
  openskyTrack: '/api/opensky-track',
  military: '/api/adsblol/mil',
  vessels: '/api/ais-live',
  cameras: '/api/cctv/sources',
} as const

/**
 * The upstream cache/honesty headers worth surfacing verbatim. They are how the
 * app reports WHICH upstream answered (OpenSky vs the adsb.lol 250 nm fallback)
 * and whether the body is fresh, cached or stale - the provenance the plan asks
 * for, without a derived verdict.
 */
const HONESTY_HEADERS = [
  'content-type',
  'x-opensky-cache',
  'x-opensky-auth',
  'x-opensky-auth-mode-requested',
  'x-opensky-auth-mode-used',
  'x-opensky-auth-reason',
  'x-opensky-stale-seconds',
  'x-opensky-retry-after-seconds',
  'x-flight-source',
  'x-flight-coverage',
  'x-flight-count',
  'x-ads-b-cache',
  'x-ads-b-cache-age-ms',
  'x-ads-b-upstream-status',
  'x-ads-b-retry-after-seconds',
] as const

/** A required configuration value is missing or unusable. */
class SpatialConfigError extends Error {}

/** Read `config.baseUrl`, or throw a loud configuration error (never a default URL). */
function requireBaseUrl(config: Config): string {
  const raw = config.baseUrl
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value.length === 0) throw new SpatialConfigError(`spatial-tools: config.baseUrl is required; ${CONFIG_HINT}`)
  try {
    return new URL(value).toString()
  } catch {
    throw new SpatialConfigError(`spatial-tools: config.baseUrl must be an absolute http(s) URL, got ${JSON.stringify(value)}`)
  }
}

/** The request timeout, clamped to a sane range. */
function timeoutOf(config: Config): number {
  const value = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return Number.isFinite(value) && value >= 1_000 && value <= 120_000 ? Math.trunc(value) : DEFAULT_TIMEOUT_MS
}

interface FetchResult {
  route: string
  url: string
  status: number
  fetchedAt: string
  headers: { get(name: string): string | null }
  body: unknown
}

interface FetchFailure {
  route: string
  url: string
  status: number | null
  fetchedAt: string
  headers?: { get(name: string): string | null }
  error: string
  body: unknown
}

type FetchOutcome = { ok: true; result: FetchResult } | { ok: false; failure: FetchFailure }

/** Build one GET URL from a base and a route + query (the base never carries a path). */
function buildUrl(baseUrl: string, route: string, query: Record<string, string | number | undefined>): string {
  const url = new URL(route.replace(/^\/+/, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** The provenance block every answer carries (route + HTTP status + fetchedAt + honesty headers). */
function sourceBlock(route: string, url: string, status: number | null, fetchedAt: string, headers?: { get(name: string): string | null }, body?: unknown): Record<string, unknown> {
  const source: Record<string, unknown> = { route, url, status, fetchedAt }
  if (headers) {
    const captured: Record<string, string> = {}
    for (const header of HONESTY_HEADERS) {
      const value = headers.get(header)
      if (value !== null) captured[header] = value
    }
    if (Object.keys(captured).length > 0) source.headers = captured
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const upstreamFetchedAt = (body as Record<string, unknown>).fetchedAt
    if (upstreamFetchedAt !== undefined && upstreamFetchedAt !== null) source.upstreamFetchedAt = upstreamFetchedAt
  }
  return source
}

/** One GET, JSON-parsed when possible. Never throws: network errors are outcomes. */
async function fetchRoute(
  baseUrl: string,
  route: string,
  query: Record<string, string | number | undefined>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const url = buildUrl(baseUrl, route, query)
  const fetchedAt = new Date().toISOString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* a non-JSON body is surfaced verbatim as text */
    }
    if (!response.ok) {
      return {
        ok: false,
        failure: {
          route,
          url,
          status: response.status,
          fetchedAt,
          headers: response.headers,
          error: `spatial-tools: ${route} returned HTTP ${String(response.status)}`,
          body,
        },
      }
    }
    return { ok: true, result: { route, url, status: response.status, fetchedAt, headers: response.headers, body } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: { route, url, status: null, fetchedAt, error: `spatial-tools: GET ${url} failed: ${message}`, body: null },
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The `{error, status, body}` shape for a failed upstream GET, plus provenance. */
function failureAnswer(failure: FetchFailure): Record<string, unknown> {
  return {
    ok: false,
    error: failure.error,
    status: failure.status,
    body: failure.body,
    source: sourceBlock(failure.route, failure.url, failure.status, failure.fetchedAt, failure.headers),
  }
}

/** The `{error, status, body}` shape for a local (config/parameter) error. */
function localError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const isConfig = error instanceof SpatialConfigError
  return {
    ok: false,
    error: message,
    status: null,
    body: isConfig ? { config: CONFIG_HINT } : null,
    ...(isConfig ? {} : { source: null }),
  }
}

/** Verbatim honesty fields of a normalized upstream payload. */
function honestyFields(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ['source', 'attribution', 'coverage', 'fetchedAt', 'stale', 'unavailable', 'reason', 'degraded', 'degradedReason']) {
    if (key in record) out[key] = record[key]
  }
  return out
}

/** A finite number parameter, or undefined. */
function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Latitude/longitude from params, or a local error when missing/invalid. */
function latLon(params: Record<string, unknown>): { lat: number; lon: number } {
  const lat = numberParam(params, 'lat')
  const lon = numberParam(params, 'lon')
  if (lat === undefined || lat < -90 || lat > 90) throw new SpatialConfigError("spatial-tools: 'lat' must be a number in [-90, 90]")
  if (lon === undefined || lon < -180 || lon > 180) throw new SpatialConfigError("spatial-tools: 'lon' must be a number in [-180, 180]")
  return { lat, lon }
}

/** Great-circle distance in km (haversine). */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Every coordinate found anywhere in a record, as [lon, lat]. */
function coordinatesIn(value: unknown, out: Array<[number, number]>, depth = 0): void {
  if (value === null || value === undefined || depth > 12) return
  if (Array.isArray(value)) {
    if (
      value.length >= 2
      && typeof value[0] === 'number' && typeof value[1] === 'number'
      && value[0] >= -180 && value[0] <= 180
      && value[1] >= -90 && value[1] <= 90
    ) {
      out.push([value[0], value[1]])
      return
    }
    for (const item of value) coordinatesIn(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const lat = [record.lat, record.latitude].find((candidate) => typeof candidate === 'number') as number | undefined
    const lon = [record.lon, record.longitude].find((candidate) => typeof candidate === 'number') as number | undefined
    if (lat !== undefined && lon !== undefined) {
      out.push([lon, lat])
      return
    }
    for (const nested of Object.values(record)) coordinatesIn(nested, out, depth + 1)
  }
}

/** Whether any coordinate in a record falls inside the bbox [minLon,minLat,maxLon,maxLat]. */
function inBbox(record: unknown, bbox: readonly number[]): boolean {
  const coords: Array<[number, number]> = []
  coordinatesIn(record, coords)
  return coords.some(([lon, lat]) => lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3])
}

/** A valid `[minLon,minLat,maxLon,maxLat]` bbox parameter, or undefined. */
function bboxParam(params: Record<string, unknown>): number[] | undefined {
  const value = params.bbox
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const numbers = value.map(Number)
  if (numbers.some((entry) => !Number.isFinite(entry))) return undefined
  return numbers
}

/** A bounded positive integer, or undefined. */
function limitParam(params: Record<string, unknown>): number | undefined {
  const value = numberParam(params, 'limit')
  if (value === undefined || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/** The primary record array of an events payload, by kind. */
const EVENT_LIST_KEY: Record<string, string> = { cyclones: 'storms', fires: 'rows', launches: 'results' }

/** The primary record array of a contacts payload, by kind (upstream records, untouched). */
function contactListOf(body: unknown, key: string): unknown[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return []
  const value = (body as Record<string, unknown>)[key]
  return Array.isArray(value) ? value : []
}

/** The position of a contacts record: an OpenSky state vector is [.., lon@5, lat@6, ..]. */
function contactCoord(record: unknown): { lat: number; lon: number } | null {
  if (Array.isArray(record)) {
    const lon = Number(record[5])
    const lat = Number(record[6])
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
  }
  if (record === null || typeof record !== 'object') return null
  const r = record as Record<string, unknown>
  const lat = [r.lat, r.latitude].find((candidate) => typeof candidate === 'number') as number | undefined
  const lon = [r.lon, r.longitude].find((candidate) => typeof candidate === 'number') as number | undefined
  return lat !== undefined && lon !== undefined ? { lat, lon } : null
}

/**
 * The human-labelled view of ONE aircraft record. The field names are the OpenSky
 * state-vector positions; the raw vector stays verbatim under `data.contacts`'s
 * sibling `data.states`, so nothing is remapped in the verbatim payload.
 */
function labelAircraft(record: unknown): Record<string, unknown> {
  if (!Array.isArray(record)) return record as Record<string, unknown>
  return {
    icao24: record[0],
    callsign: record[1],
    origin_country: record[2],
    lon: record[5],
    lat: record[6],
    baro_altitude: record[7],
    on_ground: record[8],
    velocity: record[9],
    true_track: record[10],
    position_source: record[16],
  }
}

/** Replace the primary list of a normalized body with a selected view, keeping every other field. */
function withList(body: unknown, key: string, view: unknown[]): unknown {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), [key]: view }
  }
  return view
}

export function apply(ctx: PluginContext, config: Config = {}, deps: Deps = {}): void {
  // Fail loudly at registration when the required URL is missing: no hardcoded
  // default, no silently broken tool. (The task's plan §6.2: "default NONE".)
  requireBaseUrl(config)
  const timeoutMs = timeoutOf(config)
  const maxTraceContacts = Number.isFinite(Number(config.maxTraceContacts)) && Number(config.maxTraceContacts) > 0
    ? Math.floor(Number(config.maxTraceContacts))
    : DEFAULT_MAX_TRACE_CONTACTS
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>)
  const get = (route: string, query: Record<string, string | number | undefined> = {}): Promise<FetchOutcome> =>
    fetchRoute(requireBaseUrl(config), route, query, fetchImpl, timeoutMs)

  // ── spatial_status ───────────────────────────────────────────────────────
  // The honesty tool: which optional keys are set (the service answers with the
  // key registry) plus a cheap liveness probe of /api/cyclones, whose
  // stale/unavailable/reason fields are surfaced verbatim.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'spatial_status',
    description:
      "God's Eye View service status (the plan's 'spatial status'): the /api/setup/status key registry (which optional upstream keys are set - all false in the keyless deployment) plus a liveness probe of /api/cyclones whose stale/unavailable/reason fields are surfaced verbatim. Call this first; if it fails, the spatial capability is down.",
    parameters: {},
    execute: async () => {
      try {
        const setup = await get(ROUTES.status)
        const liveness = await get(ROUTES.cyclones)
        const livenessBlock = liveness.ok
          ? { route: liveness.result.route, status: liveness.result.status, fetchedAt: liveness.result.fetchedAt, ...honestyFields(liveness.result.body) }
          : failureAnswer(liveness.failure)
        // If the liveness probe answers, the service IS up even when
        // /api/setup/status refuses this caller: upstream answers that route only
        // to the machine running the server (403 "Provider Settings answers only
        // the machine running the server"), so a sibling container gets the raw
        // 403. Surface it verbatim rather than failing the whole status call.
        if (!setup.ok && !liveness.ok) return { ...failureAnswer(setup.failure), liveness: livenessBlock }
        const answer: Record<string, unknown> = {
          ok: true,
          keys: setup.ok ? setup.result.body : null,
          liveness: livenessBlock,
          source: setup.ok
            ? sourceBlock(setup.result.route, setup.result.url, setup.result.status, setup.result.fetchedAt, setup.result.headers, setup.result.body)
            : liveness.ok
              ? sourceBlock(liveness.result.route, liveness.result.url, liveness.result.status, liveness.result.fetchedAt, liveness.result.headers, liveness.result.body)
              : null,
        }
        if (!setup.ok) {
          answer.setupError = {
            error: setup.failure.error,
            status: setup.failure.status,
            body: setup.failure.body,
            source: sourceBlock(setup.failure.route, setup.failure.url, setup.failure.status, setup.failure.fetchedAt, setup.failure.headers),
          }
        }
        return answer
      } catch (error) {
        return localError(error)
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── spatial_events ───────────────────────────────────────────────────────
  // kind -> the local normalized route. quakes has NO local route in the pinned
  // upstream (USGS is fetched client-side by the browser), so it answers a typed
  // error naming the upstream feed instead of inventing a route.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'spatial_events',
    description:
      "Reads the gods-eye-view normalized event layer for one kind: cyclones (/api/cyclones), fires (/api/fire-perimeters) or launches (/api/launches). The records are returned verbatim under `data`; optional bbox=[minLon,minLat,maxLon,maxLat] and limit SELECT a subset of the same verbatim records. There is no local /api route for earthquakes in the pinned upstream, so kind=quakes answers a typed error naming the USGS feed.",
    parameters: {
      kind: { type: 'string', required: true, description: 'which event layer: cyclones | fires | quakes | launches', enum: ['cyclones', 'fires', 'quakes', 'launches'] },
      bbox: { type: 'array', description: 'optional [minLon, minLat, maxLon, maxLat]; applied over the record coordinates (the upstream routes do not take bbox)' },
      limit: { type: 'integer', description: 'optional cap on the number of records returned' },
    },
    execute: async (params) => {
      try {
        const kind = String(params.kind ?? '')
        if (kind === 'quakes') {
          return {
            ok: false,
            error: 'spatial-tools: no local /api route for earthquakes in the pinned upstream; USGS is fetched client-side by the browser',
            status: null,
            body: { route: null, upstream: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson' },
            source: null,
          }
        }
        const route = kind === 'cyclones' ? ROUTES.cyclones : kind === 'fires' ? ROUTES.fires : kind === 'launches' ? ROUTES.launches : undefined
        if (route === undefined) {
          return { ok: false, error: `spatial-tools: unsupported kind ${JSON.stringify(kind)}`, status: null, body: { supported: ['cyclones', 'fires', 'quakes', 'launches'] }, source: null }
        }
        const outcome = await get(route)
        if (!outcome.ok) return failureAnswer(outcome.failure)
        const body = outcome.result.body as Record<string, unknown> | null
        const listKey = EVENT_LIST_KEY[kind]
        const list = body !== null && typeof body === 'object' && Array.isArray(body[listKey]) ? (body[listKey] as unknown[]) : []
        const bbox = bboxParam(params)
        const limit = limitParam(params)
        const filtered = bbox === undefined ? list : list.filter((record) => inBbox(record, bbox))
        const view = limit === undefined ? filtered : filtered.slice(0, limit)
        return {
          ok: true,
          kind,
          total: list.length,
          returned: view.length,
          bbox: bbox ?? null,
          limit: limit ?? null,
          data: withList(body, listKey, view),
          source: sourceBlock(outcome.result.route, outcome.result.url, outcome.result.status, outcome.result.fetchedAt, outcome.result.headers, body),
        }
      } catch (error) {
        return localError(error)
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── spatial_contacts ─────────────────────────────────────────────────────
  // Live aircraft / military / vessels near a point. The upstream records are
  // returned verbatim under `data` (`data` is the upstream body with its record
  // list replaced by the radius-selected records) plus a named `contacts` view.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'spatial_contacts',
    description:
      "Live contacts near a point from the gods-eye-view service: kind=aircraft (/api/opensky, anonymous; the lat/lon anchor also enables the bounded adsb.lol 250 nm fallback, whose provenance is reported in source), kind=military (/api/adsblol/mil, a global snapshot filtered to the radius) or kind=vessels (/api/ais-live, which keyless answers status=missing-key verbatim). radius_nm is capped at 250. trace=true adds /api/opensky-track for the nearest aircraft.",
    parameters: {
      lat: { type: 'number', required: true, description: 'latitude of the centre point, -90..90' },
      lon: { type: 'number', required: true, description: 'longitude of the centre point, -180..180' },
      radius_nm: { type: 'integer', description: `search radius in nautical miles (default ${String(DEFAULT_RADIUS_NM)}, hard max ${String(MAX_RADIUS_NM)})` },
      kind: { type: 'string', description: 'aircraft (default) | military | vessels', enum: ['aircraft', 'military', 'vessels'] },
      trace: { type: 'boolean', description: 'also fetch recent tracks for the nearest aircraft (aircraft only)' },
    },
    execute: async (params) => {
      try {
        const { lat, lon } = latLon(params)
        const kind = params.kind === 'military' || params.kind === 'vessels' ? String(params.kind) : 'aircraft'
        const requested = numberParam(params, 'radius_nm')
        const radiusNm = Math.min(MAX_RADIUS_NM, Math.max(1, Math.round(requested ?? DEFAULT_RADIUS_NM)))
        const route = kind === 'military' ? ROUTES.military : kind === 'vessels' ? ROUTES.vessels : ROUTES.opensky
        const query = kind === 'aircraft' ? { lat, lon } : {}
        const outcome = await get(route, query)
        if (!outcome.ok) return failureAnswer(outcome.failure)
        const body = outcome.result.body
        const listKey = kind === 'military' ? 'ac' : kind === 'vessels' ? 'rows' : 'states'
        const records = contactListOf(body, listKey)
        const nearby = records.filter((record) => {
          const coord = contactCoord(record)
          return coord !== null && distanceKm(lat, lon, coord.lat, coord.lon) <= radiusNm * 1.852
        })
        const result: Record<string, unknown> = {
          ok: true,
          kind,
          route: outcome.result.route,
          centre: { lat, lon },
          radius_nm: radiusNm,
          total: records.length,
          matched: nearby.length,
          // `data` keeps the upstream records VERBATIM (the list is the same
          // shape as upstream); `contacts` is the labelled view of the same records.
          data: withList(body, listKey, nearby),
          contacts: nearby.map((record) => (kind === 'aircraft' ? labelAircraft(record) : record)),
          source: sourceBlock(outcome.result.route, outcome.result.url, outcome.result.status, outcome.result.fetchedAt, outcome.result.headers, body),
        }
        if (params.trace === true && kind === 'aircraft') {
          const nearest = nearby
            .map((record) => {
              const coord = contactCoord(record)
              const labelled = labelAircraft(record)
              return { hex: String(labelled.icao24 ?? ''), distance_km: coord === null ? Number.POSITIVE_INFINITY : distanceKm(lat, lon, coord.lat, coord.lon) }
            })
            .filter((entry) => /^[0-9a-f]{6}$/i.test(entry.hex) && Number.isFinite(entry.distance_km))
            .sort((a, b) => a.distance_km - b.distance_km)
            .slice(0, maxTraceContacts)
          const tracks: Array<Record<string, unknown>> = []
          for (const entry of nearest) {
            const track = await get(ROUTES.openskyTrack, { icao24: entry.hex })
            tracks.push({
              icao24: entry.hex,
              distance_km: Math.round(entry.distance_km * 10) / 10,
              source: track.ok
                ? sourceBlock(track.result.route, track.result.url, track.result.status, track.result.fetchedAt, track.result.headers, track.result.body)
                : sourceBlock(track.failure.route, track.failure.url, track.failure.status, track.failure.fetchedAt, track.failure.headers),
              track: track.ok ? track.result.body : null,
              ...(track.ok ? {} : { error: track.failure.error, status: track.failure.status, body: track.failure.body }),
            })
          }
          result.tracks = tracks
        }
        return result
      } catch (error) {
        return localError(error)
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── spatial_cameras ──────────────────────────────────────────────────────
  // The public camera CATALOG for an area. Metadata only: no frame/stream URL is
  // fetched, nothing is stored and nothing is analysed (research plan §5.4).
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'spatial_cameras',
    description:
      "The public camera catalog near a point (/api/cctv/sources), metadata only: id, name, city, provider, lat/lon, feedType and licence, exactly as the service exposes them under `data`. catalog_only=true returns the whole catalog unfiltered. This tool never fetches, stores or analyses a frame, and does no recognition, ever.",
    parameters: {
      lat: { type: 'number', required: true, description: 'latitude of the centre point, -90..90' },
      lon: { type: 'number', required: true, description: 'longitude of the centre point, -180..180' },
      radius_km: { type: 'number', description: `search radius in km (default ${String(DEFAULT_RADIUS_KM)})` },
      catalog_only: { type: 'boolean', description: 'true = return the whole catalog unfiltered (default false: filter to radius_km)' },
    },
    execute: async (params) => {
      try {
        const { lat, lon } = latLon(params)
        const catalogOnly = params.catalog_only === true
        const radiusKm = Math.max(0.1, numberParam(params, 'radius_km') ?? DEFAULT_RADIUS_KM)
        const outcome = await get(ROUTES.cameras)
        if (!outcome.ok) return failureAnswer(outcome.failure)
        const body = outcome.result.body as Record<string, unknown> | null
        const sources = body !== null && typeof body === 'object' && Array.isArray(body.sources) ? (body.sources as Array<Record<string, unknown>>) : []
        const cameras = catalogOnly
          ? sources
          : sources.filter((source) => {
              const sLat = Number(source.lat)
              const sLon = Number(source.lon)
              return Number.isFinite(sLat) && Number.isFinite(sLon) && distanceKm(lat, lon, sLat, sLon) <= radiusKm
            })
        return {
          ok: true,
          route: outcome.result.route,
          centre: { lat, lon },
          radius_km: catalogOnly ? null : radiusKm,
          catalog_only: catalogOnly,
          frames_fetched: false,
          total: sources.length,
          matched: cameras.length,
          cameras,
          source: sourceBlock(outcome.result.route, outcome.result.url, outcome.result.status, outcome.result.fetchedAt, outcome.result.headers, body),
        }
      } catch (error) {
        return localError(error)
      }
    },
    output: { schema: {}, render: renderValue },
  })))
}

export default { name, inject: ['tools'], apply }
