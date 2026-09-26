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
 *    which nothing else writes). `plugin add` / `plugin remove` declare or drop
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
 *                           it, back the live file up into
 *                           /opt/omni/data/backups/config/, place it atomically,
 *                           sync the in-memory overlay list and re-compose
 *     plugin config remove- drop the row from the file (managed one-line JSON
 *                           entry or an operator block row) AND from the live
 *                           list; the Loader disposes the entry
 *     plugin config sync  - re-read the file and reconcile rows that this plugin
 *                           can fully parse (managed one-line JSON entries, and
 *                           block rows without a config block) into the live
 *                           list, so a RAW file edit is applied live too
 *     plugin config list  - the file, its declared rows, the live list and the
 *                           Loader state per row (drift included)
 *
 * `plugin remove` handles BOTH layers: a row declared in the config file is
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

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Default backup directory for the production overlay file. */
const DEFAULT_BACKUP_DIR = '/opt/omni/data/backups/config'

/** A row id we are willing to write into the YAML patch (safe, unique-looking). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Ownership marker of the one-line JSON overlay rows this plugin manages. */
const MANAGED_MARKER = '# plugin-live:managed'

/** Header written once above the managed rows of the overlay file. */
const MANAGED_HEADER = [
  '# --- plugin-live MANAGED ROWS -------------------------------------------',
  '# Rows below are written, re-read and removed LIVE by the dsh plugin',
  '# `plugin-live` (`plugin config add|remove|sync`). Each row is ONE line of',
  '# JSON preceded by the marker comment: JSON is valid YAML entry-list dialect,',
  '# and the one-line form is what lets plugin-live re-read and remove the row',
  '# without a container restart. Do not hand-edit the marker lines.',
  '# ------------------------------------------------------------------------',
].join('\n')

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
  /** Parsed CLI `--patch` overlays: the LIVE, mutable config layer. */
  overlays?: unknown
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
  /** Absolute path of the managed CLI `--patch` overlay (default: the first `--patch` in argv). */
  configFile?: string
  /** Where the overlay file is backed up before every placement. */
  backupDir?: string
  /** Default wait budget of add/remove (default 15000 ms, capped at 60000). */
  waitMs?: number
}

// ── the live patch layer (JSON document: YAML 1.2 accepts JSON verbatim) ────

/** One managed patch group: one `insert` list carrying exactly one row. */
interface PatchGroup {
  insert: Array<{ id: string; name: string; config?: unknown }>
}

/** A row as a patch layer declares it. */
interface LiveRow {
  id: string
  name: string
  config?: unknown
}

/** An overlay patch entry as the launcher parsed it (`PatchOptions`). */
interface OverlayPatch {
  id?: unknown
  insert?: unknown
  name?: unknown
  disabled?: unknown
  [key: string]: unknown
}

/** One row the overlay declares. */
interface OverlayRow {
  id: string
  name: string
  config?: unknown
}

/** One row the overlay FILE text declares, with its provenance. */
interface FileRow extends OverlayRow {
  kind: 'managed' | 'block'
  line: number
  hasConfigBlock: boolean
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

/** Read a file, treating "missing" as empty text. */
function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return ''
    throw error
  }
}

/** Strip whole-line comments so the JSON document this plugin writes stays parseable. */
function withoutComments(text: string): string {
  return text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
}

