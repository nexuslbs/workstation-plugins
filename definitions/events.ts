// definitions/events.ts - the plugin EVENT contract of this repository.
//
// The operator asked for the deepseek-harness event surface inside workbench:
// `on` / `once` / `off` / `emit` / `serial` / `parallel` / `bail` / `waterfall`,
// with subscriptions that DISAPPEAR when the owning plugin is unloaded, plus an
// `effect()` API whose disposer releases external resources (sockets, pools,
// timers, subprocesses, browser contexts) when the plugin is unloaded.
//
// Where each half lives (this is the point of the module):
//
//   * the DISPATCH ENGINE is the HOST's: workbench's core is cordis, whose
//     `EventsService` (`ctx.on` / `ctx.once` / `ctx.emit` / `ctx.serial` /
//     `ctx.parallel` / `ctx.bail` / `ctx.waterfall`) already implements the dsh
//     semantics AND binds a subscription to the registering plugin's FIBER (it
//     registers a fiber effect), so a listener is removed when that plugin is
//     unloaded. NOTHING of that is re-implemented here or in `lib/events.ts`:
//     the layer DELEGATES every dispatch to the host.
//   * THIS MODULE + `lib/events.ts` add what the host does NOT give a plugin:
//     the typed contract, the event NAME convention and its collision rule, the
//     missing `off`, an error-ISOLATED dispatch (a throwing listener is logged
//     and neither kills the emitter, the other listeners, nor the process) and an
//     `effect()` scope with LIFO ordering, exactly-once semantics, per-disposer
//     isolation and a bounded await at unload.
//
// Nothing is imported from the workbench core and no plugin of this repository
// imports `cordis`: everything the host must offer is expressed STRUCTURALLY
// below, exactly like `definitions/support.ts` does for the service stack.
// (`scripts/check-seam.ts` enforces that: a definition depends on `node:` and
// its own siblings only.)

/** The contract id of the plugin event surface. */
export const EVENTS_CONTRACT = 'events@1'

/** A listener: `emit`/`serial`/`parallel`/`bail` pass the payload, `waterfall` adds `next`. */
export type Listener = (...args: any[]) => unknown

/** Releases one thing. Called at most once by the layer; may be async. */
export type Disposer = () => unknown | Promise<unknown>

/** What `on`/`once`/`effect` return: idempotent, safe to call twice. */
export type Unsubscribe = () => void

export interface EventOptions {
  /** Register the listener at the HEAD of the chain (host option, forwarded). */
  prepend?: boolean
  /**
   * The event is part of the process-wide PUBLIC surface of this plugin: the
   * layer DECLARES it in the registry, so a second plugin declaring the same
   * name is reported as a collision instead of silently sharing an event.
   */
  declare?: boolean
}

export interface EffectOptions {
  /** Human label used in the unload log line and in `listenerCount`-style audits. */
  label?: string
  /**
   * Also register the disposer with the process SHUTDOWN coordinator (default
   * true): it then runs on SIGTERM/SIGINT as well as on plugin unload. The
   * exactly-once rule still holds, so the two paths never double-release.
   */
  shutdown?: boolean
  /** Bound for THIS disposer in ms (default: the scope's `disposeTimeoutMs`). */
  timeoutMs?: number
}

/** The callback handed to `effect()`: it ACQUIRES now and returns how to RELEASE. */
export type EffectCallback = () => Disposer | readonly (Disposer | null | undefined)[] | null | undefined

// ---------------------------------------------------------------------------
// Event NAME convention.
//
// `<namespace>/<event>`, the cordis convention (`internal/service`), never the
// dotted form: the same string is used on the host bus, in logs and in the
// registry. Rules (enforced by `qualify` when `strictNamespaces` is on):
//   * a plugin declares its OWN namespace (normally its plugin name) and emits
//     only `<its-namespace>/<event>` - one plugin, one namespace;
//   * `internal/` is the HOST's (cordis lifecycle, never emitted by a plugin);
//   * `plugin/` is the LIFECYCLE namespace of this layer (see LIFECYCLE);
//   * a name may be written in full (`email/received`) or short (`received`,
//     resolved against the scope's namespace);
//   * COLLISIONS: two plugins declaring the same full name is an error the
//     registry reports (`EventsError` code `collision`); emitting an undeclared
//     name is allowed (events are open) but is NOT protected by that check.
// ---------------------------------------------------------------------------

