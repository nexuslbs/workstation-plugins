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
//
// PER-PROJECT SESSION ORGANIZATION (operator requirement, 2026-09-27).
// dsh stores every session under $DSH_HOME/sessions/--<normalized-cwd>--/, i.e.
// the PROJECT BUCKET is the cwd of the run (packages/session/README + the agent
// note `2026-07-24-project-session-directories`). This tool therefore runs the
// worker with its cwd set to a PER-PROJECT workspace
// (`<projectsDir>/<project>`, default /var/lib/workstation/projects/<project>),
// so dispatches group by project instead of piling every run into the single
// `--harness--` bucket, and every worker of one project shares the session-search
// authority of that workspace (dsh-tool-session-query authorizes cross-session
// access only on EXACT cwd equality).
//
// The session id itself is dsh-generated (`session-<uuid>`): the harness CLI's
// `--session-id` only RESUMES an existing session (an unknown id fails with
// `session "<id>" does not exist; omit --session-id to start a new Session`,
// apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts), it can never
// NAME a new one. So this tool puts the STRUCTURED id
// (`<role>-<project>-<timestamp>-<suffix>`) where it does help: as the first line
// of the first prompt (the LLM session title is derived from that prompt and the
// text is indexed by the FTS session-query backend), into the answer, and into a
// per-project `dsh-sessions.jsonl` dispatch record that maps the structured id to
// the real session directory the run created (discoverability, retention, search).

import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
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
  /**
   * Root of the PROJECT workspaces (default $WORKSTATION_PROJECTS_DIR or
   * /var/lib/workstation/projects). One subdirectory per project; the worker's
   * cwd is `<projectsDir>/<project>` and that cwd IS the dsh session project
   * bucket, so the layout (and the workspace-scoped session search) follow the
   * project. Overridden by the `WORKSTATION_PROJECTS_DIR` env var.
   */
  projectsDir?: string
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

/** A project name is ONE path segment: lowercase, short, no traversal. */
function sanitizeProject(raw: string | undefined): string {
  const cleaned = (raw ?? 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return cleaned.length === 0 ? 'default' : cleaned.slice(0, 48)
}

/** A compact UTC stamp for the structured session id (YYYYMMDD-HHMMSS). */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
}

/** A short random suffix so two dispatches in the same second never collide. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7)
}

/**
 * The dsh session PROJECT BUCKET directory name for one cwd.
 *
 * The JSONL session backend stores sessions under `--<normalized-cwd>--` with the
 * filesystem separators replaced by `-` (packages/session/session-persistence-jsonl
 * README, "On-disk layout"). Replicating that normalization is how this tool
 * reports the session directory a run created: the id inside the bucket is a
 * dsh-generated `session-<uuid>` that no CLI flag can set, so the project bucket
 * is the addressable, readable part of the layout.
 */
function projectBucket(cwd: string): string {
  const normalized = cwd
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._~-]/g, '-')
  return `--${normalized}--`
}

