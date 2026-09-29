// core/data-write-fence - the EXACT write grant of a read-only research role, as
// a tool-policy GUARD.
//
// WHY THIS PLUGIN EXISTS. The harness sandbox fences ctx.fs writes to the
// SESSION WORKSPACE (`workspace-write` allows the session cwd plus the host temp
// areas: packages/sandbox/sandbox/src/roots.ts `writableRoots`), and
// `SandboxExecutionPolicy` carries exactly ONE primary root. That is the right
// boundary for a coding role, but it is too WIDE for a read-only research role
// whose only outputs are two directories: with the workspace root at
// <omni_dir>/data, every other file under data/ is writable too.
//
// This plugin closes the gap without touching the image or the harness: it
// registers a MONOTONIC tool guard (`ctx.tools.guard`) that DENIES every
// mutating filesystem call whose resolved target is not under one of the
// configured allow roots. A guard has no allow result (only a denial reason),
// so no later listener, escalation or re-briefing can turn the denial back into
// a permission - which is exactly what "the role may write ONLY
// <omni_dir>/data/research/ and <omni_dir>/data/report/" has to mean.
//
// SCOPE, honestly stated:
//   * it fences the TOOL surface (`write`, `edit`, and any other tool named in
//     `mutatingTools`): the model-facing file mutations of a dsh agent;
//   * it does NOT fence a shell command (only the harness shell sandbox can).
//     On the workstation image there is no shell-sandbox backend, so `bash` is
//     refused outright on `workspace-write` - the file surface IS the whole
//     writable surface of the role;
//   * reads are never touched.
//
// Every denial is a real, raw error naming the fence and the resolved path, so a
// caller (and a test) can prove the policy instead of trusting prose.

import fs from 'node:fs'
import path from 'node:path'

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'data-write-fence'

/** Tools this plugin fences by default: the model-facing file mutations. */
export const DEFAULT_MUTATING_TOOLS = ['write', 'edit'] as const

/** Argument names a mutation may carry its target in (first present wins). */
export const DEFAULT_PATH_ARGS = ['file_path', 'path', 'target', 'target_path'] as const

interface ToolsLike {
  register(def: ToolDefinition): () => void
  /** Monotonic execution guard: return a reason to deny, `undefined` to allow. */
  guard?(guard: (execution: { name?: unknown; arguments?: unknown }) => string | undefined): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
  /**
   * Deferred dependency declaration (`ctx.inject(['tools'], ...)`), when the host
   * offers it: `ctx.tools` is an INJECTED service, so a bare property read on the
   * profile context throws. Absent on a bare test context, which passes `tools`
   * directly.
   */
  inject?(deps: string[], callback: (injected: PluginContext) => void): unknown
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

export interface Config {
  /**
   * The ONLY directories a mutating tool may target. Absolute paths; a relative
   * entry is resolved against process.cwd(). An empty/absent list disables the
   * fence with a warning (never silently: the plugin then mounts nothing).
   */
  allow?: readonly string[]
  /** Tools to fence (default {@link DEFAULT_MUTATING_TOOLS}). */
  mutatingTools?: readonly string[]
  /** Argument names carrying the target path (default {@link DEFAULT_PATH_ARGS}). */
  pathArgs?: readonly string[]
}

/**
 * The canonical form of `p`: the real path of its longest EXISTING ancestor,
 * plus the not-yet-existing tail. The sandbox resolves targets the same way
 * (`realpathSync.native`), so `/tmp` and a symlinked data dir compare equal and
 * a lexical escape (`data/research/../../etc`) cannot pass the fence.
 */
export function canonicalPath(p: string): string {
  const absolute = path.resolve(p)
  const tail: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = fs.realpathSync.native(current)
      return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    } catch {
      /* missing or unreadable: walk up to the deepest existing prefix */
    }
    const parent = path.dirname(current)
    if (parent === current) return absolute
    tail.push(path.basename(current))
    current = parent
  }
}

