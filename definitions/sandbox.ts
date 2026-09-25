// definitions/sandbox.ts - the `sandbox@1` POLICY + ENFORCEMENT seam.
//
// WHY THIS MODULE EXISTS: `fs@1`, `subprocess@1`, `jobs@1`, `computer-use` and
// `browser-use` all do things that can hurt the host: read or write a path,
// start a process, open a socket, drive a browser. Each of them already carries
// an OPTIONAL hook for a policy (definitions/fs.ts `FsSandboxPolicy`,
// definitions/subprocess.ts `SubprocessSandboxLike`, consumed the same way by
// core/jobs-local), and this module is the CONTRACT those hooks resolve against:
// the `sandbox` service on the context.
//
//        Provider  ->  Definition  <-  Consumer
//   core/sandbox-policy           plugins/sandbox-tools
//   core/sandbox-enforce          plugins/sandbox-consumer
//                                 core/fs-local, core/subprocess-local, ...
//
// SEPARATION (the model of the DeepSeek harness `sandbox` group, MIT, adapted
// here; see THIRD_PARTY.md): the POLICY (what is allowed) is a different family
// from the EXECUTION (how it happens). `core/sandbox-policy` only DECIDES;
// `core/sandbox-enforce` decides AND confines a real child process with the
// strongest mechanism the host offers. A deployment loads either one, and a
// consumer never names a provider.
//
// THE THREE ANSWERS a decision can be:
//   * ALLOW with constraints: the request is permitted, and the constraints
//     (roots, network rule, env allow-list, cpu/memory/wall-time limits, output
//     cap, approval flag) are what the caller must honour;
//   * DENY with a machine-readable reason: a `sandbox.*` reason code plus the
//     rule that produced it. A consumer MUST honour it and MUST NOT silently
//     continue;
//   * no sandbox service loaded at all: the seam is OPTIONAL, the consumer
//     degrades to its own configuration and must REPORT the gap (it then has no
//     policy handle).
//
// WHAT IS BACKEND-AGNOSTIC (this module): the request/constraint/decision model,
// the pure decision engine (`evaluateSandbox`), the pure mechanism planner
// (`buildEnforcementPlan`) that turns constraints + a MEASURED host capability
// report into an argv prefix + a filtered environment, and the reporting shapes.
// WHAT IS BACKEND-SPECIFIC (a provider): where the rules come from, which
// mechanisms really exist on the host, and how a child is actually spawned.
//
// CORDIS-FREE and dependency-free on purpose: the service base is STRUCTURAL, so
// this file compiles and runs inside any host that exposes a `sandbox` service
// with the published shape (a bare object is a valid context).
import path from 'node:path'
import { ServiceError, isRecord, positiveInt, serviceOf, str } from './support.ts'
import type { ServiceContext } from './support.ts'

/** Name of the cordis service every consumer resolves (`ctx.sandbox`). */
export const SANDBOX = 'sandbox'

/** Contract version this definition speaks. A provider must implement it. */
export const SANDBOX_VERSION = 1

/** Contract id including the version, e.g. `sandbox@1`. */
export const SANDBOX_CONTRACT = `${SANDBOX}@${SANDBOX_VERSION}`

/**
 * Which capability/domain is asking. `fs | subprocess | jobs | computer-use |
 * browser-use` are the known families; anything else is a CUSTOM resource whose
 * rules live under the same name in the policy config.
 */
export type SandboxResource =
  | 'fs'
  | 'subprocess'
  | 'jobs'
  | 'computer-use'
  | 'browser-use'
  | (string & {})

/**
 * The confinement ladder (DSH `SandboxMode`): `read-only` refuses every write,
 * `workspace-write` allows writes under the configured write roots only, and
 * `danger-full-access` lifts the shaping (limits and reporting still apply).
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Network posture: no egress, an explicit host allow-list, or unrestricted. */
export type SandboxNetworkMode = 'none' | 'allow-list' | 'unrestricted'

export interface SandboxNetworkRule {
  mode: SandboxNetworkMode
  /** Allowed hosts (`example.com` also matches `api.example.com`). */
  hosts: readonly string[]
}

/** Resource ceilings of a call. Every field is optional; `0`/absent = no limit. */
export interface SandboxLimits {
  /** RLIMIT_CPU in seconds. */
  cpuSeconds?: number
  /** RLIMIT_AS in bytes (address space). */
  memoryBytes?: number
  /** RLIMIT_NOFILE (open file descriptors). */
  nofile?: number
  /** Wall-clock deadline in ms (the process GROUP is signalled on expiry). */
  wallTimeMs?: number
  /** Inline byte cap of stdout and stderr. */
  maxOutputBytes?: number
  /** RLIMIT_NPROC when the host supports it. */
  maxProcesses?: number
}

/** Run the child as another user/group (drop privileges where the host allows). */
export interface SandboxPrivilegeDrop {
  user?: string
  group?: string
}

/**
 * ONE request: what a capability wants to do. Everything is optional except the
 * resource, because the model serves five very different families: an `fs` call
 * names a path, a `subprocess`/`jobs` call names an argv, a `browser-use` call
 * names a URL, a `computer-use` call names a target.
 */
export interface SandboxRequest {
  resource: SandboxResource
  /**
   * The verb within the resource (`read` | `write` | `spawn` | `start` |
   * `connect` | `open` | `act` | ...). An `fs` request without an operation is
   * treated as a WRITE (fail-closed: the stricter reading wins).
   */
  operation?: string
  /** Filesystem target: the path to read, to write, or the working directory. */
  path?: string
  /** The command as an ARGV ARRAY (never a shell string). */
  argv?: readonly string[]
  /** True when the caller intends to run the argv through a shell. */
  shell?: boolean
  /** Working directory of the child. */
  cwd?: string
  /** Environment NAMES the caller wants to pass (never values). */
  envNames?: readonly string[]
  /**
   * Network use: `false`/absent = none; `true` = egress somewhere; an object
   * names the target (`host`, `port`, `protocol`, `url`).
   */
  network?: boolean | { host?: string; port?: number; protocol?: string; url?: string }
  /** Bytes the call wants to produce/keep (checked against `maxOutputBytes`). */
  bytes?: number
  /** Wall time the call wants (checked against `wallTimeMs`). */
  wallTimeMs?: number
  /** Free-form context, echoed back in the decision (never used by the engine). */
  metadata?: Record<string, unknown>
}