/** Read the live layer: `[]` when the file does not exist yet. */
function readGroups(file: string): PatchGroup[] {
  const text = withoutComments(readText(file))
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

/** The rows a patch group list declares, in file order. */
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

/** A generation counter: guarantees the watched file text changes on every apply. */
let generation = 0

/** Atomic write: the watcher sees exactly one create/replace event, and the text always changes. */
function writeGroups(file: string, groups: PatchGroup[]): void {
  generation += 1
  const header = `# plugin-live generation=${new Date().toISOString()}-${String(generation)}`
  const body = `${header}\n${JSON.stringify(groups, null, 2)}\n`
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.plugin-live.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

/** Re-write the live layer with a fresh generation header: the reload trigger. */
function touchLiveLayer(ctx: PluginContext, config: Config): void {
  const file = livePatchFile(ctx, config)
  writeGroups(file, readGroups(file))
}

/** Declare (or re-declare) one row in the live layer. Returns true when the file changed. */
function upsertRow(file: string, row: LiveRow): boolean {
  const groups = readGroups(file)
  const current = rowsOf(groups).find((candidate) => candidate.id === row.id)
  if (current !== undefined && current.name === row.name && JSON.stringify(current.config) === JSON.stringify(row.config)) {
    writeGroups(file, groups)
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
  if (next.length === groups.length) {
    writeGroups(file, groups)
    return false
  }
  writeGroups(file, next)
  return true
}

// ── the LIVE CONFIG LAYER (the CLI `--patch` overlay) ──────────────────────

/** The `--patch` overlay files named on the command line, in argv order. */
function overlayFilesFromArgv(): string[] {
  const argv = process.argv
  const files: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--patch' && argv[index + 1] !== undefined) files.push(resolve(argv[index + 1]))
    else if (arg.startsWith('--patch=')) files.push(resolve(arg.slice('--patch='.length)))
  }
  return files
}

/** The managed overlay file, or undefined when this boot has none. */
function overlayFileOf(ctx: PluginContext, config: Config): string | undefined {
  const explicit = config.configFile
  if (explicit !== undefined && explicit.trim().length > 0) return resolve(explicit.trim())
  return overlayFilesFromArgv()[0]
}

/** The LIVE overlay patch list held by the running profile context (mutated in place). */
function overlayPatches(ctx: PluginContext): OverlayPatch[] | undefined {
  const profile = ctx.get?.('profileContext') as ProfileContextLike | undefined
  const overlays = profile?.overlays
  return Array.isArray(overlays) ? overlays as OverlayPatch[] : undefined
}

/** The rows the LIVE overlay list declares. */
function overlayRowsOf(ctx: PluginContext): OverlayRow[] {
  const rows: OverlayRow[] = []
  for (const patch of overlayPatches(ctx) ?? []) {
    if (patch === null || typeof patch !== 'object' || !Array.isArray(patch.insert)) continue
    for (const entry of patch.insert) {
      if (entry === null || typeof entry !== 'object') continue
      const { id, name, config } = entry as { id?: unknown; name?: unknown; config?: unknown }
      if (typeof id !== 'string' || typeof name !== 'string') continue
      rows.push(config === undefined ? { id, name } : { id, name, config })
    }
  }
  return rows
}

/** Whether the LIVE overlay list declares one id. */
function overlayDeclares(ctx: PluginContext, id: string): boolean {
  return overlayRowsOf(ctx).some((row) => row.id === id)
}

/** Insert one row into the LIVE overlay list (in place: the next composition sees it). */
function addOverlayRow(ctx: PluginContext, row: OverlayRow): void {
  const patches = overlayPatches(ctx)
  if (patches === undefined) {
    throw new Error(
      'plugin-live: the running profile context holds no --patch overlay list; '
      + 'this boot has no CLI overlay to apply a config row to',
    )
  }
  patches.push({
    insert: [row.config === undefined ? { id: row.id, name: row.name } : { id: row.id, name: row.name, config: row.config }],
  })
}

/** Remove every declaration of one id from the LIVE overlay list. Returns true when it changed. */
function dropOverlayRow(ctx: PluginContext, id: string): boolean {
  const patches = overlayPatches(ctx)
  if (patches === undefined) return false
  let changed = false
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    const patch = patches[index]
    if (patch === null || typeof patch !== 'object') continue
    if (Array.isArray(patch.insert)) {
      const kept = patch.insert.filter((entry) => !(entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === id))
      if (kept.length !== patch.insert.length) {
        changed = true
        if (kept.length === 0 && patch.id === undefined) patches.splice(index, 1)
        else patch.insert = kept
      }
      continue
    }
    if (patch.id === id) {
      patches.splice(index, 1)
      changed = true
    }
  }
  return changed
}

/** The directory this plugin's module lives in (its own control-plane row). */
const OWN_DIR = dirname(fileURLToPath(import.meta.url))

/** Whether a module specifier points at this plugin's own module directory. */
function isOwnModule(module: string): boolean {
  return module.startsWith(OWN_DIR)
}

/** Normalize a module specifier: the Loader reports absolute paths as file URLs. */
function normModule(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return text.startsWith('file://') ? decodeURIComponent(text.slice('file://'.length)) : text
}

/** Whether two module specifiers name the same module file. */
function sameModule(left: unknown, right: string): boolean {
  return normModule(left) === normModule(right)
}

/** The indentation of one text line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Unquote a YAML scalar (single or double quoted, else the plain value). */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** One row as a single-line JSON patch entry (the managed form). */
function managedEntryLine(row: OverlayRow): string {
  const entry = row.config === undefined ? { id: row.id, name: row.name } : { id: row.id, name: row.name, config: row.config }
  return JSON.stringify({ insert: [entry] })
}

/** The rows of one parsed patch object. */
function patchRows(patch: unknown): OverlayRow[] {
  if (patch === null || typeof patch !== 'object') return []
  const insert = (patch as { insert?: unknown }).insert
  if (!Array.isArray(insert)) return []
  const rows: OverlayRow[] = []
  for (const entry of insert) {
    if (entry === null || typeof entry !== 'object') continue
    const { id, name, config } = entry as { id?: unknown; name?: unknown; config?: unknown }
    if (typeof id !== 'string' || typeof name !== 'string') continue
    rows.push(config === undefined ? { id, name } : { id, name, config })
  }
  return rows
}

/** The managed rows in the overlay text, with their line numbers. */
function managedRows(text: string): Array<{ row: OverlayRow; markerLine: number; entryLine: number }> {
  const lines = text.split('\n')
  const rows: Array<{ row: OverlayRow; markerLine: number; entryLine: number }> = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== MANAGED_MARKER) continue
    let cursor = index + 1
    while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1
    if (cursor >= lines.length) {
      throw new Error(`plugin-live: the managed marker on line ${String(index + 1)} has no JSON entry after it`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[cursor].trim())
    } catch (error) {
      throw new Error(
        `plugin-live: the managed entry on line ${String(cursor + 1)} is not the one-line JSON patch entry `
        + `this plugin writes (${String(error)})`,
      )
    }
    const found = patchRows(parsed)
    if (found.length !== 1) {
      throw new Error(`plugin-live: the managed entry on line ${String(cursor + 1)} must declare exactly one row`)
    }
    rows.push({ row: found[0], markerLine: index, entryLine: cursor })
    index = cursor
  }
  return rows
}

