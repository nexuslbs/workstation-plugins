/**
 * plugin-live - add and REMOVE dsh plugins ON THE FLY in the RUNNING
 * workstation service (no container recreate, no service restart, no release
 * path).
 *
 * THE MECHANISM (harness-native, no shim)
 * ---------------------------------------
 * The deepseek-harness composes its plugin tree from an ordered list of patch
 * LAYERS (`readProfilePatches`, packages/boot/app-boot/src/profile-context.ts):
 *
 *   bundle layers  ->  profile patch ($DSH_HOME/profiles/<p>/cordis.patch.yml)
 *                  ->  HOME patch    ($DSH_HOME/cordis.patch.yml)
 *                  ->  CLI overlays  (`--patch <file>`, e.g. the workstation
 *                                     config/workstation.yml)
 *
 * The harness `@deepseek-ai/dsh-hmr` service is ENABLED in this boot (the base
 * bundle enables it whenever the launcher supplies `profileContext`, which the
 * dsh profile launcher always does: apps/cli/src/profile-boot.ts) and it
 * registers an EXACT-PATH config watch on the PROFILE patch and the HOME patch
 * (packages/boot/hmr/src/index.ts: `patchFiles = [profile.patchPath,
 * join(profile.home, PROFILE_PATCH_FILENAME)]`). Every change to one of those
 * two files re-reads ALL layers (including the CLI overlays) and applies the
 * new patch generation to the LIVE Loader tree through
 * `reconcileProfilePatches(...)` -> `ctx.loader.await()`: new rows activate,
 * deleted rows are DISPOSED, all inside the running process.
 *
 * What is NOT watched is the CLI `--patch` overlay itself. That single fact is
 * why "a new row reaches the running workstation only through a service
 * recreate" used to be true: the workstation roster lives in
 * /opt/omni/config/workstation.yml, i.e. in the CLI overlay, which is read once
 * at boot.
 *
 * This plugin closes that gap with the harness' own machinery. It owns the
 * HOME patch layer ($DSH_HOME/cordis.patch.yml, which nothing else writes) as
 * the LIVE PLUGIN LAYER and exposes three facade tools:
 *
 *   plugin list    - the live plugin rows and the raw Loader rows behind them
 *   plugin add     - {id, module, config?}: declare the row in the live layer
 *                    and wait until the RUNNING tree has it mounted
 *   plugin remove  - {id}: drop the row from the live layer and wait until the
 *                    Loader has DISPOSED the entry (its tools and effects)
 *
 * The write is atomic (temp file + rename, which the file watcher reports
 * exactly once) and every call writes a timestamped line to an audit file
 * ($DSH_HOME/plugin-live.log), so a reload/dispose is provable after the fact
 * even though the harness logger is not wired to the container's stdout.
 *
 * LAYER PRIORITY: the live layer sits BELOW the CLI overlay, so a row that the
 * boot roster (/opt/omni/config/workstation.yml) declares cannot be disposed
 * live by writing a lower layer - `plugin remove` detects that case and says so
 * instead of pretending.
 *
 * No workbench API, no hikari shim, no compat layer: this is a native dsh
 * plugin (defineTool + cordis injection) driving the harness Loader service.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'plugin-live'

/** Cordis dependencies: the tool registry and the (always mounted) Loader. */
export const inject = ['tools', 'loader']

/** The file name of the HOME patch layer, watched by dsh-hmr. */
const LIVE_PATCH_FILENAME = 'cordis.patch.yml'

/** The audit trail this plugin appends (timestamped reload/dispose evidence). */
const AUDIT_FILENAME = 'plugin-live.log'

/** Default and hard caps for "wait until the Loader reflects the change". */
const DEFAULT_WAIT_MS = 15000
const MAX_WAIT_MS = 60000

/** A row id we are willing to write into the YAML patch (safe, unique-looking). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// ── structural contracts (the plugin imports nothing from the harness) ──────

/** One Loader entry row as `loader.entries()` reports it. */
interface LoaderRow {
  id?: unknown
  disabled?: boolean
  options?: { id?: unknown; name?: unknown; config?: unknown; disabled?: boolean }
  fiber?: { state?: unknown }
}

/** The Loader service slice this plugin drives. */
interface LoaderLike {
  entries(): Iterable<LoaderRow>
  await?(): Promise<void>
}

/** The launcher-supplied profile facts (`profileContext`). */
interface ProfileContextLike {
  dir: string
  patchPath: string
  home: string
  startedBundles?: readonly string[]
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
  schemas?(): Array<{ name?: unknown }>
}