/** The ACTIVE constraint view of one resource (what the caller must honour). */
export interface SandboxConstraints {
  /** The resource this view belongs to. */
  resource: SandboxResource
  /** Who declared the policy (a provider id or a config path; diagnostics only). */
  source: string
  /** Which rule produced the view: the resource rule, the defaults or nothing. */
  from: 'resource' | 'defaults' | 'unconfigured'
  mode: SandboxMode
  /** Convenience: `mode === 'read-only'` (the `fs@1` hook reads this field). */
  readOnly: boolean
  /** Roots a read is confined to (empty = no read confinement). */
  readRoots: readonly string[]
  /** Roots a write is confined to (empty = no write is allowed). */
  writeRoots: readonly string[]
  /** Environment allow-list by NAME; `['*']` inherits the whole environment. */
  env: readonly string[]
  network: SandboxNetworkRule
  limits: SandboxLimits
  /** The call needs an explicit approval before it may run. */
  approvalRequired: boolean
  /** The rule (or the defaults) refuses this resource outright: deny precedence. */
  denied: boolean
  /** Drop to this user/group before running (when the provider can). */
  dropPrivileges?: SandboxPrivilegeDrop
  /** argv[0] allow-list (basename or absolute path); absent = no allow-list. */
  allowCommands?: readonly string[]
  /** argv[0] deny-list (basename or absolute path); checked BEFORE the allow-list. */
  denyCommands?: readonly string[]
}

/** Machine-readable reason of a DENY. A caller branches on this, never on text. */
export type SandboxDenyReason =
  /** The request itself is unusable (no resource, an fs call without a path, ...). */
  | 'sandbox.invalid-request'
  /** The policy config denies this resource outright (`deny: true`). */
  | 'sandbox.resource-denied'
  /** No rule exists for this resource and `unconfigured: 'deny'` is in effect. */
  | 'sandbox.no-policy'
  /** The path is outside the roots the policy allows. */
  | 'sandbox.outside-roots'
  /** The policy is `read-only` and the request writes. */
  | 'sandbox.read-only'
  /** Network use is refused (or the host is not on the allow-list). */
  | 'sandbox.network-denied'
  /** An environment NAME the caller asked for is not on the allow-list. */
  | 'sandbox.env-denied'
  /** argv[0] is on the deny-list, or not on the allow-list. */
  | 'sandbox.command-denied'
  /** The call needs an approval that was not granted. */
  | 'sandbox.approval-required'
  /** The call asks for MORE than the policy grants (bytes, wall time). */
  | 'sandbox.limit-exceeded'
  /** The consumer asked for a constraint it cannot enforce (a reported gap). */
  | 'sandbox.unsupported-constraint'

export interface SandboxAllow {
  allowed: true
  constraints: SandboxConstraints
  /** Non-fatal observations the caller should know (clamped values, gaps). */
  notes: readonly string[]
}

export interface SandboxDeny {
  allowed: false
  reason: SandboxDenyReason
  message: string
  /** The resource the decision was made for. */
  resource: SandboxResource
  /** The constraint view that refused, when there was one. */
  constraints?: SandboxConstraints
  /** Structured details (paths, names, the rule). Never a credential value. */
  details: Record<string, unknown>
}

/** The answer of `check`: allow-with-constraints, or deny-with-a-reason. */
export type SandboxDecision = SandboxAllow | SandboxDeny

/** Options the CALLER passes into a decision (an approval it already holds). */
export interface SandboxDecisionOptions {
  /** True when the caller has an out-of-band approval for this call. */
  approvalGranted?: boolean
}

/**
 * ONE configured rule. Every field is optional: a rule NARROWS the defaults of
 * the policy it lives in, and an explicit `deny` wins over everything (deny
 * precedence).
 */
export interface SandboxRule {
  /** Refuse this resource outright. */
  deny?: boolean
  mode?: SandboxMode
  readRoots?: readonly string[]
  writeRoots?: readonly string[]
  /** Convenience: `['*']` inherits the whole environment, `[]` passes none. */
  env?: readonly string[]
  network?: SandboxNetworkRule | SandboxNetworkMode
  limits?: SandboxLimits
  approvalRequired?: boolean
  dropPrivileges?: SandboxPrivilegeDrop
  allowCommands?: readonly string[]
  denyCommands?: readonly string[]
}

/** The policy CONFIG a provider normalizes (the same shape for both providers). */
export interface SandboxPolicyConfig {
  /** Label of the policy for reporting (default: the provider id). */
  source?: string
  /** What happens to a resource no rule matches (`deny` is the fail-closed default). */
  unconfigured?: 'deny' | 'allow'
  /** Rules applied to every resource before the resource rule narrows them. */
  defaults?: SandboxRule
  /** One rule per resource name (`fs`, `subprocess`, `jobs`, ...). */
  resources?: Record<string, SandboxRule>
  /** True when EVERY resource needs an approval (unless a rule relaxes it). */
  approvalRequired?: boolean
}

/** The normalized policy config (what a provider keeps in memory). */
export interface NormalizedSandboxPolicy {
  source: string
  unconfigured: 'deny' | 'allow'
  defaults: SandboxRule
  resources: Record<string, SandboxRule>
  approvalRequired: boolean
}

// ---------------------------------------------------------------------------
// Enforcement reporting: which mechanism really confines what, MEASURED.
// ---------------------------------------------------------------------------

