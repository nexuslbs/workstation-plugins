/**
 * live-layer - the SHARED live composition layer of the workstation control
 * plane. Extracted verbatim from `plugin-live/index.ts` so that BOTH the
 * running `plugin_remove` / `plugin_add` tools AND the imperative
 * `dsh_reload` tool drive ONE implementation of the proven dispose+mount seam
 * (the watched HOME patch and the managed CLI --patch overlay), instead of a
 * second, hand-rolled path against the Loader tree.
 *
 * The module is deliberately self-contained: it imports only node: builtins and
 * the tool contract TYPE, and it holds no harness state. Its `Config` and
 * `PluginContext` describe the structural slice every caller supplies. The
 * `generation` counter guarantees the watched file text changes on every write,
 * which is what fires the harness' own re-composition.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ToolDefinition } from '../../definitions/tools.ts'

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
  '# `plugin-live` (`plugin config add|remove|sync`). Each row is ONE YAML',
  '# SEQUENCE ITEM of this top-level patch array: a marker comment followed by',
  '# `- ` and one line of JSON, e.g.',
  '#   - {"insert":[{"id":"my-row","name":"/abs/path/index.ts"}]}',
  '# The leading `- ` is REQUIRED: a BARE JSON mapping after the block sequence',
  '# is not a sequence item, and the harness boot parser (js-yaml) then rejects',
  '# the WHOLE overlay with "end of the stream or a document separator is',
  '# expected" (production incident 2026-09-27 03:26Z, container restart loop).',
  '# The one-line form is what lets plugin-live re-read and remove the row',
  '# without a container restart, and every placement is validated with that',
  '# same boot parser before it is installed. Do not hand-edit the marker lines.',
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

/**
 * One row as a YAML SEQUENCE ITEM of the top-level patch array (the managed form:
 * `- ` plus one line of JSON). The leading `- ` is required - a bare mapping after
 * the block sequence is not a sequence item and the boot parser rejects the file.
 */
export function managedEntryLine(row: OverlayRow): string {
  const entry = row.config === undefined ? { id: row.id, name: row.name } : { id: row.id, name: row.name, config: row.config }
  return `- ${JSON.stringify({ insert: [entry] })}`
}

/** The JSON text of a managed entry line: BOTH the legacy bare form and the `- ` form parse. */
function managedEntryJson(line: string): string {
  const raw = line.trim()
  return raw.startsWith('- ') ? raw.slice(2).trim() : raw
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
      parsed = JSON.parse(managedEntryJson(lines[cursor]))
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

/**
 * Re-write every managed row in the canonical sequence-item form. Called on EVERY
 * config placement: a legacy file written by the pre-2026-09-27 plugin (bare JSON
 * mappings) is repaired by the same write instead of being left unparseable.
 */
export function normalizeManagedRows(text: string): string {
  const lines = text.split('\n')
  for (const entry of managedRows(text)) {
    // Throws on a managed entry that is not one-line JSON, BEFORE anything is rewritten.
    JSON.parse(managedEntryJson(lines[entry.entryLine]))
    lines[entry.entryLine] = managedEntryLine(entry.row)
  }
  return lines.join('\n')
}

/** The YAML parser the harness runs at boot over this overlay (`yaml.load`). */
let bootParser: { load(text: string): unknown } | undefined
let bootParserError: string | undefined

/** Resolve js-yaml through the HARNESS dependency tree (the plugin imports nothing from the harness). */
function bootYaml(): { load(text: string): unknown } | undefined {
  if (bootParser !== undefined || bootParserError !== undefined) return bootParser
  const anchors = [
    process.argv[1],
    join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
    '/harness/apps/cli/lib/bin.js',
  ]
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || anchor.length === 0) continue
    try {
      const load = createRequire(anchor)('js-yaml') as { load?: (text: string) => unknown }
      if (typeof load?.load === 'function') {
        bootParser = { load: (text: string) => load.load?.(text) }
        return bootParser
      }
    } catch {
      /* try the next anchor */
    }
  }
  bootParserError = 'js-yaml is not resolvable from the harness, the plugin or /harness'
  return undefined
}

/**
 * Validate overlay text with the SAME parser the harness runs at boot: js-yaml
 * `load` plus the "must be a top-level YAML array" rule (packages/boot/app-boot
 * parsePatchList). A placement that would break the NEXT boot is refused BEFORE the
 * live production file is touched.
 */
