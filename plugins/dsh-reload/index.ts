/**
 * dsh-reload - ONE imperative call that re-resolves a changed plugin module
 * graph in the RUNNING workstation service, with no container recreate, no
 * service restart and no compose verb.
 *
 * THE DEFECT
 * ----------
 * The harness (dsh) serves the module it imported for a URL for the LIFE of the
 * process. Re-mounting a row at a NEW url re-imports the ENTRY module, but its
 * RELATIVE imports (for example `shared/usage.ts`) resolve to the SAME url and
 * therefore stay CACHED: a `?query` remount refreshes the entry only, not the
 * nested graph. Proven live 2026-10-03: `agent-run` was remounted at
 * `.../index.ts?rev=20261003-pricing` and still emitted the stale nested
 * pricing module.
 *
 * THE RECIPE (from @deepseek-ai/dsh-hmr, packages/boot/hmr/src/index.ts:441-511)
 * -----------------------------------------------------------------------------
 * dsh-hmr busts the cache by EVICTION at the SAME url, never with a query. It
 * iterates the plugin dependency closure and calls
 * `Map.prototype.delete.call(this.internal.loadCache, filename)` on Node's
 * INTERNAL ESM loadCache (plus the matching `require.cache` entry), then
 * re-imports the same url. The recipe already ships in this image, but dsh-hmr
 * registers NO tool and its module watch root is empty
 * (packages/bundle/base/cordis.patch.yml:32), so there is no imperative way to
 * fire it. This plugin fires it.
 *
 * WHAT THIS TOOL DOES (ONE call, no manual second step)
 * -----------------------------------------------------
 * 1. resolve the row's current module specifier from the running Loader tree
 *    (fallback: the live config file), unless `module` is given;
 * 2. DISPOSE the row from the running Loader tree (EntryGroup.remove);
 * 3. EVICT every `internal.loadCache` key under the source prefix, plus the
 *    matching `require.cache` entries, exactly dsh-hmr's recipe;
 * 4. RE-MOUNT the row at the SAME specifier (EntryGroup.create), so the entry
 *    AND its nested relative imports import FRESH;
 * 5. return raw JSON { ok, id, module, disposed, mounted, evicted, ... } plus
 *    the tool-name delta.
 *
 * Steps 2+4 use the public Loader tree API (`entry.parent.remove` /
 * `entry.parent.create`), which is exactly the dispose/mount seam plugin-live
 * already drives. If that API is unavailable on a future harness build, the
 * result still reports the eviction and carries a `next` field naming the exact
 * facade calls (`plugin_remove` + `plugin_add` with their JSON bodies) instead
 * of claiming a false success.
 *
 * OPERATOR REQUEST
 * ----------------
 * "an imperative in-image reload command" (telegram, 2026-10-03).
 *
 * USAGE
 * -----
 *   dsh_reload {"id":"agent-run"}
 *   dsh_reload {"id":"agent-run","module":"/path/to/index.ts?rev=20261003"}
 *   dsh_reload {"id":"agent-run","prefix":"/var/lib/workstation/sources/"}
 *
 * No secrets anywhere. OMNI_DIR is read from the environment with the /opt/omni
 * fallback. ASCII only.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'dsh-reload'

/** Cordis dependencies: the tool registry and the (always mounted) Loader. */
export const inject = ['tools', 'loader']

/** Default source prefix whose cached module URLs are evicted (the live plugin volume). */
const DEFAULT_PREFIX = '/var/lib/workstation/sources/'

/** Default config file (relative to OMNI_DIR) used to resolve a row when the tree has none. */
const DEFAULT_CONFIG_RELATIVE = 'config/workstation.yml'

/** OMNI_DIR fallback when the environment does not name it. */
const DEFAULT_OMNI_DIR = '/opt/omni'