/** Append one managed row (marker + one-line JSON) to the overlay text. */
function appendManagedRow(text: string, row: OverlayRow): string {
  const head = text.trimEnd()
  const header = text.includes(MANAGED_MARKER) ? '' : `${MANAGED_HEADER}\n`
  return `${head}\n\n${header}${MANAGED_MARKER}\n${managedEntryLine(row)}\n`
}

/** Delete one managed row (its marker line and its JSON entry) from the overlay text. */
function removeManagedRow(text: string, id: string): { text: string; removed: boolean } {
  const entry = managedRows(text).find((candidate) => candidate.row.id === id)
  if (entry === undefined) return { text, removed: false }
  const lines = text.split('\n')
  lines.splice(entry.markerLine, entry.entryLine - entry.markerLine + 1)
  return { text: lines.join('\n'), removed: true }
}

/** Delete one operator BLOCK row (`- id: <id>` plus every more-indented line after it). */
function removeBlockRow(text: string, id: string): { text: string; removed: boolean } {
  const lines = text.split('\n')
  const pattern = new RegExp(`^(\\s*)-\\s*id:\\s*['"]?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim().length === 0 || indentOf(line) > indent) {
        end += 1
        continue
      }
      break
    }
    while (end > index + 1 && lines[end - 1].trim().length === 0) end -= 1
    lines.splice(index, end - index)
    return { text: lines.join('\n'), removed: true }
  }
  return { text, removed: false }
}

/** The rows the overlay FILE text declares: managed entries plus operator block rows. */
function scanFileRows(text: string): FileRow[] {
  const rows: FileRow[] = managedRows(text).map((entry) => ({
    ...entry.row,
    kind: 'managed' as const,
    line: entry.entryLine + 1,
    hasConfigBlock: false,
  }))
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s*id:\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]*)['"]?\s*$/.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const id = match[2]
    let rowName: string | undefined
    let rowConfig: unknown
    let hasConfigBlock = false
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim().length === 0) continue
      if (indentOf(line) <= indent) break
      const nameMatch = /^\s*name:\s*(.+)$/.exec(line)
      if (nameMatch !== null && rowName === undefined) rowName = unquote(nameMatch[1])
      const configMatch = /^\s*config:\s*(.*)$/.exec(line)
      if (configMatch !== null) {
        const rest = configMatch[1].trim()
        if (rest.length === 0) hasConfigBlock = true
        else {
          try {
            rowConfig = JSON.parse(rest)
          } catch {
            hasConfigBlock = true
            rowConfig = undefined
          }
        }
      }
    }
    if (rowName !== undefined) {
      rows.push({
        id,
        name: rowName,
        kind: 'block',
        line: index + 1,
        hasConfigBlock,
        ...(rowConfig === undefined ? {} : { config: rowConfig }),
      })
    }
  }
  return rows
}

/** Validate the overlay text this plugin is about to place: managed rows must parse and the id must be unique. */
function validateOverlayText(text: string, id?: string): void {
  const rows = scanFileRows(text)
  for (const row of rows) {
    if (!ID_PATTERN.test(row.id)) throw new Error(`plugin-live: the overlay declares an unusable row id ${JSON.stringify(row.id)}`)
    if (row.name.trim().length === 0) throw new Error(`plugin-live: the overlay row ${row.id} has an empty module name`)
  }
  if (id === undefined) return
  const matches = rows.filter((row) => row.id === id).length
  if (matches !== 1) {
    throw new Error(`plugin-live: the overlay text would declare '${id}' ${String(matches)} times; refusing to place it`)
  }
}

/** Back the live overlay file up before a placement. Returns the backup path when it worked. */
function backupOverlay(file: string, dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${basename(file)}.${stamp}.bak`)
    copyFileSync(file, target)
    return target
  } catch {
    return undefined
  }
}