export function validateBootParse(text: string): void {
  const parser = bootYaml()
  if (parser === undefined) {
    throw new Error(
      `plugin-live: cannot load the boot YAML parser (${String(bootParserError)}); `
      + 'refusing to place an overlay that was not validated against the boot parser',
    )
  }
  let parsed: unknown
  try {
    parsed = parser.load(text)
  } catch (error) {
    throw new Error(`plugin-live: the overlay text would not parse at boot (${String(error)}); refusing to place it`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('plugin-live: the overlay text is not a top-level YAML array; refusing to place it')
  }
}

/** The first line of the managed-rows header block (its presence means "already documented"). */
const HEADER_START = '# --- plugin-live MANAGED ROWS'

/** Drop every managed-rows header block (called when the last managed row goes away). */
function stripManagedHeader(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith(HEADER_START)) {
      kept.push(lines[index])
      continue
    }
    while (index + 1 < lines.length && !/^# -{20,}$/.test(lines[index + 1])) index += 1
    index += 1 // skip the closing rule
    if (kept.length > 0 && kept[kept.length - 1].trim().length === 0) kept.pop()
    while (index + 1 < lines.length && lines[index + 1].trim().length === 0) index += 1
  }
  return kept.join('\n')
}

/** Append one managed row (marker + one-line JSON) to the overlay text. */
function appendManagedRow(text: string, row: OverlayRow): string {
  const head = text.trimEnd()
  const header = text.includes(HEADER_START) ? '' : `${MANAGED_HEADER}\n`
  return `${head}\n\n${header}${MANAGED_MARKER}\n${managedEntryLine(row)}\n`
}

