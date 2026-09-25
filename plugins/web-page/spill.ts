// The hard char cap + spill path.
//
// Same pattern as omniagent's `web__extract`: a page (or an outline) is never
// allowed to flood a caller's context. When the text exceeds the cap, the FULL
// text goes to a file under the spill dir and the caller receives the capped
// head plus the absolute path of the full text, so nothing is lost and the
// response stays bounded.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PageError } from './errors.ts'

export interface CappedText {
  /** The text the caller receives (capped, with a pointer when spilled). */
  text: string
  /** Whether the cap bit. */
  capped: boolean
  /** Chars of `text` actually returned. */
  shownChars: number
  /** Chars of the full text before the cap. */
  totalChars: number
  /** Absolute path of the full text when it was spilled. */
  spillFile: string | undefined
  /** Estimated tokens of the returned text (chars / 4, deliberately crude). */
  estimatedTokens: number
}

/** How the spill file is named: stable per content, so a repeat call reuses it. */
export function spillName(label: string, text: string): string {
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${slug.length === 0 ? 'page' : slug}-${digest}.md`
}

/** Estimate tokens the way the operator reads them (chars / 4). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/**
 * Apply the hard cap. Under the cap the text is returned verbatim; over it the
 * full text is written to `spillDir` (atomically) and the returned text ends
 * with a one-line pointer to that file.
 */
export async function capText(text: string, maxChars: number, spillDir: string, label: string): Promise<CappedText> {
  const totalChars = text.length
  if (totalChars <= maxChars) {
    return { text, capped: false, shownChars: totalChars, totalChars, spillFile: undefined, estimatedTokens: estimateTokens(totalChars) }
  }
  const spillFile = path.join(spillDir, spillName(label, text))
  await writeFileAtomic(spillFile, text)
  const head = text.slice(0, maxChars)
  const note = `\n\n[... web-page: capped at ${String(maxChars)} of ${String(totalChars)} chars; full text: ${spillFile}]`
  const capped = `${head}${note}`
  return { text: capped, capped: true, shownChars: capped.length, totalChars, spillFile, estimatedTokens: estimateTokens(capped.length) }
}

/** Write a file so a reader never sees a partial one (tmp + rename). */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${String(process.pid)}.tmp`
    await fs.promises.writeFile(tmp, content, 'utf8')
    await fs.promises.rename(tmp, file)
  } catch (error) {
    throw new PageError('internal', `could not write the spill file ${file}`, { detail: error instanceof Error ? error.message : String(error) })
  }
}

/** Read a spilled file back (used by tests and by a caller that wants the tail). */
export async function readSpill(spillFile: string): Promise<string> {
  try {
    return await fs.promises.readFile(spillFile, 'utf8')
  } catch (error) {
    throw new PageError('internal', `could not read the spill file ${spillFile}`, { detail: error instanceof Error ? error.message : String(error) })
  }
}