/**
 * A mechanism the provider probed on the host. `evidence` is what the probe
 * OBSERVED (a version line, an exit code, an error), never an intention.
 */
export interface SandboxMechanism {
  /** `bwrap` | `unshare-net` | `prlimit` | `sh-ulimit` | `setpriv` | ... */
  id: string
  kind: 'namespace' | 'rlimit' | 'process' | 'env' | 'fs' | 'network' | 'limit' | 'approval'
  available: boolean
  /** The observation the availability was derived from (raw, short). */
  evidence: string
  note?: string
}

/** One constraint of the matrix: what enforces it here, and how completely. */
export interface SandboxConstraintEnforcement {
  /** `cpu` | `memory` | `nofile` | `wall-time` | `output-bytes` | `env` | `cwd` |
   *  `command` | `read-roots` | `write-roots` | `network` | `approval` */
  constraint: string
  /** The mechanism id that enforces it, or null when nothing does. */
  mechanism: string | null
  enforced: 'yes' | 'partial' | 'no'
  note?: string
}

/** The enforcement report of a provider: mechanisms + the MEASURED matrix. */
export interface SandboxEnforcement {
  provider: string
  mechanisms: readonly SandboxMechanism[]
  constraints: readonly SandboxConstraintEnforcement[]
  /** Every constraint that is NOT fully enforced here, in plain language. */
  gaps: readonly string[]
}

/** The active policy, as a report (what `sandbox policy` answers). */
export interface SandboxActivePolicy {
  contract: string
  provider: string
  source: string
  unconfigured: 'deny' | 'allow'
  mode: SandboxMode
  approvalRequired: boolean
  /** One view per CONFIGURED resource, plus the `defaults` view. */
  resources: readonly SandboxConstraints[]
  enforcement?: SandboxEnforcement
}

// ---------------------------------------------------------------------------
// Optional EXECUTION: only an ENFORCING provider implements `exec`.
// ---------------------------------------------------------------------------

export interface SandboxExecInput {
  /** The command as an ARGV ARRAY (never a shell string). */
  argv: readonly string[]
  cwd?: string
  /** LITERAL environment for the child (already resolved values; never logged). */
  env?: Record<string, string>
  /** Environment NAMES beyond the literal map (checked against the allow-list). */
  envNames?: readonly string[]
  stdin?: string
  /** Which resource the call belongs to (default `subprocess`). */
  resource?: SandboxResource
  /** The deadline the caller wants (the policy cap still wins). */
  timeoutMs?: number
  /** The inline byte cap the caller wants (the policy cap still wins). */
  maxOutputBytes?: number
  approvalGranted?: boolean
}

export interface SandboxExecResult {
  allowed: boolean
  decision: SandboxDecision
  /** The command actually started (mechanism wrappers included). */
  effectiveArgv: readonly string[]
  /** Mechanism ids that were applied to this run. */
  mechanisms: readonly string[]
  /** The provider's enforcement report (the same object as `enforcement()`). */
  enforcement?: SandboxEnforcement
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  durationMs: number
  timedOut: boolean
  killed: boolean
  truncated: boolean
  note?: string
}

/** The compatibility answer of `checkCommand` (fs/subprocess/jobs hooks). */
export interface SandboxCommandVerdict {
  allowed: boolean
  reason?: string
  decision?: SandboxDecision
}

/** The `sandbox@1` capability, as a consumer sees it (never a backend detail). */
export interface SandboxService {
  readonly contract: string
  readonly provider: string
  /** The decision for one request. A DENY is an ANSWER, not a thrown error. */
  check(request: SandboxRequest, options?: SandboxDecisionOptions): SandboxDecision | Promise<SandboxDecision>
  /**
   * The constraint view of a resource (the hook of `definitions/fs.ts`: its
   * `FsSandboxPolicy` is structurally a subset of `SandboxConstraints`).
   * `undefined` when the policy has no rule AND is configured to allow none.
   */
  policyFor(resource: SandboxResource): SandboxConstraints | undefined
  /** The ACTIVE policy (reporting: `sandbox policy`). */
  activePolicy(): SandboxActivePolicy
  /** What this provider can really enforce here (only an enforcing provider has it). */
  enforcement?(): SandboxEnforcement
  /** Run a command under the constraints (only an ENFORCING provider has it). */
  exec?(input: SandboxExecInput): Promise<SandboxExecResult>
  /**
   * The structural hook of `definitions/subprocess.ts` / `core/jobs-local`: the
   * verdict for a planned command. Implemented by every provider of this seam.
   */
  checkCommand?(plan: { argv: readonly string[]; shell?: boolean; cwd?: string }): SandboxCommandVerdict | Promise<SandboxCommandVerdict>
}

/** The reason codes of the errors this module throws (never a policy deny). */
export type SandboxErrorReason =
  | 'sandbox.invalid-request'
  | 'sandbox.invalid-config'
  | 'sandbox.missing-service'
  | 'sandbox.exec-unavailable'
  | 'sandbox.spawn-failed'

/** A structural failure (bad request/config, no provider, no `exec`). A policy
 * DENY is NOT an error: it is a `SandboxDecision` with `allowed: false`. */
export class SandboxError extends ServiceError {
  readonly reason: SandboxErrorReason

  constructor(reason: SandboxErrorReason, message: string, options: { stage?: string; details?: Record<string, unknown>; code?: ServiceError['code'] } = {}) {
    super(options.code ?? 'invalid-input', message, { stage: options.stage ?? reason, details: options.details ?? {} })
    this.name = 'SandboxError'
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Constants: the defaults a policy starts from.
// ---------------------------------------------------------------------------

/** Environment NAMES a child inherits when a rule names no allow-list. */
export const DEFAULT_ENV_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
]

/** The limits a rule starts from: generous, but never unbounded. */
export const DEFAULT_LIMITS: SandboxLimits = {
  wallTimeMs: 30000,
  maxOutputBytes: 65536,
  cpuSeconds: 30,
  memoryBytes: 1073741824,
  nofile: 256,
}

// ---------------------------------------------------------------------------
// Config normalization (the same shape for both providers).
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    const text = str(entry)
    if (text !== undefined) out.push(text)
  }
  return out
}