/** Namespaces a plugin may not claim. */
export const RESERVED_NAMESPACES: readonly string[] = ['internal', 'plugin', 'events']

/** The lifecycle events this layer emits on the host bus. */
export const LIFECYCLE = {
  /** `{ plugin, namespace }` - a scope was created (its plugin was applied). */
  pluginLoaded: 'plugin/loaded',
  /** `{ plugin, namespace, effects, listeners, errors }` - a scope was disposed. */
  pluginUnloaded: 'plugin/unloaded',
} as const

export interface LifecyclePayload {
  /** The plugin namespace (normally the plugin name). */
  plugin: string
  namespace: string
  effects?: number
  listeners?: number
  errors?: string[]
}

export type EventsErrorCode =
  /** The name is empty, has an empty segment or is not a string. */
  | 'invalid-name'
  /** The name claims a namespace only the host or this layer may emit. */
  | 'reserved-namespace'
  /** Two plugins declared the same public event name. */
  | 'collision'
  /** The scope was disposed and a registration was attempted afterwards. */
  | 'inactive'
  /** The host context does not offer the event surface at all. */
  | 'host-unsupported'

/** The one error shape this module throws. */
export class EventsError extends Error {
  readonly code: EventsErrorCode
  readonly details: Record<string, unknown>

  constructor(code: EventsErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'EventsError'
    this.code = code
    this.details = details
  }
}

/**
 * The host's "this listener ANSWERED" rule, kept identical to cordis'
 * `isBailed` (and to dsh): anything that is not `null`, `undefined` or `false`
 * is an answer, so `bail`/`serial` stop there and `waterfall` may abort there.
 * Re-exported as a function because a consumer must be able to depend on the
 * rule without depending on the host implementation.
 */
export function isAnswer(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false
}

/** `{ namespace, event }` of a full name. */
export function splitName(name: string): { namespace: string; event: string } {
  const index = name.indexOf('/')
  if (index < 0) return { namespace: '', event: name }
  return { namespace: name.slice(0, index), event: name.slice(index + 1) }
}

/**
 * Resolves a name against a scope namespace: a full `namespace/event` name is
 * returned verbatim, a short one is prefixed. Throws {@link EventsError} for an
 * empty/invalid name and for a RESERVED namespace.
 */
export function qualify(namespace: string, name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new EventsError('invalid-name', 'an event name must be a non-empty string', { name, namespace })
  }
  const full = name.includes('/') ? name : `${namespace}/${name}`
  const { namespace: owner, event } = splitName(full)
  if (owner.length === 0 || event.length === 0 || full.includes('//') || /\s/.test(full)) {
    throw new EventsError('invalid-name', `'${name}' is not a '<namespace>/<event>' name`, { name, namespace, full })
  }
  if (RESERVED_NAMESPACES.includes(owner)) {
    throw new EventsError(
      'reserved-namespace',
      `'${owner}/' is reserved (${RESERVED_NAMESPACES.join(', ')}); plugin '${namespace}' may not emit '${full}'`,
      { name, namespace, full, reserved: RESERVED_NAMESPACES },
    )
  }
  return full
}

// ---------------------------------------------------------------------------
// The structural view of the HOST context this layer needs. Only `on`, `emit`
// and `effect` are REQUIRED (each dispatch mode falls back to the host's sync
// `emit` when the richer dispatcher is missing), so a test context can implement
// exactly the documented surface.
// ---------------------------------------------------------------------------

