/**
 * Web capability - SERVICE DEFINITION.
 *
 * The workbench Web UI is composed ONLY of plugins; the core knows how to
 * SERVE bytes and how to route them, nothing about what a page shows. This
 * module is the CONTRACT of that capability (the definition role) and it names
 * no HTTP server, no template engine and no UI framework:
 *
 *   Provider  ->  Definition  <-  Consumer
 *
 * - PROVIDERS implement the serving side. A provider is a PLUGIN of this
 *   repository (core/web-impl, provider `http`: a `node:http` server); it is
 *   the only role that touches a socket. A provider
 *   calls {@link Web.dispatch} for the registered routes and reads the
 *   registered assets/pages through the accessors below.
 * - CONSUMERS (UI plugins, from any source) register routes, assets and pages
 *   through `ctx.web` and never import a provider. Registering returns the
 *   disposer, so a plugin wraps every call in `ctx.effect(...)` and unloads
 *   cleanly.
 *
 * Everything a consumer registers is disposable: unloading a plugin removes its
 * routes, assets and pages (proved by `test/web.test.ts`).
 *
 * `npm run check:seam` enforces the direction on the module graph: only a
 * provider is a plugin of this repository, and a consumer registers through
 * `ctx.web` without importing a provider at all.
 */

/** Name of the cordis service (`ctx.web`). */
export const WEB = 'web'

/** Contract version this definition speaks. A provider must implement it. */
export const WEB_VERSION = 1

/** Contract id including the version, e.g. `web@1`. */
export const WEB_CONTRACT = `${WEB}@${WEB_VERSION}`

/**
 * Default bind host of the web provider: loopback. The UI has no auth in this
 * round, so the default MUST NOT be reachable from another machine.
 */
export const DEFAULT_WEB_HOST = '127.0.0.1'

/** Default web UI port (`workbench web`, and `serve` when `web.enabled` is true). */
export const DEFAULT_WEB_PORT = 8080

/** A request as the seam hands it to a route handler (provider built, I/O free). */
export interface WebRequest {
  /** Upper case HTTP method, e.g. `GET`. */
  method: string
  /** Request path without query string, e.g. `/api/plugin-inventory/plugins`. */
  path: string
  /**
   * Path parameters a DYNAMIC route captured (a `:name` segment), decoded by the
   * provider; absent on an exact route. E.g. the route `POST /api/tools/:name`
   * answers a request to `/api/tools/hello%20greet` with `{ name: 'hello greet' }`.
   */
  params?: Record<string, string>
  /** Parsed query string. */
  query: URLSearchParams
  /** Request headers, as received. */
  headers: Record<string, string | string[] | undefined>
  /** Reads the request body (capped by the provider) as text. */
  readText(): Promise<string>
  /** Reads the request body as JSON; throws on invalid JSON. */
  readJson<T = unknown>(): Promise<T>
}

