// External workbench plugin: the CONSUMER of the TOTP capability (`totp@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4f):
//   Definition (core)  - the contract, `ctx.totp`
//   Provider           - a backend implementation (any `totp@1` provider plugin,
//                        e.g. core/totp-rfc6238)
//   Consumer           - THIS plugin: it exposes the capability as the tools
//                        `totp list` and `totp code` and never learns which
//                        provider answers.
//
// It imports NOTHING from the core and NOTHING from a provider: the only seams
// it touches are `ctx.totp` (injected by name) and `ctx.tools` (`tools@1`,
// provided by core/tools-impl of this repository).
// Swapping the provider (disable one `totp@1` provider, enable another) is a
// config edit; this file does not change and its tools keep working, which is
// what `npm run check:seam` in the core repository enforces. This plugin names
// no key handling anywhere: it never sees a secret, only the generated code.

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

/** One declared tool parameter (the property map the core publishes). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

type ToolParameters = Record<string, ToolParameter>

/** One configured entry, as the capability reports it (metadata only). */
interface TotpEntryLike {
  label: string
  issuer?: string
  account?: string
  digits: number
  period: number
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  configured: boolean
}

/** The generated code (the capability's `TotpCode`). */
interface TotpCodeLike {
  label: string
  code: string
  digits: number
  period: number
  algorithm: string
  generatedAt: number
  remainingSeconds: number
}

/**
 * The consumer-visible subset of the capability. The core service implements
 * more (provider registry, selection); a consumer only depends on the two
 * methods it calls.
 */
interface TotpLike {
  entries(): Promise<TotpEntryLike[]>
  code(label: string, options?: { at?: number }): Promise<TotpCodeLike> | TotpCodeLike
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  totp: TotpLike
  tools: ToolsLike
  effect(callback: () => () => void): void
}

export const name = 'totp-tools'

export interface Config {
  /** Reported with every code: whether to include the entry's issuer/account. */
  reportEntryMetadata?: boolean
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const reportMetadata = config.reportEntryMetadata !== false

  // 1) The inventory: which entries exist (labels + metadata). A key value is
  // never part of this answer because it is never part of the capability's
  // `entries()` either - the contract is metadata only.
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'totp list',
      description:
        'lists the configured TOTP entries: label, issuer, account, digits, period, algorithm and whether a key is configured; never a secret',
      parameters: {},
      execute: async () => {
        const entries = await ctx.totp.entries()
        return { count: entries.length, entries }
      },
      output: { schema: {}, render: renderValue },
    })),
  )

  // 2) The operator's headline use case: the CURRENT code of a named entry.
  // `at` (unix seconds) makes it deterministic for a test or a boundary check;
  // the capability answers for exactly that second and reports how long the code
  // stays valid (`remainingSeconds`).
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'totp code',
      description:
        'generates the current code of the named TOTP entry (label, optional unix-second `at`) and reports digits, period, algorithm, generatedAt and remainingSeconds',
      parameters: {
        label: { type: 'string', description: "entry label, as reported by 'totp list' (e.g. github)", required: true },
        at: {
          type: 'integer',
          description: 'unix SECONDS to generate for (default: now); useful for deterministic and boundary checks',
        },
      },
      execute: async (params) => {
        const label = str(params.label)
        if (label === undefined) throw new Error("totp code: the 'label' parameter must be a non-empty entry label")
        const at = int(params.at)
        const result = await ctx.totp.code(label, at === undefined ? {} : { at })
        const entries = reportMetadata ? await ctx.totp.entries() : undefined
        const entry = entries?.find((candidate) => candidate.label === result.label)
        return {
          label: result.label,
          code: result.code,
          digits: result.digits,
          period: result.period,
          algorithm: result.algorithm,
          generatedAt: result.generatedAt,
          remainingSeconds: result.remainingSeconds,
          ...(entry === undefined
            ? {}
            : {
                issuer: entry.issuer,
                account: entry.account,
              }),
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )
}

/** A trimmed non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A whole number, or `undefined` (the core already rejected a non-integer). */
function int(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

export default { name, inject: ['totp', 'tools'], apply }