/** Place the overlay text atomically (temp file in the same directory, then rename). */
function placeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.plugin-live.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** Remove one row from the overlay FILE. Returns what changed and where the backup is. */
function removeRowFromOverlayFile(
  file: string, id: string, backupDir: string,
): { changed: boolean; backupFile?: string; form?: 'managed' | 'block' } {
  const text = readText(file)
  if (text.trim().length === 0) return { changed: false }
  const managed = removeManagedRow(text, id)
  const next = managed.removed ? managed : removeBlockRow(text, id)
  if (!next.removed) return { changed: false }
  const backupFile = backupOverlay(file, backupDir)
  placeText(file, next.text)
  return { changed: true, ...(backupFile === undefined ? {} : { backupFile }), form: managed.removed ? 'managed' : 'block' }
}

/** The backup directory used for the overlay file. */
function backupDirOf(config: Config): string {
  const configured = config.backupDir
  return configured !== undefined && configured.trim().length > 0 ? configured.trim() : DEFAULT_BACKUP_DIR
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

  audit(
    `event=load tool=plugin-live patch_file=${livePatchFile(ctx, config)} `
    + `config_file=${overlayFileOf(ctx, config) ?? 'none'} node=${process.version}`,
  )

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

  // ── plugin add ───────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin add',
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
        const nextText = appendManagedRow(readText(target), row)
        validateOverlayText(nextText, id)
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

  // ── plugin remove ────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin remove',
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

  // ── plugin config list ───────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin config list',
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

  // ── plugin config sync ───────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'plugin config sync',
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
            skipped.push({ id: row.id, reason: 'the overlay row carries a config block this plugin does not parse; use plugin add --layer config' })
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
