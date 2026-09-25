// core/browser-use-playwright/extract.ts - the page-side extraction code of the
// `browser-use` provider.
//
// WHY THIS FILE EXISTS: `extract` answers READABLE content (text, markdown, html,
// a table, attributes, links) out of a page the provider does not own. The work
// happens INSIDE the page (one `page.evaluate` round trip), so every function
// here is SELF-CONTAINED: no import, no closure over node state, only its
// `payload` argument. That is also why this module has no dependency beyond the
// definition's types.
//
// It reuses the IDEA of `web-page`'s readability pass (score the text nodes,
// drop navigation/footer noise) without importing that plugin: a provider may
// import its own directory and the definitions only (rule 4 of
// `scripts/check-seam.ts`), so the extraction is implemented here, on the same
// shared chromium, with no second browser.

/** The payload the page-side extractor receives. */
export interface ExtractPayload {
  mode: 'text' | 'markdown' | 'html' | 'table' | 'attributes' | 'links' | 'json'
  /** A CSS selector the extraction is scoped to (absent: the whole document). */
  selector?: string
  /** The attribute names `attributes` reads (absent: a documented default set). */
  attributes?: string[]
  /** `table`: which table of the scope (0-based). */
  index?: number
  /** `json`: the expression evaluated in the page. */
  expression?: string
  /** Serialization cap applied IN the page, so a huge page never crosses the wire. */
  maxChars: number
}

/** The page-side answer (the provider caps and validates it again). */
export interface ExtractResult {
  text?: string
  rows?: unknown[]
  elements?: { tag: string; attrs: Record<string, string>; text: string }[]
  links?: { text: string; href: string }[]
  value?: unknown
  chars: number
  truncated: boolean
  /** A structured, caller-visible note when the scope did not resolve. */
  note?: string
}

/** The default attributes `attributes` reads (a documented, stable set). */
export const DEFAULT_ATTRIBUTES = ['id', 'name', 'type', 'href', 'src', 'alt', 'title', 'value', 'placeholder', 'role', 'aria-label', 'data-testid']

/**
 * Noise elements that never belong to "readable" content. Declared INSIDE
 * {@link extractInPage} (see the note there): a module-level constant would not
 * survive the serialization of the evaluated function into the page.
 */

/**
 * The page-side entry point. It is passed to `page.evaluate` as a FUNCTION, so it
 * must not reference anything outside its own body: every helper it needs is
 * declared inside it.
 */
