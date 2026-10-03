// External workstation plugin: ROLE DELEGATION as a model-facing tool.
//
// WHY THIS EXISTS (operator rule, telegram thread 3346, 2026-09-27): a dsh worker
// runs under ONE fixed role profile and a `subagent` inherits its parent's
// profile/model, so a running worker cannot switch itself to another role. Until
// now the only delegation seam was the FACADE tool `agent_run`, i.e. the hop
// worker -> WEB-SEARCH-REQUEST block -> orchestrator -> `agent_run websearcher`
// -> worker. The operator rejected that: it wastes orchestrator tokens and the
// orchestrator must stay at the MACRO level. Requirement: **dsh agents must be
// able to call other dsh agents directly**, and the single-purpose roles (the
// `websearcher`, the vision solver) are to be seen as a kind of
// NON-DETERMINISTIC DYNAMIC TOOL by the other dsh agents.
//
// WHAT THIS PLUGIN DOES: it registers ONE model-facing tool per DECLARED
// delegated role (config `roles`). A tool call runs ONE one-shot dsh run of that
// ROLE profile - the child has its own profile, model route, toolset, session
// and context window; the caller gets the child's final answer text back as the
// tool result. Example row (a worker role's cordis.patch.yml):
//
//   - insert:
//       - id: role-delegate
//         name: '/var/lib/workstation/sources/workstation-plugins/plugins/role-delegate/index.ts'
//         config:
//           roles:
//             - tool: websearcher
//               role: websearcher
//               template: /opt/omni/workstation/templates/workstation-websearcher.md
//
// The mechanism is deliberately the SAME machine as `plugins/agent-run/index.ts`
// (the proven orchestrator seam): provision the role profile from the user repo
// once, run `node <harnessDir>/apps/cli/lib/bin.js <role> "<briefing>"` as a
// child process with DSH_HOME pinned, return the child's stdout (in non-JSON
// mode the harness headless runner prints EXACTLY the final answer to stdout and
// the verbose log to stderr - verified in apps/cli/tests/profiles/headless).
// It is a SEPARATE module on purpose: agent-run is load-bearing for the facade
// and this plugin must not change its behaviour.
//
// RECURSION GUARD: every delegated child is launched with
// DSH_DELEGATE_DEPTH=<parent+1>. A profile loaded at depth >= `maxDepth`
// (default 2) registers NO delegation tool at all, so a delegation chain cannot
// run away.
//
// It never touches a credential: the child resolves its own key from the harness
// credential store ($DSH_HOME/.credentials.yaml) or the launch environment. A
// missing key fails LOUDLY in the returned output (dsh: MISSING_CREDENTIAL) with
// exit code != 0, and the tool says so instead of pretending to have searched.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { defineTool, renderValue, type ContentBlock, type ToolDefinition } from '../../definitions/tools.ts'
import { collectUsage, listSessionIds, projectKey, usageMarker, usageToken } from '../../shared/usage.ts'

/** One declared tool parameter (the property map the core publishes). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

type ToolParameters = Record<string, ToolParameter>

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

export const name = 'role-delegate'

/** ONE delegated role exposed as a model-facing tool. */
export interface DelegateRole {
  /** Tool name the model calls (default: the role name). */
  tool?: string
  /** dsh role/profile to run (a directory under the role profiles dir). */
  role: string
  /** Tool description shown to the model. NEVER guess a tool's purpose from its name. */
  description?: string
  /** Optional briefing file the child must read before working (a pointer, never content). */
  template?: string
  /** Fixed project (dsh session bucket) for the child runs of this role (default: the caller's project). */
  project?: string
  /** Per-tool wall-clock bound in seconds (default: the plugin's timeoutSecs). */
  timeoutSecs?: number
}

export interface Config {
  /** Harness checkout root (default $WORKSTATION_DIR or /harness). */
  harnessDir?: string
  /** Harness home (default $DSH_HOME or /var/lib/workstation). */
  dshHome?: string
  /** Role definitions shipped in the user repo (default /opt/omni/workstation/profiles). */
  roleProfilesDir?: string
  /** Project workspaces root (default $WORKSTATION_PROJECTS_DIR or /var/lib/workstation/projects). */
  projectsDir?: string
  /** Canonical profile provisioner (default /opt/omni/services/workstation/provision-role.sh). */
  provisionScript?: string
  /** Default role when the generic tool is called without one (default: websearcher). */
  defaultRole?: string
  /** Wall clock bound of ONE delegated run, seconds (default 900, bounded 30..7200). */
  timeoutSecs?: number
  /** Tail of a stream kept in the answer, chars (default 12000). */
  maxOutputChars?: number
  /** Maximum delegation depth; a child at this depth registers no delegation tool (default 2). */
  maxDepth?: number
  /** The roles exposed as tools. Empty/omitted -> only the generic tool is registered. */
  roles?: DelegateRole[]
  /** Name of the generic `role`-parameterised tool (default 'delegate'; empty string disables it). */
  genericTool?: string
}

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The caller cancelled this run (client disconnect): the child was killed. */
  aborted: boolean
}

