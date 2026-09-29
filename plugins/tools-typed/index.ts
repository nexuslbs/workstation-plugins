// plugins/tools-typed - the TYPED FACADE TOOLS of the workstation-tools concern.
//
// Usage evidence (2026-09-26..29: python3 1066 productive calls across 155
// sessions, jq 27 calls across 4 sessions) selected the two general tools worth
// a TYPED, model-facing parameter surface. Everything else stays reachable
// through the generic container-exec `tools_exec` fallback (a config-only
// concern row, no code here).
//
// Two tools, both executing INSIDE the `workstation-tools` compose service
// through the `general-service@1` container transport (docker-impl ->
// `docker compose exec -T <service> sh -c <command>`), exactly like
// container-exec reaches the concern images and himalaya-impl reaches the
// email CLI. The container is the security boundary: only `/opt/omni/**` is
// mounted (read-only), nothing runs on the workstation host.
//
//   * jq_query   - run a jq program over inline JSON or a file inside the
//                  container; the parsed JSON answer comes back as `result`.
//   * python_run - run Python source with `python3 -c`, optional stdin, argv
//                  and cwd; the raw stdout comes back as `stdout`.
//
// SAFETY: every caller-supplied value (filter, json, file, code, stdin, cwd,
// args) is POSIX single-quoted with the shared `shellQuote` helper before it
// reaches the shell, so no value can break out into a second command. Boolean
// switches are the only unquoted interpolations and their values are literals
// chosen here, never caller text.
//
// NAMING: `jq_query` and `python_run` are single legal model-facing names
// (`^[a-zA-Z0-9_-]+$`), snake_case like every other tool of this repository.
//
// NO SECRETS: the plugin holds no credential; a DSN/password is a call-time
// parameter or an `$env:VAR` / `${cred:NAME}` reference the caller resolves,
// never a config value and never a committed file.

import { shellQuote } from '../../definitions/support.ts'
import {
  GENERAL_SERVICE,
  type GeneralService,
  type GeneralServiceConfig,
} from '../../definitions/general-service.ts'
import { defineTool, renderValue, type ParameterSchemaSpec, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'tools-typed'

/** The compose service the typed tools exec into by default. */
export const DEFAULT_SERVICE = 'workstation-tools'

/** The compose project directory (the `-p`/`--project-directory` argument). */
export const DEFAULT_PROJECT_DIR = '/opt/omni'

/** Default bound of one call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60000

/** Hard ceiling of one call's bound, in milliseconds. */
export const MAX_TIMEOUT_MS = 600000

/** The container transport engine the typed tools always use. */
export const COMPOSE_ENGINE = 'docker-compose'

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  get(serviceName: string, strict?: boolean): unknown
  effect?(callback: () => () => void): void
}

export interface Config {
  /** Compose service to exec into (default `workstation-tools`). */
  service?: string
  /** Compose project directory (default `/opt/omni`). */
  projectDir?: string
  /** Default per-call bound in ms (default 60000, hard cap 600000). */
  timeoutMs?: number
}

/** The resolved, validated config the tools are built with. */
export interface ToolsTypedSettings {
  service: string
  projectDir: string
  timeoutMs: number
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

/** Resolves the config to defaults + caps, ignoring malformed values. */
export function settings(config: Config = {}): ToolsTypedSettings {
  return {
    service: nonEmptyString(config.service, DEFAULT_SERVICE),
    projectDir: nonEmptyString(config.projectDir, DEFAULT_PROJECT_DIR),
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  }
}

/** One declared tool: description + author-form parameters + handler. */
type ToolHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>

export interface ToolSpec {
  description: string
  parameters: ParameterSchemaSpec
  handler: ToolHandler
}

/** Trimmed non-empty string, or undefined. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** `ok` when `output` parses as one JSON value, `no` otherwise. */
function tryParseJson(output: string): { ok: true; value: unknown } | { ok: false } {
  if (output.trim().length === 0) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(output) }
  } catch {
    return { ok: false }
  }
}

/** The `container` target shared by both tools (one place, no host fallback). */
function containerTarget(settings: ToolsTypedSettings): GeneralServiceConfig {
  return {
    type: 'container',
    params: {
      engine: COMPOSE_ENGINE,
      compose: { project_dir: settings.projectDir, service: settings.service },
    },
  }
}

/** The general-service, or undefined when the provider is not loaded. */
function resolveGeneralService(ctx: PluginContext): GeneralService | undefined {
  return ctx.get(GENERAL_SERVICE, false) as GeneralService | undefined
}

const MISSING_SERVICE = {
  ok: false,
  error: 'missing-service',
  message:
    'no general-service@1 provider is loaded (enable core/general-service-impl + the docker-compose transport)',
} as const

/**
 * The tools this consumer registers. `jq_query` runs a jq program over inline
 * JSON or a container-local file; `python_run` runs Python source with
 * `python3 -c`.
 */
