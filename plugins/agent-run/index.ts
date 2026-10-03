// External workstation plugin: the AGENT-RUN seam of the workstation facade
// (`agent_run`). This is the row the orchestrator delegation surface was missing
// (see config/workstation.yml DECISION 6 and the wiki page
// Projects/Omniagent/Workstation-Standard-Config.md).
//
// The facade (`plugins/http-surface`) dispatches through the harness ToolRuntime,
// so whatever a facade tool does, `workstation__tool {"tool": "agent_run", ...}`
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
//
// DISPATCH RECORD (accounting, crash-safe). The per-project
// `<projectsDir>/<project>/dsh-sessions.jsonl` line maps the structured id to the
// real session directory AND carries the run's accounting: `usage` (the child's
// per-call array with its own aggregate LAST, `[]` when the log could not be
// read), `usage_error` (why the scan found nothing) and `usage_session_log` (the
// log the scan read) when present, and `error` (the RAW thrown error when the
// dispatch crashed, else the worker's stderr tail on a non-zero exit / timeout /
// abort). The record is written in a `finally`, so a throw between dispatch start
// and the write (objective validation, role provisioning, workspace mkdir) still
// leaves its accounting behind. The additive `_meta` block returned to the caller
// is unchanged and never becomes model-facing content.

import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { defineTool, renderValue, type ContentBlock, type ToolDefinition } from '../../definitions/tools.ts'
import { collectUsage, type UsageReport } from '../../shared/usage.ts'
import {
  attachSessionIds,
  ensureWorkspace,
  type WorkspaceLike,
  type WorkspaceRegistryLike,
} from '../workspace-register/registration.ts'

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
  /**
   * Cordis service lookup. Used NON-STRICTLY (`get(name, false)`) for the
   * optional workspace-registration services: a process that does not compose
   * the workspace registry must still be able to run a worker.
   */
  get?(name: string, strict?: boolean): unknown
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

/**
 * Render the NORMAL result for the model, WITHOUT the additive `_meta` block.
 * `_meta.usage` is accounting data for the CALLER (the HTTP facade and a parent
 * agent reading the session log), never model-facing content: the harness
 * persists it separately through `output.presentationMeta`.
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

/**
 * Run one command to completion, capturing both streams (never rejecting on a
 * non-zero exit).
 *
 * `signal` is the CALLER cancellation signal (`exec.signal`): when it aborts -
 * the HTTP client that dispatched this worker went away, i.e. the omniagent
 * stopped the thread - the spawned dsh worker is SIGKILLed so it stops spending
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

/**
 * The SEVEN required `## ` sections of a dispatch briefing, per
 * `/opt/omni/workstation/skills/ops/dispatch-briefing/SKILL.md`. The gate
 * matches the heading at line start, case-insensitively.
 */
const REQUIRED_BRIEFING_SECTIONS = [
  'Role',
  'Template',
  'Objective',
  'Context',
  'Prior session',
  'Success evidence',
  'Bounds',
] as const

/**
 * The credential-VALUE patterns a briefing may never carry. A match is a
 * rejection, and the MATCHED VALUE is never echoed into a problem string.
 */
const CREDENTIAL_VALUE_PATTERN = /PRIVATE KEY|ghp_|ghs_|sk-|AKIA|api_key:|password:/

/**
 * Trim the sentence punctuation a prose line leaves on a path token, but only
 * while the raw token still does not resolve: a real `/opt/.../file.md` keeps
 * its extension while a trailing `.`/`,`/backtick does not.
 */
function normalizePathToken(raw: string): string {
  let token = raw
  while (token.length > 5 && /[.,:;!?]+$/.test(token) && !existsSync(token)) {
    token = token.replace(/[.,:;!?]+$/, '')
  }
  return token
}