/** What a handler answers. `body` defaults to `''`, `status` to 200. */
export interface WebResponse {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

/** A route handler: returns a response, or nothing to fall through to the 404. */
export type WebHandler = (request: WebRequest) => WebResponse | undefined | void | Promise<WebResponse | undefined | void>

/**
 * A route registration: one method + one path. The path is EXACT, or it may
 * carry one or more WHOLE dynamic segments (`/api/tools/:name`); each `:name`
 * segment captures exactly one request path segment, decoded by the provider
 * (`/api/tools/hello%20greet` captures `hello greet`). An exact route always
 * wins over a dynamic one.
 */
export interface WebRouteSpec {
  /** HTTP method (`GET`, `POST`, ...); case insensitive, stored upper case. */
  method: string
  /** Absolute path, e.g. `/api/plugin-inventory/plugins` or `/api/tools/:name`. */
  path: string
  /** The handler; everything it returns is served verbatim. */
  handler: WebHandler
  /** Human readable purpose, shown in the inventory. */
  description?: string
}

/** A registered dynamic route: its spec plus the segment pattern it matches. */
interface DynamicRoute {
  spec: WebRouteSpec
  /** Path segments; a segment starting with `:` captures its request segment. */
  segments: string[]
}

/** A registered route, as reported by {@link Web.routes}. */
export interface WebRouteInfo {
  method: string
  path: string
  plugin: string
  description?: string
}

/** A static asset registration: an absolute URL path backed by a file on disk. */
export interface WebAssetSpec {
  /** Absolute URL path, e.g. `/plugins/plugin-inventory/app.js`. */
  path: string
  /** Absolute path of the file; it lives WITH the plugin (no build step). */
  file: string
  /** MIME type; defaults from the file extension. */
  contentType?: string
}

/** A registered asset, as reported by {@link Web.assets}. */
export interface WebAssetInfo {
  path: string
  file: string
  contentType: string
  plugin: string
}

/** A UI page registration: a nav entry plus the module that mounts it. */
export interface WebPageSpec {
  /** Stable page id, unique across the UI (e.g. `plugin-inventory`). */
  id: string
  /** Nav title shown in the shell. */
  title: string
  /** URL path the shell answers with itself, e.g. `/plugin-inventory`. */
  path: string
  /** Browser module URL the shell imports, e.g. `/plugins/plugin-inventory/app.js`. */
  module: string
  /** Optional description (shown on the page and in the inventory). */
  description?: string
}

/** A registered page, as reported by {@link Web.pages}. */
export interface WebPageInfo {
  id: string
  title: string
  path: string
  module: string
  description?: string
  plugin: string
}

/** Every route the seam answers, with the plugin that registered it. */
export interface WebSeamInfo {
  contract: string
  routes: WebRouteInfo[]
  assets: WebAssetInfo[]
  pages: WebPageInfo[]
}

/** MIME types the seam knows without a dependency. */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** Default content type of a file path, by extension. */
export function contentTypeOf(file: string): string {
  const lower = file.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return (dot >= 0 ? CONTENT_TYPES[lower.slice(dot)] : undefined) ?? 'application/octet-stream'
}

/** Validates and normalises an absolute seam path (`/a/b`). */
export function normalizePath(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`web: ${what} needs a non-empty path`)
  const path = value.startsWith('/') ? value : `/${value}`
  if (/\s/.test(path)) throw new Error(`web: ${what} path '${value}' must not contain whitespace`)
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The service of the capability. It holds the registries and the route
 * dispatch; it never touches a socket, the filesystem or a template engine
 * (that is the provider's job). Consumers call `ctx.web`.
 */
export class Web {
  // Plain (runtime) properties, not `#private`: a host may wrap the instance in
  // a Proxy for dependency tracking, and a Proxy breaks private-field access.
  protected routeMap = new Map<string, WebRouteSpec>()
  /** Dynamic routes (a `:name` path segment), keyed exactly like the static ones. */
  protected dynamicRoutes = new Map<string, DynamicRoute>()
  protected assetMap = new Map<string, WebAssetSpec>()
  protected pageMap = new Map<string, WebPageSpec>()
  /** Registration key -> plugin that made it (see {@link WebSeamOptions.owner}). */
  protected owners = new Map<string, string>()
  protected registrationCount = 0
  /** Label used for a registration the host could not attribute (see the option). */
  protected ownerLabel: () => string

  constructor(options: WebSeamOptions = {}) {
    this.ownerLabel = options.owner ?? (() => 'plugin')
  }

  /** Number of routes served so far (the dispatch counter, for tests). */
  dispatched(): number {
    return this.registrationCount
  }

  /** Registers one route (exact or dynamic); returns the disposer that unregisters it. */
  route(spec: WebRouteSpec): () => void {
    const method = typeof spec?.method === 'string' ? spec.method.trim().toUpperCase() : ''
    if (method.length === 0) throw new Error('web: a route needs a method (e.g. GET)')
    const path = normalizePath(spec?.path, `${method} route`)
    if (typeof spec?.handler !== 'function') throw new Error(`web: route ${method} ${path} needs a handler function`)
    const key = `${method} ${path}`
    const entry: WebRouteSpec = { method, path, handler: spec.handler, ...(spec.description === undefined ? {} : { description: spec.description }) }
    if (path.split('/').some((segment) => segment.startsWith(':'))) {
      const segments = path.split('/')
      const names = new Set<string>()
      for (const segment of segments) {
        if (!segment.startsWith(':')) continue
        const name = segment.slice(1)
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`web: route ${method} ${path}: '${segment}' must be a whole path parameter segment (letters, digits, '_')`)
        }
        if (names.has(name)) throw new Error(`web: route ${method} ${path}: parameter ':${name}' is declared twice`)
        names.add(name)
      }
      if (this.dynamicRoutes.has(key)) throw new Error(`web: route ${key} is already registered`)
      this.dynamicRoutes.set(key, { spec: entry, segments })
      this.owners.set(`route:${key}`, this.owner())
      return () => {
        if (this.dynamicRoutes.get(key)?.spec === entry) {
          this.dynamicRoutes.delete(key)
          this.owners.delete(`route:${key}`)
        }
      }
    }
    if (this.routeMap.has(key)) throw new Error(`web: route ${key} is already registered`)
    this.routeMap.set(key, entry)
    this.owners.set(`route:${key}`, this.owner())
    return () => {
      if (this.routeMap.get(key) === entry) {
        this.routeMap.delete(key)
        this.owners.delete(`route:${key}`)
      }
    }
  }