function positiveOrUndefined(value: unknown, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return positiveInt(number, 1, max)
}

/** Normalizes a network rule from its three accepted spellings. */
export function normalizeNetworkRule(raw: unknown): SandboxNetworkRule {
  if (raw === undefined || raw === null) return { mode: 'none', hosts: [] }
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase()
    if (mode === 'none' || mode === 'allow-list' || mode === 'unrestricted') {
      return { mode: mode as SandboxNetworkMode, hosts: [] }
    }
    return { mode: 'none', hosts: [] }
  }
  if (raw === true) return { mode: 'unrestricted', hosts: [] }
  if (isRecord(raw)) {
    const mode = str(raw.mode)?.toLowerCase()
    const hosts = stringList(raw.hosts) ?? []
    if (mode === 'none' || mode === 'allow-list' || mode === 'unrestricted') {
      return { mode: mode as SandboxNetworkMode, hosts }
    }
    if (mode === undefined) return hosts.length > 0 ? { mode: 'allow-list', hosts } : { mode: 'none', hosts: [] }
    return { mode: 'none', hosts: [] }
  }
  return { mode: 'none', hosts: [] }
}

/** Normalizes one rule: every field optional, unknown fields dropped. */
export function normalizeSandboxRule(raw: unknown): SandboxRule {
  if (!isRecord(raw)) return {}
  const rule: SandboxRule = {}
  if (raw.deny === true) rule.deny = true
  const mode = str(raw.mode)?.toLowerCase()
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') rule.mode = mode
  const readRoots = stringList(raw.readRoots)
  if (readRoots !== undefined) rule.readRoots = readRoots
  const writeRoots = stringList(raw.writeRoots)
  if (writeRoots !== undefined) rule.writeRoots = writeRoots
  const env = stringList(raw.env)
  if (env !== undefined) rule.env = env
  if (raw.network !== undefined) rule.network = normalizeNetworkRule(raw.network)
  if (isRecord(raw.limits)) {
    const limits: SandboxLimits = {}
    const cpuSeconds = positiveOrUndefined(raw.limits.cpuSeconds)
    if (cpuSeconds !== undefined) limits.cpuSeconds = cpuSeconds
    const memoryBytes = positiveOrUndefined(raw.limits.memoryBytes)
    if (memoryBytes !== undefined) limits.memoryBytes = memoryBytes
    const nofile = positiveOrUndefined(raw.limits.nofile)
    if (nofile !== undefined) limits.nofile = nofile
    const wallTimeMs = positiveOrUndefined(raw.limits.wallTimeMs)
    if (wallTimeMs !== undefined) limits.wallTimeMs = wallTimeMs
    const maxOutputBytes = positiveOrUndefined(raw.limits.maxOutputBytes)
    if (maxOutputBytes !== undefined) limits.maxOutputBytes = maxOutputBytes
    const maxProcesses = positiveOrUndefined(raw.limits.maxProcesses)
    if (maxProcesses !== undefined) limits.maxProcesses = maxProcesses
    rule.limits = limits
  }
  if (raw.approvalRequired === true) rule.approvalRequired = true
  if (raw.approvalRequired === false) rule.approvalRequired = false
  if (isRecord(raw.dropPrivileges)) {
    const drop: SandboxPrivilegeDrop = {}
    const user = str(raw.dropPrivileges.user)
    if (user !== undefined) drop.user = user
    const group = str(raw.dropPrivileges.group)
    if (group !== undefined) drop.group = group
    if (drop.user !== undefined || drop.group !== undefined) rule.dropPrivileges = drop
  }
  const allowCommands = stringList(raw.allowCommands)
  if (allowCommands !== undefined) rule.allowCommands = allowCommands
  const denyCommands = stringList(raw.denyCommands)
  if (denyCommands !== undefined) rule.denyCommands = denyCommands
  return rule
}

/** Normalizes a whole policy config (the shape both providers accept). */
export function normalizeSandboxPolicyConfig(raw: unknown, fallbackSource = SANDBOX_CONTRACT): NormalizedSandboxPolicy {
  const record = isRecord(raw) ? raw : {}
  const resources: Record<string, SandboxRule> = {}
  if (isRecord(record.resources)) {
    for (const [name, rule] of Object.entries(record.resources)) {
      const key = str(name)
      if (key === undefined) continue
      resources[key] = normalizeSandboxRule(rule)
    }
  }
  const unconfigured = str(record.unconfigured)?.toLowerCase() === 'allow' ? 'allow' : 'deny'
  return {
    source: str(record.source) ?? fallbackSource,
    unconfigured,
    defaults: normalizeSandboxRule(record.defaults),
    resources,
    approvalRequired: record.approvalRequired === true,
  }
}

function mergeLimits(base: SandboxLimits, patch?: SandboxLimits): SandboxLimits {
  if (patch === undefined) return { ...base }
  return {
    cpuSeconds: patch.cpuSeconds ?? base.cpuSeconds,
    memoryBytes: patch.memoryBytes ?? base.memoryBytes,
    nofile: patch.nofile ?? base.nofile,
    wallTimeMs: patch.wallTimeMs ?? base.wallTimeMs,
    maxOutputBytes: patch.maxOutputBytes ?? base.maxOutputBytes,
    maxProcesses: patch.maxProcesses ?? base.maxProcesses,
  }
}