export function extractInPage(payload: ExtractPayload): ExtractResult {
  const cap = payload.maxChars > 0 ? payload.maxChars : 20_000
  // This constant MUST stay inside the function body: `page.evaluate` serializes
  // the function into the browser, where a module-level constant is simply not
  // defined (`ReferenceError: NOISE_SELECTOR is not defined`, caught live).
  const NOISE_SELECTOR = 'script, style, noscript, template, svg, iframe, nav, footer, header [role="navigation"], aside[role="complementary"]'
  const scopeOf: () => Element = () => {
    if (payload.selector === undefined || payload.selector.length === 0) return document.body
    // A ref-based scope arrives already translated to a CSS attribute selector by
    // the provider, so plain `querySelector` is enough here.
    const found = document.querySelector(payload.selector)
    return found ?? document.body
  }
  const scope = scopeOf()
  const textOfElement = (element: Element): string => {
    const raw = (element as HTMLElement).innerText ?? element.textContent ?? ''
    return raw.replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
  }
  const bounded = (text: string): ExtractResult => {
    const truncated = text.length > cap
    return { text: truncated ? text.slice(0, cap) : text, chars: Math.min(text.length, cap), truncated }
  }

  if (payload.mode === 'text') {
    const clone = scope.cloneNode(true) as Element
    clone.querySelectorAll(NOISE_SELECTOR).forEach((node) => node.remove())
    return bounded(textOfElement(clone))
  }

  if (payload.mode === 'html') {
    const html = (scope as HTMLElement).outerHTML ?? ''
    return bounded(html)
  }

  if (payload.mode === 'table') {
    const tables = payload.selector === undefined
      ? Array.from(document.querySelectorAll('table'))
      : Array.from(scope.querySelectorAll('table'))
    const table = tables[payload.index ?? 0]
    if (table === undefined) {
      return { rows: [], chars: 0, truncated: false, note: `no table exists at index ${String(payload.index ?? 0)} (found ${String(tables.length)})` }
    }
    const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) => textOfElement(cell)),
    )
    const serialized = JSON.stringify(rows)
    const truncated = serialized.length > cap
    return { rows: truncated ? JSON.parse(serialized.slice(0, cap < 2 ? 0 : cap)) || [] : rows, chars: Math.min(serialized.length, cap), truncated }
  }

  if (payload.mode === 'attributes') {
    const names = payload.attributes ?? []
    const elements = Array.from(scope.querySelectorAll('*')).slice(0, 2_000).map((element) => {
      const attrs: Record<string, string> = {}
      for (const name of names) {
        const value = element.getAttribute(name)
        if (value !== null) attrs[name] = value.slice(0, 1_000)
      }
      return { tag: element.tagName.toLowerCase(), attrs, text: textOfElement(element).slice(0, 200) }
    })
    const kept = elements.filter((element) => Object.keys(element.attrs).length > 0)
    const serialized = JSON.stringify(kept)
    const truncated = serialized.length > cap
    return { elements: truncated ? [] : kept, chars: Math.min(serialized.length, cap), truncated, note: truncated ? 'the attribute payload exceeded maxChars: narrow the scope or raise maxChars' : undefined }
  }

  if (payload.mode === 'links') {
    const links = Array.from(scope.querySelectorAll('a[href]'))
      .slice(0, 1_000)
      .map((anchor) => ({ text: textOfElement(anchor).slice(0, 300), href: (anchor as HTMLAnchorElement).href }))
    const serialized = JSON.stringify(links)
    return { links, chars: Math.min(serialized.length, cap), truncated: serialized.length > cap }
  }

  if (payload.mode === 'json') {
    let value: unknown = null
    try {
      const expression = payload.expression ?? 'null'
      // The expression is evaluated IN the page, like a devtools console line.
      // eslint-disable-next-line no-new-func
      value = new Function(`return (${expression})`)()
    } catch (error) {
      return { value: null, chars: 0, truncated: false, note: `the expression failed in the page: ${error instanceof Error ? error.message : String(error)}` }
    }
    let serialized: string
    try {
      serialized = JSON.stringify(value ?? null)
    } catch {
      serialized = String(value)
    }
    const truncated = serialized.length > cap
    return { value: truncated ? serialized.slice(0, cap) : value ?? null, chars: Math.min(serialized.length, cap), truncated }
  }

  // markdown: a small deterministic DOM walk (headings, paragraphs, lists, links,
  // code, tables as pipe rows). No model, no readability scoring: the same page
  // always renders the same markdown, which is what makes a re-read cheap.
  const lines: string[] = []
  const inline = (element: Element): string => {
    let out = ''
    element.childNodes.forEach((node) => {
      if (node.nodeType === 3) {
        out += (node.textContent ?? '').replace(/\s+/g, ' ')
        return
      }
      if (node.nodeType !== 1) return
      const child = node as Element
      const tag = child.tagName.toLowerCase()
      if (tag === 'br') {
        out += '\n'
        return
      }
      if (tag === 'a') {
        const href = child.getAttribute('href')
        const label = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (label.length === 0) return
        out += href === null || href.length === 0 || href.startsWith('javascript:') ? label : `[${label}](${href})`
        return
      }
      if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
        out += `\`${(child.textContent ?? '').trim()}\``
        return
      }
      if (tag === 'strong' || tag === 'b') {
        out += `**${inline(child).trim()}**`
        return
      }
      if (tag === 'em' || tag === 'i') {
        out += `_${inline(child).trim()}_`
        return
      }
      if (tag === 'img') {
        const alt = child.getAttribute('alt') ?? ''
        const src = child.getAttribute('src') ?? ''
        out += src.length === 0 ? alt : `![${alt}](${src})`
        return
      }
      out += inline(child)
    })
    return out
  }
  const blockTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre', 'blockquote', 'dt', 'dd', 'figcaption', 'summary']
  const walk = (element: Element): void => {
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') continue
      if (tag === 'table') {
        const rows = Array.from(child.querySelectorAll('tr')).slice(0, 200).map((row) =>
          Array.from(row.querySelectorAll('th, td')).map((cell) => inline(cell).replace(/\|/g, '\\|').trim()),
        )
        const kept = rows.filter((row) => row.some((cell) => cell.length > 0))
        if (kept.length > 0) {
          lines.push('')
          lines.push(`| ${kept[0]!.join(' | ')} |`)
          lines.push(`| ${kept[0]!.map(() => '---').join(' | ')} |`)
          for (const row of kept.slice(1)) lines.push(`| ${row.join(' | ')} |`)
          lines.push('')
        }
        continue
      }
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1))
        lines.push('', `${'#'.repeat(level)} ${inline(child).trim()}`, '')
        continue
      }
      if (tag === 'ul' || tag === 'ol') {
        Array.from(child.querySelectorAll(':scope > li')).forEach((item, position) => {
          lines.push(`${tag === 'ol' ? `${String(position + 1)}.` : '-'} ${inline(item).trim()}`)
        })
        lines.push('')
        continue
      }
      if (tag === 'pre') {
        lines.push('', '```', (child.textContent ?? '').replace(/\n+$/, ''), '```', '')
        continue
      }
      if (blockTags.includes(tag)) {
        const text = inline(child).trim()
        if (text.length > 0) lines.push('', text, '')
        continue
      }
      walk(child)
    }
  }
  walk(scope)
  // Collapse runs of blank lines, so the markdown is stable and compact.
  const markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trim()
  return bounded(markdown)
}