  /** Registers one static asset (a file served verbatim); returns its disposer. */
  asset(spec: WebAssetSpec): () => void {
    const path = normalizePath(spec?.path, 'asset')
    if (!isNonEmptyString(spec?.file) || !spec.file.startsWith('/')) {
      throw new Error(`web: asset ${path} needs an absolute 'file' (got ${JSON.stringify(spec?.file)})`)
    }
    if (this.assetMap.has(path)) throw new Error(`web: asset ${path} is already registered`)
    const entry: WebAssetSpec = {
      path,
      file: spec.file,
      contentType: spec.contentType ?? contentTypeOf(spec.file),
    }
    this.assetMap.set(path, entry)
    this.owners.set(`asset:${path}`, this.owner())
    return () => {
      if (this.assetMap.get(path) === entry) {
        this.assetMap.delete(path)
        this.owners.delete(`asset:${path}`)
      }
    }
  }

  /** Registers one UI page (nav entry + module); returns its disposer. */
  page(spec: WebPageSpec): () => void {
    if (!isNonEmptyString(spec?.id)) throw new Error('web: a page needs a non-empty id')
    if (!isNonEmptyString(spec?.title)) throw new Error(`web: page '${spec.id}' needs a non-empty title`)
    const path = normalizePath(spec?.path, `page '${spec.id}'`)
    const module = normalizePath(spec?.module, `page '${spec.id}' module`)
    if (this.pageMap.has(spec.id)) throw new Error(`web: page id '${spec.id}' is already registered`)
    for (const existing of this.pageMap.values()) {
      if (existing.path === path) throw new Error(`web: page path ${path} is already registered (by page '${existing.id}')`)
    }
    const entry: WebPageSpec = {
      id: spec.id,
      title: spec.title,
      path,
      module,
      ...(spec.description === undefined ? {} : { description: spec.description }),
    }
    this.pageMap.set(spec.id, entry)
    this.owners.set(`page:${spec.id}`, this.owner())
    return () => {
      if (this.pageMap.get(spec.id) === entry) {
        this.pageMap.delete(spec.id)
        this.owners.delete(`page:${spec.id}`)
      }
    }
  }