/** The constraint view of one resource: the defaults narrowed by the rule. */
export function constraintView(policy: NormalizedSandboxPolicy, resource: SandboxResource): SandboxConstraints {
  const rule = policy.resources[resource]
  const defaults = policy.defaults
  const hasDefaults = Object.keys(defaults).length > 0
  const origin = rule !== undefined ? 'resource' : hasDefaults ? 'defaults' : 'unconfigured'
  const mode = rule?.mode ?? defaults.mode ?? 'workspace-write'
  const readRoots = resolveRoots(rule?.readRoots ?? defaults.readRoots)
  const writeRoots = mode === 'read-only' ? [] : resolveRoots(rule?.writeRoots ?? defaults.writeRoots)
  return {
    resource,
    source: policy.source,
    from: origin,
    mode,
    readOnly: mode === 'read-only',
    readRoots,
    writeRoots,
    env: rule?.env ?? defaults.env ?? DEFAULT_ENV_ALLOW,
    network: normalizeNetworkRule(rule?.network ?? defaults.network),
    limits: mergeLimits(mergeLimits(DEFAULT_LIMITS, defaults.limits), rule?.limits),
    approvalRequired: rule?.approvalRequired ?? defaults.approvalRequired ?? policy.approvalRequired,
    ...(rule?.dropPrivileges ?? defaults.dropPrivileges) === undefined
      ? {}
      : { dropPrivileges: (rule?.dropPrivileges ?? defaults.dropPrivileges) as SandboxPrivilegeDrop },
    ...(rule?.allowCommands ?? defaults.allowCommands) === undefined
      ? {}
      : { allowCommands: (rule?.allowCommands ?? defaults.allowCommands) as readonly string[] },
    ...(rule?.denyCommands ?? defaults.denyCommands) === undefined
      ? {}
      : { denyCommands: (rule?.denyCommands ?? defaults.denyCommands) as readonly string[] },
    denied: rule?.deny === true || defaults.deny === true,
  }
}

/** Every configured resource of a policy, plus the `defaults` view. */
export function policyViews(policy: NormalizedSandboxPolicy): SandboxConstraints[] {
  const names = new Set<string>(Object.keys(policy.resources))
  const views: SandboxConstraints[] = []
  for (const name of [...names].sort()) views.push(constraintView(policy, name))
  views.push(constraintView(policy, 'defaults'))
  return views
}

function resolveRoots(roots: readonly string[] | undefined): string[] {
  if (roots === undefined || roots.length === 0) return []
  const out: string[] = []
  for (const root of roots) out.push(path.resolve(root))
  return out
}

// ---------------------------------------------------------------------------
// Pure path / name helpers (unit-testable without a filesystem).
// ---------------------------------------------------------------------------

/** Resolves a request path: absolute stays as-is, relative resolves against `cwd`. */
export function resolveSandboxPath(target: string, cwd?: string): string {
  if (path.isAbsolute(target)) return path.resolve(target)
  return cwd !== undefined && cwd.length > 0 ? path.resolve(cwd, target) : path.resolve(target)
}