/** Delete one managed row (its marker line and its JSON entry) from the overlay text. */
function removeManagedRow(text: string, id: string): { text: string; removed: boolean } {
  const entry = managedRows(text).find((candidate) => candidate.row.id === id)
  if (entry === undefined) return { text, removed: false }
  const lines = text.split('\n')
  lines.splice(entry.markerLine, entry.entryLine - entry.markerLine + 1)
  const next = lines.join('\n')
  // The header block documents the managed section: when its last row goes away it
  // goes away too, so the next placement writes it exactly once.
  return { text: next.includes(MANAGED_MARKER) ? next : stripManagedHeader(next), removed: true }
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
  const validated = normalizeManagedRows(next.text)
  validateBootParse(validated)
  const backupFile = backupOverlay(file, backupDir)
  placeText(file, validated)
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

// ── the surface every caller imports ───────────────────────────────────────

export {
  LIVE_PATCH_FILENAME,
  AUDIT_FILENAME,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  DEFAULT_BACKUP_DIR,
  ID_PATTERN,
  MANAGED_MARKER,
  MANAGED_HEADER,
  HEADER_START,
  OWN_DIR,
  homeOf,
  livePatchFile,
  readText,
  withoutComments,
  readGroups,
  rowsOf,
  writeGroups,
  touchLiveLayer,
  upsertRow,
  dropRow,
  overlayFilesFromArgv,
  overlayFileOf,
  overlayPatches,
  overlayRowsOf,
  overlayDeclares,
  addOverlayRow,
  dropOverlayRow,
  isOwnModule,
  normModule,
  sameModule,
  indentOf,
  unquote,
  managedEntryJson,
  patchRows,
  managedRows,
  bootYaml,
  stripManagedHeader,
  appendManagedRow,
  removeManagedRow,
  removeBlockRow,
  scanFileRows,
  validateOverlayText,
  backupOverlay,
  placeText,
  removeRowFromOverlayFile,
  backupDirOf,
  sleep,
  rowId,
  liveEntry,
  mounted,
  toolNames,
  waitUntil,
  requiredParam,
  waitBudget,
  delta,
}
export type {
  LoaderRow,
  LoaderLike,
  ProfileContextLike,
  ToolsLike,
  PluginContext,
  PatchGroup,
  LiveRow,
  OverlayPatch,
  OverlayRow,
  FileRow,
}

// ── the proven reload seam (shared by dsh-reload) ───────────────────────────
//
// dsh-reload must NOT hand-roll the row re-add against the Loader tree: the
// dispose+mount path that WORKS in production is the one these functions drive,
// i.e. the exact path the running `plugin_remove` / `plugin_add` tools use.
// `removeRowSeam` drops the row from whichever live layers declare it (the
// watched HOME patch and the managed CLI --patch overlay) and waits until the
// harness Loader has disposed the entry. `addRowSeam` re-declares the row on
// the SAME layers with the SAME config and waits until the Loader has mounted
// it again. Both write through the SAME primitive helpers the tools use, so
// there is one composition mechanism, not two.

/** Where a row is declared across the two live layers this control plane owns. */
export interface RowDeclaration {
  /** Declared in the watched HOME patch (the live plugin layer). */
  live: boolean
  /** Declared in the managed CLI --patch overlay (the persistent roster). */
  config: boolean
  /** The module specifier as declared, when one was found. */
  module?: string
  /** The row config as declared, for an exact restore. */
  liveConfig?: unknown
  configConfig?: unknown
  /** The managed overlay file, when this boot has one. */
  configFile: string | null
}

/** Read where one id is declared, plus the exact config it carries. */
export function rowDeclaration(ctx: PluginContext, config: Config, id: string): RowDeclaration {
  const file = livePatchFile(ctx, config)
  const live = rowsOf(readGroups(file)).find((row) => row.id === id)
  const overlay = overlayRowsOf(ctx).find((row) => row.id === id)
  const module = live?.name ?? overlay?.name
  return {
    live: live !== undefined,
    config: overlay !== undefined,
    ...(module === undefined ? {} : { module }),
    ...(live?.config === undefined ? {} : { liveConfig: live.config }),
    ...(overlay?.config === undefined ? {} : { configConfig: overlay.config }),
    configFile: overlayFileOf(ctx, config) ?? null,
  }
}

/** The evidence of one seam remove. */
export interface SeamRemoveResult {
  liveDeclared: boolean
  configDeclared: boolean
  declaredRowRemoved: boolean
  configFileChanged: boolean
  configForm: string | null
  backupFile: string | null
  disposed: boolean
  waitedMs: number
}

/** Remove one row through BOTH live layers, exactly as the plugin_remove tool does. */
export async function removeRowSeam(
  ctx: PluginContext,
  config: Config,
  id: string,
  budget: number,
): Promise<SeamRemoveResult> {
  const file = livePatchFile(ctx, config)
  const liveDeclared = rowsOf(readGroups(file)).some((row) => row.id === id)
  const configDeclared = overlayDeclares(ctx, id)
  const target = overlayFileOf(ctx, config)
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

  const waitedMs = await waitUntil(ctx.loader, () => liveEntry(ctx.loader, id) === undefined, budget)
  try {
    await ctx.loader.await?.()
  } catch {
    /* reporting is best effort */
  }
  await sleep(300)
  return {
    liveDeclared,
    configDeclared,
    declaredRowRemoved,
    configFileChanged,
    configForm,
    backupFile,
    disposed: liveEntry(ctx.loader, id) === undefined,
    waitedMs,
  }
}

/** The evidence of one seam add. */
export interface SeamAddResult {
  liveDeclared: boolean
  configDeclared: boolean
  declared: boolean
  overlayFile: string | null
  backupFile: string | null
  mounted: boolean
  fiberState: string | null
  waitedMs: number
}

/** Re-declare one row on the layer(s) it came from, exactly as the plugin_add tool does. */
export async function addRowSeam(
  ctx: PluginContext,
  config: Config,
  id: string,
  module: string,
  layer: RowDeclaration,
  budget: number,
): Promise<SeamAddResult> {
  const file = livePatchFile(ctx, config)
  const beforeTools = toolNames(ctx.tools)
  const toolsGrew = (): boolean => toolNames(ctx.tools).some((entry) => !beforeTools.includes(entry))
  let overlayFile: string | null = null
  let backupFile: string | null = null

  if (layer.config) {
    const target = overlayFileOf(ctx, config)
    if (target === undefined) {
      throw new Error('plugin-live: this boot has no CLI --patch overlay to write (pass --patch <file> or configure configFile)')
    }
    if (overlayDeclares(ctx, id)) throw new Error(`plugin-live: the overlay layer already declares '${id}'`)
    if (rowsOf(readGroups(file)).some((row) => row.id === id)) {
      throw new Error(`plugin-live: the live layer already declares '${id}'; remove it first`)
    }
    const row: LiveRow = layer.configConfig === undefined ? { id, name: module } : { id, name: module, config: layer.configConfig }
    const nextText = normalizeManagedRows(appendManagedRow(readText(target), row))
    validateOverlayText(nextText, id)
    validateBootParse(nextText)
    backupFile = backupOverlay(target, backupDirOf(config)) ?? null
    placeText(target, nextText)
    addOverlayRow(ctx, row)
    overlayFile = target
  }
  if (layer.live) {
    const row: LiveRow = layer.liveConfig === undefined ? { id, name: module } : { id, name: module, config: layer.liveConfig }
    upsertRow(file, row)
  }
  if (layer.config && !layer.live) touchLiveLayer(ctx, config)

  const waitedMs = await waitUntil(ctx.loader, () => mounted(liveEntry(ctx.loader, id)) || toolsGrew(), budget)
  try {
    await ctx.loader.await?.()
  } catch {
    /* reporting is best effort */
  }
  await sleep(300)
  const entry = liveEntry(ctx.loader, id)
  return {
    liveDeclared: layer.live,
    configDeclared: layer.config,
    declared: layer.live || layer.config,
    overlayFile,
    backupFile,
    mounted: mounted(entry),
    fiberState: entry === undefined ? null : String(entry.fiber?.state ?? 'none'),
    waitedMs,
  }
}

/** Poll until the registered tool-name SET equals `target`, draining the Loader. */
export async function waitForToolSet(ctx: PluginContext, target: readonly string[], timeoutMs: number): Promise<number> {
  const targetSet = new Set(target)
  const equal = (): boolean => {
    const current = toolNames(ctx.tools)
    return current.length === targetSet.size && current.every((entry) => targetSet.has(entry))
  }
  return waitUntil(ctx.loader, equal, timeoutMs)
}
