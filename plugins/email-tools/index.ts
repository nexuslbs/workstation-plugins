// plugins/email-tools - the `email@1` CONSUMER (EmailConsumer).
//
// It exposes the generic email capability as TOOLS for an agent or a human,
// through the tools seam `ctx.tools.registerTool` (tools@1 API
// `POST /api/tools/<name>` / `POST /api/tool/call {"tool","params"}` or the
// CLI). It imports the DEFINITION and the shared helpers only:
//
//   Provider -> Definition <- Consumer   (this file)
//
// No backend, no protocol and no CLI name appears here. Which mailbox answers,
// and how it authenticates, is the provider's configuration; the account
// parameter is an optional LABEL that selects a different mailbox, and omitting
// it uses the configured default (so a single-mailbox deployment needs no
// boilerplate in a tool call).
//
// Error behaviour: a not-configured or failing provider makes the handler throw
// a structured `ServiceError`, which the core renders as
// `{ status: 'error', error: { kind, message } }` (HTTP 500) while the process
// keeps serving. An invalid parameter is rejected by the core with the 400
// `violations` list before the handler runs.
import {
  MAIL,
  derivedCode,
  emailRef,
  extractCode,
  serviceOfMail,
  type EmailCode,
  type EmailFormat,
  type EmailRef,
  type EmailService,
  type EmailSummary,
} from '../../definitions/email.ts'
import { ServiceError, messageOf, type ServiceContext } from '../../definitions/support.ts'
import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'email-tools'

/** One declared tool parameter (the property map the core publishes). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

type ToolParameters = Record<string, ToolParameter>

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

export interface Config {
  /** Cap of one `email list` page (default 10, hard cap 50). */
  defaultLimit?: number
}

export interface EmailToolsContext extends ServiceContext {
  tools: ToolsLike
  effect?: (callback: () => () => void) => void
}

/** Largest page a tool call ever asks for. */
export const MAX_LIMIT = 50

/** Default page when the caller passes no `limit`. */
export const DEFAULT_LIMIT = 10

/** The email service of this deployment, or a structured not-configured error. */
export function resolveEmailService(ctx: ServiceContext): EmailService {
  const service = serviceOfMail(ctx)
  if (service === undefined) {
    throw new ServiceError(
      'not-configured',
      `email is not available: no '${MAIL}' (or kernel 'email') service is loaded (enable a plugin that provides email@1)`,
      { stage: 'email-tools.resolve' },
    )
  }
  return service
}

function str(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ServiceError('invalid-input', `email: '${field}' is required`, { stage: 'email-tools.validate', details: { field } })
    return undefined
  }
  if (typeof value !== 'string') {
    throw new ServiceError('invalid-input', `email: '${field}' must be a string`, { stage: 'email-tools.validate', details: { field } })
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed
}

function int(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new ServiceError('invalid-input', `email: '${field}' must be an integer`, { stage: 'email-tools.validate', details: { field } })
  }
  return Math.floor(parsed)
}

function bool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ServiceError('invalid-input', `email: '${field}' must be a boolean`, { stage: 'email-tools.validate', details: { field } })
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  const text = str(value, field)
  if (text === undefined) return undefined
  if (!allowed.includes(text as T)) {
    throw new ServiceError('invalid-input', `email: '${field}' must be one of ${allowed.join(', ')}`, {
      stage: 'email-tools.validate',
      details: { field, allowed },
    })
  }
  return text as T
}

/** Applies a `since` bound (an ISO date or a relative age in seconds). */
function filterSince(messages: EmailSummary[], since?: string, maxAgeSeconds?: number): EmailSummary[] {
  const bound =
    maxAgeSeconds !== undefined
      ? Date.now() - maxAgeSeconds * 1000
      : since !== undefined
        ? Date.parse(since)
        : undefined
  if (bound === undefined || Number.isNaN(bound)) return messages
  return messages.filter((message) => {
    const date = Date.parse(message.date)
    return Number.isNaN(date) ? true : date >= bound
  })
}

/** Picks the body the caller asked for out of a message. */
function bodyOf(message: { text?: string; markdown?: string; raw?: string }, format: EmailFormat): string {
  if (format === 'markdown' && message.markdown !== undefined) return message.markdown
  if (format === 'raw' && message.raw !== undefined) return message.raw
  return message.text ?? message.raw ?? message.markdown ?? ''
}

/** Extracts a code with the caller's own pattern (group 1 when present). */
function extractWith(pattern: string, text: string): string | undefined {
  let regexp: RegExp
  try {
    regexp = new RegExp(pattern)
  } catch (error) {
    throw new ServiceError('invalid-input', `email: 'pattern' is not a valid regular expression: ${messageOf(error)}`, {
      stage: 'email-tools.validate',
      details: { pattern },
    })
  }
  const match = regexp.exec(text)
  if (match === null) return undefined
  return match[1] ?? match[0]
}

