// definitions/logger.ts - the `logger@1` contract: the logger SERVICE the core
// hosts (cordis installs `ctx.logger` on every context) plus the EXPORTER
// interface every OUTPUT SINK of this repository implements.
//
// The model (operator, 2026-09-19):
//
//   "Logging is not console.log sprinkled around, and not a single monolithic
//    logger plugin. Cordis core ships a logger service, and output is produced
//    by separately mounted exporter plugins."
//
// In workbench that is:
//
//   SERVICE  the CORE (cordis `LoggerService`) - reachable from every plugin
//            context. `ctx.logger(name)` yields {error,warn,info,debug} and
//            `ctx.logger.exporter(...)` mounts a SINK; the registration is a
//            cordis `effect`, so it is disposed with the plugin's fiber (unload
//            the plugin, the sink is gone) and it is filtered by the sink's own
//            `levels` table.
//   SINK     ONE PLUGIN PER SINK (`logger-console`, `logger-jsonl`,
//            `logger-ring`, ...), mounted by its OWN roster row: independently
//            configurable, independently disableable, never a monolith.
//   CONSUMER any plugin: it CALLS the service and prints nothing itself.
//
// What this module gives a plugin of this repository:
//   - the level semantics (LOG_LEVELS / levelThreshold / exporterLevels);
//   - the Message and Exporter shapes (a STRUCTURAL copy of cordis's, so no
//     plugin imports cordis and the contract holds for any host that installs
//     the service);
//   - `loggerOf(ctx, name)` - the typed handle a CONSUMER uses. It NEVER falls
//     back to `console` (the model: no output at all without a mounted sink)
//     and it isolates a failing sink from the caller's business logic;
//   - `mountExporter(ctx, exporter, label)` - how a SINK PLUGIN mounts itself,
//     with the isolation cordis does NOT provide: a throwing exporter
//     PROPAGATES to the emitter in cordis (measured, see docs/LOGGING.md), so
//     the wrapper catches it, counts it and reports it ONCE;
//   - the JSON-safe / text serializers a sink formats a Message with, so a file
//     sink writes STRUCTURE (name, type, level, ts) instead of prose.
import { messageOf } from './support.ts'

/** The capability id a SINK plugin declares in its manifest. */
export const LOGGER = 'logger'
/** The contract version of that capability. */
export const LOGGER_VERSION = 1
/** Human-readable contract label (`logger@1`). */
export const LOGGER_CONTRACT = 'logger@1'
/** The service name a ring/buffer sink registers its read side under. */
export const LOGS_SERVICE = 'logs'

/** The four levels, ERROR 0 .. DEBUG 3 (the cordis `LoggerLevel` enum). */
export type LogLevelName = 'error' | 'warn' | 'info' | 'debug'

export const LOG_LEVELS: Readonly<Record<LogLevelName, number>> = { error: 0, warn: 1, info: 2, debug: 3 }

/** Names by ordinal: `LOG_LEVEL_NAMES[message.level]`. */
export const LOG_LEVEL_NAMES = ['error', 'warn', 'info', 'debug'] as const

/**
 * The threshold the service applies when neither the sink nor the logger sets
 * one: INFO. So `debug` is hidden unless a deployment asks for it.
 */
export const DEFAULT_LEVEL = LOG_LEVELS.info

/** A level as config writes it: a name (`info`) or the ordinal (`2`). */
export type LogLevelOption = LogLevelName | number

/** A per-name threshold table; `default` applies to every other name. */
export interface LogLevels {
  default?: number
  [name: string]: number | undefined
}

/**
 * One log Message, exactly as the service hands it to a sink. `sn` is the
 * process-wide sequence number, `ts` the epoch-ms timestamp, `name` the logger
 * name (the plugin's name unless the caller passed one) and `type`/`level` the
 * level (name + ordinal).
 */
export interface LogMessage {
  sn: number
  ts: number
  name: string
  type: LogLevelName
  level: number
  args: unknown[]
  /** The emitting plugin, when the host scopes the logger to a fiber. */
  fiber?: { name?: string }
}

/**
 * A SINK. `export` receives EVERY Message that passes the sink's own `levels`
 * table; `colors`/`maxLength`/`formatters` are optional rendering hints the
 * host may honour (a sink that formats itself may ignore them).
 */
export interface LogExporter {
  colors?: number
  maxLength?: number
  levels?: LogLevels
  formatters?: Record<string, (value: unknown, exporter: LogExporter, message: LogMessage) => string>
  export(message: LogMessage): void
}

