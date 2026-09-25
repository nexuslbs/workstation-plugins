// definitions/email.ts - the `email@1` SERVICE DEFINITION (re-homed here).
//
// The generic EMAIL capability: accounts, list, get, code, search and SEND.
// It is backend agnostic - it names no mail protocol, no CLI and no transport -
// so a provider (core/email-himalaya) and a consumer (plugins/email-tools)
// can evolve independently:
//
//   Provider -> Definition <- Consumer
//
// WHY THIS FILE EXISTS EVEN THOUGH THE CORE HAS AN EMAIL DEFINITION: the core
// copy (`nexuslbs/workbench`, `src/email/definition.ts`) is a CORE module whose
// service is hosted by the kernel, and it has NO `send`. This repository is an
// EXTERNAL plugin source and must not change the core, so the contract is
// re-homed here (task R5/R14): the plugins of this repository speak THIS
// Definition. It also offers the plugins-repo service name `mail`, so an
// implementation can serve it without touching the kernel-hosted `email`
// service. See the report of task task_workbench_workbench_generalservice_himalaya
// for the exact core change that would remove the split.
//
// The account is always a REFERENCE (a label), never an address and never a
// value: which mailboxes exist, and how a backend authenticates, is the
// provider's configuration; credential VALUES are resolved at call time through
// the credentials capability.
//
// The `code()` (verification code extraction) and `search()` algorithms live
// HERE, on top of `list()`/`get()`, because they are backend agnostic: a
// provider that implements nothing but `accounts()`/`list()`/`get()`/`send()`
// gets both for free.
import {
  ServiceError,
  requireService,
  serviceOf,
  type ServiceContext,
} from './support.ts'

/** Name of the service of THIS repository's contract (`ctx.mail`). */
export const MAIL = 'mail'

/** Name of the KERNEL-hosted email service (`ctx.email`), read-only fallback. */
export const EMAIL = 'email'

/** Contract version this definition speaks. */
export const EMAIL_VERSION = 1

/** Contract id including the version, e.g. `email@1`. */
export const EMAIL_CONTRACT = `${EMAIL}@${EMAIL_VERSION}`

export const EMAIL_POLICY_PROVIDE = EMAIL_CONTRACT
export const EMAIL_POLICY_REQUIRE = EMAIL_CONTRACT

/** One configured account, as the capability reports it (never a secret). */
export interface EmailAccount {
  /** Stable label the callers use as the account REFERENCE. */
  label: string
  /** The mailbox address, when the provider knows it (not a credential). */
  address?: string
  /** True for the account a call without a reference resolves to. */
  default?: boolean
  description?: string
}

/** The account REFERENCE a call passes (a label, never a value). */
export interface EmailRef {
  label: string
}

/** One message summary (list/search answers). */
export interface EmailSummary {
  id: string
  subject: string
  from: string
  to: string[]
  date: string
  unread: boolean
  snippet?: string
  folder?: string
}

/** One body format a provider can deliver. */
export type EmailFormat = 'text' | 'markdown' | 'html' | 'raw'

/** One full message (get answers). */
export interface EmailMessage extends EmailSummary {
  text?: string
  markdown?: string
  html?: string
  raw?: string
  attachments: { filename: string; contentType?: string; size?: number }[]
  format: EmailFormat
}

/** A verification code found in a message. */
export interface EmailCode {
  code: string
  /** The message the code came from. */
  message: EmailSummary
  /** The line the code was found on (redaction-friendly context). */
  context?: string
}

export interface EmailListOptions {
  folder?: string
  /** Max messages to return (provider-bounded). */
  pageSize?: number
  /** Backend search query, when the provider supports one. */
  query?: string
  unreadOnly?: boolean
}

export interface EmailGetOptions {
  folder?: string
  /** Strip the headers, keeping the body only. */
  noHeaders?: boolean
  /** Preferred body format (default `text`). */
  format?: EmailFormat
}

export interface EmailCodeOptions extends EmailListOptions {
  /** How many recent messages to scan (default 10). */
  scan?: number
  /** Restrict to messages from this sender substring. */
  from?: string
}

export interface EmailSendInput {
  to: string | string[]
  subject: string
  body: string
  cc?: string | string[]
  bcc?: string | string[]
  /** Send the body as HTML instead of plain text. */
  html?: boolean
  /** Account REFERENCE selecting the sending mailbox (default account when absent). */
  ref?: EmailRef
  /** Reply-to, when the backend supports it. */
  replyTo?: string
}

export interface EmailSendResult {
  /** The mailbox that sent the message (a label). */
  account?: string
  /** Recipients the backend accepted. */
  accepted: string[]
  /** The CLI/backend answer, when it has one (bounded). */
  output?: string
}

/** What an `email@1` provider must offer at least. */
export interface EmailProvider {
  readonly id: string
  readonly version?: number
  describe?(): string
  accounts(): Promise<EmailAccount[]>
  list(ref?: EmailRef, options?: EmailListOptions): Promise<EmailSummary[]>
  get(ref: EmailRef | undefined, id: string, options?: EmailGetOptions): Promise<EmailMessage>
  send(input: EmailSendInput): Promise<EmailSendResult>
  /** Optional: a better implementation than the derived one. */
  code?(ref?: EmailRef, options?: EmailCodeOptions): Promise<EmailCode | undefined>
  /** Optional: a better implementation than the derived one. */
  search?(ref: EmailRef | undefined, query: string, options?: EmailListOptions): Promise<EmailSummary[]>
}

/** The consumer-facing service: the provider contract plus the derived commands. */
export interface EmailService extends EmailProvider {
  code(ref?: EmailRef, options?: EmailCodeOptions): Promise<EmailCode | undefined>
  search(ref: EmailRef | undefined, query: string, options?: EmailListOptions): Promise<EmailSummary[]>
}