interface PluginContext {
  tools: ToolsLike
  loader: LoaderLike
  get?(key: string): unknown
  effect(callback: () => () => void): void
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

export interface Config {
  /** Absolute path of the live patch layer (default: $DSH_HOME/cordis.patch.yml). */
  patchFile?: string
  /** Absolute path of the audit trail (default: $DSH_HOME/plugin-live.log). */
  auditFile?: string
  /** Default wait budget of add/remove (default 15000 ms, capped at 60000). */
  waitMs?: number
}

// ── the live patch layer (JSON document: YAML 1.2 accepts JSON verbatim) ────

/** One managed patch group: one `insert` list carrying exactly one row. */
interface PatchGroup {
  insert: Array<{ id: string; name: string; config?: unknown }>
}

/** A row as the live layer declares it. */
interface LiveRow {
  id: string
  name: string
  config?: unknown
}

/** The HOME patch layer path: the harness watches `$DSH_HOME/cordis.patch.yml`. */
function homeOf(ctx: PluginContext): string {
  const profile = ctx.get?.('profileContext') as ProfileContextLike | undefined
  const home = profile?.home ?? process.env.DSH_HOME
  if (typeof home !== 'string' || home.trim().length === 0) {
    throw new Error('plugin-live: no profile home (profileContext.home / DSH_HOME); cannot locate the live patch layer')
  }
  return home
}

/** The live patch layer this plugin owns. */
function livePatchFile(ctx: PluginContext, config: Config): string {
  if (config.patchFile !== undefined && config.patchFile.trim().length > 0) return config.patchFile.trim()
  return join(homeOf(ctx), LIVE_PATCH_FILENAME)
}

/** Read the live layer: `[]` when the file does not exist yet. */
function readGroups(file: string): PatchGroup[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  if (text.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `plugin-live: the live patch layer ${file} is not the JSON document this plugin owns `
      + `(${String(error)}); refusing to overwrite operator content`,
    )
  }
  if (!Array.isArray(parsed)) throw new Error(`plugin-live: the live patch layer ${file} must be a top-level array`)
  return parsed as PatchGroup[]
}

/** The rows the live layer declares, in file order. */
function rowsOf(groups: readonly PatchGroup[]): LiveRow[] {
  const rows: LiveRow[] = []
  for (const group of groups) {
    if (group === null || typeof group !== 'object' || !Array.isArray(group.insert)) continue
    for (const row of group.insert) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
      rows.push(row.config === undefined ? { id: row.id, name: row.name } : { id: row.id, name: row.name, config: row.config })
    }
  }
  return rows
}