export interface Config {
  /** Source prefix whose cached module URLs are evicted (default DEFAULT_PREFIX). */
  prefix?: string
  /** Absolute path of the live config file used to resolve a row (default $OMNI_DIR/config/workstation.yml). */
  configFile?: string
}

// -- structural contracts (this plugin imports nothing from the harness) -----

/** One Loader entry row as `loader.entries()` reports it. */
interface EntryOptionsLike {
  id?: unknown
  name?: unknown
  config?: unknown
  inject?: unknown
  disabled?: unknown
  group?: unknown
}

/** The EntryGroup slice this plugin drives (dispose and re-mount seam). */
interface GroupLike {
  data?: unknown[]
  tree?: { write?(): void }
  create(options: Record<string, unknown>): Promise<unknown>
  remove(id: string): void
}

/** One live Loader entry. */
interface EntryLike {
  id?: unknown
  options?: EntryOptionsLike
  fiber?: { state?: unknown }
  parent?: GroupLike
}

/** The Loader service slice this plugin drives. */
interface LoaderLike {
  root?: GroupLike
  internal?: { loadCache?: Map<string, unknown> } | null
  entries(): Iterable<EntryLike>
  await?(): Promise<void>
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
  schemas?(): Array<{ name?: unknown }>
}

interface PluginContext {
  tools: ToolsLike
  loader: LoaderLike
  effect(callback: () => () => void): void
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

// -- small helpers -----------------------------------------------------------

/** A non-empty string, else undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The declared id of a Loader entry, preferring the patch-declared id. */
function entryId(entry: EntryLike): string | undefined {
  return readString(entry.options?.id) ?? readString(entry.id)
}

/** The live Loader entry for an id, when the running tree holds one. */
function findEntry(loader: LoaderLike, id: string): EntryLike | undefined {
  for (const entry of loader.entries()) {
    if (entryId(entry) === id) return entry
  }
  return undefined
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

/** The tool-name delta between two snapshots (added and removed, sorted). */
function delta(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter((entry) => !beforeSet.has(entry)).sort(),
    removed: before.filter((entry) => !afterSet.has(entry)).sort(),
  }
}

/** A required non-empty string parameter, or a readable refusal. */
function requiredParam(params: Record<string, unknown>, key: string): string {
  const value = readString(params[key])
  if (value === undefined) throw new Error(`dsh-reload: the '${key}' parameter must be a non-empty string`)
  return value.trim()
}

/** An optional non-empty string parameter (undefined when absent or blank). */
function optionalParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = readString(params[key])
  return value === undefined ? undefined : value.trim()
}

/** The omni root: $OMNI_DIR when set, else the /opt/omni fallback. */
function omniDir(): string {
  const value = process.env.OMNI_DIR
  return value !== undefined && value.trim().length > 0 ? value.trim() : DEFAULT_OMNI_DIR
}

/** The live config file used as the module fallback. */
function configFileOf(config: Config): string {
  if (config.configFile !== undefined && config.configFile.trim().length > 0) return config.configFile.trim()
  return join(omniDir(), DEFAULT_CONFIG_RELATIVE)
}

/** The module a patch insert row declares, scanned straight from its insert list. */
function moduleInPatch(parsed: unknown, id: string): string | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const insert = (parsed as { insert?: unknown }).insert
  if (!Array.isArray(insert)) return undefined
  for (const row of insert) {
    if (row === null || typeof row !== 'object') continue
    const candidate = row as { id?: unknown; name?: unknown }
    if (candidate.id === id && typeof candidate.name === 'string' && candidate.name.length > 0) return candidate.name
  }
  return undefined
}

/** Unquote a YAML scalar (single or double quoted, else the plain value). */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The module specifier of one row inside the live config file. Handles the
 * managed one-line JSON form (`- {"insert":[{"id":...,"name":...}]}`) and the
 * operator block form (`- id: <id>` followed by an indented `name:`).
 */