export interface EventsHostContext {
  on?(name: string, listener: Listener, options?: boolean | EventOptions): unknown
  once?(name: string, listener: Listener, options?: boolean | EventOptions): unknown
  emit?(...args: unknown[]): unknown
  serial?(...args: unknown[]): Promise<unknown>
  parallel?(...args: unknown[]): unknown
  bail?(...args: unknown[]): unknown
  waterfall?(...args: unknown[]): unknown
  /** The host effect scope: the disposer runs when the calling plugin unloads. */
  effect?(callback: () => unknown): unknown
  /** cordis' EventsService, read structurally for the host hook count (optional). */
  events?: { _hooks?: Record<string, unknown[]> }
  /**
   * The logger SERVICE (`logger@1`, see definitions/logger.ts and
   * docs/LOGGING.md): the HOST installs it on the context, `ctx.logger(name)`
   * yields the levelled handle a consumer calls and `ctx.logger.exporter(sink)`
   * mounts one exporter PLUGIN's sink. Read STRUCTURALLY, like the rest of this
   * interface (this module imports nothing). A host without the service produces
   * NO output at all - the model is "no exporter mounted, no output", so there is
   * deliberately no console fallback anywhere.
   */
  logger?: {
    (name?: string): {
      error(...args: unknown[]): void
      warn(...args: unknown[]): void
      info(...args: unknown[]): void
      debug(...args: unknown[]): void
    }
    exporter?(exporter: unknown): unknown
  }
  [key: string]: unknown
}

/** What `dispose()` reports (tests and audit surfaces read it). */
export interface DisposeReport {
  plugin: string
  namespace: string
  /** Disposers that RAN (exactly once each). */
  effects: number
  /** Subscriptions removed from the host bus. */
  listeners: number
  /** One entry per disposer that threw/timed out (never a credential value). */
  errors: string[]
  /** True when this call did the work (false when the scope was already disposed). */
  first: boolean
}

/** The process-wide bookkeeping the layer keeps (audit + collision detection). */
export interface EventRegistrySnapshot {
  /** event name -> owning plugin namespace (only DECLARED names). */
  declared: Record<string, string>
  /** event name -> live listener count registered through this layer. */
  listeners: Record<string, number>
  /** event name -> the plugin namespaces that registered a listener. */
  owners: Record<string, string[]>
}

export interface EventRegistryLike {
  declare(owner: string, names: readonly string[]): void
  track(owner: string, name: string): void
  untrack(owner: string, name: string): void
  snapshot(): EventRegistrySnapshot
}

/**
 * The plugin-facing event scope. One scope per plugin (created by
 * `createEvents` in `lib/events.ts`, which binds it to the plugin's own fiber).
 */
export interface EventScope {
  readonly contract: string
  readonly namespace: string
  readonly disposed: boolean
  on(name: string, listener: Listener, options?: EventOptions): Unsubscribe
  once(name: string, listener: Listener, options?: EventOptions): Unsubscribe
  /** Removes one listener (or every listener of `name` when omitted). Returns how many were removed. */
  off(name: string, listener?: Listener): number
  /** Fire and forget: every listener runs, a throwing one cannot stop the others. */
  emit(name: string, ...args: unknown[]): void
  /** Awaits every listener in order; stops at the first ANSWER (see {@link isAnswer}). */
  serial(name: string, ...args: unknown[]): Promise<unknown>
  /** Awaits every listener concurrently; caller-visible errors are recorded, never thrown. */
  parallel(name: string, ...args: unknown[]): Promise<void>
  /** Synchronous, first ANSWER wins and stops the chain. */
  bail(name: string, ...args: unknown[]): unknown
  /** `value` is threaded through the listeners; each one calls `next(value?)` to continue. */
  waterfall(name: string, value: unknown, next?: (value?: unknown) => unknown): unknown
  effect(callback: EffectCallback, options?: EffectOptions): Unsubscribe
  /** Listeners registered through THIS scope for `name`. */
  listenerCount(name: string): number
  listeners(name: string): Listener[]
  /** Declares public names in the registry (collision check). */
  declare(names: readonly string[]): void
  /** Runs every effect disposer (LIFO) and removes every subscription. Idempotent. */
  dispose(): Promise<DisposeReport>
}

/** The dispatchers a scope delegates to; every member is REQUIRED by the runtime. */
export type EventsHostDispatchers = Required<Pick<EventsHostContext, 'on' | 'emit'>> &
  Pick<EventsHostContext, 'once' | 'serial' | 'parallel' | 'bail' | 'waterfall' | 'effect' | 'events' | 'logger'>
