// External workstation plugin: the AGENT-RUN seam of the workstation facade
// (`agent run`). This is the row the orchestrator delegation surface was missing
// (see config/workstation.yml DECISION 6 and the wiki page
// Projects/Omniagent/Workstation-Standard-Config.md).
//
// The facade (`plugins/http-surface`) dispatches through the harness ToolRuntime,
// so whatever a facade tool does, `workstation__tool {"tool": "agent run", ...}`
// does over HTTP: this plugin turns one facade call into ONE dsh worker run - the
// delegation hop "orchestrator -> workstation__tool -> dsh subagent (profile +
// template) -> artifact" is exactly this tool.
//
// It runs the harness CLI as a child process, because a one-shot WORKER is a
// separate agent process (own context window, own model route, own sandbox
// policy), not a service call:
//
//   node <harnessDir>/apps/cli/lib/bin.js <role> "<briefing>"
//
// The role is a PROFILE under $DSH_HOME/profiles/<role>. Because a fresh profile
// cannot run anything (the shipped shell sandbox has no backend and a one-shot
// run has no approval channel), the tool provisions the role ONCE per dispatch:
// it creates the profile from the harness' `headless` default profile and copies
// the role's `cordis.patch.yml` (shipped in the user repo at
// /opt/omni/workstation/profiles/<role>/cordis.patch.yml) into it. Provisioning
// is idempotent, so a second dispatch to the same role skips it.
//
// It never touches a credential: the worker resolves DEEPSEEK_API_KEY itself,
// from the harness credential store ($DSH_HOME/.credentials.yaml) or the launch
// environment. A missing key fails LOUDLY in the returned output
// (dsh: MISSING_CREDENTIAL) with exit code != 0.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

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

export const name = 'agent-run'

export interface Config {
  /** Harness checkout root (default $WORKSTATION_DIR or /harness). */
  harnessDir?: string
  /** Harness home (default $DSH_HOME or /var/lib/workstation). */
  dshHome?: string
  /** Role definitions shipped in the user repo (default /opt/omni/workstation/profiles). */
  roleProfilesDir?: string
  /** Default role when a caller omits it (default: developer). */
  defaultRole?: string
  /** Wall clock bound of ONE worker run, seconds (default 1200, bounded 30..7200). */
  timeoutSecs?: number
  /** Tail of stdout/stderr kept in the answer, chars per stream (default 12000). */
  maxOutputChars?: number
}

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Trim a string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A whole number, or `undefined`. */
function int(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

/** The tail of a string (the worker's final answer lives at the END of stdout). */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `[...${text.length - limit} chars elided...]\n${text.slice(text.length - limit)}`
}

/** Run one command to completion, capturing both streams (never rejecting on a non-zero exit). */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const harnessDir = str(config.harnessDir) ?? str(process.env.WORKSTATION_DIR) ?? '/harness'
  const dshHome = str(config.dshHome) ?? str(process.env.DSH_HOME) ?? '/var/lib/workstation'
  const roleProfilesDir = str(config.roleProfilesDir) ?? '/opt/omni/workstation/profiles'
  const defaultRole = str(config.defaultRole) ?? 'developer'
  const timeoutSecs = Math.min(Math.max(int(config.timeoutSecs) ?? 1200, 30), 7200)
  const maxOutputChars = Math.max(int(config.maxOutputChars) ?? 12000, 1000)
  const bin = join(harnessDir, 'apps', 'cli', 'lib', 'bin.js')

  /** Create $DSH_HOME/profiles/<role> from the headless default profile, once. */
  const ensureRole = async (role: string): Promise<{ provisioned: boolean; notes: string[] }> => {
    const notes: string[] = []
    const profileDir = join(dshHome, 'profiles', role)
    const manifest = join(profileDir, 'package.json')
    let provisioned = false
    if (!existsSync(manifest)) {
      mkdirSync(profileDir, { recursive: true })
      const init = await run('node', [bin, role, '--from-default-profile', 'headless'], {
        cwd: harnessDir,
        env: process.env,
        timeoutMs: 120000,
      })
      provisioned = true
      notes.push(`profile '${role}' created from the headless default profile (exit ${init.code})`)
    }
    const patch = join(roleProfilesDir, role, 'cordis.patch.yml')
    if (existsSync(patch)) {
      copyFileSync(patch, join(profileDir, 'cordis.patch.yml'))
      notes.push(`role patch copied: ${patch} -> ${profileDir}/cordis.patch.yml`)
    } else {
      notes.push(`WARNING: no role patch at ${patch}: the worker's bash will be refused by the default sandbox policy`)
    }
    return { provisioned, notes }
  }

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'agent run',
      description:
        'runs ONE dsh worker agent (a subagent) with a ROLE profile and a briefing and returns its result: role (a profile under $DSH_HOME/profiles), objective (the task) and template (optional briefing file the worker must read first). Each call is an isolated agent process with its own context window and model route; the answer carries the exit code, the worker\'s output and the provisioning notes, so an orchestrator verifies the artifact it asked for instead of trusting prose. A missing DEEPSEEK_API_KEY fails loudly (dsh: MISSING_CREDENTIAL, non-zero exit) after zero work.',
      parameters: {
        role: {
          type: 'string',
          description: `worker role/profile to run (e.g. developer, designer, devops, tester, researcher); default: ${defaultRole}`,
        },
        objective: {
          type: 'string',
          description: 'the task for the worker, stated as a goal with its success criteria and the evidence to return',
          required: true,
        },
        template: {
          type: 'string',
          description: 'absolute path of the project briefing the worker must read BEFORE working (e.g. /opt/omni/workstation/templates/<project>-<role>.md); pass the pointer, never the content',
        },
        workdir: {
          type: 'string',
          description: 'working directory handed to the worker (default: a scratch dir under $DSH_HOME/work, so the worker starts neutral)',
        },
        timeoutSecs: {
          type: 'integer',
          description: `wall-clock bound of this ONE worker run in seconds (default ${timeoutSecs})`,
        },
      },
      execute: async (params) => {
        const objective = str(params.objective)
        if (objective === undefined) throw new Error("agent run: the 'objective' parameter must be a non-empty task statement")
        const role = str(params.role) ?? defaultRole
        const template = str(params.template)
        const workdir = str(params.workdir) ?? join(dshHome, 'work', role)
        const bound = Math.min(Math.max(int(params.timeoutSecs) ?? timeoutSecs, 30), 7200)

        const provisioning = await ensureRole(role)
        if (!existsSync(join(dshHome, 'profiles', role, 'package.json'))) {
          throw new Error(`agent run: role '${role}' could not be provisioned (no profile at ${join(dshHome, 'profiles', role)})`)
        }

        const briefing = template === undefined
          ? objective
          : `Your briefing is the file ${template} - read it first with the fs tool and follow it. Objective: ${objective}`
        mkdirSync(workdir, { recursive: true })

        const started = Date.now()
        const result = await run('node', [bin, role, briefing], { cwd: harnessDir, env: process.env, timeoutMs: bound * 1000 })
        const durationSecs = Math.round((Date.now() - started) / 1000)

        return {
          role,
          objective,
          ...(template === undefined ? {} : { template }),
          workdir,
          command: `node ${bin} ${role} "<briefing>" (cwd ${harnessDir})`,
          exitCode: result.code,
          timedOut: result.timedOut,
          durationSecs,
          provisioningNotes: provisioning.notes,
          stdoutTail: tail(result.stdout, maxOutputChars),
          stderrTail: tail(result.stderr, maxOutputChars),
        }
      },
      output: { schema: {}, render: renderValue },
    })),
  )
}

export default { name, inject: ['tools'], apply }
