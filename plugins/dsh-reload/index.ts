/**
 * dsh-reload - ONE imperative call that re-resolves a changed plugin module
 * graph in the RUNNING workstation service, with no container recreate, no
 * service restart and no compose verb.
 *
 * THE DEFECT (fixed 2026-10-03)
 * -----------------------------
 * The previous implementation disposed the row through its own EntryGroup and
 * re-created it against the Loader tree by hand (`entry.parent.remove` +
 * `group.create`). In production that re-mounted the ENTRY module but did NOT
 * re-register the row's tools: `dsh_reload {"id":"agent-run"}` returned
 * disposed=true, mounted=true, yet `agent_run` DISAPPEARED from the running
 * facade. Only the harness' own composition path (driven by the watched patch
 * layer) re-runs a row's `apply`, and that is exactly the path the running
 * `plugin_remove` / `plugin_add` tools use.
 *
 * THE FIX
 * -------
 * 1. RE-MOUNT THROUGH THE PROVEN SEAM. `dsh_reload` now imports the shared
 *    primitives and the remove/add seam extracted from `plugin-live`
 *    (`plugins/plugin-live/live-layer.ts`). `removeRowSeam` drops the row from
 *    whichever live layers declare it (the watched HOME patch and the managed
 *    CLI --patch overlay) and waits for the Loader to DISPOSE it;
 *    `addRowSeam` re-declares the row on the SAME layers with the SAME config
 *    and waits for the Loader to MOUNT it again. Nothing is hand-rolled against
 *    the Loader tree.
 * 2. ASSERT THE POST-CONDITION. The tool-name set AFTER must equal the set
 *    BEFORE (the SAME `delta` helper plugin-live uses). When a tool is still
 *    missing, one more explicit remove+add cycle is attempted and the
 *    post-condition is re-asserted. The result carries tools_before,
 *    tools_after, tools_added, tools_removed and postcondition_ok.
 * 3. EVICT THE GRAPH. Before the re-mount, every cached module URL under the
 *    source prefix is evicted from Node's INTERNAL ESM loadCache (the dsh-hmr
 *    recipe: `Map.prototype.delete.call`), so the re-import of the ENTRY module
 *    AND its nested relative imports is a cache miss.
 * 4. OBSERVE THE FRESH PRICING PROVENANCE. After the re-import the tool result
 *    carries `pricing: { pricing_ref, source, version }`, read from the freshly
 *    loaded `shared/pricing.ts` through its exported API
 *    (`loadPriceTable()` + `aggregateProvenance()`). Nothing is hardcoded: the
 *    value is read from the same file-driven definition the running usage
 *    accounting serves.
 *
 * USAGE
 * -----
 *   dsh_reload {"id":"agent-run"}
 *   dsh_reload {"id":"agent-run","module":"/path/to/index.ts?rev=20261003"}
 *   dsh_reload {"id":"live-fixture","prefix":"/var/lib/workstation/sources/"}
 *
 * No secrets anywhere. OMNI_DIR is read from the environment with the /opt/omni
 * fallback. ASCII only.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineTool, renderValue } from '../../definitions/tools.ts'
import {
  DEFAULT_WAIT_MS,
  addRowSeam,
  delta,
  liveEntry,
  mounted,
  removeRowSeam,
  rowDeclaration,
  sameModule,
  toolNames,
  waitBudget,
  waitForToolSet,
  type Config as LiveConfig,
  type LoaderLike,
  type PluginContext as LiveContext,
  type SeamAddResult,
  type SeamRemoveResult,
} from '../plugin-live/live-layer.ts'

export const name = 'dsh-reload'

/** Cordis dependencies: the tool registry and the (always mounted) Loader. */
export const inject = ['tools', 'loader']

/** Default source prefix whose cached module URLs are evicted (the live plugin volume). */
const DEFAULT_PREFIX = '/var/lib/workstation/sources/'

/** Default config file (relative to OMNI_DIR) used to resolve a row when the tree has none. */
const DEFAULT_CONFIG_RELATIVE = 'config/workstation.yml'

/** OMNI_DIR fallback when the environment does not name it. */
const DEFAULT_OMNI_DIR = '/opt/omni'

export interface Config extends LiveConfig {
  /** Source prefix whose cached module URLs are evicted (default DEFAULT_PREFIX). */
  prefix?: string
}

// -- structural contracts (this plugin imports nothing from the harness) -----

/** The Loader slice this tool additionally drives: the Node-internal ESM cache. */
interface ReloadLoaderLike extends LoaderLike {
  internal?: { loadCache?: Map<string, unknown> } | null
}

/** The context this tool needs: the shared seam plus the internal loadCache. */
interface ReloadContext extends LiveContext {
  loader: ReloadLoaderLike
}

// -- small helpers -----------------------------------------------------------

/** A non-empty string, else undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
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
function assertLoadCache(loader: ReloadLoaderLike): Map<string, unknown> {
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

/** The pricing provenance of the freshly loaded shared module, best effort. */
async function pricingProvenance(): Promise<{ pricing: { pricing_ref: string | null; source: string; version: string }; error?: string }> {
  try {
    // A relative import inside the plugin: after the eviction above it is a
    // cache miss and re-imports fresh, together with the rest of the graph.
    const module = await import('../../shared/pricing.ts')
    const table = module.loadPriceTable()
    const provenance = module.aggregateProvenance(table)
    return { pricing: { pricing_ref: provenance.pricing_ref, source: provenance.source, version: table.version } }
  } catch (error) {
    return { pricing: { pricing_ref: null, source: 'unavailable', version: '' }, error: String(error) }
  }
}