export function tools(config: Config = {}, ctx: PluginContext): Record<string, ToolSpec> {
  const resolved = settings(config)

  return {
    jq_query: {
      description:
        'Runs a jq program over inline JSON text or a JSON file visible INSIDE the workstation-tools ' +
        "container (only /opt/omni/** is mounted, read-only). Pass exactly one of json (inline) or " +
        'file (container path); raw adds -r, slurp adds -s, compact adds -c (default true). The stdout ' +
        'is returned as output and, when it parses as JSON, as result.',
      parameters: {
        filter: {
          type: 'string',
          description: 'jq filter/program, e.g. .tables.workspaces|keys',
          required: true,
        },
        json: { type: 'string', description: 'inline JSON text; mutually exclusive with file' },
        file: {
          type: 'string',
          description: 'JSON file visible INSIDE workstation-tools; only /opt/omni/** is mounted, read-only',
        },
        raw: { type: 'boolean', description: 'jq -r (raw string output)' },
        slurp: { type: 'boolean', description: 'jq -s (slurp inputs into one array)' },
        compact: { type: 'boolean', description: 'jq -c (compact output, default true)' },
      },
      handler: async (params) => {
        const filter = optionalText(params.filter)
        if (filter === undefined) {
          return { ok: false, error: 'invalid-input', message: "a non-empty `filter` is required" }
        }
        const hasJson = typeof params.json === 'string' && params.json.length > 0
        const file = optionalText(params.file)
        if (hasJson && file !== undefined) {
          return { ok: false, error: 'invalid-input', message: "pass either 'json' (inline) or 'file', not both" }
        }
        if (!hasJson && file === undefined) {
          return { ok: false, error: 'invalid-input', message: "one of 'json' (inline) or 'file' is required" }
        }

        const flags: string[] = []
        if (params.compact !== false) flags.push('-c')
        if (params.raw === true) flags.push('-r')
        if (params.slurp === true) flags.push('-s')
        const invocation = ['jq', ...flags, shellQuote(filter)].join(' ')
        const command = hasJson
          ? `printf '%s' ${shellQuote(params.json as string)} | ${invocation}`
          : `${invocation} ${shellQuote(file as string)}`

        const general = resolveGeneralService(ctx)
        if (general === undefined) return MISSING_SERVICE
        const result = await general.call(command, containerTarget(resolved), { timeoutMs: resolved.timeoutMs })
        const parsed = tryParseJson(result.output)
        return {
          ok: true,
          service: resolved.service,
          code: result.code,
          ...(parsed.ok ? { result: parsed.value } : {}),
          output: result.output,
          ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
          durationMs: result.durationMs,
          ...(result.truncated === true ? { truncated: true } : {}),
        }
      },
    },

    python_run: {
      description:
        'Runs Python source with `python3 -c` INSIDE the workstation-tools container (only /opt/omni/** ' +
        'exists there). Optional stdin is piped to the process, args become sys.argv[1:], cwd changes ' +
        'directory first, and timeoutMs bounds this one call (default 60000, cap 600000). Returns the ' +
        'raw stdout plus stderr, exit code and duration.',
      parameters: {
        code: { type: 'string', description: 'Python source executed with python3 -c', required: true },
        stdin: { type: 'string', description: 'text piped to the process standard input' },
        args: { type: 'array', items: { type: 'string' }, description: 'argv items passed after the code, sys.argv[1:]' },
        cwd: { type: 'string', description: 'working directory inside workstation-tools; only /opt/omni/** exists' },
        timeoutMs: {
          type: 'integer',
          description: `per-call bound ms, default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}`,
        },
      },
      handler: async (params) => {
        const code = optionalText(params.code)
        if (code === undefined) {
          return { ok: false, error: 'invalid-input', message: "a non-empty `code` is required" }
        }
        const stdin = typeof params.stdin === 'string' ? params.stdin : ''
        const cwd = optionalText(params.cwd)
        const argv = Array.isArray(params.args) ? params.args.filter((entry): entry is string => typeof entry === 'string') : []
        const timeoutMs = Math.min(
          positiveInt(params.timeoutMs, resolved.timeoutMs, MAX_TIMEOUT_MS),
          MAX_TIMEOUT_MS,
        )

        const parts: string[] = []
        if (cwd !== undefined) parts.push(`cd ${shellQuote(cwd)} &&`)
        parts.push(`printf '%s' ${shellQuote(stdin)} | python3 -c ${shellQuote(code)}`)
        if (argv.length > 0) parts.push(argv.map((entry) => shellQuote(entry)).join(' '))
        const command = parts.join(' ')

        const general = resolveGeneralService(ctx)
        if (general === undefined) return MISSING_SERVICE
        const result = await general.call(command, containerTarget(resolved), { timeoutMs })
        return {
          ok: true,
          service: resolved.service,
          code: result.code,
          stdout: result.output,
          ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
          durationMs: result.durationMs,
          ...(result.truncated === true ? { truncated: true } : {}),
        }
      },
    },
  }
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const registered = tools(config, ctx)
  const install = (): (() => void) => {
    const disposers = Object.entries(registered).map(([toolName, tool]) =>
      ctx.tools.register(defineTool({
        name: toolName,
        description: tool.description,
        parameters: tool.parameters,
        execute: tool.handler,
        output: { schema: {}, render: renderValue },
      })),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(install)
  else install()
}

export default { name, inject: ['tools'], apply }
