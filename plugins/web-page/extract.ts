// Deterministic, dependency-free main-content extraction: HTML in, compact
// markdown + an outline out.
//
// Why no `readability` / `turndown` dependency: this plugin already needs one
// runtime dependency (playwright-core) that a plugin source cannot install by
// itself, and the extraction rules here are the *product* of the plugin (they
// decide what a caller sees and therefore how many tokens a page costs). Keeping
// them in-repo makes the output deterministic and reviewable: no transitive
// diff, no parser version drift, and the unit tests pin the exact markdown for
// the fixture HTML. The rules follow the readability idea (score the paragraph
// containers, pick the densest, drop the boilerplate) at a fraction of the size.
import { PageError } from './errors.ts'

export interface Heading {
  level: number
  text: string
}

export interface LinkRef {
  text: string
  href: string
}

export interface Section {
  heading: string
  level: number
  chars: number
}

export interface Outline {
  title: string
  headings: Heading[]
  links: LinkRef[]
  sections: Section[]
  chars: number
}

export interface Extraction {
  title: string
  markdown: string
  outline: Outline
  chars: number
}

interface TextNode {
  kind: 'text'
  text: string
}

interface Element {
  kind: 'element'
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
  parent: Element | undefined
}

type HtmlNode = TextNode | Element

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose CONTENT is never page text (scripts, chrome, media, controls). */
const DROP_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'object', 'embed', 'video', 'audio',
  'source', 'track', 'select', 'option', 'optgroup', 'input', 'textarea', 'label', 'button', 'form', 'dialog',
  'link', 'meta', 'base', 'map', 'area', 'picture', 'frame', 'frameset', 'applet',
])

/** Layout chrome: dropped unless it lives inside a content container. */
const STRUCTURE_ELEMENTS = new Set(['nav', 'footer', 'header', 'aside'])

/** Tags that only make sense inside a text run. */
const INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
])

const CONTENT_CONTAINERS = new Set(['article', 'main', 'section', 'div', 'body', '#root', '#scope', 'td', 'dd'])

/** class/id vocabulary that names site chrome rather than content. */
const NEGATIVE_SIGNAL = new RegExp(
  [
    '(^|[\\s_-])(nav|navbar|navigation|menu|sidebar|side-bar|breadcrumb|footer|masthead|cookie|consent|gdpr',
    'banner|advert|ads?|sponsor|promo|newsletter|subscribe|social|share|related|recommend|comments?|disqus',
    'pagination|pager|toolbar|skip-link|sr-only|visually-hidden|screen-reader|modal|popup|overlay|drawer',
    'offcanvas|back-to-top|toc-toggle)([\\s_-]|$)',
  ].join('|'),
  'i',
)

const NEGATIVE_ROLES = new Set(['navigation', 'banner', 'complementary', 'contentinfo', 'search', 'dialog', 'toolbar'])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '-', ndash: '-', hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)',
  laquo: '<<', raquo: '>>', times: 'x', middot: '.', bull: '*', deg: 'deg',
  euro: 'EUR', pound: 'GBP', sect: 'S', para: 'P', plusmn: '+/-',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', ensp: ' ', emsp: ' ', thinsp: ' ',
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'by', 'at', 'from',
  'as', 'it', 'this', 'that', 'how', 'what', 'why', 'do', 'does', 'not', 'can', 'my', 'your', 'you', 'about',
])

// ---------------------------------------------------------------------------
// HTML parsing (tolerant, deterministic, no dependency)
// ---------------------------------------------------------------------------

