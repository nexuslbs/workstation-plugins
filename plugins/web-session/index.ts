// `web-session`: ONE multiplexed browser tool with an ACTION ENUM.
//
// The design constraint of this plugin (thread 2415) is the TOOL SURFACE: every
// tool schema is paid for in every prompt, and a 24-tool browser driver is both
// expensive and a source of wrong-tool choices. So this plugin registers exactly
// ONE tool, `session`, whose `action` enum covers the whole browser workflow:
//
//   open   - a site's session label -> a live, authenticated page
//   act    - an ordered list of steps (click/fill/select/press/waitFor/navigate)
//            answered with a DELTA (what changed), never with the page again
//   read   - a selector-scoped slice (CSS / XPath / role+name), or the bounded
//            page OUTLINE, or the DISCOVERED JSON endpoints, or one of them
//            called DIRECTLY (`api`) instead of re-rendering the DOM
//   close  - persist the storage state and drop the live browser context
//
// Sessions are per-site storage-state files (cookies + localStorage) under the
// configured state dir, so a session SURVIVES A PROCESS RESTART, and an expired
// session is re-established from `credential` NAMEs (resolved through
// `ctx.credentials` at login time, never logged, echoed or persisted).
//
// It is a CONSUMER plugin: the core stays a host/registry, the browser comes
// from the SHARED launcher in `shared/` (web-page uses the same one,
// so the two plugins never fight over chromium), and no per-site knowledge is
// hardcoded here - a site is config (and, later, the recipe store).
import { loggerOf, type LoggerHandle, type LoggerServiceLike } from '../../definitions/logger.ts'
import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'
import { resolveConfig } from './config.ts'
import type { WebSessionConfig } from './config.ts'
import type { SessionDriver } from './driver.ts'
import { SessionError, envelopeOf } from './errors.ts'
import { SessionManager, STEP_TYPES } from './manager.ts'

export const name = 'web-session'

export type { WebSessionConfig }

interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
  items?: ToolParameter
  properties?: ToolParameters
}

type ToolParameters = Record<string, ToolParameter>

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface CredentialsLike {
  resolve(ref: { name: string }): Promise<{ value: string } | undefined>
}

interface PluginContext {
  tools: ToolsLike
  credentials?: CredentialsLike
  effect(callback: () => () => void): void
  /** The logger SERVICE the core hosts (docs/LOGGING.md). */
  logger?: LoggerServiceLike
}

/** Optional collaborators, so the dispatch can be tested without a browser. */
export interface WebSessionDeps {
  driver?: SessionDriver
  now?: () => number
  /** Override the logger handle (default: the host logger service). */
  logger?: LoggerHandle
}

/** One `act` step: the closed set, documented in the README. */
const STEP_PARAMETERS: ToolParameters = {
  type: {
    type: 'string',
    required: true,
    enum: STEP_TYPES,
    description: 'click, fill, select, press, waitFor or navigate',
  },
  selector: {
    type: 'string',
    description: "CSS ('#id', 'main .card'), XPath ('//div[@id=\"x\"]' or 'xpath=...') or role+name ('role=button[name=\"Save\"]')",
  },
  value: {
    type: 'string',
    description: 'fill/select: the value; press: the key (default Enter); waitFor: the state (visible|hidden|attached|detached) or a ms wait when no selector is given',
  },
  url: { type: 'string', description: 'navigate: the URL to open (absolute, or relative to the site base URL; `value` is the fallback)' },
  timeout_ms: { type: 'integer', description: 'this step only: timeout in ms' },
}

const SESSION_PARAMETERS: ToolParameters = {
  action: {
    type: 'string',
    required: true,
    enum: ['open', 'act', 'read', 'close'],
    description: 'open: start/attach a site session; act: run steps and get a DELTA; read: get a slice/outline/endpoint; close: persist the state and stop',
  },
  site: {
    type: 'string',
    description: 'session label of the configured site table; default: the configured `defaultSite`',
  },
  url: { type: 'string', description: 'open: the page to open (absolute, or relative to the site base URL; default: the site base URL)' },
  steps: {
    type: 'array',
    items: { type: 'object', properties: STEP_PARAMETERS },
    description: 'act: ordered steps, each with a type, an optional selector/value/url and an optional timeout_ms',
  },
  selector: {
    type: 'string',
    description: "read: resolve ONLY this slice - CSS, XPath ('//...' or 'xpath=...') or role+name ('role=button[name=\"Load\"]')",
  },
  format: {
    type: 'string',
    enum: ['text', 'markdown', 'html', 'json'],
    description: 'read: how a selector match is rendered (default text; json returns one object per match)',
  },
  max_chars: { type: 'integer', description: 'read: cap of the returned body (the rest spills to a file)' },
  api: {
    type: 'string',
    description: "read: 'list' the discovered JSON/XHR endpoints, or an endpoint id/path/URL to call DIRECTLY and get its JSON (cheaper than re-rendering)",
  },
}

/**
 * The plugin entry. `deps` is a test seam (the core calls `apply(ctx, config)`);
 * without it the plugin builds the shared-chromium driver, lazily.
 */
export function apply(ctx: PluginContext, config: WebSessionConfig = {}, deps: WebSessionDeps = {}): void {
  const resolved = resolveConfig(config)
  const resolveCredential = async (credentialName: string): Promise<string | undefined> => {
    const credentials = ctx.credentials
    if (credentials === undefined) return undefined
    try {
      const resolution = await credentials.resolve({ name: credentialName })
      return resolution === undefined ? undefined : resolution.value
    } catch {
      // A credential that cannot be resolved is reported as a missing login
      // field by the manager; its VALUE never reaches a message either way.
      return undefined
    }
  }
  const log = loggerOf(ctx, name)
  const manager = new SessionManager(resolved, resolveCredential, { ...deps, logger: deps.logger ?? log })
  const unregister = ctx.tools.register(defineTool({
    name: 'session',
    description:
      'browser session by site label: one action enum (open|act|read|close) with persisted logins, change DELTAS after act, selector-scoped reads (CSS/XPath/role+name) and direct JSON endpoint calls (read {api:"list"})',
    parameters: SESSION_PARAMETERS,
    execute: async (params: Record<string, unknown>): Promise<unknown> => {
      try {
        return await manager.execute(params)
      } catch (error) {
        // A structured envelope, always: the process keeps serving and the
        // caller gets a machine-readable cause. A NON-SessionError is a bug in
        // this plugin (not a browser failure): its stack goes to the workbench
        // log once, so the operator can see where it came from - the response
        // stays the small `internal` envelope.
        if (!(error instanceof SessionError)) {
          log.error('unhandled failure:', error instanceof Error ? (error.stack ?? error.message) : String(error))
        }
        return envelopeOf(error, resolved.redact)
      }
    },
    output: { schema: {}, render: renderValue },
  }))
  ctx.effect(() => () => {
    unregister()
    void manager.dispose()
  })
}

export default { name, inject: ['credentials', 'tools'], apply }