/** What `ctx.logger(name)` returns: four bound, levelled methods. */
export interface LoggerHandle {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** The structural view of the host's logger SERVICE (cordis `LoggerService`). */
export interface LoggerServiceLike {
  (name?: string): LoggerHandle
  /**
   * Mount a SINK. Optional on purpose: a host context is read STRUCTURALLY
   * (definitions/support.ts), and a plugin that only CONSUMES the service may
   * declare the callable part alone - `mountExporter` refuses loudly when the
   * host has no registry instead of the whole context failing to typecheck.
   */
  exporter?(exporter: LogExporter): unknown
  exporters?: Map<number, LogExporter>
  buffer?: LogMessage[]
}

/** The structural view of the context a logger consumer/sink needs. */
export interface LoggerHost {
  logger?: LoggerServiceLike
  effect?(callback: () => () => void): unknown
}

// ---------------------------------------------------------------------------
// Levels.
// ---------------------------------------------------------------------------

/** The ordinal of a level name/number, or undefined when it is not a level. */
export function levelThreshold(level: LogLevelOption | undefined): number | undefined {
  if (level === undefined) return undefined
  if (typeof level === 'number') return Number.isFinite(level) ? level : undefined
  const named = LOG_LEVELS[level]
  return named
}

/** The level NAME of an ordinal (`error` for 0); unknown ordinals keep `info`. */
export function levelName(level: unknown): LogLevelName {
  return typeof level === 'number' && LOG_LEVEL_NAMES[level] !== undefined ? LOG_LEVEL_NAMES[level] : 'info'
}

/**
 * The `levels` table a sink declares for ONE threshold (plus optional per-name
 * overrides): `{ default: 2 }`. Returned even when `level` is omitted, so the
 * caller can decide: the model is `exporterLevels(config.level)` and nothing
 * else, and the host then hides every Message below it.
 */
export function exporterLevels(
  level?: LogLevelOption,
  names?: Record<string, LogLevelOption>,
): LogLevels | undefined {
  const table: LogLevels = {}
  const fallback = levelThreshold(level)
  if (fallback !== undefined) table.default = fallback
  for (const [name, value] of Object.entries(names ?? {})) {
    const threshold = levelThreshold(value)
    if (threshold !== undefined) table[name] = threshold
  }
  return Object.keys(table).length > 0 ? table : undefined
}

// ---------------------------------------------------------------------------
// Serialization: what a sink writes. Structure, never prose, never a secret.
// ---------------------------------------------------------------------------

/**
 * A JSON-safe view of one Message argument: an Error keeps its name/message/
 * stack, a Map/Set becomes an array, a bigint/function/symbol becomes a string,
 * a cycle becomes `[circular]` and the depth is bounded (so a sink can always
 * write `JSON.stringify(...)` on the result).
 *
 * A caller must still never PASS a credential value to a logger: redaction is a
 * naming discipline (log the NAME, never the value), not something a serializer
 * can guess.
 */
export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value as number) ? value : String(value)
  if (type === 'bigint' || type === 'function' || type === 'symbol') return String(value)
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? null }
  }
  if (depth >= 4) return '[deep]'
  if (Array.isArray(value)) {
    const capped = value.slice(0, 50).map((entry) => toJsonSafe(entry, depth + 1))
    if (value.length > 50) capped.push(`[+${value.length - 50} more]`)
    return capped
  }
  if (value instanceof Map) return toJsonSafe([...value.entries()], depth)
  if (value instanceof Set) return toJsonSafe([...value.values()], depth)
  if (type === 'object') {
    const seen = new WeakSet<object>()
    const walk = (entry: unknown, level: number): unknown => {
      if (entry === null || typeof entry !== 'object') return toJsonSafe(entry, level)
      if (level >= 4) return '[deep]'
      if (seen.has(entry as object)) return '[circular]'
      seen.add(entry as object)
      if (Array.isArray(entry)) return entry.slice(0, 50).map((item) => walk(item, level + 1))
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(entry as Record<string, unknown>)) out[key] = walk(item, level + 1)
      return out
    }
    return walk(value, depth)
  }
  return String(value)
}

/** The JSON-safe projection of a whole Message (what a JSONL sink writes). */
export function messageToJson(message: LogMessage): Record<string, unknown> {
  return {
    sn: message.sn,
    ts: message.ts,
    name: message.name,
    type: message.type,
    level: message.level,
    args: message.args.map((arg) => toJsonSafe(arg)),
  }
}

/**
 * The text of a Message for a HUMAN sink: `%s/%d/%i/%f/%o/%O/%c` placeholders of
 * a leading string are consumed exactly like cordis' `defaultFormatters`, an
 * Error prints its stack and anything else is joined as JSON.
 */