export function moduleFromPatchText(text: string, id: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const jsonText = trimmed.startsWith('- {') ? trimmed.slice(2).trim() : trimmed.startsWith('{') ? trimmed : undefined
    if (jsonText === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      continue
    }
    const found = moduleInPatch(parsed, id)
    if (found !== undefined) return found
  }
  const lines = text.split('\n')
  const pattern = new RegExp(`^(\\s*)-\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim().length === 0) continue
      if (line.length - line.trimStart().length <= indent) break
      const nameMatch = /^\s*name:\s*(.+)$/.exec(line)
      if (nameMatch !== null) return unquote(nameMatch[1])
    }
  }
  return undefined
}

/** Read the module fallback from the live config file (undefined on any error). */
function moduleFromConfigFile(file: string, id: string): string | undefined {
  try {
    return moduleFromPatchText(readFileSync(file, 'utf8'), id)
  } catch {
    return undefined
  }
}

/** Normalize the caller prefix to a trailing-slash file URL prefix. */
function toUrlPrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (trimmed.startsWith('file://')) return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
  const url = pathToFileURL(trimmed).href
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * The ESM cache to evict, or a loud refusal. The whole point of this tool is the
 * eviction, so a build without Node internals must fail BEFORE anything is
 * disposed rather than remount into a still-cached graph.
 */
function assertLoadCache(loader: LoaderLike): Map<string, unknown> {
  const cache = loader.internal?.loadCache
  if (cache === undefined || cache === null || typeof (cache as { get?: unknown }).get !== 'function') {
    throw new Error(
      'dsh-reload: ctx.loader.internal.loadCache is unavailable on this harness build; '
      + 'the ESM module cache cannot be evicted without Node internals (dsh-hmr needs them too)',
    )
  }
  return cache
}

/**
 * Evict every cached module URL under `prefix` from Node's INTERNAL ESM
 * loadCache (dsh-hmr's recipe: `Map.prototype.delete.call`) and every matching
 * `require.cache` entry. Returns the deleted urls and the CJS count.
 */
export function evictPrefix(prefix: string, cache: Map<string, unknown>): { urls: string[]; cjs: number } {
  const urlPrefix = toUrlPrefix(prefix)
  const urls: string[] = []
  for (const key of Map.prototype.keys.call(cache) as Iterable<unknown>) {
    if (typeof key !== 'string' || !key.startsWith(urlPrefix)) continue
    Map.prototype.delete.call(cache, key)
    urls.push(key)
  }
  urls.sort()
  const pathPrefix = urlPrefix.startsWith('file://') ? fileURLToPath(urlPrefix) : prefix
  const require = createRequire(import.meta.url)
  let cjs = 0
  for (const key of Object.keys(require.cache)) {
    if (!key.startsWith(pathPrefix)) continue
    Reflect.deleteProperty(require.cache, key)
    cjs += 1
  }
  return { urls, cjs }
}

/** Dispose the row through its own EntryGroup (the harness dispose seam). */
function disposeEntry(entry: EntryLike, fallbackId: string): boolean {
  const parent = entry.parent
  if (parent === undefined || typeof parent.remove !== 'function') return false
  const localId = readString(entry.options?.id) ?? fallbackId
  parent.remove(localId)
  try {
    parent.tree?.write?.()
  } catch {
    // an in-memory tree writes as a no-op, or not at all
  }
  return true
}

/**
 * Re-mount one row into its EntryGroup at the same specifier. Mirrors
 * `EntryTree.create`: the options join the group data (so the next reconcile
 * sees the row) and `group.create` imports the module FRESH (the cache was just
 * evicted).
 */
async function remountEntry(group: GroupLike, options: Record<string, unknown>): Promise<boolean> {
  if (Array.isArray(group.data)) group.data.push(options)
  try {
    group.tree?.write?.()
  } catch {
    // an in-memory tree writes as a no-op, or not at all
  }
  await group.create(options)
  return true
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_reload',
    description:
      'reloads ONE running dsh plugin row in place: disposes it from the live Loader tree, evicts the Node ESM loadCache for the whole plugin-source graph (dsh-hmr recipe) and re-mounts the row at the SAME specifier, so nested relative imports re-resolve; one call, no restart',
    parameters: {
      id: { type: 'string', description: 'cordis loader row id to reload, e.g. "agent-run"', required: true },
      module: { type: 'string', description: 'explicit module specifier to remount (default: the row current specifier, then the live config file)' },
      prefix: { type: 'string', description: `source prefix whose cached module URLs are evicted (default ${DEFAULT_PREFIX})` },
    },
    execute: async (params) => {
      const id = requiredParam(params, 'id')
      const explicit = optionalParam(params, 'module')
      const configured = config.prefix !== undefined && config.prefix.trim().length > 0 ? config.prefix.trim() : undefined
      const prefix = optionalParam(params, 'prefix') ?? configured ?? DEFAULT_PREFIX

      // Fail before disposing when the eviction itself is impossible.
      const cache = assertLoadCache(ctx.loader)

      // 1. resolve the specifier: explicit param, then the live Loader tree,
      //    then the live config file.
      const entry = findEntry(ctx.loader, id)
      let module = explicit
      let resolvedFrom: 'param' | 'loader' | 'config-file' = 'param'
      if (module === undefined && entry !== undefined) {
        module = readString(entry.options?.name)
        resolvedFrom = 'loader'
      }
      if (module === undefined) {
        const file = configFileOf(config)
        module = moduleFromConfigFile(file, id)
        resolvedFrom = 'config-file'
        if (module === undefined) {
          throw new Error(`dsh-reload: cannot resolve the module specifier for row '${id}' (absent from the Loader tree and not found in ${file})`)
        }
        if (module.length === 0) throw new Error(`dsh-reload: the config file row '${id}' declares an empty module specifier`)
      }

      const beforeTools = toolNames(ctx.tools)
      const parent = entry?.parent

      // 2. dispose the old generation.
      const disposed = entry === undefined ? false : disposeEntry(entry, id)

      // 3. evict the whole graph under the prefix at the SAME urls.
      const evicted = evictPrefix(prefix, cache)

      // 4. re-mount at the SAME specifier; the import is now a cache miss.
      let mounted = false
      let remountError: string | undefined
      const target = parent ?? ctx.loader.root
      if (target === undefined) {
        remountError = 'the running Loader exposes no root group to mount the row into'
      } else {
        const nextOptions: Record<string, unknown> = { ...(entry?.options ?? {}), id, name: module }
        try {
          mounted = await remountEntry(target, nextOptions)
        } catch (error) {
          remountError = String(error)
        }
      }

      try {
        await ctx.loader.await?.()
      } catch {
        // reporting is best effort
      }
      const afterTools = toolNames(ctx.tools)
      const changed = delta(beforeTools, afterTools)
      const current = findEntry(ctx.loader, id)

      const result: Record<string, unknown> = {
        ok: mounted,
        id,
        module,
        resolved_from: resolvedFrom,
        prefix,
        disposed,
        mounted,
        evicted: evicted.urls,
        evicted_count: evicted.urls.length,
        require_cache_evicted: evicted.cjs,
        fiber_state: current === undefined ? null : String(current.fiber?.state ?? 'none'),
        tools_before: beforeTools,
        tools_after: afterTools,
        tools_added: changed.added,
        tools_removed: changed.removed,
      }
      if (!mounted) {
        result.next = [
          { tool: 'plugin_remove', params: { id } },
          { tool: 'plugin_add', params: { id, module } },
        ]
        result.next_note = 'in-process dispose+remount did not complete on this harness build; apply the facade calls in order'
        if (remountError !== undefined) result.error = remountError
      }
      return result
    },
    output: { schema: {}, render: renderValue },
  })))
}

export default { name, inject, apply }