export function apply(ctx: ReloadContext, config: Config = {}): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_reload',
    description:
      'reloads ONE running dsh plugin row in place through the SAME dispose+mount seam plugin_remove/plugin_add use: evicts the Node ESM loadCache for the whole plugin-source graph (dsh-hmr recipe), disposes and re-declares the row on its live layer(s), asserts the tool set is unchanged and reports the fresh pricing provenance; one call, no restart',
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
      const budget = waitBudget(params, config.waitMs ?? DEFAULT_WAIT_MS)

      // Fail before disposing when the eviction itself is impossible.
      const cache = assertLoadCache(ctx.loader)

      // 1. resolve the specifier: explicit param, then the live Loader tree,
      //    then the live config file.
      const entry = liveEntry(ctx.loader, id)
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
      const declaration = rowDeclaration(ctx, config, id)
      const declaredInLiveLayer = declaration.live || declaration.config
      // The Loader reports a resolved file URL while the patch may declare an
      // absolute path. Re-declare the DECLARED specifier when it names the same
      // module, so a reload does not rewrite the row's form.
      const remountModule = declaration.module !== undefined && sameModule(declaration.module, module) ? declaration.module : module

      // 2. EVICT the whole graph under the prefix at the SAME urls, BEFORE the
      //    remove+add cycle, so the re-import is a cache miss.
      const evicted = evictPrefix(prefix, cache)

      // 3. RE-MOUNT through the proven seam: remove (both live layers, wait for
      //    dispose) then add back on the SAME layer(s), wait for mount. A row
      //    that no live layer declares cannot be disposed by this tool, so it is
      //    reported honestly instead of being re-created against the tree.
      let remove: SeamRemoveResult
      let add: SeamAddResult
      if (declaredInLiveLayer) {
        remove = await removeRowSeam(ctx, config, id, budget)
        add = await addRowSeam(ctx, config, id, remountModule, declaration, budget)
      } else {
        const current = liveEntry(ctx.loader, id)
        remove = {
          liveDeclared: false,
          configDeclared: false,
          declaredRowRemoved: false,
          configFileChanged: false,
          configForm: null,
          backupFile: null,
          disposed: current === undefined,
          waitedMs: 0,
        }
        add = {
          liveDeclared: false,
          configDeclared: false,
          declared: false,
          overlayFile: null,
          backupFile: null,
          mounted: mounted(current),
          fiberState: current === undefined ? null : String(current.fiber?.state ?? 'none'),
          waitedMs: 0,
        }
      }
      await waitForToolSet(ctx, beforeTools, Math.min(budget, 3000))
      let afterTools = toolNames(ctx.tools)
      let changed = delta(beforeTools, afterTools)
      let postconditionOk = changed.added.length === 0 && changed.removed.length === 0

      // 4. FALLBACK: if a tool is still missing, one more explicit remove+add
      //    cycle (with a fresh eviction) and re-assert.
      let fallbackUsed = false
      if (declaredInLiveLayer && !postconditionOk) {
        fallbackUsed = true
        evictPrefix(prefix, cache)
        remove = await removeRowSeam(ctx, config, id, budget)
        add = await addRowSeam(ctx, config, id, remountModule, declaration, budget)
        await waitForToolSet(ctx, beforeTools, Math.min(budget, 3000))
        afterTools = toolNames(ctx.tools)
        changed = delta(beforeTools, afterTools)
        postconditionOk = changed.added.length === 0 && changed.removed.length === 0
      }

      // 5. OBSERVE the pricing provenance of the module graph the RUNNING
      //    process now serves, read through the shared module API.
      const pricingOutcome = await pricingProvenance()

      const result: Record<string, unknown> = {
        ok: add.mounted && postconditionOk,
        id,
        module: remountModule,
        resolved_module: module,
        resolved_from: resolvedFrom,
        prefix,
        declared_before: { live: declaration.live, config: declaration.config },
        disposed: remove.disposed,
        mounted: add.mounted,
        decl: {
          removed_live: remove.liveDeclared,
          removed_config: remove.configDeclared,
          added_live: add.liveDeclared,
          added_config: add.configDeclared,
          config_file: add.overlayFile ?? declaration.configFile,
          backup_file: add.backupFile,
        },
        evicted: evicted.urls,
        evicted_count: evicted.urls.length,
        require_cache_evicted: evicted.cjs,
        fiber_state: add.fiberState,
        tools_before: beforeTools,
        tools_after: afterTools,
        tools_added: changed.added,
        tools_removed: changed.removed,
        postcondition_ok: postconditionOk,
        fallback_used: fallbackUsed,
        pricing: pricingOutcome.pricing,
      }
      if (pricingOutcome.error !== undefined) result.pricing_error = pricingOutcome.error
      if (!add.mounted) {
        result.next = [
          { tool: 'plugin_remove', params: { id } },
          { tool: 'plugin_add', params: { id, module: remountModule } },
        ]
        result.next_note = 'the shared dispose+mount seam did not report a mount on this harness build; apply the facade calls in order'
      }
      if (!postconditionOk) {
        result.warning = 'postcondition failed: the tool-name set changed across the reload'
      } else if (!declaration.live && !declaration.config) {
        result.warning = 'the row is not declared in a live layer this tool owns (HOME patch or CLI --patch overlay); it cannot be disposed and re-mounted'
      }
      return result
    },
    output: { schema: {}, render: renderValue },
  })))
}

export default { name, inject, apply }