/** Atomic write: the watcher sees exactly one create/replace event. */
function writeGroups(file: string, groups: PatchGroup[]): void {
  const body = `${JSON.stringify(groups, null, 2)}\n`
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.plugin-live.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

/** Declare (or re-declare) one row in the live layer. Returns true when the file changed. */
function upsertRow(file: string, row: LiveRow): boolean {
  const groups = readGroups(file)
  const current = rowsOf(groups).find((candidate) => candidate.id === row.id)
  if (current !== undefined && current.name === row.name && JSON.stringify(current.config) === JSON.stringify(row.config)) {
    return false
  }
  const next = groups.filter((group) => !rowsOf([group]).some((candidate) => candidate.id === row.id))
  next.push({
    insert: [row.config === undefined ? { id: row.id, name: row.name } : { id: row.id, name: row.name, config: row.config }],
  })
  writeGroups(file, next)
  return true
}

/** Drop every declaration of one id from the live layer. Returns true when the file changed. */
function dropRow(file: string, id: string): boolean {
  const groups = readGroups(file)
  const next = groups.filter((group) => !rowsOf([group]).some((candidate) => candidate.id === id))
  if (next.length === groups.length) return false
  writeGroups(file, next)
  return true
}

// ── runtime helpers ────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * The declared id of a Loader row. The Loader carries BOTH a store id and the
 * patch-declared id (`options.id`); the declared one is what a patch row names,
 * so it is preferred, with the store id as the fallback for entries that carry
 * the declared id as their store key.
 */
function rowId(row: LoaderRow): string | undefined {
  for (const candidate of [row.options?.id, row.id]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** The live Loader entry for an id, when the tree holds one. */
function liveEntry(loader: LoaderLike, id: string): LoaderRow | undefined {
  for (const row of loader.entries()) {
    if (rowId(row) === id) return row
  }
  return undefined
}

/** Whether a Loader row is mounted with a fiber (a failed row also carries one). */
function mounted(row: LoaderRow | undefined): boolean {
  return row !== undefined && row.disabled !== true && row.fiber !== undefined
}

/** The registered tool names, best effort (the registry is the observable surface). */
function toolNames(tools: ToolsLike): string[] {
  try {
    return (tools.schemas?.() ?? [])
      .map((schema) => schema?.name)
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

/** Poll the RUNNING tree until `done`, draining the Loader between polls. */
async function waitUntil(loader: LoaderLike, done: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now()
  for (;;) {
    if (done()) return Date.now() - started
    try {
      await loader.await?.()
    } catch {
      /* a failing row must not hide the observable outcome */
    }
    if (Date.now() - started >= timeoutMs) return Date.now() - started
    await sleep(150)
  }
}

/** A required non-empty string parameter, or a readable refusal. */
function requiredParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`plugin-live: the '${key}' parameter must be a non-empty string`)
  }
  return value.trim()
}

/** The wait budget of one call: the caller's value inside [0, MAX_WAIT_MS]. */
function waitBudget(params: Record<string, unknown>, fallback: number): number {
  const raw = params.wait_ms ?? params.waitMs
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.trunc(value), MAX_WAIT_MS)
}

/** The tool-name delta between two snapshots (added and removed, sorted). */
function delta(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((entry) => !beforeSet.has(entry)).sort(),
    removed: before.filter((entry) => !afterSet.has(entry)).sort(),
  }
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const defaultWaitMs = Math.min(Math.max(0, Math.trunc(config.waitMs ?? DEFAULT_WAIT_MS)), MAX_WAIT_MS)

  /** Timestamped audit trail: raw reload/dispose evidence that outlives the call. */
  const audit = (event: string): void => {
    const line = `${new Date().toISOString()} pid=${String(process.pid)} ${event}\n`
    try {
      const file = config.auditFile !== undefined && config.auditFile.trim().length > 0
        ? config.auditFile.trim()
        : join(homeOf(ctx), AUDIT_FILENAME)
      appendFileSync(file, line, 'utf8')
    } catch {
      /* the audit trail is evidence, never a failure mode */
    }
    ctx.logger?.info?.('plugin-live: %s', event)
  }

  // Observability: the harness announces every applied patch generation on the
  // ROOT context (app-boot/config-reload) - the proof that the running tree was
  // RE-COMPOSED in place rather than restarted.
  try {
    const root = (ctx as PluginContext & { root?: { on?(event: string, listener: () => void): unknown } }).root
    if (root !== undefined && typeof root.on === 'function') {
      ctx.effect(() => {
        const off = root.on?.('app-boot/config-reload', () => {
          audit('event=app-boot/config-reload the harness re-composed the RUNNING plugin tree')
        })
        return () => {
          if (typeof off === 'function') (off as () => void)()
        }
      })
    }
  } catch {
    /* observability only: never block the control plane on it */
  }

  audit(`event=load tool=plugin-live patch_file=${livePatchFile(ctx, config)} node=${process.version}`)

  // ── plugin list ──────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin list',
    description:
      'lists the plugins declared in the LIVE layer of the running workstation service, the raw Loader rows behind them and the tools the registry holds',
    parameters: {
      live_only: { type: 'boolean', description: 'only rows the running Loader does NOT hold mounted (default false)' },
    },
    execute: async (params) => {
      const file = livePatchFile(ctx, config)
      const rows = rowsOf(readGroups(file))
      const listed = rows.map((row) => {
        const entry = liveEntry(ctx.loader, row.id)
        return {
          id: row.id,
          module: row.name,
          config: row.config,
          mounted: mounted(entry),
          present: entry !== undefined,
          fiber_state: entry === undefined ? null : String(entry.fiber?.state),
          row_id: entry === undefined ? null : String(entry.id),
          disabled: entry?.disabled === true,
        }
      })
      const loaderRows = [...ctx.loader.entries()].slice(0, 80).map((row) => (
        `${String(row.options?.id ?? '?')}#${String(row.id ?? '?')} ${String(row.options?.name ?? '?')} fiber=${String(row.fiber?.state ?? 'none')}`
      ))
      const plugins = params.live_only === true ? listed.filter((row) => !row.mounted) : listed
      return {
        patch_file: file,
        tool_count: toolNames(ctx.tools).length,
        count: plugins.length,
        plugins,
        loader_rows: loaderRows,
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── plugin add ───────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin add',
    description:
      'adds a dsh plugin to the RUNNING workstation service: declares the row in the live patch layer (watched by the harness) and waits until the running tree has it mounted; the module source must be reachable by the service',
    parameters: {
      id: { type: 'string', description: 'loader row id (letters/digits/._-, unique across the tree)', required: true },
      module: { type: 'string', description: 'module specifier: an absolute .ts/.js path inside the container, or a package name', required: true },
      config: { type: 'json', description: 'the row config (a JSON object), when the plugin takes one' },
      wait_ms: { type: 'integer', description: `how long to wait for the harness Loader (default ${String(defaultWaitMs)})` },
    },
    execute: async (params) => {
      const id = requiredParam(params, 'id')
      const module = requiredParam(params, 'module')
      if (!ID_PATTERN.test(id)) throw new Error(`plugin-live: '${id}' is not a usable row id (letters/digits/._- only)`)
      const file = livePatchFile(ctx, config)
      const beforeTools = toolNames(ctx.tools)
      const present = liveEntry(ctx.loader, id)
      const presentModule = present === undefined ? undefined : String(present.options?.name)
      if (present !== undefined && presentModule !== module) {
        throw new Error(
          `plugin-live: the Loader already holds an entry '${id}' (module ${String(presentModule)}); `
          + 'remove it first or pick another id',
        )
      }
      const hasConfig = params.config !== undefined && params.config !== null
      const row: LiveRow = hasConfig ? { id, name: module, config: params.config } : { id, name: module }
      audit(`event=add-start id=${id} module=${module} config=${JSON.stringify(row.config ?? null)}`)
      const declared = upsertRow(file, row)

      const budget = waitBudget(params, defaultWaitMs)
      const toolsGrew = (): boolean => toolNames(ctx.tools).some((entry) => !beforeTools.includes(entry))
      const waited = await waitUntil(ctx.loader, () => mounted(liveEntry(ctx.loader, id)) || toolsGrew(), budget)
      try {
        await ctx.loader.await?.()
      } catch {
        /* reporting is best effort */
      }
      await sleep(300)

      const entry = liveEntry(ctx.loader, id)
      const isMounted = mounted(entry)
      const tools = delta(beforeTools, toolNames(ctx.tools))
      audit(
        `event=add-done id=${id} declared=${declared} mounted=${isMounted} fiber=${String(entry?.fiber?.state ?? 'none')} `
        + `waited_ms=${waited} tools_added=${JSON.stringify(tools.added)}`,
      )
      return {
        id,
        module,
        patch_file: file,
        declared,
        mounted: isMounted,
        present: entry !== undefined,
        fiber_state: entry === undefined ? null : String(entry.fiber?.state),
        waited_ms: waited,
        tools_added: tools.added,
        tools_removed: tools.removed,
        ...(isMounted ? {} : {
          warning: 'the row is declared but the running tree did not mount the entry within the wait budget',
        }),
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── plugin remove ────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin remove',
    description:
      'removes a dsh plugin from the RUNNING workstation service: drops its row from the live patch layer and waits until the harness Loader has DISPOSED the entry (its tools and effects)',
    parameters: {
      id: { type: 'string', description: 'the loader row id to dispose', required: true },
      wait_ms: { type: 'integer', description: `how long to wait for the harness Loader (default ${String(defaultWaitMs)})` },
    },
    execute: async (params) => {
      const id = requiredParam(params, 'id')
      const file = livePatchFile(ctx, config)
      const beforeTools = toolNames(ctx.tools)
      const mountedBefore = mounted(liveEntry(ctx.loader, id))
      audit(`event=remove-start id=${id} mounted_before=${mountedBefore} tools_before=${JSON.stringify(beforeTools)}`)
      const declared = dropRow(file, id)

      const budget = waitBudget(params, defaultWaitMs)
      const waited = await waitUntil(ctx.loader, () => liveEntry(ctx.loader, id) === undefined, budget)
      try {
        await ctx.loader.await?.()
      } catch {
        /* reporting is best effort */
      }
      await sleep(300)

      const entry = liveEntry(ctx.loader, id)
      const disposed = entry === undefined
      const tools = delta(beforeTools, toolNames(ctx.tools))
      audit(
        `event=remove-done id=${id} declared_row_removed=${declared} disposed=${disposed} waited_ms=${waited} `
        + `tools_removed=${JSON.stringify(tools.removed)}`,
      )
      return {
        id,
        patch_file: file,
        declared_row_removed: declared,
        mounted_before: mountedBefore,
        disposed,
        fiber_state: entry === undefined ? null : String(entry.fiber?.state),
        waited_ms: waited,
        tools_removed: tools.removed,
        tools_added: tools.added,
        ...(disposed ? {} : {
          warning: 'the entry is still mounted; a higher-priority layer (a --patch overlay such as '
            + '/opt/omni/config/workstation.yml) declares this row, so it can only be removed from that file',
        }),
      }
    },
    output: { schema: {}, render: renderValue },
  })))
}

export default { name, inject, apply }
