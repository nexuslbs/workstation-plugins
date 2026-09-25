// External workbench plugin: the CONSUMER of the SMS capability (`sms@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (core)  - the contract, `ctx.sms`
//   Provider           - a backend implementation (any `sms@1` provider plugin)
//   Consumer           - THIS plugin: it exposes the capability as TOOLS and
//                        never learns which backend answers.
//
// It imports NOTHING from the core and NOTHING from a provider: the only seam it
// touches is `ctx.sms` (injected by name) plus `ctx.tools` (`tools@1`,
// provided by core/tools-impl of this repository).
// Swapping the provider (disable one `sms@1` provider, enable another) is a
// config edit; this file does not change and its tools keep working, which is
// what `npm run check:seam` in the core repository enforces. No SMS backend and
// no phone number appears anywhere in the executable code here: the number is
// always a LABEL the operator configured, forwarded verbatim.

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

/** One declared tool parameter (the DSH-style property map the core publishes). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

type ToolParameters = Record<string, ToolParameter>

/** One configured number, as the capability reports it (never a secret). */
interface SmsNumberLike {
  label: string
  number?: string
  default?: boolean
  configured?: boolean
  description?: string
}

/** A LABEL naming a configured number - the capability's number reference. */
interface SmsRefLike {
  label: string
}

interface SmsSummaryLike {
  id: string
  from: string
  to: string
  date: string
  body: string
  status?: string
  unread?: boolean
}

interface SmsMessageLike extends SmsSummaryLike {
  segments?: number
  direction?: string
  error?: string
  media?: string[]
}

interface SmsCodeLike {
  code: string
  body: string
  from: string
  date: string
  messageId: string
}

/**
 * The consumer-visible subset of the capability. The core service implements
 * more (provider registry, `numbers`, `list`, `get`, `code`, `search`); a
 * consumer only depends on the methods it calls.
 */
interface SmsLike {
  numbers(): Promise<SmsNumberLike[]>
  list(ref?: SmsRefLike, options?: Record<string, unknown>): Promise<SmsSummaryLike[]>
  get(ref: SmsRefLike | undefined, id: string): Promise<SmsMessageLike>
  code(ref: SmsRefLike | undefined, options?: Record<string, unknown>): Promise<SmsCodeLike>
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  sms: SmsLike
  tools: ToolsLike
  effect(callback: () => () => void): void
}

export const name = 'sms-tools'

export interface Config {
  /** Cap of the `limit` parameter clients may ask for (default 50, max 100). */
  maxListLimit?: number
  /** Default `limit` when a caller omits it (default 10). */
  defaultListLimit?: number
  /** Report each message body in `sms list` (default true; `false` keeps previews only). */
  includeBodies?: boolean
}

/** The hard cap of the definition itself: a client can never ask for more. */
const HARD_MAX_LIMIT = 100

/**
 * A `number` parameter (`number: 'work'`) becomes the capability's number
 * REFERENCE (`{ label: 'work' }`). An omitted/blank parameter means "the
 * provider's default number", which is what an `undefined` reference does, so
 * the operator's `defaultNumber` config decides - never this plugin.
 */
function refOf(params: Record<string, unknown>): SmsRefLike | undefined {
  const label = params.number
  if (typeof label !== 'string' || label.trim().length === 0) return undefined
  return { label: label.trim() }
}

/** A trimmed non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A positive integer within [1, HARD_MAX_LIMIT], or the fallback. */
function clampLimit(value: number, max = HARD_MAX_LIMIT): number {
  if (!Number.isFinite(value) || value <= 0) return Math.min(HARD_MAX_LIMIT, max)
  return Math.min(HARD_MAX_LIMIT, max, Math.trunc(value))
}

/** A required non-empty string parameter, or a readable refusal. */
function required(param: unknown, label: string): string {
  const value = str(param)
  if (value === undefined) throw new Error(`sms-tools: the '${label}' parameter must be a non-empty string`)
  return value
}