/**
 * The caller cancellation signal of a harness tool call, when the harness
 * supplies one (`exec.signal`). Duck-typed: the plugin must stay usable on a
 * bare delegation plane whose execution context carries no signal.
 */
function abortSignalOf(exec: unknown): AbortSignal | undefined {
  const candidate = (exec as { signal?: unknown } | undefined)?.signal as AbortSignal | undefined
  if (candidate === undefined || candidate === null) return undefined
  return typeof (candidate as { addEventListener?: unknown }).addEventListener === 'function' ? candidate : undefined
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function int(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

/** The tail of a string (the answer / the error lives at the END of a stream). */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `[...${text.length - limit} chars elided...]\n${text.slice(text.length - limit)}`
}

/**
 * Render the NORMAL result for the model, WITHOUT the additive `_meta` block.
 * `_meta.usage` is accounting data for the PARENT agent (persisted through
 * `output.presentationMeta`), never model-facing content.
 */
function renderPublicResult(args: unknown, value: unknown): ContentBlock[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { _meta: _ignored, ...rest } = value as Record<string, unknown>
    return renderValue(args, rest)
  }
  return renderValue(args, value)
}

/** A project name is ONE path segment: lowercase, short, no traversal. */
function sanitizeProject(raw: string | undefined): string {
  const cleaned = (raw ?? 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return cleaned.length === 0 ? 'default' : cleaned.slice(0, 48)
}

/**
 * Run one command to completion, capturing both streams (never rejecting on a
 * non-zero exit).
 *
 * `signal` is the CALLER cancellation signal (`exec.signal`): when it aborts -
 * the HTTP client that dispatched this run went away, i.e. the omniagent
 * stopped the thread - the spawned dsh agent is SIGKILLed so it stops spending
 * tokens instead of running on with no consumer left.
 */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const signal = options.signal
    const onAbort = (): void => {
      if (aborted) return
      aborted = true
      stderr += `\n[cancelled: the calling client disconnected; killing ${command} pid ${String(child.pid)}]`
      child.kill('SIGKILL')
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      cleanup()
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut, aborted })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      resolve({ code, signal, stdout, stderr, timedOut, aborted })
    })
  })
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const harnessDir = str(config.harnessDir) ?? str(process.env.WORKSTATION_DIR) ?? '/harness'
  const dshHome = str(config.dshHome) ?? str(process.env.DSH_HOME) ?? '/var/lib/workstation'
  const roleProfilesDir = str(config.roleProfilesDir) ?? '/opt/omni/workstation/profiles'
  const projectsDir = str(config.projectsDir) ?? str(process.env.WORKSTATION_PROJECTS_DIR) ?? '/var/lib/workstation/projects'
  const sessionsDir = join(dshHome, 'sessions')
  const provisionScript = str(config.provisionScript) ?? '/opt/omni/services/workstation/provision-role.sh'
  const defaultRole = str(config.defaultRole) ?? 'websearcher'
  const timeoutSecs = Math.min(Math.max(int(config.timeoutSecs) ?? 900, 30), 7200)
  const maxOutputChars = Math.max(int(config.maxOutputChars) ?? 12000, 1000)
  const maxDepth = Math.max(int(config.maxDepth) ?? 2, 1)
  const genericTool = config.genericTool === '' ? undefined : (str(config.genericTool) ?? 'delegate')
  const bin = join(harnessDir, 'apps', 'cli', 'lib', 'bin.js')

  const declared = Array.isArray(config.roles) ? config.roles.filter((entry) => str(entry?.role) !== undefined) : []

  /**
   * The dsh roles this deployment supports: the directories under the role tree
   * (`roleProfilesDir`), the SAME source the canonical provisioner and this
   * plugin's own generic tool description name. Read at call time so a role
   * added to the user repo is accepted without reloading the plugin.
   */
  const supportedRoles = (): string[] => {
    try {
      return readdirSync(roleProfilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  // The delegation depth of THIS process. A worker launched by a delegated call
  // inherits it through the environment; at maxDepth a profile registers no
  // delegation tool at all (no runaway chains).
  const depth = int(process.env.DSH_DELEGATE_DEPTH) ?? 0
  if (depth >= maxDepth) {
    ctx.logger?.info?.(`role-delegate: delegation depth ${depth} >= maxDepth ${maxDepth}; no delegation tool registered`)
    return
  }

  /** The project (dsh session bucket) of a delegated run: the caller's own project by default. */
  const callerProject = (): string => {
    const cwd = process.cwd()
    if (cwd.startsWith(`${projectsDir}/`)) return sanitizeProject(basename(cwd))
    return 'default'
  }

  /**
   * Make sure $DSH_HOME/profiles/<role> exists, using the CANONICAL provisioner
   * (services/workstation/provision-role.sh: manifest from a provisioned sibling
   * + the role's cordis.patch.yml from the user repo). Idempotent; a role whose
   * patch CHANGED keeps the old patch until this script is re-run - that is the
   * documented re-provision step of a role.
   */
  const ensureProfile = async (role: string): Promise<string[]> => {
    const manifest = join(dshHome, 'profiles', role, 'package.json')
    if (existsSync(manifest)) return [`profile '${role}' present (${join(dshHome, 'profiles', role)})`]
    const result = await run('sh', [provisionScript, role, dshHome, roleProfilesDir], {
      cwd: '/',
      env: { ...process.env, DSH_HOME: dshHome },
      timeoutMs: 180000,
    })
    if (!existsSync(manifest)) {
      throw new Error(
        `role-delegate: role '${role}' could not be provisioned (no profile at ${join(dshHome, 'profiles', role)}); ` +
          `provisioner exit=${String(result.code)}\n${tail(result.stderr, 2000)}`,
      )
    }
    return [
      `provisioned '${role}' via ${provisionScript}`,
      tail(result.stdout.trim(), 2000),
    ]
  }

  /** Run ONE delegated child agent of `role` and return its final answer. */
  const delegate = async (
    toolName: string,
    role: string,
    objective: string,
    options: { template?: string; project?: string; timeoutSecs?: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> => {
    const bound = Math.min(Math.max(options.timeoutSecs ?? timeoutSecs, 30), 7200)
    const notes = await ensureProfile(role)

    const project = sanitizeProject(options.project ?? callerProject())
    const workspace = join(projectsDir, project)
    mkdirSync(workspace, { recursive: true })

    const task = options.template === undefined
      ? objective
      : `Your briefing is the file ${options.template} - read it first with the fs tool and follow it. Objective: ${objective}`
    // The unique `call=<token>` marker lets this plugin locate the CHILD's own
    // session after the run: a child that delegates creates grandchild sessions
    // in the SAME project bucket, so only the marker tells them apart.
    const marker = usageMarker(usageToken())
    const header = `[delegated by ${toolName} role=${role} project=${project} depth=${depth + 1} ${marker}]`
    const briefing = `${header}\n\n${task}`

    const bucket = projectKey(workspace)
    const before = listSessionIds(sessionsDir, bucket)
    const started = Date.now()
    const result = await run('node', [bin, role, briefing], {
      cwd: workspace,
      // DSH_HOME is handed to the child EXPLICITLY (never ambient) and the depth
      // is incremented, so the child's own delegation budget is bounded.
      env: { ...process.env, DSH_HOME: dshHome, DSH_DELEGATE_DEPTH: String(depth + 1) },
      timeoutMs: bound * 1000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const durationSecs = Math.round((Date.now() - started) / 1000)
    // Non-JSON headless mode: stdout IS the final answer (verified), stderr is the log.
    const answer = result.stdout.trim()

    // USAGE (the child's own tokens), in call order, last = child aggregate.
    const usageReport = collectUsage({ sessionsDir, bucket, before, marker, agent: role })

    return {
      tool: toolName,
      role,
      project,
      workspace,
      objective,
      ...(options.template === undefined ? {} : { template: options.template }),
      exitCode: result.code,
      timedOut: result.timedOut,
      aborted: result.aborted,
      durationSecs,
      modelRoute: 'the delegated role profile resolves its own route (see the role PROFILE.md)',
      // Empty stdout with a non-zero exit is a FAILED delegation, never an empty
      // finding: the caller must see that instead of inventing a result.
      answer,
      answerChars: answer.length,
      ...(answer.length === 0
        ? { failure: `delegated run of role '${role}' produced no answer (exitCode=${String(result.code)}); see stderrTail` }
        : {}),
      command: `node ${bin} ${role} "<briefing>" (cwd ${workspace})`,
      provisioningNotes: notes,
      ...(answer.length === 0 ? { stderrTail: tail(result.stderr, maxOutputChars) } : { stderrTail: tail(result.stderr, 2000) }),
      // ADDITIVE accounting block, never mixed into the fields above: returned
      // to the caller and, for a nested call, persisted on the `tool/result`
      // event so the parent agent splices it at the call point.
      _meta: {
        usage: usageReport.usage,
        ...(usageReport.error === undefined ? {} : { usage_error: usageReport.error }),
        ...(usageReport.sessionLog === undefined ? {} : { usage_session_log: usageReport.sessionLog }),
      },
    }
  }

  const objectiveParam: ToolParameter = {
    type: 'string',
    description: 'the exact question / instruction for the delegated agent, stated as a goal with what to return (for a search role: the exact queries and what to extract)',
    required: true,
  }

  const register = (toolName: string, description: string, parameters: ToolParameters, call: (params: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>, timeoutFor: DelegateRole | undefined): void => {
    ctx.effect(() =>
      ctx.tools.register(defineTool({
        name: toolName,
        description,
        parameters,
        execute: async (params, exec) => {
          const objective = str(params.objective)
          if (objective === undefined) throw new Error(`${toolName}: the 'objective' parameter must be a non-empty task statement`)
          const requestedTimeout = int(params.timeoutSecs)
          return await call({
            objective,
            // The generic tool's `role` parameter MUST survive this wrapper: the
            // generic handler reads it to pick the profile to run. Dropping it
            // silently rerouted every delegation to `defaultRole`.
            ...(str(params.role) === undefined ? {} : { role: str(params.role) }),
            ...(str(params.project) === undefined ? {} : { project: str(params.project) }),
            ...(requestedTimeout === undefined ? {} : { timeoutSecs: requestedTimeout }),
            ...(timeoutFor === undefined ? {} : {}),
          }, exec)
        },
        output: {
          schema: {},
          render: renderPublicResult,
          // Persist `_meta` as `data.meta` on the `tool/result` event (NOT model
          // content) so the parent agent splices the child usage array.
          presentationMeta: (_args, value) => {
            const meta = value !== null && typeof value === 'object' ? (value as { _meta?: unknown })._meta : undefined
            return { _meta: meta ?? { usage: [] } }
          },
        },
      })),
    )
  }

  for (const entry of declared) {
    const role = String(str(entry.role))
    const toolName = str(entry.tool) ?? role
    const description = str(entry.description) ??
      `runs ONE dsh dev-agent of the '${role}' role on the objective you pass and returns its final answer. The delegated agent is a full harness peer (own role profile, model route, tools, session) - a NON-DETERMINISTIC DYNAMIC TOOL: call it when the job needs that role's capability, then use the returned answer. A run with no answer and a non-zero exit failed LOUDLY (see failure/stderrTail); never read that as an empty finding.`
    const template = str(entry.template)
    const fixedProject = str(entry.project)
    register(
      toolName,
      description,
      {
        objective: objectiveParam,
        project: {
          type: 'string',
          description: `the PROJECT (dsh session bucket) of the delegated run (default: the caller's own project)`,
        },
        timeoutSecs: { type: 'integer', description: `wall-clock bound of this ONE delegated run in seconds (default ${int(entry.timeoutSecs) ?? timeoutSecs})` },
      },
      async (params, exec) => await delegate(toolName, role, String(params.objective), {
        ...(template === undefined ? {} : { template }),
        project: fixedProject ?? (str(params.project) as string | undefined),
        timeoutSecs: int(params.timeoutSecs) ?? int(entry.timeoutSecs),
        ...(abortSignalOf(exec) === undefined ? {} : { signal: abortSignalOf(exec) as AbortSignal }),
      }),
      entry,
    )
  }

  if (genericTool !== undefined) {
    register(
      genericTool,
      `runs ONE dsh dev-agent of a role you NAME and returns its final answer (a NON-DETERMINISTIC DYNAMIC TOOL: the delegated agent is a full harness peer with its own profile, model route, tools and session). Role profiles: the directories under the workstation role tree (e.g. websearcher, vision-captcha, researcher, developer, tester, devops, designer, author, reviewer).`,
      {
        role: { type: 'string', description: `the role profile to run (default: ${defaultRole})` },
        objective: objectiveParam,
        project: { type: 'string', description: 'the PROJECT (dsh session bucket) of the delegated run (default: the caller\'s own project)' },
        timeoutSecs: { type: 'integer', description: `wall-clock bound of this ONE delegated run in seconds (default ${timeoutSecs})` },
      },
      async (params, exec) => {
        const role = str(params.role) ?? defaultRole
        // Fail CLOSED on an unsupported role: never silently run some other
        // profile. The valid set is the role tree the provisioner reads.
        const roles = supportedRoles()
        if (!roles.includes(role)) {
          throw new Error(`${genericTool}: unsupported role '${role}'; valid roles are: ${roles.length === 0 ? `(none found under ${roleProfilesDir})` : roles.join(', ')}`)
        }
        const toolName = `${genericTool}:${role}`
        return await delegate(toolName, role, String(params.objective), {
          project: str(params.project),
          timeoutSecs: int(params.timeoutSecs),
          ...(abortSignalOf(exec) === undefined ? {} : { signal: abortSignalOf(exec) as AbortSignal }),
        })
      },
      undefined,
    )
  }
}

export default { name, inject: ['tools'], apply }