/** True when `target` IS `root` or lives under it (a `..`-escape is outside). */
export function pathInside(target: string, root: string): boolean {
  const from = path.resolve(root)
  const to = path.resolve(target)
  if (to === from) return true
  const relative = path.relative(from, to)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** True when `target` lives under ANY of the roots (an empty list means none). */
export function pathInsideAny(target: string, roots: readonly string[]): boolean {
  for (const root of roots) if (pathInside(target, root)) return true
  return false
}

/** The name a command allow/deny list is matched against, plus the full path. */
export function commandName(argv0: string): string {
  return path.basename(argv0)
}

/** True when a command matches a list entry (absolute path or basename). */
export function commandMatches(argv0: string, entry: string): boolean {
  if (entry === argv0) return true
  if (entry === commandName(argv0)) return true
  return path.isAbsolute(entry) && path.resolve(entry) === path.resolve(argv0)
}

/** True when `host` is on an allow-list entry (exact, or a subdomain of it). */
export function hostAllowed(host: string, rule: SandboxNetworkRule): boolean {
  const wanted = host.trim().toLowerCase()
  if (wanted.length === 0) return false
  for (const entry of rule.hosts) {
    const allowed = entry.trim().toLowerCase()
    if (allowed.length === 0) continue
    if (wanted === allowed || wanted.endsWith(`.${allowed}`)) return true
  }
  return false
}

/** True when an environment NAME may be passed to the child. */
export function envAllowed(name: string, allow: readonly string[]): boolean {
  if (allow.includes('*')) return true
  return allow.includes(name)
}

/** The host of a URL, or undefined when it cannot be parsed. */
export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** Reads the network intent of a request (absent/false = no egress). */
export function networkRequested(request: SandboxRequest): {
  requested: boolean
  host?: string
  port?: number
  protocol?: string
  url?: string
} {
  const raw = request.network
  if (raw === undefined || raw === false || raw === null) return { requested: false }
  if (raw === true) return { requested: true }
  if (!isRecord(raw)) return { requested: true }
  const url = str(raw.url)
  const host = str(raw.host) ?? (url === undefined ? undefined : hostOfUrl(url))
  const port = typeof raw.port === 'number' ? raw.port : undefined
  const protocol = str(raw.protocol) ?? (url === undefined ? undefined : new URL(url).protocol.replace(':', ''))
  return {
    requested: true,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(url === undefined ? {} : { url }),
  }
}

// ---------------------------------------------------------------------------
// The decision engine (pure: request + constraint view in, decision out).
// ---------------------------------------------------------------------------

export interface SandboxEvaluationOptions extends SandboxDecisionOptions {
  /** What to do when no rule matches the resource (default: deny, fail-closed). */
  unconfigured?: 'deny' | 'allow'
}

/** The read side of an `fs` operation (anything else is a WRITE, fail-closed). */
const READ_OPERATIONS = new Set(['read', 'list', 'info', 'stat', 'search', 'grep', 'glob', 'cat'])

/**
 * Decides ONE request against ONE constraint view. Pure: no host access, no
 * clock, no process. Every deny carries a `sandbox.*` reason a caller branches
 * on; deny precedence means the first refusal wins, in this order:
 * unconfigured/deny rule, limits asked, environment names, fs/command/cwd,
 * network, approval.
 */
export function evaluateSandbox(
  request: SandboxRequest,
  view: SandboxConstraints,
  options: SandboxEvaluationOptions = {},
): SandboxDecision {
  const resource = str(request?.resource) ?? view.resource
  const deny = (
    reason: SandboxDenyReason,
    message: string,
    details: Record<string, unknown> = {},
  ): SandboxDeny => ({ allowed: false, reason, message, resource, constraints: view, details })
  const allow = (notes: readonly string[] = []): SandboxAllow => ({ allowed: true, constraints: view, notes })

  if (str(request?.resource) === undefined) {
    return deny('sandbox.invalid-request', "a sandbox request must name its 'resource'")
  }
  if (view.denied) {
    return deny('sandbox.resource-denied', `the policy denies the '${resource}' resource outright`, { resource })
  }
  if (view.from === 'unconfigured' && options.unconfigured !== 'allow') {
    return deny(
      'sandbox.no-policy',
      `no policy rule is configured for the '${resource}' resource and the policy is fail-closed (unconfigured: deny)`,
      { resource, source: view.source },
    )
  }

  // 1. what the call ASKS for must fit in what the policy GRANTS.
  const wallTimeMs = typeof request.wallTimeMs === 'number' ? request.wallTimeMs : undefined
  if (wallTimeMs !== undefined && view.limits.wallTimeMs !== undefined && wallTimeMs > view.limits.wallTimeMs) {
    return deny('sandbox.limit-exceeded', `the call asks for ${wallTimeMs} ms of wall time; the policy grants at most ${view.limits.wallTimeMs} ms`, {
      requested: wallTimeMs,
      granted: view.limits.wallTimeMs,
    })
  }
  const bytes = typeof request.bytes === 'number' ? request.bytes : undefined
  if (bytes !== undefined && view.limits.maxOutputBytes !== undefined && bytes > view.limits.maxOutputBytes) {
    return deny('sandbox.limit-exceeded', `the call asks to keep ${bytes} bytes; the policy caps output at ${view.limits.maxOutputBytes} bytes`, {
      requested: bytes,
      granted: view.limits.maxOutputBytes,
    })
  }

  // 2. environment NAMES (never values).
  for (const name of request.envNames ?? []) {
    if (!envAllowed(name, view.env)) {
      return deny('sandbox.env-denied', `the environment variable '${name}' is not on the allow-list of the policy`, {
        name,
        allow: view.env,
      })
    }
  }

  const notes: string[] = []

  // 3. resource-specific shaping.
  if (resource === 'fs') {
    const target = str(request.path)
    if (target === undefined) return deny('sandbox.invalid-request', "an 'fs' request must name the 'path' it wants to touch")
    const operation = (str(request.operation) ?? 'write').toLowerCase()
    const absolute = resolveSandboxPath(target, request.cwd)
    const writing = !READ_OPERATIONS.has(operation)
    if (view.mode === 'danger-full-access') {
      notes.push('mode danger-full-access: the path is not confined by the policy')
    } else if (writing) {
      if (view.readOnly) {
        return deny('sandbox.read-only', `the policy is read-only: the ${operation} of ${absolute} is refused`, { path: absolute })
      }
      if (view.writeRoots.length === 0) {
        return deny('sandbox.outside-roots', `the policy allows no write at all: no write root is configured (path ${absolute})`, {
          path: absolute,
          writeRoots: [],
        })
      }
      if (!pathInsideAny(absolute, view.writeRoots)) {
        return deny('sandbox.outside-roots', `the write path ${absolute} is outside the allowed write roots (${view.writeRoots.join(', ')})`, {
          path: absolute,
          writeRoots: view.writeRoots,
        })
      }
    } else if (view.readRoots.length > 0 && !pathInsideAny(absolute, view.readRoots)) {
      return deny('sandbox.outside-roots', `the read path ${absolute} is outside the allowed read roots (${view.readRoots.join(', ')})`, {
        path: absolute,
        readRoots: view.readRoots,
      })
    }
  } else {
    const argv = request.argv ?? []
    if (argv.length === 0) {
      if (resource === 'subprocess' || resource === 'jobs') {
        return deny('sandbox.invalid-request', `a '${resource}' request must name the 'argv' it wants to run`)
      }
    } else {
      const head = argv[0] ?? ''
      for (const entry of view.denyCommands ?? []) {
        if (commandMatches(head, entry)) {
          return deny('sandbox.command-denied', `the command '${head}' is on the deny-list of the policy`, { argv0: head, entry })
        }
      }
      const allowCommands = view.allowCommands ?? []
      if (allowCommands.length > 0 && !allowCommands.some((entry) => commandMatches(head, entry))) {
        return deny('sandbox.command-denied', `the command '${head}' is not on the allow-list (${allowCommands.join(', ')})`, {
          argv0: head,
          allowCommands,
        })
      }
    }
    if (request.cwd !== undefined && request.cwd.length > 0 && view.mode !== 'danger-full-access' && view.readRoots.length > 0) {
      const cwd = resolveSandboxPath(request.cwd)
      if (!pathInsideAny(cwd, view.readRoots)) {
        return deny('sandbox.outside-roots', `the working directory ${cwd} is outside the allowed read roots (${view.readRoots.join(', ')})`, {
          cwd,
          readRoots: view.readRoots,
        })
      }
    }
  }

  // 4. network intent.
  const network = networkRequested(request)
  if (network.requested) {
    if (view.network.mode === 'none') {
      return deny('sandbox.network-denied', `the policy allows no network use for the '${resource}' resource`, {
        host: network.host ?? null,
        url: network.url ?? null,
      })
    }
    if (view.network.mode === 'allow-list') {
      if (network.host === undefined) {
        return deny(
          'sandbox.network-denied',
          `the policy allows network use only to ${view.network.hosts.join(', ')} and this call names no host`,
          { hosts: view.network.hosts },
        )
      }
      if (!hostAllowed(network.host, view.network)) {
        return deny('sandbox.network-denied', `the host '${network.host}' is not on the allow-list (${view.network.hosts.join(', ')})`, {
          host: network.host,
          hosts: view.network.hosts,
        })
      }
    }
  }

  // 5. approval.
  if (view.approvalRequired && options.approvalGranted !== true) {
    return deny('sandbox.approval-required', `the '${resource}' resource requires an approval that was not granted`, {
      approval: 'pending',
      resource,
    })
  }

  return allow(notes)
}

/** One-line human summary of a decision (used by the tool and by logs). */
export function describeDecision(decision: SandboxDecision): string {
  if (decision.allowed) {
    const view = decision.constraints
    return `ALLOW ${view.resource} (${view.from}/${view.mode}, source ${view.source})`
  }
  return `DENY ${decision.resource}: ${decision.reason} - ${decision.message}`
}

// ---------------------------------------------------------------------------
// The mechanism planner (pure): constraints + MEASURED availability -> argv.
// ---------------------------------------------------------------------------

/** What the probe found on the host. A false entry is a GAP, never an error. */
export interface SandboxMechanismAvailability {
  /** `bwrap` present and able to create the namespaces the plan needs. */
  bwrap: boolean
  /** `unshare -n` works (a network namespace without privileges). */
  unshareNet: boolean
  /** `prlimit` present and able to set rlimits. */
  prlimit: boolean
  /** `/bin/sh` with `ulimit` (the rlimit fallback). */
  shUlimit: boolean
  /** `setpriv` present (privilege drop). */
  setpriv: boolean
}

/** The plan of one run: what to start, with which mechanisms, and what is missing. */
export interface SandboxMechanismPlan {
  argv: readonly string[]
  mechanisms: readonly string[]
  env: Record<string, string>
  cwd: string
  /** Constraints this run could NOT enforce (the honest part of the answer). */
  gaps: readonly string[]
}

/** The `ulimit` prologue of the shell fallback (KB for -v, seconds for -t). */
export function ulimitScript(limits: SandboxLimits): string {
  const lines: string[] = []
  if (limits.cpuSeconds !== undefined) lines.push(`ulimit -t ${limits.cpuSeconds} 2>/dev/null || true`)
  if (limits.memoryBytes !== undefined) lines.push(`ulimit -v ${Math.max(1, Math.floor(limits.memoryBytes / 1024))} 2>/dev/null || true`)
  if (limits.nofile !== undefined) lines.push(`ulimit -n ${limits.nofile} 2>/dev/null || true`)
  if (limits.maxProcesses !== undefined) lines.push(`ulimit -u ${limits.maxProcesses} 2>/dev/null || true`)
  lines.push('exec "$@"')
  return lines.join('; ')
}

/** Filters a literal environment map through the allow-list of a policy. */
export function filterSandboxEnv(env: Record<string, string>, allow: readonly string[]): Record<string, string> {
  if (allow.includes('*')) return { ...env }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (allow.includes(name)) out[name] = value
  return out
}

/**
 * Builds the run plan: the argv prefix of the strongest AVAILABLE mechanism,
 * the filtered environment, and the list of constraints nothing here enforces.
 * Pure, so the mechanism choice is unit-tested against a fake availability map
 * (bwrap/unshare cannot be exercised on a host that lacks them).
 */
export function buildEnforcementPlan(input: {
  argv: readonly string[]
  cwd?: string
  env?: Record<string, string>
  constraints: SandboxConstraints
  availability: SandboxMechanismAvailability
}): SandboxMechanismPlan {
  const view = input.constraints
  const limits = view.limits
  const mechanisms: string[] = []
  const gaps: string[] = []
  const cwd = input.cwd !== undefined && input.cwd.length > 0 ? path.resolve(input.cwd) : path.resolve('/')
  let argv: string[] = [...input.argv]

  // 1. privilege drop is OUTERMOST: the child starts with the reduced identity,
  //    so every rlimit and namespace below is established as the unprivileged
  //    user too.
  const drop = view.dropPrivileges
  if (drop !== undefined && (drop.user !== undefined || drop.group !== undefined)) {
    if (input.availability.setpriv) {
      argv = [
        'setpriv',
        ...(drop.user === undefined ? [] : [`--reuid=${drop.user}`]),
        ...(drop.group === undefined ? [] : [`--regid=${drop.group}`]),
        '--clear-groups',
        '--no-new-privs',
        '--',
        ...argv,
      ]
      mechanisms.push('setpriv')
    } else {
      gaps.push('privilege drop requested but setpriv is unavailable: the child keeps the caller identity')
    }
  }

  // 2. namespaces (mount/net/pid): the only mechanism that confines the
  //    filesystem and the network at KERNEL level.
  if (view.mode !== 'danger-full-access' && input.availability.bwrap) {
    argv = [
      'bwrap',
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      ...(view.network.mode === 'none' ? ['--unshare-net'] : []),
      '--ro-bind',
      '/',
      '/',
      ...view.writeRoots.flatMap((root) => ['--bind', root, root]),
      '--chdir',
      cwd,
      '--',
      ...argv,
    ]
    mechanisms.push('bwrap')
    if (view.network.mode === 'allow-list') {
      gaps.push('bwrap cannot express a host allow-list: every host stays reachable (the allow-list is a decision-level rule)')
    }
  } else if (view.network.mode === 'none' && view.mode !== 'danger-full-access') {
    if (input.availability.unshareNet) {
      argv = ['unshare', '-n', '--', ...argv]
      mechanisms.push('unshare-net')
    } else {
      gaps.push('network denial is DECISION-level only here: no network namespace mechanism is available')
    }
    if (!input.availability.bwrap && view.writeRoots.length > 0) {
      gaps.push('write confinement is DECISION-level only here: no mount namespace mechanism is available')
    }
  }

  // 3. resource ceilings: prlimit first (it sets RLIMIT_CPU / RLIMIT_AS /
  //    RLIMIT_NOFILE at the kernel without a shell), then the `/bin/sh` ulimit
  //    prologue which `exec`s the real command ARGV unchanged.
  const wantsRlimits =
    limits.cpuSeconds !== undefined ||
    limits.memoryBytes !== undefined ||
    limits.nofile !== undefined ||
    limits.maxProcesses !== undefined
  if (wantsRlimits) {
    if (input.availability.prlimit) {
      argv = [
        'prlimit',
        ...(limits.cpuSeconds === undefined ? [] : [`--cpu=${limits.cpuSeconds}`]),
        ...(limits.memoryBytes === undefined ? [] : [`--as=${limits.memoryBytes}`]),
        ...(limits.nofile === undefined ? [] : [`--nofile=${limits.nofile}`]),
        ...(limits.maxProcesses === undefined ? [] : [`--nproc=${limits.maxProcesses}`]),
        '--',
        ...argv,
      ]
      mechanisms.push('prlimit')
    } else if (input.availability.shUlimit) {
      argv = ['sh', '-c', ulimitScript(limits), 'sh', ...argv]
      mechanisms.push('sh-ulimit')
    } else {
      gaps.push('no rlimit mechanism is available: the cpu/memory/nofile ceilings of this policy are NOT enforced')
    }
  }

  // 4. the swapper (wall time + process-group kill + output caps) is applied by
  //    the SPAWNER, not by an argv prefix: the provider adds those ids.
  return {
    argv,
    mechanisms,
    env: filterSandboxEnv(input.env ?? {}, view.env),
    cwd,
    gaps,
  }
}

// ---------------------------------------------------------------------------
// Enforcement reporting.
// ---------------------------------------------------------------------------

/** Assembles the report; the gaps are DERIVED from the constraint rows. */
export function sandboxEnforcement(input: {
  provider: string
  mechanisms: readonly SandboxMechanism[]
  constraints: readonly SandboxConstraintEnforcement[]
}): SandboxEnforcement {
  const gaps: string[] = []
  for (const row of input.constraints) {
    if (row.enforced === 'yes') continue
    gaps.push(`${row.constraint}: ${row.note ?? (row.mechanism === null ? 'no mechanism enforces it here' : `only partially enforced by ${row.mechanism}`)}`)
  }
  return { provider: input.provider, mechanisms: input.mechanisms, constraints: input.constraints, gaps }
}

/** Multi-line text report of an enforcement matrix (used by the inspect tool). */
export function describeEnforcement(report: SandboxEnforcement | undefined): string {
  if (report === undefined) return 'no enforcing provider is loaded: no mechanism report is available'
  const lines: string[] = [`provider ${report.provider}`]
  for (const row of report.constraints) {
    lines.push(`  ${row.constraint.padEnd(14)} ${row.enforced.padEnd(7)} ${row.mechanism ?? '(none)'}${row.note === undefined ? '' : ` - ${row.note}`}`)
  }
  if (report.gaps.length > 0) {
    lines.push('  gaps:')
    for (const gap of report.gaps) lines.push(`    - ${gap}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Service lookup helpers (every consumer uses these, never a provider import).
// ---------------------------------------------------------------------------

/** Structural lookup of the sandbox capability (`ctx.sandbox`). */
export function sandboxOf(ctx: ServiceContext): SandboxService | undefined {
  return serviceOf<SandboxService>(ctx, SANDBOX)
}

/** The sandbox capability, or a structured error naming the missing provider. */
export function requireSandbox(ctx: ServiceContext, hint?: string): SandboxService {
  const service = sandboxOf(ctx)
  if (service === undefined || typeof service.check !== 'function') {
    throw new SandboxError(
      'sandbox.missing-service',
      `no sandbox@1 provider is loaded${hint === undefined ? '' : ` (${hint})`}: enable core/sandbox-policy or core/sandbox-enforce in the roster`,
      { code: 'missing-service', details: { service: SANDBOX } },
    )
  }
  return service
}

/** The constraint view of a resource, when a provider answers for it. */
export function sandboxConstraintsOf(ctx: ServiceContext, resource: SandboxResource): SandboxConstraints | undefined {
  const service = sandboxOf(ctx)
  if (service === undefined || typeof service.policyFor !== 'function') return undefined
  return service.policyFor(resource)
}

/**
 * The verdict of the OPTIONAL command hook (`definitions/subprocess.ts` and
 * `core/jobs-local` call it before starting anything). `undefined` means "no
 * provider is loaded": the caller then runs with its own configuration and
 * should report that it had no policy handle.
 */
export async function sandboxVerdictOf(
  ctx: ServiceContext,
  plan: { argv: readonly string[]; shell?: boolean; cwd?: string },
): Promise<SandboxCommandVerdict | undefined> {
  const service = sandboxOf(ctx)
  if (service === undefined) return undefined
  if (typeof service.checkCommand === 'function') return await service.checkCommand(plan)
  const decision = await service.check({
    resource: 'subprocess',
    operation: 'spawn',
    argv: plan.argv,
    ...(plan.shell === undefined ? {} : { shell: plan.shell }),
    ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
  })
  return decision.allowed ? { allowed: true, decision } : { allowed: false, reason: decision.message, decision }
}

/** The enforcement report of the loaded provider, when it has one. */
export function sandboxEnforcementOf(ctx: ServiceContext): SandboxEnforcement | undefined {
  const service = sandboxOf(ctx)
  return service !== undefined && typeof service.enforcement === 'function' ? service.enforcement() : undefined
}
