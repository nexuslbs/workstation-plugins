// Network interception / API discovery for a session.
//
// While a session is open, every XHR/fetch response of its page is observed and
// deduplicated into a small ENDPOINT LIST (method + URL + content type), so the
// agent can see the JSON API behind the UI and then call it DIRECTLY
// (`read` with `api`) instead of re-rendering the DOM - the cheap path the
// thread-2415 design asks for.
//
// Hard rules, enforced here and not by convention:
//   * only SAME-ORIGIN requests (plus the configured allow-list) are recorded or
//     callable - an off-origin endpoint is counted as `blocked`, never listed;
//   * the list holds method/URL/content-type only: no request headers, no
//     cookies, no bodies, so a credential cannot leak through it;
//   * query parameters whose NAME looks like a secret (`token`, `key`,
//     `secret`, `password`, `auth`, `code`, `sid`) have their VALUE replaced by
//     `[redacted]` in the sample URL;
//   * the list is bounded (`maxEndpoints`); everything past the bound is counted.
export interface Endpoint {
  /** Stable ref of the list: `E1`, `E2`, ... (what `read {api: 'E1'}` takes). */
  id: string
  method: string
  /** The sample URL, with secret-looking query VALUES redacted. */
  url: string
  /** Path only (no query): the identity of the endpoint. */
  path: string
  /** A readable name derived from the path (last segment). */
  name: string
  contentType: string
  /** The status of the observation kept as the sample (undefined: still in flight). */
  status: number | undefined
  /** How many times this endpoint was observed. */
  hits: number
}

export interface ObservedRequest {
  method: string
  url: string
  /** playwright's resourceType ('xhr', 'fetch', 'document', ...). */
  resourceType?: string
  /** The response content-type, when known. */
  contentType?: string
  status?: number
}

export interface RecorderOptions {
  /** The site's own origin (always allowed). */
  origin: string
  /** Extra allowed origins (from the site/plugin config). */
  allowOrigins: string[]
  /** How many endpoints the list may hold. */
  max: number
  /** Resource types that count as API traffic (default xhr + fetch). */
  apiResourceTypes?: string[]
}

const DEFAULT_API_TYPES = ['xhr', 'fetch']
const SECRET_QUERY = /^(token|access_token|api_?key|key|secret|password|passwd|pwd|auth|authorization|code|sid|session|sessionid|jwt|sig|signature)$/i

/** The origin of a URL, or `undefined` when it is not a valid absolute URL. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** Same-origin OR explicitly allow-listed. */
export function originAllowed(url: string, origin: string, allowOrigins: readonly string[]): boolean {
  const target = originOf(url)
  if (target === undefined) return false
  return target === origin || allowOrigins.includes(target)
}

/** Remove the fragment and redact secret-looking query VALUES. */
export function sanitizeUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw.replace(/#.*$/, '')
  }
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY.test(key)) parsed.searchParams.set(key, '[redacted]')
  }
  return parsed.toString()
}

/** The readable name of an endpoint: its last non-empty path segment. */
export function nameOf(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
    return segments.length === 0 ? parsed.host : segments[segments.length - 1]
  } catch {
    return url
  }
}

/** The identity of an endpoint: method + path (query values never split it). */
export function endpointKey(method: string, url: string): string {
  try {
    const parsed = new URL(url)
    return `${method.toUpperCase()} ${parsed.pathname}`
  } catch {
    return `${method.toUpperCase()} ${url}`
  }
}

/** Bounded, deduplicated endpoint discovery for one session. */
export class EndpointRecorder {
  private readonly options: RecorderOptions
  private readonly byKey = new Map<string, Endpoint>()
  private readonly order: string[] = []
  private blockedCount = 0
  private droppedCount = 0

  constructor(options: RecorderOptions) {
    this.options = options
  }

  /** How many off-origin (not allow-listed) requests were seen and never listed. */
  get blocked(): number {
    return this.blockedCount
  }

  /** How many DISTINCT endpoints were past the bound and never listed. */
  get dropped(): number {
    return this.droppedCount
  }