/** Parse the HTML into a light element tree. Never throws: bad markup is tolerated. */
export function parseHtml(html: string): Element {
  const root: Element = { kind: 'element', tag: '#root', attrs: {}, children: [], parent: undefined }
  const stack: Element[] = [root]
  const lower = html.toLowerCase()
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      pushText(stack[stack.length - 1], html.slice(i))
      break
    }
    if (lt > i) pushText(stack[stack.length - 1], html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const end = findTagEnd(html, lt)
    if (end < 0) break
    const inner = html.slice(lt + 1, end)
    i = end + 1
    if (inner.startsWith('/')) {
      closeTag(stack, inner.slice(1).trim().toLowerCase())
      continue
    }
    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const match = /^([a-zA-Z][^\s/>]*)([\s\S]*)$/.exec(body)
    if (match === null) continue
    const tag = match[1].toLowerCase()
    const element: Element = { kind: 'element', tag, attrs: parseAttrs(match[2]), children: [], parent: stack[stack.length - 1] }
    stack[stack.length - 1].children.push(element)
    if (VOID_ELEMENTS.has(tag) || selfClosing) continue
    if (DROP_ELEMENTS.has(tag)) {
      // Skip the content of raw-text elements (script/style/template/...).
      const close = lower.indexOf(`</${tag}`, i)
      const stop = close < 0 ? html.length : close
      if (tag === 'title') pushText(element, html.slice(i, stop))
      if (tag === 'textarea') pushText(element, html.slice(i, stop))
      i = stop
      continue
    }
    stack.push(element)
  }
  return root
}

/** The index of the `>` closing the tag that starts at `start`, quotes respected. */
function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

/** Close the innermost matching open tag; an unmatched end tag is ignored. */
function closeTag(stack: Element[], tag: string): void {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i].tag === tag) {
      stack.length = i
      return
    }
  }
}

function pushText(parent: Element, text: string): void {
  if (text.length === 0) return
  const decoded = decodeEntities(text)
  if (/^\s*$/.test(decoded)) {
    const last = parent.children[parent.children.length - 1]
    if (last !== undefined && last.kind === 'text') last.text = `${last.text} `
    return
  }
  parent.children.push({ kind: 'text', text: decoded })
}

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const name = match[1].toLowerCase()
    if (name.length === 0) continue
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/** Decode the entity forms a page actually uses. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function walk(root: Element): Element[] {
  const out: Element[] = []
  const visit = (element: Element): void => {
    for (const child of element.children) {
      if (child.kind !== 'element') continue
      out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

function textOf(element: Element): string {
  let out = ''
  for (const child of element.children) {
    if (child.kind === 'text') out += `${child.text} `
    else out += `${textOf(child)} `
  }
  return out
}

function rawTextOf(element: Element): string {
  let out = ''
  for (const child of element.children) {
    if (child.kind === 'text') out += child.text
    else if (child.tag === 'br') out += '\n'
    else out += rawTextOf(child)
  }
  return out
}

function findFirst(root: Element, tags: string[]): Element | undefined {
  return walk(root).find((element) => tags.includes(element.tag))
}

function findByAttr(root: Element, name: string, value: string): Element | undefined {
  return walk(root).find((element) => (element.attrs[name] ?? '').toLowerCase() === value)
}

/**
 * The page's main content must never be thrown away as chrome: a wrapper that
 * CONTAINS an `article`/`main` with real text is always walked into.
 */
function containsMainContent(element: Element): boolean {
  return walk(element).some(
    (node) =>
      (node.tag === 'main' || node.tag === 'article' || (node.attrs.role ?? '').toLowerCase() === 'main') &&
      textOf(node).trim().length >= 200,
  )
}

/**
 * The chrome vocabulary, tested against the id and each class token. A token
 * carrying a utility VARIANT prefix (`lg:grid-cols-sidebar-content`) describes
 * LAYOUT, not site chrome, so it is skipped (a Tailwind grid column named after
 * the sidebars once killed a whole page).
 */
function hasNegativeSignal(element: Element): boolean {
  if (NEGATIVE_SIGNAL.test(element.attrs.id ?? '')) return true
  for (const token of (element.attrs.class ?? '').split(/\s+/)) {
    if (token.length === 0 || token.includes(':')) continue
    if (NEGATIVE_SIGNAL.test(token)) return true
  }
  return NEGATIVE_ROLES.has((element.attrs.role ?? '').toLowerCase())
}

function hasContentAncestor(element: Element): boolean {
  let current = element.parent
  while (current !== undefined) {
    if (current.tag === 'article' || current.tag === 'main' || current.tag === 'section') return true
    current = current.parent
  }
  return false
}