/** The session directories currently present in one project bucket (best effort). */
function listSessions(sessionsDir: string, bucket: string): Set<string> {
  try {
    return new Set(readdirSync(join(sessionsDir, bucket)))
  } catch {
    return new Set()
  }
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
  const projectsDir = str(config.projectsDir) ?? str(process.env.WORKSTATION_PROJECTS_DIR) ?? '/var/lib/workstation/projects'
  const sessionsDir = join(dshHome, 'sessions')
  const defaultRole = str(config.defaultRole) ?? 'developer'
  const timeoutSecs = Math.min(Math.max(int(config.timeoutSecs) ?? 1200, 30), 7200)
  const maxOutputChars = Math.max(int(config.maxOutputChars) ?? 12000, 1000)
  const bin = join(harnessDir, 'apps', 'cli', 'lib', 'bin.js')

  /**
   * Create $DSH_HOME/profiles/<role> from the harness' `headless` default
   * profile, once, IDEMPOTENTLY.
   *
   * The harness CLI refuses to initialise a profile directory that ALREADY
   * exists ("dsh: profile directory <dir> already exists; choose an unused
   * profile name"), and an interrupted boot can leave a role dir behind WITHOUT
   * a manifest. Doing `mkdirSync(profileDir)` first therefore made a role
   * PERMANENTLY undispatchable: the dir existed, the CLI refused, no manifest
   * ever appeared, and every call answered
   *   agent run: role '<role>' could not be provisioned (no profile at ...)
   * (observed thread 3263 for a never-seen role). Here the CLI is run against a
   * TEMP home and the finished profile is RENAMED into place, so a
   * manifest-less leftover dir is replaced and the FIRST call of a new role
   * succeeds. A role that still cannot be provisioned stays LOUD: the caller
   * throws on the missing manifest.
   */
  const ensureRole = async (role: string): Promise<{ provisioned: boolean; notes: string[] }> => {
    const notes: string[] = []
    const profilesDir = join(dshHome, 'profiles')
    const profileDir = join(profilesDir, role)
    const manifest = join(profileDir, 'package.json')
    let provisioned = false
    if (existsSync(manifest)) {
      notes.push(`profile '${role}' already provisioned (${profileDir})`)
    } else {
      mkdirSync(profilesDir, { recursive: true })
      const stagingHome = join(profilesDir, `.init-${role}-${process.pid}-${Date.now()}`)
      rmSync(stagingHome, { recursive: true, force: true })
      const init = await run('node', [bin, role, '--from-default-profile', 'headless'], {
        cwd: harnessDir,
        // A TEMP home: the CLI then initialises a FRESH profile dir instead of
        // refusing the one that is (about to be) in place.
        env: { ...process.env, DSH_HOME: stagingHome },
        timeoutMs: 120000,
      })
      const stagedProfile = join(stagingHome, 'profiles', role)
      if (existsSync(join(stagedProfile, 'package.json'))) {
        // The target is manifest-less by definition: it is not a usable profile.
        rmSync(profileDir, { recursive: true, force: true })
        renameSync(stagedProfile, profileDir)
        provisioned = true
        notes.push(`profile '${role}' created from the headless default profile (init exit ${init.code}, staged in ${stagingHome})`)
      } else {
        // LOUD: keep the CLI's own words, the caller throws on the manifest.
        notes.push(
          `profile '${role}' NOT created: \`${bin} ${role} --from-default-profile headless\` exited ${init.code} without writing a manifest: ${tail(init.stderr.length > 0 ? init.stderr : init.stdout, 400)}`,
        )
      }
      rmSync(stagingHome, { recursive: true, force: true })
    }
    const patch = join(roleProfilesDir, role, 'cordis.patch.yml')
    if (existsSync(patch)) {
      if (existsSync(manifest)) {
        copyFileSync(patch, join(profileDir, 'cordis.patch.yml'))
        notes.push(`role patch copied: ${patch} -> ${profileDir}/cordis.patch.yml`)
      } else {
        notes.push(`role patch NOT copied: no profile manifest at ${manifest}`)
      }
    } else {
      notes.push(`WARNING: no role patch at ${patch}: the worker's bash will be refused by the default sandbox policy`)
    }

    // A row a ROLE patch INSERTS by bare package NAME is resolved from the
    // PROFILE directory, and a freshly initialised profile has no node_modules of
    // its own, so such an entry never loads (VERIFIED 2026-09-27):
    //   dsh: warning: 1 entry did not activate
    //   tool-session-query (@deepseek-ai/dsh-tool-session-query): failed to import
    //   Cannot find package '@deepseek-ai/dsh-tool-session-query' imported from
    //   /var/lib/workstation/profiles/<role>/
    // The harness resolves every one of those packages from its OWN
    // <harnessDir>/node_modules, so the profile gets a SYMLINK to it: role-patch
    // rows then resolve exactly like the bundle's own rows, and the profile keeps
    // no second copy to drift from the image. Idempotent, never fatal.
    const profileNodeModules = join(profileDir, 'node_modules')
    const harnessNodeModules = join(harnessDir, 'node_modules')
    if (existsSync(manifest) && !existsSync(profileNodeModules) && existsSync(harnessNodeModules)) {
      try {
        symlinkSync(harnessNodeModules, profileNodeModules, 'dir')
        notes.push(`role patch module resolution: ${profileNodeModules} -> ${harnessNodeModules}`)
      } catch (error) {
        notes.push(`WARNING: could not link ${profileNodeModules} -> ${harnessNodeModules}: ${error instanceof Error ? error.message : String(error)}`)
      }
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
        project: {
          type: 'string',
          description: 'the PROJECT the worker belongs to (e.g. omnidev, workstation, demo, research, my-project-x; default: default). The worker runs with its cwd INSIDE the project workspace, which is the dsh session project bucket: sessions group per project and every worker of one project shares that workspace session-search authority. The structured session id is <role>-<project>-<timestamp>-<suffix>.',
        },
        workdir: {
          type: 'string',
          description: 'ADVISORY working directory recorded in the answer (compatibility only). It is NOT used as the process cwd: the process cwd is always the project workspace <projectsDir>/<project>, which is what makes dsh group the session under the project instead of scattering it.',
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
        const project = sanitizeProject(str(params.project))
        const advisoryWorkdir = str(params.workdir)
        const bound = Math.min(Math.max(int(params.timeoutSecs) ?? timeoutSecs, 30), 7200)

        const provisioning = await ensureRole(role)
        if (!existsSync(join(dshHome, 'profiles', role, 'package.json'))) {
          throw new Error(`agent run: role '${role}' could not be provisioned (no profile at ${join(dshHome, 'profiles', role)})`)
        }

        // The PROJECT workspace is the worker's cwd => the dsh session project
        // bucket. Created on demand (the first dispatch of a project makes it).
        const workspace = join(projectsDir, project)
        mkdirSync(workspace, { recursive: true })

        const sessionId = `${role}-${project}-${stamp(Date.now())}-${randomSuffix()}`
        const sessionHeader = `[dsh-session role=${role} project=${project} id=${sessionId}]`
        const task = template === undefined
          ? objective
          : `Your briefing is the file ${template} - read it first with the fs tool and follow it. Objective: ${objective}`
        // The structured id leads the FIRST prompt: the LLM session title is derived
        // from that prompt and the prompt text is indexed by the FTS session-query
        // backend, so role+project+id are readable in the title AND searchable.
        const briefing = `${sessionHeader}\n\n${task}`

        const bucket = projectBucket(workspace)
        const before = listSessions(sessionsDir, bucket)
        const started = Date.now()
        // DSH_HOME is handed to the worker EXPLICITLY: the harness home (role
        // profiles, credentials, session store) must never depend on ambient
        // environment, and the session store this tool diffs afterwards lives
        // under exactly this home.
        const result = await run('node', [bin, role, briefing], {
          cwd: workspace,
          env: { ...process.env, DSH_HOME: dshHome },
          timeoutMs: bound * 1000,
        })
        const durationSecs = Math.round((Date.now() - started) / 1000)
        const created = [...listSessions(sessionsDir, bucket)].filter((id) => !before.has(id)).sort()

        // The dispatch record maps the STRUCTURED id to the dsh session directory
        // the run really created: dsh names the directory session-<uuid>, so this
        // is the only place both identities meet (discoverability, retention,
        // archive). Best effort: never fail a worker run over the index.
        try {
          appendFileSync(join(workspace, 'dsh-sessions.jsonl'), `${JSON.stringify({
            sessionId,
            role,
            project,
            workspace,
            bucket,
            startedAt: new Date(started).toISOString(),
            durationSecs,
            exitCode: result.code,
            timedOut: result.timedOut,
            sessions: created,
          })}\n`, 'utf8')
        } catch {
          /* best effort */
        }

        return {
          role,
          project,
          sessionId,
          workspace,
          sessionBucket: bucket,
          sessionDir: created.length === 1 ? join(sessionsDir, bucket, created[0]) : null,
          sessionDirs: created.map((id) => join(sessionsDir, bucket, id)),
          objective,
          ...(template === undefined ? {} : { template }),
          ...(advisoryWorkdir === undefined ? {} : { requestedWorkdir: advisoryWorkdir }),
          command: `node ${bin} ${role} "<briefing>" (cwd ${workspace} -> session bucket ${bucket})`,
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
