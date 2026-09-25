// The DELTA reporter: after an `act` (or a `navigate`) the caller receives WHAT
// CHANGED, never the page again.
//
// The unit of change is a TEXT NODE of the live DOM, identified by a STABLE ref
// (`#id`, `[data-testid=...]`, `[name=...]`, else a short structural path), so a
// node that merely moves is not reported while a node whose text changed is.
// The diff is PURE (two snapshots in, a bounded delta out), so the tests pin it
// without a browser, and it is char-budgeted twice: at most `maxNodes` entries
// per list, and the whole payload is trimmed until it fits `maxChars` (the
// entries are re-counted in `counts.truncated`, nothing is silently lost).
import { estimateTokens } from '../web-page/spill.ts'

export interface TextNodeRef {
  ref: string
  tag: string
  text: string
}

export interface Snapshot {
  url: string
  title: string
  nodes: TextNodeRef[]
}

export interface NodePreview {
  ref: string
  tag: string
  text: string
}

export interface NodeChange {
  ref: string
  tag: string
  from: string
  to: string
}

export interface DeltaBudget {
  /** Entries per list (added/removed/changed). */
  maxNodes: number
  /** Char budget of the WHOLE delta payload. */
  maxChars: number
}

/** How much of a node's text a delta quotes (the rest stays out of context). */
const PREVIEW_CHARS = 200

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}...`
}

function index(nodes: TextNodeRef[]): Map<string, TextNodeRef> {
  const map = new Map<string, TextNodeRef>()
  for (const node of nodes) {
    const existing = map.get(node.ref)
    // A ref must identify ONE node's text: when a page repeats a ref (a
    // non-unique data-testid), the longer text wins deterministically.
    if (existing === undefined || node.text.length > existing.text.length) map.set(node.ref, node)
  }
  return map
}

/** Sort a node list deterministically (by ref) and drop empty text. */
export function snapshotNodes(nodes: TextNodeRef[]): TextNodeRef[] {
  return nodes.filter((node) => node.text.trim().length > 0).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
}

/**
 * Diff two snapshots. `before === undefined` is the BASELINE case: nothing was
 * known, so the delta reports the counts and the URL/title only (a first `open`
 * must not dump the page). The returned object is budget-trimmed.
 */
export function diffSnapshots(before: Snapshot | undefined, after: Snapshot, budget: DeltaBudget): Record<string, unknown> {
  const beforeNodes = index(before?.nodes ?? [])
  const afterNodes = index(after.nodes)
  const added: NodePreview[] = []
  const removed: NodePreview[] = []
  const changed: NodeChange[] = []
  for (const [ref, node] of afterNodes) {
    const previous = beforeNodes.get(ref)
    if (previous === undefined) {
      added.push({ ref, tag: node.tag, text: clip(node.text) })
      continue
    }
    if (previous.text !== node.text) changed.push({ ref, tag: node.tag, from: clip(previous.text), to: clip(node.text) })
  }
  for (const [ref, node] of beforeNodes) {
    if (!afterNodes.has(ref)) removed.push({ ref, tag: node.tag, text: clip(node.text) })
  }
  const baseline = before === undefined
  const counts = {
    before: beforeNodes.size,
    after: afterNodes.size,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    reported: 0,
    truncated: false,
  }
  const delta: Record<string, unknown> = {
    baseline,
    url: { before: before?.url ?? null, after: after.url, changed: before === undefined ? true : before.url !== after.url },
    title: { before: before?.title ?? null, after: after.title, changed: before === undefined ? true : before.title !== after.title },
    added: baseline ? [] : added.slice(0, budget.maxNodes),
    removed: baseline ? [] : removed.slice(0, budget.maxNodes),
    changed: baseline ? [] : changed.slice(0, budget.maxNodes),
    counts,
  }
  counts.truncated = added.length > budget.maxNodes || removed.length > budget.maxNodes || changed.length > budget.maxNodes
  return trimToBudget(delta, budget.maxChars)
}

/** Char/token size of a payload, as the operator reads them (chars / 4). */
export function measure(payload: unknown): { chars: number; estimatedTokens: number } {
  const chars = JSON.stringify(payload ?? null)?.length ?? 0
  return { chars, estimatedTokens: estimateTokens(chars) }
}

/**
 * Drop the TAIL of the largest list until the payload fits `maxChars`; the
 * dropped entries stay visible in `counts` (added/removed/changed) and set
 * `counts.truncated`, so a caller sees that the delta was cut.
 */
function trimToBudget(delta: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const counts = delta.counts as { truncated: boolean; reported: number }
  const lists: unknown[][] = [delta.changed as unknown[], delta.added as unknown[], delta.removed as unknown[]]
  let size = JSON.stringify(delta)?.length ?? 0
  while (size > maxChars) {
    const largest = lists.reduce((a, b) => (b.length > a.length ? b : a), lists[0])
    if (largest.length === 0) break
    largest.pop()
    counts.truncated = true
    size = JSON.stringify(delta)?.length ?? 0
  }
  counts.reported = (delta.added as unknown[]).length + (delta.removed as unknown[]).length + (delta.changed as unknown[]).length
  return delta
}

/** `true` when two snapshots describe the same DOM text (used to skip work). */
export function snapshotsEqual(a: Snapshot | undefined, b: Snapshot): boolean {
  if (a === undefined) return false
  if (a.url !== b.url || a.title !== b.title || a.nodes.length !== b.nodes.length) return false
  for (let i = 0; i < a.nodes.length; i++) {
    const left = a.nodes[i]
    const right = b.nodes[i]
    if (left.ref !== right.ref || left.text !== right.text) return false
  }
  return true
}