export function formatText(message: LogMessage, maxLength = 10_240): string {
  const args = message.args
  const head = typeof args[0] === 'string' ? args[0] : undefined
  const parts: string[] = []
  if (head === undefined) {
    for (const arg of args) parts.push(textOf(arg))
  } else {
    let index = 1
    parts.push(
      head.replace(/%[sdifoOcC]/g, (token) => {
        if (token === '%c' || token === '%C') return ''
        const value = args[index++]
        return token === '%s' ? textOf(value) : textOf(value)
      }),
    )
    for (; index < args.length; index++) parts.push(textOf(args[index]))
  }
  const text = parts.join(' ')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

/** One argument as text: an Error shows its stack, a string stays raw, rest JSON. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(toJsonSafe(value))
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// The one-shot reporter. The logging subsystem's OWN last resort.
// ---------------------------------------------------------------------------

const REPORTED = new Set<string>()

/**
 * Reports a SINKING or EMITTING failure ONCE per key.
 *
 * Why stderr and not the service: the thing that just failed IS (or is behind)
 * the service, so routing this line through it would re-enter the failing sink
 * (and, with the sink broken, lose the report). This is the ONE deliberate
 * print outside the service path in this repository, it names the sink and the
 * failure class only (never the Message args, which may carry anything), and it
 * happens at most once per key per process: a sink that fails on every Message
 * must not turn a log line into an outage.
 */
export function reportOnce(key: string, line: string): void {
  if (REPORTED.has(key)) return
  REPORTED.add(key)
  try {
    process.stderr.write(`[logger] ${line}\n`)
  } catch {
    /* stderr is gone: there is nothing left to report to, and the caller must still run */
  }
}

/** Forgets the one-shot report keys (tests). */
export function resetReports(): void {
  REPORTED.clear()
}

// ---------------------------------------------------------------------------
// The two entry points a plugin uses.
// ---------------------------------------------------------------------------

/** A handle that swallows everything: a host without the service prints NOTHING. */
const SILENT_LOGGER: LoggerHandle = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}

/**
 * The typed logger handle of a CONSUMER: `loggerOf(ctx, 'my-plugin')`. Use it
 * once in `apply()` and call `.info/.warn/.error/.debug` where the plugin used
 * to call `console.*`.
 *
 * - a host WITHOUT the logger service yields a SILENT handle (never `console`:
 *   "no exporter mounted = no output" is the model, not a reason to fall back);
 * - a SINK that throws while the message is emitted is caught here, reported
 *   once and NOT propagated: a broken sink can never break the caller's work.
 */
export function loggerOf(ctx: LoggerHost, name?: string): LoggerHandle {
  const service = ctx.logger
  if (service === undefined || typeof service !== 'function') return SILENT_LOGGER
  const emit = (level: LogLevelName) => (...args: unknown[]): void => {
    try {
      const handle = service(name)
      handle[level](...args)
    } catch (error) {
      reportOnce(
        `emit:${name ?? 'default'}:${level}`,
        `a sink threw while emitting '${name ?? 'default'}/${level}'; the emitter was protected and the sink is isolated: ${messageOf(error)}`,
      )
    }
  }
  return { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug') }
}

/** What {@link mountExporter} returns to the SINK plugin. */
export interface MountedExporter {
  /** True when the service accepted the sink (a host without the service: false). */
  mounted: boolean
  /** How many Messages the sink FAILED on (the isolation counter). */
  failures(): number
  /**
   * Best-effort unmount. The registration is a cordis `effect`, so the sink is
   * already disposed when the plugin's fiber is disposed (unload / reload /
   * disable): a plugin normally does NOT need this.
   */
  dispose(): void
}

/**
 * Mounts ONE sink from a SINK PLUGIN: `mountExporter(ctx, { levels, export })`.
 *
 * The wrapper is the isolation cordis does not provide (a throwing exporter
 * propagates to the emitter, measured in cordis 4.0.0-rc.10): every `export`
 * call is guarded, a failure is counted and reported once, and the Message is
 * NOT re-emitted to the other sinks (the host already delivered it to them).
 */
export function mountExporter(ctx: LoggerHost, exporter: LogExporter, label = 'exporter'): MountedExporter {
  let failures = 0
  const guarded: LogExporter = {
    ...exporter,
    export(message: LogMessage): void {
      try {
        exporter.export(message)
      } catch (error) {
        failures += 1
        reportOnce(
          `export:${label}`,
          `exporter '${label}' threw on Message #${message.sn} (${message.name}/${message.type}) and is ISOLATED; ` +
            `later failures are counted, not printed: ${messageOf(error)}`,
        )
      }
    },
  }
  const service = ctx.logger
  if (service === undefined || typeof service.exporter !== 'function') {
    reportOnce(
      `mount:${label}`,
      `exporter '${label}' could not mount: the host context exposes no logger service (ctx.logger) - ` +
        'this host produces no log output at all',
    )
    return { mounted: false, failures: () => failures, dispose: () => {} }
  }
  const disposable = service.exporter(guarded)
  return {
    mounted: true,
    failures: () => failures,
    dispose: () => {
      const closer = (disposable as { dispose?: () => void } | undefined)?.dispose
      if (typeof closer === 'function') closer.call(disposable)
    },
  }
}

// ---------------------------------------------------------------------------
// The read side a ring/buffer sink offers (the inventory/settings UI reads it).
// ---------------------------------------------------------------------------

/** What a `logs` service answers: the bounded history a ring sink kept. */
export interface LogsReader {
  /** The last `count` Messages (oldest first), plus what it dropped. */
  tail(count?: number): { messages: LogMessage[]; dropped: number; size: number }
  /** The Messages kept, oldest first. */
  all(): LogMessage[]
  /** How many Messages the ring currently holds. */
  size(): number
  /** Drops everything kept. */
  clear(): void
}