/** The tools this consumer registers, resolvable per call (provider swappable). */
export function tools(config: Config = {}, ctx: ServiceContext): Record<string, { description: string; parameters: ToolParameters; handler: (params: Record<string, unknown>) => unknown | Promise<unknown> }> {
  const defaultLimit = Math.min(config.defaultLimit ?? DEFAULT_LIMIT, MAX_LIMIT)

  return {
    'email accounts': {
      description:
        'Lists the configured email accounts (labels only; never a credential). format=labels answers the labels and the default account, format=full adds the address of each account.',
      parameters: {
        format: { type: 'string', description: 'labels (default) or full', enum: ['labels', 'full'] },
      },
      handler: async (params) => {
        const service = resolveEmailService(ctx)
        const format = oneOf(params.format, 'format', ['labels', 'full'] as const) ?? 'labels'
        const accounts = await service.accounts()
        const defaultAccount = accounts.find((account) => account.default === true)?.label
        if (format === 'labels') {
          return {
            count: accounts.length,
            ...(defaultAccount === undefined ? {} : { default: defaultAccount }),
            accounts: accounts.map((account) => account.label),
          }
        }
        return {
          count: accounts.length,
          ...(defaultAccount === undefined ? {} : { default: defaultAccount }),
          accounts: accounts.map((account) => ({
            label: account.label,
            ...(account.address === undefined ? {} : { address: account.address }),
            ...(account.default === true ? { default: true } : {}),
            ...(account.description === undefined ? {} : { description: account.description }),
          })),
        }
      },
    },
    'email list': {
      description:
        'Lists the most recent messages of a mailbox (default account when no account is given). Optional folder, query, limit, unreadOnly and since filters; the page is capped.',
      parameters: {
        account: { type: 'string', description: 'account label (default: the configured default account)' },
        folder: { type: 'string', description: 'mail folder (provider default when omitted)' },
        query: { type: 'string', description: 'backend search query, when the provider supports one' },
        limit: { type: 'integer', description: `max messages, 1..${MAX_LIMIT} (default ${defaultLimit})` },
        unreadOnly: { type: 'boolean', description: 'only unread messages' },
        since: { type: 'string', description: 'ISO date: only messages not older than this' },
      },
      handler: async (params) => {
        const service = resolveEmailService(ctx)
        const ref = emailRef(params.account) as EmailRef | undefined
        const limit = Math.min(Math.max(int(params.limit, 'limit') ?? defaultLimit, 1), MAX_LIMIT)
        const folder = str(params.folder, 'folder')
        const query = str(params.query, 'query')
        const unreadOnly = bool(params.unreadOnly, 'unreadOnly')
        const messages = await service.list(ref, {
          pageSize: limit,
          ...(folder === undefined ? {} : { folder }),
          ...(query === undefined ? {} : { query }),
          ...(unreadOnly === undefined ? {} : { unreadOnly }),
        })
        const filtered = filterSince(messages, str(params.since, 'since'), undefined)
        return {
          ...(ref === undefined ? {} : { account: ref.label }),
          count: filtered.length,
          messages: filtered.map((message) => ({
            id: message.id,
            subject: message.subject,
            from: message.from,
            to: message.to,
            date: message.date,
            unread: message.unread,
            ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
          })),
        }
      },
    },
    'email get': {
      description: 'Reads one message by id: the requested body format plus the sender, subject, date and attachment metadata.',
      parameters: {
        id: { type: 'string', description: 'message id from email list', required: true },
        account: { type: 'string', description: 'account label (default: the configured default account)' },
        folder: { type: 'string', description: 'mail folder (provider default when omitted)' },
        format: { type: 'string', description: 'body format (default text)', enum: ['text', 'markdown', 'raw'] },
      },
      handler: async (params) => {
        const service = resolveEmailService(ctx)
        const id = str(params.id, 'id', true) as string
        const ref = emailRef(params.account) as EmailRef | undefined
        const folder = str(params.folder, 'folder')
        const format = oneOf(params.format, 'format', ['text', 'markdown', 'raw'] as const) ?? 'text'
        const message = await service.get(ref, id, {
          format,
          ...(folder === undefined ? {} : { folder }),
        })
        return {
          id: message.id,
          subject: message.subject,
          from: message.from,
          to: message.to,
          date: message.date,
          format,
          body: bodyOf(message, format),
          attachments: message.attachments,
        }
      },
    },
    'email code': {
      description:
        'Finds the newest verification code in a mailbox. Pass id to read one known message, or query/from/scan to search recent ones; pattern overrides the built-in code patterns.',
      parameters: {
        account: { type: 'string', description: 'account label (default: the configured default account)' },
        folder: { type: 'string', description: 'mail folder (provider default when omitted)' },
        query: { type: 'string', description: 'backend search query, when the provider supports one' },
        from: { type: 'string', description: 'only messages whose sender contains this text' },
        id: { type: 'string', description: 'read this exact message id instead of scanning' },
        pattern: { type: 'string', description: 'regular expression overriding the code patterns (group 1 wins)' },
        scan: { type: 'integer', description: 'how many recent messages to scan (default 10)' },
        maxAgeSeconds: { type: 'integer', description: 'only messages not older than this many seconds' },
      },
      handler: async (params) => {
        const service = resolveEmailService(ctx)
        const ref = emailRef(params.account) as EmailRef | undefined
        const folder = str(params.folder, 'folder')
        const pattern = str(params.pattern, 'pattern')
        const id = str(params.id, 'id')
        const query = str(params.query, 'query')
        const from = str(params.from, 'from')
        const scan = Math.max(int(params.scan, 'scan') ?? 10, 1)
        const maxAgeSeconds = int(params.maxAgeSeconds, 'maxAgeSeconds')
        const folderOption = folder === undefined ? {} : { folder }
        const extract = (text: string): string | undefined => (pattern === undefined ? extractCode(text) : extractWith(pattern, text))

        if (id !== undefined) {
          const message = await service.get(ref, id, { format: 'text', ...folderOption })
          const text = [message.subject, bodyOf(message, 'text')].join('\n')
          const code = extract(text)
          if (code === undefined) {
            return { found: false, messageId: id, subject: message.subject, from: message.from, date: message.date }
          }
          return { found: true, code, messageId: id, subject: message.subject, from: message.from, date: message.date }
        }

        const list = await service.list(ref, {
          pageSize: Math.max(scan, 1),
          ...folderOption,
          ...(query === undefined ? {} : { query }),
        })
        const candidates = filterSince(list, undefined, maxAgeSeconds)
          .filter((message) => (from === undefined ? true : message.from.toLowerCase().includes(from.toLowerCase())))
          .slice(0, scan)
        for (const summary of candidates) {
          let text = [summary.subject, summary.snippet ?? ''].join('\n')
          if (extract(text) === undefined) {
            try {
              const message = await service.get(ref, summary.id, { format: 'text', ...folderOption })
              text = [message.subject, bodyOf(message, 'text')].join('\n')
            } catch {
              continue
            }
          }
          const code = extract(text)
          if (code !== undefined) {
            return {
              found: true,
              code,
              messageId: summary.id,
              subject: summary.subject,
              from: summary.from,
              date: summary.date,
            }
          }
        }
        let derived: EmailCode | undefined
        if (from === undefined && maxAgeSeconds === undefined && pattern === undefined) {
          derived = await derivedCode(service, ref, { scan, ...folderOption }).catch(() => undefined)
        }
        if (derived === undefined) return { found: false, scanned: candidates.length }
        return {
          found: true,
          code: derived.code,
          messageId: derived.message.id,
          subject: derived.message.subject,
          from: derived.message.from,
          date: derived.message.date,
        }
      },
    },
    'email send': {
      description:
        'Sends an email from the selected mailbox (default account when no account is given): required to, subject and body; optional cc, bcc, replyTo and html.',
      parameters: {
        to: { type: 'string', description: 'recipient address (comma separated for several)', required: true },
        subject: { type: 'string', description: 'message subject', required: true },
        body: { type: 'string', description: 'message body', required: true },
        account: { type: 'string', description: 'account label to send from (default: the configured default account)' },
        cc: { type: 'string', description: 'carbon copy recipients (comma separated)' },
        bcc: { type: 'string', description: 'blind carbon copy recipients (comma separated)' },
        replyTo: { type: 'string', description: 'reply-to address' },
        html: { type: 'boolean', description: 'send the body as HTML (default: plain text)' },
      },
      handler: async (params) => {
        const service = resolveEmailService(ctx)
        const to = str(params.to, 'to', true) as string
        const subject = str(params.subject, 'subject', true) as string
        const body = typeof params.body === 'string' ? params.body : ''
        if (body.trim().length === 0) {
          throw new ServiceError('invalid-input', "email: 'body' is required", { stage: 'email-tools.validate', details: { field: 'body' } })
        }
        const ref = emailRef(params.account) as EmailRef | undefined
        const cc = str(params.cc, 'cc')
        const bcc = str(params.bcc, 'bcc')
        const replyTo = str(params.replyTo, 'replyTo')
        const html = bool(params.html, 'html')
        const result = await service.send({
          to: to.split(',').map((entry) => entry.trim()).filter(Boolean),
          subject,
          body,
          ...(ref === undefined ? {} : { ref }),
          ...(cc === undefined ? {} : { cc: cc.split(',').map((entry) => entry.trim()).filter(Boolean) }),
          ...(bcc === undefined ? {} : { bcc: bcc.split(',').map((entry) => entry.trim()).filter(Boolean) }),
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(html === undefined ? {} : { html }),
        })
        return {
          ...(result.account === undefined ? {} : { account: result.account }),
          accepted: result.accepted,
          ...(result.output === undefined ? {} : { output: result.output }),
        }
      },
    },
  }
}

export function apply(ctx: EmailToolsContext, config: Config = {}): void {
  const registered = tools(config, ctx)
  const install = (): (() => void) => {
    const disposers = Object.entries(registered).map(([toolName, tool]) =>
      ctx.tools.register(defineTool({
        name: toolName,
        description: tool.description,
        parameters: tool.parameters,
        execute: tool.handler,
        output: { schema: {}, render: renderValue },
      })),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(install)
  else install()
}

export default { name, inject: ['tools'], apply }