/** The instance-style handle (a provider descriptor bound and normalised). */
export type EmailInstance = EmailService

// ---------------------------------------------------------------------------
// Derived commands (backend agnostic): `code()` and `search()` on top of
// list()/get(). A provider may override either one.
// ---------------------------------------------------------------------------

/** Message ids/pages scanned by the derived code search. */
export const DEFAULT_CODE_SCAN = 10

const CODE_PATTERNS: readonly RegExp[] = [
  /\b(?:code|otp|passcode|pin|verification|verify|security)\b[^0-9a-z]{0,20}([0-9]{4,8})\b/i,
  /\b([0-9]{4,8})\b[^0-9a-z]{0,20}\b(?:is your|code|otp|passcode|pin|verification)\b/i,
  /\b(?:code|otp|passcode|pin|verification|verify|security)\b[^0-9a-z]{0,20}([A-Z0-9]{4,8})\b/,
  /\b([A-Z0-9]{6,8})\b[^a-z]{0,20}\b(?:code|verification|otp)\b/i,
]

/** Extracts the first plausible verification code out of a text. */
export function extractCode(text: string): string | undefined {
  for (const pattern of CODE_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

/** The searchable text of a message (subject + snippet + body). */
function messageText(message: EmailMessage | EmailSummary): string {
  const parts = [message.subject, message.snippet ?? '']
  const full = message as EmailMessage
  for (const value of [full.text, full.markdown, full.html]) if (typeof value === 'string') parts.push(value)
  return parts.join('\n')
}

/** The derived `code()`: newest code-bearing message, restricted by `from`. */
export async function derivedCode(
  provider: EmailProvider,
  ref?: EmailRef,
  options: EmailCodeOptions = {},
): Promise<EmailCode | undefined> {
  const scan = Number.isFinite(options.scan) && (options.scan as number) > 0 ? Math.floor(options.scan as number) : DEFAULT_CODE_SCAN
  const list = await provider.list(ref, {
    ...(options.folder === undefined ? {} : { folder: options.folder }),
    ...(options.query === undefined ? {} : { query: options.query }),
    pageSize: Math.max(scan, options.pageSize ?? 0),
  })
  const filtered =
    options.from === undefined ? list : list.filter((message) => message.from.toLowerCase().includes(options.from!.toLowerCase()))
  for (const summary of filtered.slice(0, scan)) {
    const quick = extractCode(messageText(summary))
    if (quick !== undefined) return { code: quick, message: summary }
    let full: EmailMessage
    try {
      full = await provider.get(ref, summary.id, {
        ...(options.folder === undefined ? {} : { folder: options.folder }),
        format: 'text',
      })
    } catch {
      continue
    }
    const code = extractCode(messageText(full))
    if (code !== undefined) return { code, message: { ...full, ...summary } }
  }
  return undefined
}

/** The derived `search()`: filter `list()` by a plain substring query. */
export async function derivedSearch(
  provider: EmailProvider,
  ref: EmailRef | undefined,
  query: string,
  options: EmailListOptions = {},
): Promise<EmailSummary[]> {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return provider.list(ref, options)
  const list = await provider.list(ref, { ...options, query: options.query ?? query })
  const hits = list.filter((message) => messageText(message).toLowerCase().includes(needle))
  return hits.length > 0 || options.query !== undefined ? hits : list
}

/**
 * Wraps a provider descriptor into the consumer-facing service: missing
 * `code`/`search` fall back to the derived implementations above.
 */
export function withDerivedEmailCommands(provider: EmailProvider): EmailService {
  const service: EmailService = {
    ...provider,
    code: provider.code !== undefined ? provider.code.bind(provider) : (ref, options) => derivedCode(provider, ref, options),
    search:
      provider.search !== undefined
        ? provider.search.bind(provider)
        : (ref, query, options) => derivedSearch(provider, ref, query, options),
    accounts: provider.accounts.bind(provider),
    list: provider.list.bind(provider),
    get: provider.get.bind(provider),
    send: provider.send.bind(provider),
  }
  return service
}

/** Validates an account label (a reference, never a value). */
export function emailRef(value: unknown, field = 'account'): EmailRef | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const label = value.trim()
    return label.length === 0 ? undefined : { label }
  }
  if (typeof value === 'object' && value !== null && typeof (value as EmailRef).label === 'string') {
    const label = (value as EmailRef).label.trim()
    return label.length === 0 ? undefined : { label }
  }
  throw new ServiceError('invalid-input', `email: '${field}' must be a label string or { label }`, {
    stage: 'email.validate',
    details: { field },
  })
}

/** Normalises a recipient list (`string | string[]` -> `string[]`). */
export function emailRecipients(value: unknown, field: string): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const recipients = list.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
  if (recipients.length === 0) {
    throw new ServiceError('invalid-input', `email: '${field}' needs at least one recipient`, {
      stage: 'email.validate',
      details: { field },
    })
  }
  return recipients
}

/**
 * The email service of this deployment: the plugins-repo `mail` service first,
 * then the KERNEL-hosted `email` service (read-only fallback: it has no `send`,
 * so a `send` through it fails with a structured error).
 */
export function serviceOfMail(ctx: ServiceContext): EmailService | undefined {
  return (
    serviceOf<EmailService>(ctx, MAIL) ??
    serviceOf<EmailService>(ctx, EMAIL)
  )
}

/** The email service, or a structured `missing-service` error naming both names. */
export function requireMail(ctx: ServiceContext, hint?: string): EmailService {
  return requireService<EmailService>(
    ctx,
    MAIL,
    hint ??
      "the email service is not loaded: enable a plugin providing email@1 (core/email-himalaya provides 'mail', the kernel hosts 'email')",
  )
}
