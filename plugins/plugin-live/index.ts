/**
 * plugin-live - add and REMOVE dsh plugins AND CONFIG ROWS ON THE FLY in the
 * RUNNING workstation service (no container recreate, no service restart, no
 * release path).
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
 * `@deepseek-ai/dsh-hmr` (ENABLED in this boot: the base bundle gates it on
 * `profileContext`, which the dsh profile launcher always supplies) watches
 * EXACTLY TWO files - the PROFILE patch and the HOME patch
 * (packages/boot/hmr/src/index.ts). Every change to one of them re-reads ALL
 * layers and applies the new generation to the LIVE Loader tree
 * (`readProfilePatches` -> `reconcileProfilePatches` -> `ctx.loader.await()`):
 * new rows activate, deleted rows are DISPOSED, inside the running process.
 *
 * Reading is _not_ the problem: `readProfilePatches` re-reads the profile patch
 * and the HOME patch from DISK on every reload. The CLI `--patch` overlay is
 * the problem: its rows are parsed ONCE by the launcher and handed to the
 * running process as `profileContext.overlays` (a plain, MUTABLE array that
 * stays the LAST layer of every later composition, apps/cli/src/profile-boot.ts
 * + packages/boot/app-boot/src/profile-context.ts). So editing the overlay FILE
 * alone can never reach the running tree - while a row the overlay declares
 * outranks both watched layers, which is why such a row could not be disposed
 * live either.
 *
 * What this plugin does - two live layers, no shim:
 *
 * 1. LIVE PLUGIN LAYER = `$DSH_HOME/cordis.patch.yml` (the watched HOME patch,
 *    which nothing else writes). `plugin_add` / `plugin_remove` declare or drop
 *    a row there and wait until the running Loader tree has mounted / DISPOSED
 *    it. The write is atomic (temp + rename, exactly one watcher event) and each
 *    generation carries a comment header so the file text changes even when the
 *    rows do not - which is how this plugin triggers a re-composition on demand.
 *
 * 2. LIVE CONFIG LAYER = the CLI `--patch` overlay (the workstation roster,
 *    e.g. /opt/omni/config/workstation.yml). This plugin owns its
 *    `profileContext.overlays` copy as the LIVE list (in-place inserts/splices,
 *    so the harness's own next composition sees them) and keeps the FILE as the
 *    persistent mirror of that list:
 *
 *     plugin config add   - temp-file-first: build the new overlay text, validate
 *                           it with the SAME YAML parser the harness runs at boot
 *                           (`yaml.load`, must be a top-level array), normalize the
 *                           managed rows to `- {json}` sequence items, back the live
 *                           file up into /opt/omni/data/backups/config/, place it
 *                           atomically, sync the in-memory overlay list and
 *                           re-compose. Text that would not parse at boot is NEVER
 *                           installed (production incident 2026-09-27 03:26Z: a bare
 *                           managed mapping crash-looped the service on the next boot)
 *     plugin config remove- drop the row from the file (managed one-line JSON
 *                           entry or an operator block row) AND from the live
 *                           list; the Loader disposes the entry
 *     plugin_config_sync  - re-read the file and reconcile rows that this plugin
 *                           can fully parse (managed one-line JSON entries, and
 *                           block rows without a config block) into the live
 *                           list, so a RAW file edit is applied live too
 *     plugin_config_list  - the file, its declared rows, the live list and the
 *                           Loader state per row (drift included)
 *
 * `plugin_remove` handles BOTH layers: a row declared in the config file is
 * removed from the file (with a backup) and from the live list, so a
 * config-declared row is addable AND removable live, as required.
 *
 * The reload itself is always the HARNESS's own path (`dsh-hmr` -> the root
 * Include entry -> `ctx.loader.await()`), announced on the root context as
 * `app-boot/config-reload`; every call appends a timestamped line to
 * `$DSH_HOME/plugin-live.log`, because the harness logger is not wired to the
 * container stdout.
 *
 * No workbench API, no hikari shim, no compat layer: this is a native dsh
 * plugin (defineTool + cordis injection) driving the harness' own composition
 * inputs and Loader service.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineTool, renderValue } from '../../definitions/tools.ts'
import {
  AUDIT_FILENAME,
  DEFAULT_WAIT_MS,
  ID_PATTERN,
  MAX_WAIT_MS,
  addOverlayRow,
  appendManagedRow,
  backupDirOf,
  backupOverlay,
  delta,
  dropOverlayRow,
  dropRow,
  homeOf,
  isOwnModule,
  liveEntry,
  livePatchFile,
  managedRows,
  mounted,
  normalizeManagedRows,
  overlayDeclares,
  overlayFileOf,
  overlayPatches,
  overlayRowsOf,
  placeText,
  readGroups,
  readText,
  removeRowFromOverlayFile,
  requiredParam,
  rowsOf,
  sameModule,
  scanFileRows,
  sleep,
  toolNames,
  touchLiveLayer,
  upsertRow,
  validateBootParse,
  validateOverlayText,
  waitBudget,
  waitUntil,
  type Config,
  type LiveRow,
  type PluginContext,
} from './live-layer.ts'

export const name = 'plugin-live'

/** Cordis dependencies: the tool registry and the (always mounted) Loader. */
export const inject = ['tools', 'loader']


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

  audit(
    `event=load tool=plugin-live patch_file=${livePatchFile(ctx, config)} `
    + `config_file=${overlayFileOf(ctx, config) ?? 'none'} node=${process.version}`,
  )

  // ── plugin_list ──────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_list',
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
        config_file: overlayFileOf(ctx, config) ?? null,
        config_rows: overlayRowsOf(ctx).length,
        tool_count: toolNames(ctx.tools).length,
        count: plugins.length,
        plugins,
        loader_rows: loaderRows,
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── plugin_add ───────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_add',
    description:
      'adds a dsh plugin to the RUNNING workstation service, either in the live patch layer (layer="live", or layer="config" to also declare the row in the managed CLI --patch overlay file); waits until the running tree has it mounted; the module source must be reachable by the service',
    parameters: {
      id: { type: 'string', description: 'loader row id (letters/digits/._-, unique across the tree)', required: true },
      module: { type: 'string', description: 'module specifier: an absolute .ts/.js path inside the container, or a package name', required: true },
      config: { type: 'json', description: 'the row config (a JSON object), when the plugin takes one' },
      layer: { type: 'string', enum: ['live', 'config', 'memory'], description: 'live = the watched HOME patch (default); config = the managed CLI --patch overlay file (persistent roster); memory = the live overlay layer only, no file write (moves a row off the watched HOME patch)' },
      wait_ms: { type: 'integer', description: `how long to wait for the harness Loader (default ${String(defaultWaitMs)})` },
    },
    execute: async (params) => {
      const id = requiredParam(params, 'id')
      const module = requiredParam(params, 'module')
      const layer = params.layer === 'config' ? 'config' : params.layer === 'memory' ? 'memory' : 'live'
      if (!ID_PATTERN.test(id)) throw new Error(`plugin-live: '${id}' is not a usable row id (letters/digits/._- only)`)
      const file = livePatchFile(ctx, config)
      const beforeTools = toolNames(ctx.tools)
      const present = liveEntry(ctx.loader, id)
      const presentModule = present === undefined ? undefined : String(present.options?.name)
      if (present !== undefined && !sameModule(presentModule, module)) {
        throw new Error(
          `plugin-live: the Loader already holds an entry '${id}' (module ${String(presentModule)}); `
          + 'remove it first or pick another id',
        )
      }
      const hasConfig = params.config !== undefined && params.config !== null
      const row: LiveRow = hasConfig ? { id, name: module, config: params.config } : { id, name: module }
      const budget = waitBudget(params, defaultWaitMs)
      const toolsGrew = (): boolean => toolNames(ctx.tools).some((entry) => !beforeTools.includes(entry))
      let declared: boolean
      let overlayFile: string | null = null
      let backupFile: string | null = null

      if (layer === 'config') {
        const target = overlayFileOf(ctx, config)
        if (target === undefined) {
          throw new Error('plugin-live: this boot has no CLI --patch overlay to write (pass --patch <file> or configure configFile)')
        }
        if (overlayDeclares(ctx, id)) throw new Error(`plugin-live: the overlay layer already declares '${id}'`)
        if (rowsOf(readGroups(file)).some((candidate) => candidate.id === id)) {
          throw new Error(`plugin-live: the live layer already declares '${id}'; remove it first`)
        }
        audit(`event=config-add-start id=${id} module=${module} layer=config file=${target}`)
        const nextText = normalizeManagedRows(appendManagedRow(readText(target), row))
        validateOverlayText(nextText, id)
        validateBootParse(nextText)
        audit(`event=config-add-validated id=${id} file=${target} boot_parse=ok managed_rows=${String(managedRows(nextText).length)}`)
        backupFile = backupOverlay(target, backupDirOf(config)) ?? null
        placeText(target, nextText)
        addOverlayRow(ctx, row)
        touchLiveLayer(ctx, config)
        declared = true
        overlayFile = target
      } else if (layer === 'memory') {
        // The live CONFIG layer without a file write: the row leaves the watched
        // HOME patch and is declared by the overlay list the running service
        // keeps in memory, so the next boot declares it exactly once (from the
        // config file) and the running tree keeps serving the SAME module.
        audit(`event=memory-add-start id=${id} module=${module} layer=memory`)
        const homeChanged = dropRow(file, id)
        dropOverlayRow(ctx, id)
        addOverlayRow(ctx, row)
        if (!homeChanged) touchLiveLayer(ctx, config)
        declared = true
      } else {
        audit(`event=add-start id=${id} module=${module} config=${JSON.stringify(row.config ?? null)} layer=live`)
        declared = upsertRow(file, row)
      }

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
        `event=add-done id=${id} layer=${layer} declared=${declared} mounted=${isMounted} fiber=${String(entry?.fiber?.state ?? 'none')} `
        + `waited_ms=${waited} tools_added=${JSON.stringify(tools.added)}`,
      )
      return {
        id,
        module,
        layer,
        patch_file: file,
        config_file: overlayFile,
        backup_file: backupFile,
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

  // ── plugin_remove ────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_remove',
    description:
      'removes a dsh plugin from the RUNNING workstation service: drops its row from the live patch layer AND from the managed CLI --patch overlay file (backed up), then waits until the harness Loader has DISPOSED the entry (its tools and effects)',
    parameters: {
      id: { type: 'string', description: 'the loader row id to dispose', required: true },
      wait_ms: { type: 'integer', description: `how long to wait for the harness Loader (default ${String(defaultWaitMs)})` },
    },
    execute: async (params) => {
      const id = requiredParam(params, 'id')
      const file = livePatchFile(ctx, config)
      const beforeTools = toolNames(ctx.tools)
      const mountedBefore = mounted(liveEntry(ctx.loader, id))
      const liveDeclared = rowsOf(readGroups(file)).some((row) => row.id === id)
      const configDeclared = overlayDeclares(ctx, id)
      const target = overlayFileOf(ctx, config)
      audit(
        `event=remove-start id=${id} mounted_before=${mountedBefore} live_declared=${liveDeclared} `
        + `config_declared=${configDeclared} tools_before=${JSON.stringify(beforeTools)}`,
      )
      let declaredRowRemoved = false
      let configFileChanged = false
      let backupFile: string | null = null
      let configForm: string | null = null

      if (liveDeclared) declaredRowRemoved = dropRow(file, id)
      if (configDeclared) {
        dropOverlayRow(ctx, id)
        if (target !== undefined) {
          const outcome = removeRowFromOverlayFile(target, id, backupDirOf(config))
          configFileChanged = outcome.changed
          backupFile = outcome.backupFile ?? null
          configForm = outcome.form ?? null
        }
        if (!liveDeclared) touchLiveLayer(ctx, config)
      }
      if (!liveDeclared && !configDeclared) audit(`event=remove-noop id=${id} not declared in a live layer`)

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
        `event=remove-done id=${id} live_declared=${liveDeclared} config_declared=${configDeclared} `
        + `declared_row_removed=${declaredRowRemoved} config_file_changed=${configFileChanged} disposed=${disposed} `
        + `waited_ms=${waited} tools_removed=${JSON.stringify(tools.removed)}`,
      )
      return {
        id,
        patch_file: file,
        config_file: target ?? null,
        declared_in_live_layer: liveDeclared,
        declared_in_config_file: configDeclared,
        declared_row_removed: declaredRowRemoved,
        config_file_changed: configFileChanged,
        config_row_form: configForm,
        backup_file: backupFile,
        mounted_before: mountedBefore,
        disposed,
        fiber_state: entry === undefined ? null : String(entry.fiber?.state),
        waited_ms: waited,
        tools_removed: tools.removed,
        tools_added: tools.added,
        ...(disposed ? {} : {
          warning: 'the entry is still mounted; it is declared by a layer this plugin does not own '
            + '(a bundle or a profile patch), so it can only be removed from that file',
        }),
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── plugin_config_list ───────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_config_list',
    description:
      'lists the rows of the managed CLI --patch overlay (the workstation roster), the LIVE overlay layer the running service applies, and the Loader state of every row',
    parameters: {},
    execute: async () => {
      const target = overlayFileOf(ctx, config)
      const text = target === undefined ? '' : readText(target)
      const fileRows = text.trim().length === 0 ? [] : scanFileRows(text)
      const live = overlayRowsOf(ctx)
      const state = (id: string): { mounted: boolean; present: boolean; fiber_state: string | null } => {
        const entry = liveEntry(ctx.loader, id)
        return {
          mounted: mounted(entry),
          present: entry !== undefined,
          fiber_state: entry === undefined ? null : String(entry.fiber?.state),
        }
      }
      return {
        config_file: target ?? null,
        config_file_bytes: text.length,
        live_layer: overlayPatches(ctx) === undefined ? 'absent (no profileContext.overlays)' : 'present',
        counts: { file_rows: fileRows.length, live_rows: live.length },
        file_rows: fileRows.map((row) => ({
          id: row.id,
          module: row.name,
          form: row.kind,
          line: row.line,
          ...(row.config === undefined ? {} : { config: row.config }),
          config_block_unparsed: row.hasConfigBlock,
          ...state(row.id),
        })),
        live_rows: live.map((row) => ({
          id: row.id,
          module: row.name,
          ...(row.config === undefined ? {} : { config: row.config }),
          ...state(row.id),
        })),
        drift: {
          only_in_file: fileRows.filter((row) => !live.some((candidate) => candidate.id === row.id)).map((row) => row.id),
          only_live: live.filter((row) => !fileRows.some((candidate) => candidate.id === row.id)).map((row) => row.id),
        },
        live_patch_file: livePatchFile(ctx, config),
        live_patch_rows: rowsOf(readGroups(livePatchFile(ctx, config))).map((row) => ({ id: row.id, module: row.name })),
        tool_count: toolNames(ctx.tools).length,
      }
    },
    output: { schema: {}, render: renderValue },
  })))

  // ── plugin_config_sync ───────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin_config_sync',
    description:
      're-reads the managed CLI --patch overlay file and applies its rows to the RUNNING service (rows this plugin can fully parse: managed one-line JSON entries and block rows without a config block), then re-composes the live tree',
    parameters: {
      wait_ms: { type: 'integer', description: `how long to wait for the harness Loader (default ${String(defaultWaitMs)})` },
    },
    execute: async (params) => {
      const target = overlayFileOf(ctx, config)
      if (target === undefined) throw new Error('plugin-live: this boot has no CLI --patch overlay to sync')
      const text = readText(target)
      const fileRows = scanFileRows(text)
      const before = overlayRowsOf(ctx)
      const beforeTools = toolNames(ctx.tools)
      const added: string[] = []
      const updated: string[] = []
      const removed: string[] = []
      const skipped: Array<{ id: string; reason: string }> = []
      for (const row of fileRows) {
        const current = before.find((candidate) => candidate.id === row.id)
        if (current === undefined) {
          if (row.hasConfigBlock) {
            skipped.push({ id: row.id, reason: 'the overlay row carries a config block this plugin does not parse; use plugin_add --layer config' })
            continue
          }
          addOverlayRow(ctx, { id: row.id, name: row.name, ...(row.config === undefined ? {} : { config: row.config }) })
          added.push(row.id)
          continue
        }
        if (row.hasConfigBlock && row.config === undefined) continue
        if (isOwnModule(row.name) && current.name !== row.name) {
          skipped.push({ id: row.id, reason: 'the plugin-live control plane is never re-synced to a different module URL in place; a changed module URL needs a container recreate' })
          continue
        }
        if (current.name !== row.name || JSON.stringify(current.config) !== JSON.stringify(row.config)) {
          dropOverlayRow(ctx, row.id)
          addOverlayRow(ctx, { id: row.id, name: row.name, ...(row.config === undefined ? {} : { config: row.config }) })
          updated.push(row.id)
        }
      }
      for (const row of before) {
        if (fileRows.some((candidate) => candidate.id === row.id)) continue
        dropOverlayRow(ctx, row.id)
        removed.push(row.id)
      }
      audit(
        `event=config-sync file=${target} added=${JSON.stringify(added)} updated=${JSON.stringify(updated)} `
        + `removed=${JSON.stringify(removed)} skipped=${JSON.stringify(skipped.map((entry) => entry.id))}`,
      )
      const changed = added.length + updated.length + removed.length > 0
      if (changed) touchLiveLayer(ctx, config)
      const budget = waitBudget(params, defaultWaitMs)
      let waited = 0
      if (changed) {
        waited = await waitUntil(ctx.loader, () => added.every((id) => mounted(liveEntry(ctx.loader, id)))
          && removed.every((id) => liveEntry(ctx.loader, id) === undefined), budget)
        try {
          await ctx.loader.await?.()
        } catch {
          /* reporting is best effort */
        }
        await sleep(300)
      }
      const tools = delta(beforeTools, toolNames(ctx.tools))
      return {
        config_file: target,
        changed,
        added,
        updated,
        removed,
        skipped,
        file_rows: fileRows.map((row) => row.id),
        live_rows: overlayRowsOf(ctx).map((row) => row.id),
        waited_ms: waited,
        tools_added: tools.added,
        tools_removed: tools.removed,
      }
    },
    output: { schema: {}, render: renderValue },
  })))
}

export default { name, inject, apply }
