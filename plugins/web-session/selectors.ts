// The selector engine of the `session` tool: THREE selector forms, parsed
// deterministically here (so a bad selector is a named `bad_selector` failure
// BEFORE a browser is touched) and resolved inside the page by the session
// manager.
//
//   CSS          `main .card`, `.item:nth-child(2)`, `css=#total`
//   XPath        `//div[@id="total"]`, `xpath=(//li)[1]`
//   role+name    `role=button[name="Load items"]`, `role=button[name=Load]`
//
// The parser is pure: the unit tests pin every form (and every rejection)
// without a browser.
import { SessionError } from './errors.ts'

export type SelectorKind = 'css' | 'xpath' | 'role'

export interface ParsedSelector {
  /** The selector exactly as the caller wrote it. */
  raw: string
  kind: SelectorKind
  /** CSS selector, for `kind: 'css'`. */
  css?: string
  /** XPath expression, for `kind: 'xpath'`. */
  xpath?: string
  /** The ARIA role, for `kind: 'role'`. */
  role?: string
  /** The accessible name, for `kind: 'role'` (optional). */
  name?: string
}

/** A short human description of the accepted forms (error hints). */
export const SELECTOR_FORMS = "use CSS ('main .card'), XPath ('//div[@id=\"x\"]' or 'xpath=...') or role+name ('role=button[name=\"Save\"]')"

/** A balanced-delimiters check for a CSS/XPath expression. */
function balanced(expr: string): boolean {
  const pairs: Record<string, string> = { '(': ')', '[': ']' }
  const stack: string[] = []
  let quote = ''
  for (const ch of expr) {
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[') stack.push(pairs[ch])
    else if (ch === ')' || ch === ']') {
      if (stack.pop() !== ch) return false
    }
  }
  return quote === '' && stack.length === 0
}

/**
 * Parse one selector into its form.
 *
 * The CSS form is validated STRUCTURALLY only (balanced delimiters, no
 * statement-level punctuation): the browser is the authority on CSS syntax, and
 * a selector it refuses comes back as a `bad_selector` failure with the browser
 * text in `detail`. Rejecting the obvious garbage here keeps the failure cheap.
 */
export function parseSelectorSpec(raw: string): ParsedSelector {
  const selector = typeof raw === 'string' ? raw.trim() : ''
  if (selector.length === 0) {
    throw new SessionError('invalid_input', 'the selector must be a non-empty string', { hint: SELECTOR_FORMS })
  }
  if (selector.startsWith('xpath=') || selector.startsWith('//') || selector.startsWith('(/') || selector.startsWith('./') || selector.startsWith('.//')) {
    const xpath = selector.startsWith('xpath=') ? selector.slice('xpath='.length).trim() : selector
    if (xpath.length === 0 || !balanced(xpath)) {
      throw new SessionError('bad_selector', `the XPath expression is incomplete: '${selector}'`, { selector, hint: SELECTOR_FORMS })
    }
    return { raw: selector, kind: 'xpath', xpath }
  }
  if (selector.startsWith('role=')) {
    const rest = selector.slice('role='.length).trim()
    const match = /^([a-zA-Z][\w-]*)\s*(?:\[name=("([^"]*)"|'([^']*)'|([^\]]*))\]|\[name=("([^"]*)"|'([^']*)'|([^\]]*))\])?$/.exec(rest)
    if (match === null) {
      throw new SessionError('bad_selector', `the role selector is malformed: '${selector}'`, { selector, hint: SELECTOR_FORMS })
    }
    const name = match[3] ?? match[4] ?? match[5] ?? match[7] ?? match[8] ?? match[9]
    return { raw: selector, kind: 'role', role: match[1].toLowerCase(), ...(name === undefined || name.trim().length === 0 ? {} : { name: name.trim() }) }
  }
  const css = selector.startsWith('css=') ? selector.slice('css='.length).trim() : selector
  if (css.length === 0 || !balanced(css) || /[;{}]/.test(css)) {
    throw new SessionError('bad_selector', `the CSS selector is malformed: '${selector}'`, { selector, hint: SELECTOR_FORMS })
  }
  return { raw: selector, kind: 'css', css }
}

/** The identity of a parsed selector, used to key a snapshot/step (never a value). */
export function describeSelector(parsed: ParsedSelector): string {
  if (parsed.kind === 'css') return `css(${parsed.css ?? ''})`
  if (parsed.kind === 'xpath') return `xpath(${parsed.xpath ?? ''})`
  return `role(${parsed.role ?? ''}${parsed.name === undefined ? '' : `[name=${parsed.name}]`})`
}