/** True when `target` is `root` itself or sits under it. */
export function isUnder(target: string, root: string): boolean {
  const resolved = canonicalPath(target)
  const canonicalRoot = canonicalPath(root)
  return resolved === canonicalRoot || resolved.startsWith(canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep)
}

/** The tool names a config supplies, or the defaults. */
function listOf(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const clean = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
  return clean.length === 0 ? [...fallback] : clean
}

/** The target path argument of one execution, when it carries a string one. */
export function targetOf(args: unknown, pathArgs: readonly string[]): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of pathArgs) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * The guard: a mutation outside every allow root is denied with a reason naming
 * the fence, the resolved target and the allowed roots. A mutation WITHOUT a
 * resolvable path argument is denied too (fail-closed: an unknown target is not
 * a permitted one).
 */
export function fenceGuard(allow: readonly string[], mutatingTools: readonly string[], pathArgs: readonly string[]) {
  const tools = new Set(mutatingTools)
  return (execution: { name?: unknown; arguments?: unknown }): string | undefined => {
    const toolName = typeof execution?.name === 'string' ? execution.name : ''
    if (!tools.has(toolName)) return undefined
    const target = targetOf(execution?.arguments, pathArgs)
    if (target === undefined) {
      return `data-write-fence: ${toolName} carries no recognizable target path argument (looked for ${pathArgs.join(', ')}); `
        + `this role may write only under ${allow.join(', ')}`
    }
    if (allow.some((root) => isUnder(target, root))) return undefined
    return `data-write-fence: ${toolName} to "${target}" (resolved ${canonicalPath(target)}) is outside this role's writable directories `
      + `(${allow.join(', ')}); this role is READ-ONLY elsewhere`
  }
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const allow = (config.allow ?? []).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  if (allow.length === 0) {
    ctx.logger?.warn?.('data-write-fence: no `allow` root configured; the plugin mounts nothing (the sandbox policy stays the only fence)')
    return
  }
  // `ctx.tools` is an INJECTED service: reading it on the profile context without
  // declaring the dependency throws `cannot get property "tools" without inject`
  // and the row never activates (observed raw). Declare the dependency and mount
  // inside its callback, the cordis-native way.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (injected) => {
      mountFence(injected, allow, config)
    })
    return
  }
  mountFence(ctx, allow, config)
}

/** Register the guard and the introspection tool on a context that HAS `tools`. */
function mountFence(ctx: PluginContext, allow: string[], config: Config): void {
  const mutatingTools = listOf(config.mutatingTools, DEFAULT_MUTATING_TOOLS)
  const pathArgs = listOf(config.pathArgs, DEFAULT_PATH_ARGS)
  if (typeof ctx.tools.guard !== 'function') {
    ctx.logger?.warn?.('data-write-fence: this tool runtime exposes no guard seam; the plugin mounts nothing')
    return
  }
  const guard = fenceGuard(allow, mutatingTools, pathArgs)
  const dispose = ctx.tools.guard(guard)
  ctx.effect?.(() => () => {
    dispose?.()
  })

  // Introspection: the fence state as a tool, so a worker (and a test) can prove
  // WHICH roots are writable without attempting a write.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'write_fence',
    description: 'reports the directories this role may write to (the enforced fence) and whether the guard is active',
    parameters: {},
    execute: async () => ({
      active: true,
      allow: allow.map((root) => ({ root, resolved: canonicalPath(root) })),
      mutating_tools: [...mutatingTools],
      path_arguments: [...pathArgs],
      note: 'a mutating call outside `allow` is denied by a monotonic tool guard (no escalation turns it back into a permission); reads are unrestricted',
    }),
    output: { schema: {}, render: renderValue },
  })))

  ctx.logger?.info?.(`data-write-fence: allow=${allow.join(', ')} tools=${mutatingTools.join(', ')}`)
}