/** The unique `/opt/...` path tokens a briefing names (punctuation tolerated). */
function briefingPathTokens(text: string): string[] {
  const matches = text.match(/\/opt\/[^\s`'"()\[\]{}<>,;]+/g) ?? []
  const tokens = new Set<string>()
  for (const raw of matches) tokens.add(normalizePathToken(raw))
  return [...tokens]
}

/**
 * True when `token` is the declared evidence artifact, its parent directory, or
 * a path under that parent. The artifact is BY DESIGN produced by the run, so it
 * can never be required to exist BEFORE the run: the pre-dispatch existence
 * checks must not reject the briefing that names it.
 */
function isEvidenceScope(token: string, evidenceArtifact: string | undefined): boolean {
  if (evidenceArtifact === undefined || token.length === 0) return false
  if (token === evidenceArtifact) return true
  const parent = dirname(evidenceArtifact)
  // A root/relative parent would exempt far more than the artifact's directory.
  if (parent === '/' || parent === '.') return false
  return token === parent || token.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/** The first value line under the `## Template` heading (backticks/quotes stripped). */
function templateSectionValue(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^##\s+template\b/i.test(lines[index])) continue
    for (let next = index + 1; next < lines.length; next += 1) {
      const value = lines[next].trim()
      if (value.length === 0) continue
      if (/^##\s/.test(value)) return undefined
      return value.replace(/^[`'"]+|[`'"]+$/g, '').trim().split(/\s+/)[0]
    }
    return undefined
  }
  return undefined
}

/**
 * Validate a composed dispatch briefing against the DISPATCH-BRIEFING CONTRACT
 * (`/opt/omni/workstation/skills/ops/dispatch-briefing/SKILL.md`) and return the
 * list of problems; an EMPTY list means the briefing conforms. Pure except for
 * the `existsSync` probes that prove the paths it names exist.
 */
export function validateBriefing(
  text: string,
  options: { template?: string; evidenceArtifact?: string } = {},
): string[] {
  const problems: string[] = []
  const reportedPaths = new Set<string>()

  // 1. the seven required section headings, at line start, case-insensitive.
  for (const section of REQUIRED_BRIEFING_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`^##\\s+${escaped}\\b`, 'im').test(text)) {
      problems.push(`missing required section: '## ${section}'`)
    }
  }

  // 2. every /opt/omni context pointer in the briefing must exist on disk. The
  //    existence check is narrowed to the contract's OWN scope: the dispatch
  //    skill's verification greps `/opt/omni/[^ )]+` only, while an artifact the
  //    briefing asks the run to CREATE usually lives under /opt/workspace (or a
  //    repo), which does not exist before the run. The declared evidence
  //    artifact and anything under its parent directory are exempt as well: they
  //    are produced BY the run.
  for (const token of briefingPathTokens(text)) {
    if (!token.startsWith('/opt/omni/')) continue
    if (isEvidenceScope(token, options.evidenceArtifact)) continue
    if (existsSync(token)) continue
    reportedPaths.add(token)
    problems.push(`briefing names a path that does not exist: ${token}`)
  }

  // 3. the '## Template' value (and the optional template parameter) must exist.
  //    The declared evidence artifact (and its parent scope) is exempt here too.
  const declaredRaw = templateSectionValue(text)
  const declared = declaredRaw === undefined ? undefined : normalizePathToken(declaredRaw)
  const templateCandidate =
    declared === undefined
      ? undefined
      : isAbsolute(declared)
        ? declared
        : options.template ?? join('/opt/omni/workstation/templates', declared)
  if (
    templateCandidate !== undefined &&
    !existsSync(templateCandidate) &&
    !reportedPaths.has(templateCandidate) &&
    !isEvidenceScope(templateCandidate, options.evidenceArtifact)
  ) {
    problems.push(`the '## Template' value does not exist: ${templateCandidate}`)
  }
  if (
    options.template !== undefined &&
    !existsSync(options.template) &&
    !isEvidenceScope(options.template, options.evidenceArtifact)
  ) {
    problems.push(`the 'template' parameter path does not exist: ${options.template}`)
  }

  // 4. credential-VALUE scan: reject on any hit, never echo the matched value.
  if (CREDENTIAL_VALUE_PATTERN.test(text)) {
    problems.push('credential-value scan: a forbidden credential pattern is present (matched value redacted)')
  }

  // 5. the declared evidence artifact must literally appear in the briefing.
  if (options.evidenceArtifact !== undefined && !text.includes(options.evidenceArtifact)) {
    problems.push(`the evidence artifact '${options.evidenceArtifact}' does not appear in the briefing text`)
  }

  return problems
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
   * OPTIONAL service lookup. The workspace registry lives in the webserver
   * process (pid=1) together with this plugin, but the composition that loads
   * this plugin does not HAVE to provide it (a bare delegation plane), so the
   * lookup is non-strict and a missing service simply skips registration -
   * never fails a worker dispatch.
   */
  const serviceOf = <T>(serviceName: string): T | undefined => {
    const getter = ctx.get
    if (typeof getter !== 'function') return undefined
    try {
      return (getter.call(ctx, serviceName, false) ?? undefined) as T | undefined
    } catch {
      return undefined
    }
  }
  const workspaceRegistry = serviceOf<WorkspaceRegistryLike>('workspaceRegistry')

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
   *   agent_run: role '<role>' could not be provisioned (no profile at ...)
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
      name: 'agent_run',
      description:
        'runs ONE dsh worker agent (a subagent) with a ROLE profile and a briefing and returns its result: role (a profile under $DSH_HOME/profiles), objective (the task) and template (optional briefing file the worker must read first). Each call is an isolated agent process with its own context window and model route; the answer carries the exit code, the worker\'s output and the provisioning notes, so an orchestrator verifies the artifact it asked for instead of trusting prose. A missing DEEPSEEK_API_KEY fails loudly (dsh: MISSING_CREDENTIAL, non-zero exit) after zero work. When the optional briefing text is provided it is validated against the dispatch-briefing contract BEFORE the role is provisioned (requires evidence_artifact), and after a clean run the declared evidence_artifact must exist on disk or the dispatch is rejected.',
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
        briefing: {
          type: 'string',
          description: 'the FULL composed worker briefing TEXT, composed by the orchestrator per /opt/omni/workstation/skills/ops/dispatch-briefing/SKILL.md. When provided it REPLACES the composed objective prompt (the worker receives this text with the [dsh-session ...] header prepended), it is materialised under <workspace>/.briefings/<sessionId>.md, and it is validated against the dispatch-briefing contract BEFORE the role is provisioned. Requires evidence_artifact.',
        },
        evidence_artifact: {
          type: 'string',
          description: 'absolute path of the RAW artifact the briefing requires the worker to produce; REQUIRED when briefing is provided and checked on disk after a clean run (exitCode 0, no timeout, no abort); a missing artifact fails the dispatch',
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
      execute: async (params, exec) => {
        // Parsing runs BEFORE the boundary so the record has role/project even
        // when the objective itself is the throw: a refused dispatch is still
        // an observable dispatch.
        const role = str(params.role) ?? defaultRole
        const template = str(params.template)
        const project = sanitizeProject(str(params.project))
        const advisoryWorkdir = str(params.workdir)
        const bound = Math.min(Math.max(int(params.timeoutSecs) ?? timeoutSecs, 30), 7200)
        // DISPATCH-BRIEFING CONTRACT GATE inputs. `briefing` is the FULL
        // composed text (the orchestrator has no write tool, so it is text, not
        // a path); `evidence_artifact` is the raw artifact path the briefing
        // requires. Both are OPTIONAL: absent, the gate is inert and behaviour
        // is today's.
        const briefingText = str(params.briefing)
        const evidenceArtifact = str(params.evidence_artifact)

        // Everything the dispatch record needs is declared OUTSIDE the boundary
        // so the `finally` can write the record even when the boundary throws
        // before the run (objective validation, provisioning, mkdir). `usage` is
        // initialized to `[]` with an error note, so a throw before the usage
        // scan still leaves a well-formed record.
        let objective = ''
        let started = Date.now()
        let result: RunResult | undefined
        let created: string[] = []
        let durationSecs = 0
        let failure: string | undefined
        // Surfaced contract-gate state, declared OUTSIDE the boundary so the
        // `finally` record carries it even when the gate itself is the throw.
        let briefingGate: { provided: boolean; ok: boolean; problems: string[] } = {
          provided: briefingText !== undefined,
          ok: briefingText === undefined,
          problems: [],
        }
        let evidence: { artifact: string | null; exists: boolean; validated: boolean } = {
          artifact: evidenceArtifact ?? null,
          exists: false,
          validated: false,
        }
        let usageReport: UsageReport = {
          usage: [],
          error: 'usage not collected: the dispatch threw before the usage scan',
        }
        const sessionId = `${role}-${project}-${stamp(started)}-${randomSuffix()}`
        const sessionHeader = `[dsh-session role=${role} project=${project} id=${sessionId}]`
        // The PROJECT workspace is the worker's cwd => the dsh session project
        // bucket. Resolved here (not inside the boundary) so the `finally` record
        // write always has a target directory to (re)create.
        const workspace = join(projectsDir, project)
        const bucket = projectBucket(workspace)

        try {
          objective = str(params.objective) ?? ''
          if (objective.length === 0) {
            throw new Error("agent_run: the 'objective' parameter must be a non-empty task statement")
          }

          // DISPATCH-BRIEFING CONTRACT GATE (PRE-DISPATCH). Active ONLY when a
          // briefing is provided: a non-conforming briefing is rejected HERE,
          // before the role is provisioned and before any child is spawned.
          if (briefingText !== undefined) {
            if (evidenceArtifact === undefined) {
              const problems = ["'evidence_artifact' is required when 'briefing' is provided"]
              briefingGate = { provided: true, ok: false, problems }
              throw new Error('agent_run: briefing rejected: ' + problems.join('; '))
            }
            // Materialise the composed text under the project workspace so the
            // record and the worker share one addressable file.
            const briefingsDir = join(workspace, '.briefings')
            mkdirSync(briefingsDir, { recursive: true })
            writeFileSync(join(briefingsDir, `${sessionId}.md`), briefingText, 'utf8')
            const problems = validateBriefing(briefingText, { template, evidenceArtifact })
            briefingGate = { provided: true, ok: problems.length === 0, problems }
            if (problems.length > 0) {
              throw new Error('agent_run: briefing rejected: ' + problems.join('; '))
            }
          }

          const provisioning = await ensureRole(role)
          if (!existsSync(join(dshHome, 'profiles', role, 'package.json'))) {
            throw new Error(`agent_run: role '${role}' could not be provisioned (no profile at ${join(dshHome, 'profiles', role)})`)
          }

          // The PROJECT workspace is created on demand (the first dispatch of a
          // project makes it).
          mkdirSync(workspace, { recursive: true })

          // AUTO-REGISTER (best effort): ensure the PROJECT's Workspace exists
          // BEFORE the run, so the session this dispatch creates has a group to
          // land in. `create()` is idempotent and the registry lives in THIS
          // process (pid=1), which is the only process that can write it.
          const registrationNotes: string[] = []
          let projectWorkspace: WorkspaceLike | undefined
          if (workspaceRegistry !== undefined) {
            try {
              projectWorkspace = await ensureWorkspace(workspaceRegistry, workspace, project)
              registrationNotes.push(`workspace ensured before run: ${projectWorkspace.path} (id ${String(projectWorkspace.id)})`)
            } catch (error) {
              registrationNotes.push(`workspace NOT ensured before run: ${error instanceof Error ? error.message : String(error)}`)
            }
          } else {
            registrationNotes.push('workspace registry not exposed in this process; pre-run registration skipped')
          }

          const task = briefingText !== undefined
            ? briefingText
            : template === undefined
              ? objective
              : `Your briefing is the file ${template} - read it first with the fs tool and follow it. Objective: ${objective}`
          // The structured id leads the FIRST prompt: the LLM session title is
          // derived from that prompt and the prompt text is indexed by the FTS
          // session-query backend, so role+project+id are readable in the title
          // AND searchable.
          const briefing = `${sessionHeader}\n\n${task}`

          const before = listSessions(sessionsDir, bucket)
          started = Date.now()
          // DSH_HOME is handed to the worker EXPLICITLY: the harness home (role
          // profiles, credentials, session store) must never depend on ambient
          // environment, and the session store this tool diffs afterwards lives
          // under exactly this home.
          const runOutput = await run('node', [bin, role, briefing], {
            cwd: workspace,
            env: { ...process.env, DSH_HOME: dshHome },
            timeoutMs: bound * 1000,
            ...(abortSignalOf(exec) === undefined ? {} : { signal: abortSignalOf(exec) as AbortSignal }),
          })
          result = runOutput
          durationSecs = Math.round((Date.now() - started) / 1000)
          created = [...listSessions(sessionsDir, bucket)].filter((id) => !before.has(id)).sort()

          // USAGE (the child's own tokens). The `sessionHeader` is the unique
          // marker in the worker's first prompt: a worker that delegates creates
          // GRANDCHILD sessions in the same bucket, so the marker is what tells
          // the direct worker apart from its own descendants. The array is in
          // call order and ends with the worker's own aggregate. collectUsage
          // never throws, but the call is guarded anyway so an unreadable store
          // can never cost the dispatch its record.
          try {
            usageReport = collectUsage({
              sessionsDir,
              bucket,
              before,
              marker: sessionHeader,
              agent: role,
            })
          } catch (error) {
            usageReport = {
              usage: [],
              error: `usage collection failed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }

          // AUTO-REGISTER (best effort): the worker is a SEPARATE CLI process, so
          // NO session-created event fires in this process; the bucket diff is
          // what yields the created `session-<uuid>` directory names, and those
          // names ARE the dsh session ids. `attachSession()` re-validates the
          // stored header cwd against the workspace path here in pid=1, which
          // also indexes the new header for the registry's membership getter.
          const attachedSessionIds: string[] = []
          if (workspaceRegistry !== undefined && created.length > 0) {
            try {
              projectWorkspace ??= await ensureWorkspace(workspaceRegistry, workspace, project)
              const outcome = await attachSessionIds(projectWorkspace, created)
              attachedSessionIds.push(...outcome.attached)
              registrationNotes.push(
                `attached ${outcome.attached.length} of ${created.length} created session(s) to workspace ${String(projectWorkspace.id)}`,
              )
              for (const skip of outcome.skipped) {
                registrationNotes.push(`session ${skip.sessionId} NOT attached: ${skip.reason}`)
              }
            } catch (error) {
              registrationNotes.push(`session attach failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          // DISPATCH-BRIEFING CONTRACT GATE (POST-RUN). A CLEAN exit must have
          // produced the raw evidence artifact the briefing declared; a prose
          // answer with no artifact on disk is a rejection. Runs AFTER the
          // accounting so the record still carries usage and the created session.
          const artifactExists = evidenceArtifact === undefined ? false : existsSync(evidenceArtifact)
          evidence = {
            artifact: evidenceArtifact ?? null,
            exists: artifactExists,
            validated:
              evidenceArtifact !== undefined &&
              artifactExists &&
              runOutput.code === 0 &&
              !runOutput.timedOut &&
              !runOutput.aborted,
          }
          if (
            evidenceArtifact !== undefined &&
            runOutput.code === 0 &&
            !runOutput.timedOut &&
            !runOutput.aborted &&
            !artifactExists
          ) {
            throw new Error(
              'agent_run: evidence artifact missing: ' + evidenceArtifact + ' (exitCode 0, no artifact on disk)',
            )
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
            briefingGate,
            evidence,
            ...(advisoryWorkdir === undefined ? {} : { requestedWorkdir: advisoryWorkdir }),
            command: `node ${bin} ${role} "<briefing>" (cwd ${workspace} -> session bucket ${bucket})`,
            exitCode: runOutput.code,
            timedOut: runOutput.timedOut,
            aborted: runOutput.aborted,
            durationSecs,
            provisioningNotes: provisioning.notes,
            workspaceRegistration: {
              workspaceId: projectWorkspace === undefined ? null : String(projectWorkspace.id),
              workspacePath: workspace,
              attachedSessionIds,
              notes: registrationNotes,
            },
            stdoutTail: tail(runOutput.stdout, maxOutputChars),
            stderrTail: tail(runOutput.stderr, maxOutputChars),
            // ADDITIVE accounting block, never mixed into the fields above: the
            // HTTP facade returns it to the orchestrator and a parent agent reads
            // it from the session log. `usage` is in call order, last = aggregate.
            _meta: {
              usage: usageReport.usage,
              ...(usageReport.error === undefined ? {} : { usage_error: usageReport.error }),
              ...(usageReport.sessionLog === undefined ? {} : { usage_session_log: usageReport.sessionLog }),
            },
          }
        } catch (error) {
          // RAW failure (message plus the head of the stack). The SAME error is
          // rethrown: the caller still sees the failure, and the record below
          // keeps why it happened.
          const thrown = error instanceof Error ? error : new Error(String(error))
          failure = (thrown.stack ?? `${thrown.name}: ${thrown.message}`).split('\n').slice(0, 3).join('\n')
          throw error
        } finally {
          // ALWAYS write the dispatch record, even for a crash: the accounting
          // (usage plus the raw error) must survive a lost caller. Best effort:
          // the record never replaces or masks the dispatch outcome.
          const exitCode = result === undefined ? null : result.code
          const timedOut = result?.timedOut ?? false
          const aborted = result?.aborted ?? false
          const recordDuration = result === undefined ? Math.round((Date.now() - started) / 1000) : durationSecs
          const rawError = failure ?? (result !== undefined && ((result.code !== null && result.code !== 0) || result.timedOut || result.aborted)
            ? tail(result.stderr, maxOutputChars)
            : undefined)
          try {
            mkdirSync(workspace, { recursive: true })
            appendFileSync(join(workspace, 'dsh-sessions.jsonl'), `${JSON.stringify({
              sessionId,
              role,
              project,
              workspace,
              bucket,
              startedAt: new Date(started).toISOString(),
              durationSecs: recordDuration,
              exitCode,
              timedOut,
              aborted,
              sessions: created,
              briefingGate,
              evidence,
              usage: usageReport.usage,
              ...(usageReport.error === undefined ? {} : { usage_error: usageReport.error }),
              ...(usageReport.sessionLog === undefined ? {} : { usage_session_log: usageReport.sessionLog }),
              ...(rawError === undefined ? {} : { error: rawError }),
            })}\n`, 'utf8')
          } catch {
            /* best effort */
          }
        }
      },
      output: {
        schema: {},
        render: renderPublicResult,
        // Persist `_meta` as `data.meta` on the `tool/result` event (NOT model
        // content) so the parent agent can splice the child usage array.
        presentationMeta: (_args, value) => {
          const meta = value !== null && typeof value === 'object' ? (value as { _meta?: unknown })._meta : undefined
          return { _meta: meta ?? { usage: [] } }
        },
      },
    })),
  )
}

export default { name, inject: ['tools'], apply }