/** The page-side snapshot builder: the compact view + the STABLE refs. */
export interface SnapshotPayload {
  includeText: boolean
  maxNodes: number
  /** The attribute the provider stamps on every ref node (it reads it back). */
  refAttribute: string
}

/** One node of the snapshot as the page reports it. */
export interface PageSnapshotNode {
  ref: string
  tag: string
  role?: string
  name?: string
  text?: string
  value?: string
  href?: string
  inputType?: string
  disabled?: boolean
  checked?: boolean
}

/**
 * Builds the snapshot INSIDE the page and stamps `refAttribute="eN"` on every
 * node it reports, which is what lets a later call resolve `{ ref: 'e12' }`
 * without the caller ever seeing a CSS selector. Refs are assigned in DOCUMENT
 * ORDER on every snapshot, so a ref belongs to exactly ONE snapshot id: a ref
 * from an older snapshot is the typed `browser-use.stale-ref`, never a silent
 * click on whatever moved into that position.
 */
export function snapshotInPage(payload: SnapshotPayload): { nodes: PageSnapshotNode[]; totalNodes: number } {
  const ACTIONABLE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="menuitem"]',
    '[role="switch"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[onclick]',
  ].join(',')
  const TEXTY = 'h1, h2, h3, h4, h5, h6, p, li, td, th, dd, dt, figcaption, blockquote, label, legend, caption'
  const selector = payload.includeText ? `${ACTIONABLE},${TEXTY}` : ACTIONABLE
  const elements = Array.from(document.querySelectorAll(selector))
  // Clear the refs of the PREVIOUS snapshot: a stale ref must no longer resolve
  // anywhere in the page (that is what makes stale-ref detectable, not a guess).
  document.querySelectorAll(`[${payload.refAttribute}]`).forEach((node) => node.removeAttribute(payload.refAttribute))
  const nodes: PageSnapshotNode[] = []
  const seen = new Set<Element>()
  const compress = (text: string, max: number): string => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max)}...` : flat
  }
  const roleOf = (element: Element): string | undefined => {
    const explicit = element.getAttribute('role')
    if (explicit !== null && explicit.trim().length > 0) return explicit.trim()
    const tag = element.tagName.toLowerCase()
    const implicit: Record<string, string> = {
      a: 'link',
      button: 'button',
      select: 'combobox',
      textarea: 'textbox',
      summary: 'button',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      li: 'listitem',
      td: 'cell',
      th: 'columnheader',
      label: 'label',
      p: 'paragraph',
    }
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    return implicit[tag]
  }
  let index = 0
  for (const element of elements) {
    if (seen.has(element)) continue
    seen.add(element)
    // Skip a node fully contained in another reported node of the same kind: the
    // view stays compact, and the refs stay meaningful.
    index += 1
    const ref = `e${String(index)}`
    element.setAttribute(payload.refAttribute, ref)
    const tag = element.tagName.toLowerCase()
    const text = compress((element as HTMLElement).innerText ?? element.textContent ?? '', 160)
    const ariaLabel = element.getAttribute('aria-label')
    const placeholder = element.getAttribute('placeholder')
    const title = element.getAttribute('title')
    const alt = element.getAttribute('alt')
    const value = (element as HTMLInputElement).value
    const rawType = element.getAttribute('type') ?? undefined
    const inputType = rawType === undefined ? undefined : rawType.toLowerCase()
    const name = compress(
      ariaLabel ?? alt ?? title ?? (tag === 'input' || tag === 'textarea' || tag === 'select' ? (value ?? placeholder ?? '') : '') ?? text,
      120,
    )
    const node: PageSnapshotNode = { ref, tag }
    const role = roleOf(element)
    if (role !== undefined) node.role = role
    if (name.length > 0) node.name = name
    if (text.length > 0) node.text = text
    // A PASSWORD field never reports a value (a snapshot is not a place for
    // secrets, and the caller has no use for the masked text).
    if (inputType !== 'password' && typeof value === 'string' && value.length > 0) node.value = compress(value, 120)
    const href = element.getAttribute('href')
    if (href !== null && href.length > 0 && tag === 'a') {
      try {
        node.href = (element as HTMLAnchorElement).href
      } catch {
        node.href = href
      }
    }
    if (inputType !== undefined) node.inputType = inputType
    if ((element as HTMLInputElement).disabled === true || element.getAttribute('aria-disabled') === 'true') node.disabled = true
    if ((element as HTMLInputElement).checked === true) node.checked = true
    nodes.push(node)
  }
  return { nodes, totalNodes: nodes.length }
}
