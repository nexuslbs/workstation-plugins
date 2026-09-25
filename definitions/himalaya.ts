// definitions/himalaya.ts - the `himalaya@1` SERVICE DEFINITION.
//
// The contract of the MAIL CLI plane: typed ACTIONS with typed OUTPUTS over the
// himalaya mail CLI (https://github.com/pimalaya/himalaya). It is deliberately
// transport agnostic: it says NOTHING about docker, ssh, paths or how himalaya
// is invoked - an implementation (core/himalaya-impl) owns that, and IT
// decides which transport runs himalaya.
//
//   - PROVIDERS implement {@link HimalayaService} and declare the capability
//     `{ "id": "himalaya", "version": 1, "provider": "<id>" }`
//     (core/himalaya-impl ships the provider `cli`).
//   - CONSUMERS (core/email-himalaya) inject the SERVICE and never learn
//     which transport or which binary answers.
//
// The typed surface is on PURPOSE small and closed:
//
//   accounts()                        -> Account[]      (himalaya `account list`)
//   folders({account?})               -> Folder[]       (`folder list`)
//   envelopeList({account?, folder?, pageSize?, query?}) -> Envelope[]  (`envelope list`)
//   messageRead({account?, id, noHeaders?})              -> { text }    (`message read`)
//   run({args})                       -> { output }     (escape hatch, argv STRING)
//
// `run` is the ESCAPE HATCH for commands the typed surface does not cover. Its
// `args` is built by plugin code from typed inputs, never taken verbatim from an
// agent/tool call: that boundary is documented in docs/SERVICES.md.
import {
  ServiceError,
  isRecord,
  requireService,
  serviceOf,
  str,
  type ServiceContext,
} from './support.ts'

/** Name of the service (`ctx.himalaya`). */
export const HIMALAYA = 'himalaya'

/** Contract version this definition speaks. */
export const HIMALAYA_VERSION = 1

/** Contract id including the version, e.g. `himalaya@1`. */
export const HIMALAYA_CONTRACT = `${HIMALAYA}@${HIMALAYA_VERSION}`

export const HIMALAYA_POLICY_PROVIDE = HIMALAYA_CONTRACT
export const HIMALAYA_POLICY_REQUIRE = HIMALAYA_CONTRACT

/**
 * The known himalaya CLI quirks an implementation MUST honour (they were
 * verified against himalaya v1.2.0 in the toolbox image; see docs/SERVICES.md):
 *   1. machine output is `-o json` (there is no `--json` flag);
 *   2. OPTIONS MUST PRECEDE THE POSITIONAL QUERY (`envelope list -o json INBOX`);
 *   3. `message read -o json` returns a JSON STRING (a quoted JSON document).
 */
export const HIMALAYA_QUIRKS = [
  "machine output is '-o json' (no '--json')",
  'options precede the positional query',
  "'message read -o json' returns a JSON string",
] as const

/** One himalaya account, as the CLI reports it (never a secret). */
export interface HimalayaAccount {
  name: string
  backend?: string
  default?: boolean
}

/** One folder of an account. */
export interface HimalayaFolder {
  name: string
}

/** One message header (`envelope list`). */
export interface HimalayaEnvelope {
  id: string
  flags: string[]
  subject: string
  from: string
  to: string
  date: string
  hasAttachment: boolean
}

/** One message body (`message read`). */
export interface HimalayaMessage {
  /** The message body as the CLI printed it (plain text, headers stripped). */
  text: string
  /** Raw JSON the CLI answered, when the caller wants to parse it itself. */
  raw?: string
}

export interface HimalayaAccountQuery {
  /** himalaya account name (`-a <name>`); omitted means the CLI default. */
  account?: string
}

export interface HimalayaFolderQuery extends HimalayaAccountQuery {}

export interface HimalayaEnvelopeQuery extends HimalayaAccountQuery {
  /** Folder/mailbox to list (positional; default the account's INBOX). */
  folder?: string
  /** Max messages to fetch (bounded by the implementation). */
  pageSize?: number
  /**
   * Optional search query (himalaya's search syntax, e.g. `from acme`). When
   * present it is the LAST positional argument (options precede it).
   */
  query?: string
}