/** Drop boilerplate subtrees, rescuing top-level headings from dropped chrome. */
function prune(element: Element): void {
  const kept: HtmlNode[] = []
  for (const child of element.children) {
    if (child.kind === 'text') {
      kept.push(child)
      continue
    }
    const drop = !containsMainContent(child)
      && (DROP_ELEMENTS.has(child.tag)
        || (STRUCTURE_ELEMENTS.has(child.tag) && !hasContentAncestor(child))
        || hasNegativeSignal(child))
    if (drop) {
      for (const heading of walk(child).filter((node) => /^h[1-3]$/.test(node.tag)).slice(0, 3)) {
        prune(heading)
        heading.parent = element
        kept.push(heading)
      }
      continue
    }
    prune(child)
    kept.push(child)
  }
  element.children = kept
}

/** The document title: <title>, then og:title, then the first heading. */
function documentTitle(root: Element): string {
  const title = findFirst(root, ['title'])
  const text = title === undefined ? '' : normalizeInline(textOf(title))
  if (text.length > 0) return text
  const og = findByAttr(root, 'property', 'og:title')
  const ogText = og?.attrs.content === undefined ? '' : normalizeInline(decodeEntities(og.attrs.content))
  if (ogText.length > 0) return ogText
  const heading = findFirst(root, ['h1', 'h2'])
  return heading === undefined ? 'untitled' : normalizeInline(textOf(heading))
}