  /** The registered pages, in registration order (the shell's nav). */
  pages(): WebPageInfo[] {
    return [...this.pageMap.values()].map((page) => ({ ...page, plugin: this.ownerOf(`page:${page.id}`) }))
  }

  /** The registered assets, in registration order. */
  assets(): WebAssetInfo[] {
    return [...this.assetMap.values()].map((asset) => ({
      path: asset.path,
      file: asset.file,
      contentType: asset.contentType ?? contentTypeOf(asset.file),
      plugin: this.ownerOf(`asset:${asset.path}`),
    }))
  }

  /** The registered routes (exact and dynamic), in registration order. */
  routes(): WebRouteInfo[] {
    const specs = [
      ...this.routeMap.values(),
      ...[...this.dynamicRoutes.values()].map((route) => route.spec),
    ]
    return specs.map((route) => ({
      method: route.method,
      path: route.path,
      plugin: this.ownerOf(`route:${route.method} ${route.path}`),
      ...(route.description === undefined ? {} : { description: route.description }),
    }))
  }

  /**
   * Matches a request path against the dynamic routes: the first route whose
   * segments line up with the request path wins and its `:name` segments become
   * the captured request params. Returns nothing when no dynamic route matched.
   */
  protected matchDynamic(method: string, path: string): { spec: WebRouteSpec; params: Record<string, string> } | undefined {
    const parts = path.split('/')
    for (const [key, route] of this.dynamicRoutes) {
      if (!key.startsWith(`${method} `)) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matches = true
      for (let index = 0; index < route.segments.length; index++) {
        const segment = route.segments[index] ?? ''
        const value = parts[index] ?? ''
        if (segment.startsWith(':')) params[segment.slice(1)] = value
        else if (segment !== value) {
          matches = false
          break
        }
      }
      if (matches) return { spec: route.spec, params }
    }
    return undefined
  }

  /** The plugin a registration key belongs to (the seam's label when unknown). */
  ownerOf(key: string): string {
    return this.owners.get(key) ?? this.ownerLabel()
  }

  /** The label a registration gets (the host marker while a plugin applies). */
  protected owner(): string {
    try {
      return this.ownerLabel()
    } catch {
      return 'plugin'
    }
  }

  /** The whole seam state, for the inventory surfaces. */
  info(): WebSeamInfo {
    return { contract: WEB_CONTRACT, routes: this.routes(), assets: this.assets(), pages: this.pages() }
  }

  /** The asset registered for a URL path, or undefined. */
  assetAt(path: string): WebAssetInfo | undefined {
    return this.assets().find((asset) => asset.path === path)
  }

  /** The page registered for a URL path, or undefined. */
  pageByPath(path: string): WebPageInfo | undefined {
    return this.pages().find((page) => page.path === path)
  }

  /**
   * The route dispatch a provider calls: it matches the registered routes (an
   * EXACT key first, then a dynamic `:name` route) and returns their response,
   * or undefined when no route matched (the provider then answers 404). It never
   * reads a file or writes to a socket.
   */
  async dispatch(request: WebRequest): Promise<WebResponse | undefined> {
    const method = request.method.toUpperCase()
    const route = this.routeMap.get(`${method} ${request.path}`)
    if (route) {
      this.registrationCount += 1
      const response = await route.handler(request)
      return response ?? undefined
    }
    const matched = this.matchDynamic(method, request.path)
    if (!matched) return undefined
    this.registrationCount += 1
    const response = await matched.spec.handler({ ...request, method, params: matched.params })
    return response ?? undefined
  }
}

/**
 * The options a HOST passes when it constructs the seam: how a registration is
 * attributed to the plugin that made it. The host owns the marker (the core's
 * loader updates it while a plugin applies); the definition never imports it,
 * so this module depends on NO host framework.
 */
export interface WebSeamOptions {
  /** Label of the plugin registering right now (default: `'plugin'`). */
  owner?: () => string
}