  /** Observe one request/response. Returns the (new or updated) endpoint. */
  observe(request: ObservedRequest): Endpoint | undefined {
    const types = this.options.apiResourceTypes ?? DEFAULT_API_TYPES
    const isApi = request.resourceType === undefined || types.includes(request.resourceType)
    if (!isApi) return undefined
    if (!originAllowed(request.url, this.options.origin, this.options.allowOrigins)) {
      this.blockedCount += 1
      return undefined
    }
    const contentType = request.contentType ?? ''
    const looksJson = /json/i.test(contentType)
    // An xhr/fetch with a non-JSON content type is still listed (an endpoint the
    // UI uses is worth knowing); a DOCUMENT request with a non-JSON type is not.
    if (request.resourceType === undefined && !looksJson) return undefined
    const method = (request.method ?? 'GET').toUpperCase()
    const key = endpointKey(method, request.url)
    const existing = this.byKey.get(key)
    if (existing !== undefined) {
      existing.hits += 1
      if (existing.status === undefined && request.status !== undefined) existing.status = request.status
      if (existing.contentType.length === 0 && contentType.length > 0) existing.contentType = contentType
      return existing
    }
    if (this.order.length >= this.options.max) {
      this.droppedCount += 1
      return undefined
    }
    const endpoint: Endpoint = {
      id: `E${String(this.order.length + 1)}`,
      method,
      url: sanitizeUrl(request.url),
      path: (() => {
        try {
          return new URL(request.url).pathname
        } catch {
          return request.url
        }
      })(),
      name: nameOf(request.url),
      contentType,
      status: request.status,
      hits: 1,
    }
    this.byKey.set(key, endpoint)
    this.order.push(key)
    return endpoint
  }

  /** The discovered endpoints, in discovery order. */
  list(): Endpoint[] {
    return this.order.map((key) => this.byKey.get(key)).filter((endpoint): endpoint is Endpoint => endpoint !== undefined)
  }

  /** Endpoints discovered since a previous list length (the delta of `act`). */
  since(count: number): Endpoint[] {
    return this.list().slice(count)
  }

  /**
   * Resolve a caller's `api` reference: an id (`E2`), a path (`/api/items`), a
   * name or an absolute URL. `undefined` when nothing matches.
   */
  resolve(ref: string): Endpoint | undefined {
    const needle = ref.trim()
    if (needle.length === 0) return undefined
    const list = this.list()
    const byIdMatch = list.find((endpoint) => endpoint.id.toLowerCase() === needle.toLowerCase())
    if (byIdMatch !== undefined) return byIdMatch
    const absolute = needle.startsWith('http://') || needle.startsWith('https://')
    // An endpoint's IDENTITY is method + PATH: discovery deduplicates on the
    // path, so a caller may quote the discovered URL verbatim (query included,
    // as it appears in the list) or just the path, and still get the endpoint.
    let pathname = needle
    let search = ''
    try {
      const parsed = new URL(absolute ? needle : `http://discovery.invalid${needle.startsWith('/') ? '' : '/'}${needle}`)
      pathname = parsed.pathname
      // A query the CALLER quoted wins over the discovered sample: the sample is
      // ONE observation (e.g. `?page=1&size=60`), so asking for `?size=5` must
      // ask the site for 5 items, not replay the sample's 60.
      search = parsed.search
    } catch {
      // Not URL-shaped at all: fall through to the name match below.
    }
    const hit =
      list.find((endpoint) => endpoint.path === pathname) ??
      list.find((endpoint) => endpoint.name === needle) ??
      (pathname.length > 1 ? list.find((endpoint) => endpoint.path.endsWith(pathname)) : undefined)
    if (hit !== undefined) {
      // A query the caller passed explicitly wins over the discovered sample
      // (the sample is one observation, e.g. `?page=1`).
      return search === '' ? hit : { ...hit, url: `${hit.url.split('?')[0]}${search}` }
    }
    // An absolute URL that was never observed is still callable (the caller
    // names it explicitly); the manager then enforces the origin allow-list.
    if (absolute) {
      return { id: needle, method: 'GET', url: needle, path: pathname, name: nameOf(needle), contentType: '', status: undefined, hits: 0 }
    }
    return undefined
  }
}