/** The label of a call for reporting: the reference when given, else '(default)'. */
function labelOf(params: Record<string, unknown>): string {
  return str(params.number) ?? '(default)'
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const defaultListLimit = clampLimit(config.defaultListLimit ?? 10)
  const maxListLimit = clampLimit(config.maxListLimit ?? 50)
  const includeBodies = config.includeBodies !== false

  // 1) Which numbers exist, which one a call without a reference uses, and
  // which of them are actually usable. The tool NEVER keeps a roster of its own:
  // it forwards the capability, so the operator's config decides.
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'sms numbers',
      description:
        'lists the configured SMS numbers by label (which one is the default, and whether each has usable credentials); never a secret',
      parameters: {
        format: {
          type: 'string',
          description: "how much to report per number: 'labels' (default) or 'full'",
          enum: ['labels', 'full'],
        },
      },
      execute: async (params) => {
        const numbers = await ctx.sms.numbers()
        const full = params.format === 'full'
        return {
          count: numbers.length,
          default: numbers.find((number) => number.default)?.label,
          numbers: full ? numbers : numbers.map((number) => number.label),
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )

  // 2) The last N inbound messages of one number (default number when omitted).
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'sms list',
      description:
        'lists the newest inbound SMS of a number: optional number label (default number when omitted), limit, since, from and unreadOnly',
      parameters: {
        number: { type: 'string', description: 'number label (default: the configured default number)' },
        limit: {
          type: 'integer',
          description: `how many of the newest messages (default ${String(defaultListLimit)}, max ${String(maxListLimit)})`,
        },
        since: { type: 'string', description: 'ISO-8601 instant: only messages at/after it' },
        from: { type: 'string', description: 'only messages whose sender contains this (case-insensitive)' },
        unreadOnly: { type: 'boolean', description: 'only messages the backend reports as not read' },
      },
      execute: async (params) => {
        const options: Record<string, unknown> = { limit: clampLimit(Number(params.limit ?? defaultListLimit), maxListLimit) }
        const since = str(params.since)
        if (since !== undefined) options.since = since
        const from = str(params.from)
        if (from !== undefined) options.from = from
        if (params.unreadOnly !== undefined) options.unreadOnly = Boolean(params.unreadOnly)
        const messages = await ctx.sms.list(refOf(params), options)
        return {
          number: labelOf(params),
          count: messages.length,
          messages: includeBodies ? messages : messages.map((message) => ({ ...message, body: undefined })),
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )

  // 3) One message, full (bounded) body included.
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'sms get',
      description: 'reads one inbound SMS of a number by id: the full body plus its sender, recipient, date and delivery metadata',
      parameters: {
        id: { type: 'string', description: 'message id, as reported by "sms list"', required: true },
        number: { type: 'string', description: 'number label (default: the configured default number)' },
      },
      execute: async (params) => {
        const id = required(params.id, 'id')
        const message = await ctx.sms.get(refOf(params), id)
        return { number: labelOf(params), ...message }
      },
      output: { schema: {}, render: renderValue },
    })),
  )

  // 4) The operator's headline use case: the verification code inside an SMS.
  // The extraction rule lives in the Definition (one place, every provider), so
  // this handler only picks the message and forwards the options.
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'sms code',
      description:
        'extracts a verification code from an SMS (a given message id, or the newest message matching query/pattern) and reports which message it came from',
      parameters: {
        number: { type: 'string', description: 'number label (default: the configured default number)' },
        id: { type: 'string', description: 'read THIS message instead of scanning the newest ones' },
        query: { type: 'string', description: 'only messages whose sender/body contains this (case-insensitive)' },
        pattern: { type: 'string', description: 'explicit extraction pattern; group 1 (or the whole match) is the code' },
        occurrences: { type: 'integer', description: 'which code candidate to return when the message carries several (1 = the first, the default)' },
        maxAgeSeconds: { type: 'integer', description: 'ignore messages older than this many seconds' },
      },
      execute: async (params) => {
        const options: Record<string, unknown> = {}
        const id = str(params.id)
        if (id !== undefined) options.id = id
        const query = str(params.query)
        if (query !== undefined) options.query = query
        const pattern = str(params.pattern)
        if (pattern !== undefined) options.pattern = pattern
        if (params.occurrences !== undefined) options.occurrences = Number(params.occurrences)
        if (params.maxAgeSeconds !== undefined) options.maxAgeSeconds = Number(params.maxAgeSeconds)
        const found = await ctx.sms.code(refOf(params), options)
        return {
          number: labelOf(params),
          code: found.code,
          from: found.from,
          date: found.date,
          messageId: found.messageId,
          body: found.body,
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )

  // The four tools above ARE the plugin: nothing else to dispose (each
  // `ctx.effect` disposes its own registration when the plugin unloads).
}

export default { name, inject: ['sms', 'tools'], apply }