export interface HimalayaMessageQuery extends HimalayaAccountQuery {
  /** Envelope id to read. */
  id: string
  /** Ask the CLI for the body only (`--no-headers`). */
  noHeaders?: boolean
  folder?: string
}

export interface HimalayaRunInput {
  /**
   * A himalaya ARGV FRAGMENT (everything AFTER the himalaya binary), built by
   * plugin code from typed inputs and already shell-quoted where needed. The
   * binary (and the account flag below) are prepended by the implementation, so
   * the command line the transport executes is complete.
   */
  args: string
  /**
   * Optional account (`-a <name>`). himalaya v1.2 takes the flag at the
   * SUBCOMMAND level, so the implementation places it in the subcommand option
   * list (after `<command> <subcommand>`, before the positional query) and
   * never as a global option before the command.
   */
  account?: string
}

export interface HimalayaRunResult {
  output: string
  code: number | null
}

/** The instance-style handle a consumer gets from `create(config)`. */
export interface HimalayaInstance {
  readonly contract: typeof HIMALAYA_CONTRACT
  readonly provider: string
  accounts(): Promise<HimalayaAccount[]>
  folders(query?: HimalayaFolderQuery): Promise<HimalayaFolder[]>
  envelopeList(query?: HimalayaEnvelopeQuery): Promise<HimalayaEnvelope[]>
  messageRead(query: HimalayaMessageQuery): Promise<HimalayaMessage>
  run(input: HimalayaRunInput): Promise<HimalayaRunResult>
}

/** What a `himalaya@1` provider must offer. */
export interface HimalayaService extends HimalayaInstance {
  describe?(): string
  /** Instance-style: binds a config now (validated) instead of on every call. */
  create?(config?: unknown): HimalayaInstance
}

/** Validates an account name (a label, never a value). */
export function himalayaAccount(value: unknown, field = 'account'): string | undefined {
  const account = str(value)
  if (account === undefined) return undefined
  if (/[\s'"]/.test(account)) {
    throw new ServiceError('invalid-config', `himalaya: '${field}' must be a plain account name`, {
      stage: 'himalaya.validate',
      details: { field },
    })
  }
  return account
}

/** Validates an envelope id (digits or a bounded token: never an argv injection). */
export function himalayaMessageId(value: unknown): string {
  const id = str(value)
  if (id === undefined) {
    throw new ServiceError('invalid-input', 'himalaya: an envelope id is required', { stage: 'himalaya.validate' })
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
    throw new ServiceError('invalid-input', `himalaya: invalid envelope id '${id}'`, {
      stage: 'himalaya.validate',
      details: { id },
    })
  }
  return id
}

/** Validates a folder name (a mailbox token, never an argv fragment). */
export function himalayaFolder(value: unknown): string | undefined {
  const folder = str(value)
  if (folder === undefined) return undefined
  if (/['"\n\r]/.test(folder)) {
    throw new ServiceError('invalid-input', `himalaya: invalid folder name '${folder}'`, {
      stage: 'himalaya.validate',
    })
  }
  return folder
}

/** Validates the shape of a typed query object. */
export function assertRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new ServiceError('invalid-input', `himalaya: ${what} must be an object`, { stage: 'himalaya.validate' })
  }
  return value
}

/** The `himalaya@1` service of this deployment, when one is loaded. */
export function serviceOfHimalaya(ctx: ServiceContext): HimalayaService | undefined {
  return serviceOf<HimalayaService>(ctx, HIMALAYA)
}

/** The `himalaya@1` service, or a structured `missing-service` error naming it. */
export function requireHimalaya(ctx: ServiceContext, hint?: string): HimalayaService {
  return requireService<HimalayaService>(
    ctx,
    HIMALAYA,
    hint ?? 'the mail service is not loaded: enable core/himalaya-impl (a plugin providing himalaya@1)',
  )
}