/** readability-lite: prefer the semantic containers, else the densest block. */
function selectContent(root: Element): Element {
  const candidates: Element[] = []
  for (const tag of ['article', 'main']) {
    const found = walk(root).find((element) => element.tag === tag && textOf(element).trim().length >= 200)
    if (found !== undefined) candidates.push(found)
  }
  const roleMain = walk(root).find((element) => element.attrs.role === 'main' && textOf(element).trim().length >= 200)
  if (roleMain !== undefined) candidates.push(roleMain)
  if (candidates.length > 0) {
    return candidates.reduce((best, current) => (textOf(current).length > textOf(best).length ? current : best))
  }
  const scores = new Map<Element, number>()
  for (const element of walk(root)) {
    if (!/^(p|pre|blockquote|li|h[1-6]|td)$/.test(element.tag)) continue
    const text = textOf(element).trim()
    if (text.length < 40) continue
    const parent = element.parent
    if (parent === undefined || parent.tag === '#root') continue
    const bonus = 1 + Math.min(text.length / 400, 2) + (/[.!?:]$/.test(text) ? 1 : 0)
    scores.set(parent, (scores.get(parent) ?? 0) + text.length * bonus)
    const grandparent = parent.parent
    if (grandparent !== undefined && grandparent.tag !== '#root') {
      scores.set(grandparent, (scores.get(grandparent) ?? 0) + (text.length * bonus) / 2)
    }
  }
  let best: Element | undefined
  let bestScore = 0
  for (const [element, score] of scores) {
    if (score > bestScore) {
      best = element
      bestScore = score
    }
  }
  if (best !== undefined && textOf(best).trim().length >= 200) return best
  const containers = walk(root).filter((element) => CONTENT_CONTAINERS.has(element.tag))
  return containers.reduce(
    (densest: Element | undefined, element) =>
      densest === undefined || textOf(element).length > textOf(densest).length ? element : densest,
    undefined,
  ) ?? root
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

interface RenderCtx {
  base: string
  links: LinkRef[]
  maxLinks: number
}

function normalizeInline(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

function isMeaningful(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

function absoluteUrl(href: string | undefined, base: string): string | undefined {
  if (href === undefined) return undefined
  const raw = href.trim()
  if (raw.length === 0) return undefined
  if (/^(javascript|mailto|tel|data):/i.test(raw)) return undefined
  try {
    const url = new URL(raw, base)
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function imageOf(element: Element, ctx: RenderCtx): string | undefined {
  const src = absoluteUrl(element.attrs.src ?? element.attrs['data-src'], ctx.base)
  const alt = normalizeInline(decodeEntities(element.attrs.alt ?? ''))
  if (src === undefined) return alt.length === 0 ? undefined : alt
  return `![${alt}](${src})`
}

function languageOf(pre: Element): string {
  const code = walk(pre).find((element) => element.tag === 'code')
  const cls = `${code?.attrs.class ?? ''} ${pre.attrs.class ?? ''}`
  const match = /(?:language|lang)-([\w+#-]+)/i.exec(cls)
  return match === null ? '' : match[1].toLowerCase()
}

function inlineOfNodes(nodes: HtmlNode[], ctx: RenderCtx): string {
  let out = ''
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += normalizeInline(node.text)
      continue
    }
    const inner = inlineOfNodes(node.children, ctx)
    switch (node.tag) {
      case 'a': {
        const href = absoluteUrl(node.attrs.href, ctx.base)
        const text = normalizeInline(inner)
        if (href === undefined || text.length === 0) {
          out += text
          break
        }
        if (ctx.links.length < ctx.maxLinks && !ctx.links.some((link) => link.href === href)) {
          ctx.links.push({ text: text.slice(0, 120), href })
        }
        out += `[${text}](${href})`
        break
      }
      case 'strong':
      case 'b': {
        const text = normalizeInline(inner)
        out += text.length === 0 ? '' : text.includes('**') ? text : `**${text}**`
        break
      }
      case 'em':
      case 'i': {
        const text = normalizeInline(inner)
        out += text.length === 0 ? '' : text.includes('*') ? text : `*${text}*`
        break
      }
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt': {
        const text = normalizeInline(rawTextOf(node)).replace(/`/g, "'")
        out += text.length === 0 ? '' : `\`${text}\``
        break
      }
      case 'br':
        out += '\n'
        break
      case 'img':
        out += imageOf(node, ctx) ?? ''
        break
      case 'wbr':
      case 'script':
      case 'style':
        break
      default:
        out += inner
    }
  }
  return out
}

function isInlineOnly(element: Element): boolean {
  return element.children.every((child) => child.kind === 'text' || INLINE_ELEMENTS.has(child.tag))
}

function blocksOf(element: Element, ctx: RenderCtx): string[] {
  if (isInlineOnly(element)) {
    const text = normalizeInline(inlineOfNodes(element.children, ctx))
    return isMeaningful(text) ? [text] : []
  }
  const out: string[] = []
  for (const child of element.children) {
    if (child.kind === 'text') {
      const text = normalizeInline(child.text)
      if (isMeaningful(text)) out.push(text)
      continue
    }
    out.push(...blocksOfElement(child, ctx, 0))
  }
  return out
}

function blocksOfElement(element: Element, ctx: RenderCtx, depth: number): string[] {
  const tag = element.tag
  if (/^h[1-6]$/.test(tag)) {
    const text = normalizeInline(inlineOfNodes(element.children, ctx))
    return isMeaningful(text) ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : []
  }
  if (tag === 'p') {
    const text = normalizeInline(inlineOfNodes(element.children, ctx))
    return isMeaningful(text) ? [text] : []
  }
  if (tag === 'pre') {
    const code = rawTextOf(element).replace(/\s+$/, '')
    return code.trim().length === 0 ? [] : [`\`\`\`${languageOf(element)}\n${code}\n\`\`\``]
  }
  if (tag === 'blockquote') {
    const inner = blocksOf(element, ctx).join('\n\n').trim()
    if (inner.length === 0) return []
    return [inner.split('\n').map((line) => (line.length === 0 ? '>' : `> ${line}`)).join('\n')]
  }
  if (tag === 'ul' || tag === 'ol') {
    const lines = listOf(element, ctx, depth, tag === 'ol')
    return lines.length === 0 ? [] : [lines.join('\n')]
  }
  if (tag === 'dl') {
    const lines: string[] = []
    for (const child of element.children) {
      if (child.kind !== 'element') continue
      const text = normalizeInline(inlineOfNodes(child.children, ctx))
      if (!isMeaningful(text)) continue
      lines.push(child.tag === 'dt' ? `**${text}**` : `: ${text}`)
    }
    return lines.length === 0 ? [] : [lines.join('\n')]
  }
  if (tag === 'table') {
    const rows = tableOf(element, ctx)
    return rows.length === 0 ? [] : [rows.join('\n')]
  }
  if (tag === 'hr') return ['---']
  if (tag === 'img') {
    const image = imageOf(element, ctx)
    return image === undefined ? [] : [image]
  }
  if (tag === 'br' || tag === 'a' || tag === 'span') {
    const text = normalizeInline(inlineOfNodes(element.children, ctx))
    return isMeaningful(text) ? [text] : []
  }
  return blocksOf(element, ctx)
}

function listOf(element: Element, ctx: RenderCtx, depth: number, ordered: boolean): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  let index = 0
  for (const item of element.children) {
    if (item.kind !== 'element' || item.tag !== 'li') continue
    index += 1
    const parts: HtmlNode[] = []
    const nested: string[] = []
    for (const child of item.children) {
      if (child.kind === 'element' && (child.tag === 'ul' || child.tag === 'ol')) {
        nested.push(...listOf(child, ctx, depth + 1, child.tag === 'ol'))
        continue
      }
      parts.push(child)
    }
    const head = normalizeInline(inlineOfNodes(parts, ctx))
    if (isMeaningful(head)) lines.push(`${indent}${ordered ? `${String(index)}. ` : '- '}${head}`)
    for (const line of nested) lines.push(line)
  }
  return lines
}

function tableOf(element: Element, ctx: RenderCtx): string[] {
  const rows: string[] = []
  for (const row of walk(element).filter((node) => node.tag === 'tr')) {
    const cells = row.children
      .filter((child): child is Element => child.kind === 'element' && (child.tag === 'td' || child.tag === 'th'))
      .map((cell) => normalizeInline(inlineOfNodes(cell.children, ctx)).replace(/\|/g, '\\|'))
    if (cells.length === 0) continue
    rows.push(`| ${cells.join(' | ')} |`)
    if (rows.length === 1) rows.push(`| ${cells.map(() => '---').join(' | ')} |`)
  }
  return rows
}

/** Collapse a markdown body: no trailing spaces, no empty runs, no repeat lines. */
export function normalizeMarkdown(markdown: string): string {
  const lines: string[] = []
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '').replace(/(\S)[ \t]{2,}(\S)/g, '$1 $2')
    // Drop decorative-only lines (a bare bullet, a rule of dots), keep tables.
    if (!line.trimStart().startsWith('|') && line.trim().length <= 2 && !/[\p{L}\p{N}]/u.test(line)) continue
    if (!/^\s{2,}[-*\d]/.test(line)) {
      const trimmed = line.replace(/^\s+/, '')
      lines.push(trimmed)
      continue
    }
    lines.push(line)
  }
  const out: string[] = []
  let blanks = 0
  for (const line of lines) {
    if (line.length === 0) {
      blanks += 1
      if (blanks > 1) continue
    } else {
      blanks = 0
      const previous = out[out.length - 1]
      if (previous !== undefined && previous === line && !line.startsWith('#')) continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// Outline (page map) and query slicing
// ---------------------------------------------------------------------------

/** The outline of a markdown body: headings, links, per-section char counts. */
export function outlineOf(markdown: string, title: string, maxLinks = 200): Outline {
  const headings: Heading[] = []
  const links: LinkRef[] = []
  const linkRe = /\[([^\]]*)\]\((?:<)?([^)\s>]+)/g
  let match: RegExpExecArray | null
  while ((match = linkRe.exec(markdown)) !== null) {
    if (links.length >= maxLinks) break
    if (links.some((link) => link.href === match?.[2])) continue
    links.push({ text: match[1].slice(0, 120), href: match[2] })
  }
  const sections: Section[] = []
  let current: Section | undefined
  let introChars = 0
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      headings.push({ level: heading[1].length, text: heading[2].trim() })
      if (current !== undefined) sections.push(current)
      current = { heading: heading[2].trim(), level: heading[1].length, chars: 0 }
      continue
    }
    if (line.trim().length === 0) continue
    if (current === undefined) introChars += line.length + 1
    else current.chars += line.length + 1
  }
  if (current !== undefined) sections.push(current)
  if (introChars > 0) sections.unshift({ heading: '(intro)', level: 0, chars: introChars })
  return { title, headings, links, sections, chars: markdown.length }
}

/** Render an outline as the compact markdown `page map` returns. */
export function renderOutline(outline: Outline): string {
  const lines: string[] = [`# ${outline.title}`, '']
  const counts = `headings: ${String(outline.headings.length)}, links: ${String(outline.links.length)}, sections: ${String(outline.sections.length)}, chars: ${String(outline.chars)}`
  lines.push(counts, '')
  if (outline.headings.length > 0) {
    lines.push('## Outline', '')
    for (const heading of outline.headings) {
      lines.push(`${'  '.repeat(Math.max(0, heading.level - 1))}- h${String(heading.level)} ${heading.text}`)
    }
    lines.push('')
  }
  if (outline.sections.length > 0) {
    lines.push('## Sections', '')
    for (const section of outline.sections) {
      lines.push(`- ${section.heading} (${String(section.chars)} chars)`)
    }
    lines.push('')
  }
  if (outline.links.length > 0) {
    lines.push('## Links', '')
    for (const link of outline.links) lines.push(`- [${link.text}](${link.href})`)
  }
  return normalizeMarkdown(lines.join('\n'))
}

/** The query terms worth scoring (lowercased, stopwords dropped). */
export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_+#.-]+/u).map((term) => term.replace(/^[.-]+|[.-]+$/g, ''))
  return [...new Set(terms.filter((term) => term.length > 1 && !STOPWORDS.has(term)))]
}

function blockScore(block: string, terms: string[]): number {
  const lower = block.toLowerCase()
  let score = 0
  for (const term of terms) {
    let index = lower.indexOf(term)
    let hits = 0
    while (index >= 0 && hits < 20) {
      hits += 1
      index = lower.indexOf(term, index + term.length)
    }
    if (hits > 0) score += hits * (1 + Math.min(term.length, 12) / 4)
  }
  if (score > 0 && /^#{1,6}\s/.test(block)) score *= 1.5
  return score
}

export interface SliceResult {
  markdown: string
  matched: number
  terms: string[]
  chars: number
}

/**
 * Split a COMPACT markdown body (paragraphs separated by a single newline, the
 * shape the extractor emits) into scoreable blocks: a heading, a list item, a
 * table row or a fence is its own block; consecutive prose lines group into one.
 */
function markdownBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let prose: string[] = []
  const flush = (): void => {
    if (prose.length > 0) {
      blocks.push(prose.join(' '))
      prose = []
    }
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (/^#{1,6}\s/.test(line) || /^([-*+]|\d+[.)])\s/.test(line) || /^\|/.test(line) || /^```/.test(line)) {
      flush()
      blocks.push(line)
    } else {
      prose.push(line)
    }
  }
  flush()
  return blocks
}

/** How many blocks a matching heading may drag in from its own section. */
const DRAG_FORWARD_MAX = 12

/**
 * Keep only the blocks matching `query` (deterministic TF scoring, document
 * order preserved). A matching block drags in the nearest preceding heading so
 * the slice keeps its context; a matching HEADING drags in the blocks of its
 * own section (bounded), so asking for a section returns its body; when the
 * result exceeds `maxChars` the best-scoring blocks survive.
 */
export function sliceByQuery(markdown: string, query: string, maxChars: number): SliceResult {
  const terms = queryTerms(query)
  if (terms.length === 0) return { markdown, matched: 0, terms, chars: markdown.length }
  const blocks = markdownBlocks(markdown)
  const scored = blocks.map((block, index) => ({ block, index, score: blockScore(block, terms) }))
  const isHeading = (index: number): boolean => /^#{1,6}\s/.test(blocks[index] ?? '')
  const keep = new Set<number>()
  for (const entry of scored) {
    if (entry.score <= 0) continue
    keep.add(entry.index)
    for (let back = entry.index - 1; back >= 0; back--) {
      if (isHeading(back)) {
        keep.add(back)
        break
      }
    }
    if (isHeading(entry.index)) {
      for (let forward = entry.index + 1; forward < blocks.length; forward++) {
        if (isHeading(forward) || forward > entry.index + DRAG_FORWARD_MAX) break
        keep.add(forward)
      }
    }
  }
  if (keep.size === 0) return { markdown: '', matched: 0, terms, chars: 0 }
  const chosen = [...keep].sort((a, b) => a - b)
  const render = (indices: number[]): string =>
    normalizeMarkdown(indices.map((index) => blocks[index]).join('\n'))
  let picked = chosen
  let text = render(picked)
  if (text.length > maxChars) {
    const byScore = [...picked].sort((a, b) => (scored[b]?.score ?? 0) - (scored[a]?.score ?? 0))
    const budgetSet = new Set<number>()
    let used = 0
    for (const index of byScore) {
      const size = (blocks[index]?.length ?? 0) + 2
      if (used + size > maxChars) continue
      budgetSet.add(index)
      used += size
    }
    picked = [...budgetSet].sort((a, b) => a - b)
    text = render(picked)
  }
  return { markdown: text, matched: picked.length, terms, chars: text.length }
}

// ---------------------------------------------------------------------------
// Selector support (`selectors` param)
// ---------------------------------------------------------------------------

interface ParsedSelector {
  tag: string | undefined
  id: string | undefined
  classes: string[]
}

/** Parse `tag#id.class` (a comma list is handled by the caller). */
export function parseSelector(selector: string): ParsedSelector {
  const trimmed = selector.trim()
  const match = /^([a-zA-Z][\w-]*|\*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/.exec(trimmed)
  if (match === null || trimmed.length === 0) {
    throw new PageError('invalid_input', `unsupported selector '${selector}' (use tag, #id, .class or tag.class)`)
  }
  const classes = match[3].split('.').filter((name) => name.length > 0)
  return { tag: match[1] === undefined || match[1] === '*' ? undefined : match[1].toLowerCase(), id: match[2], classes }
}

function matchesSelector(element: Element, selector: ParsedSelector): boolean {
  if (selector.tag !== undefined && element.tag !== selector.tag) return false
  if (selector.id !== undefined && element.attrs.id !== selector.id) return false
  const classes = (element.attrs.class ?? '').split(/\s+/)
  return selector.classes.every((name) => classes.includes(name))
}

/**
 * The whole pipeline: HTML in, compact markdown + outline out. Deterministic:
 * same HTML in, same markdown out (no clock, no randomness, no network).
 */
export function extractMain(html: string, options: { url: string; selectors?: string[]; maxLinks?: number }): Extraction {
  const root = parseHtml(html)
  const title = documentTitle(root)
  prune(root)
  const ctx: RenderCtx = { base: options.url, links: [], maxLinks: options.maxLinks ?? 200 }
  // Scope: the caller's selectors, else the detected main content.
  let blocks: string[]
  const selectors = (options.selectors ?? []).filter((selector) => selector.trim().length > 0)
  if (selectors.length > 0) {
    const parsed = selectors.flatMap((selector) => selector.split(',').map((part) => parseSelector(part)))
    const matched = walk(root).filter((element) => parsed.some((selector) => matchesSelector(element, selector)))
    if (matched.length === 0) {
      throw new PageError('extract_empty', `no element matched the selector(s) ${selectors.join(', ')}`, { url: options.url })
    }
    blocks = matched.flatMap((element) => blocksOfElement(element, ctx, 0))
  } else {
    blocks = blocksOf(selectContent(root), ctx)
  }
  const markdown = normalizeMarkdown(blocks.join('\n\n'))
  return { title, markdown, outline: outlineOf(markdown, title, ctx.maxLinks), chars: markdown.length }
}
