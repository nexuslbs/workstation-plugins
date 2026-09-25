// core/himalaya-impl - the `himalaya@1` PROVIDER (`cli`): typed mail actions
// over the himalaya CLI, driven THROUGH the general service.
//
// It shells out to NOTHING itself: it injects `general-service@1`, and the
// transport himalaya runs in (a container of the current stack, a remote
// machine, a local binary) is CONFIG - not code:
//
//   config: { general: { type: 'container', params: {
//     engine: 'docker-compose',
//     compose: { project_dir: '${env:OMNI_DIR}', service: 'toolbox' } } } }
//
// The plugin names no image, no host and no project dir of its own: they come
// from the config row (omni-root `config/workbench.yml` in the stack, the
// plugins-repo `config.yml` in development).
//
// The typed actions of the Definition are converted into a himalaya ARGV STRING
// (every value single-quoted, so spaces/quotes survive), sent to the general
// service, and the returned string is parsed back into the typed output. The
// himalaya CLI quirks are honoured here (they are the CLI's, not the
// Definition's): `-o json`, OPTIONS BEFORE THE POSITIONAL QUERY, and
// `message read -o json` returning a JSON STRING.
//
// NOT CONFIGURED is a valid state: with no `general` config the plugin loads,
// logs the reason and provides nothing; a call then answers a structured
// `not-configured` error. It never appears under `failures`.
import { loggerOf } from '../../definitions/logger.ts'
import {
  HIMALAYA,
  HIMALAYA_CONTRACT,
  himalayaAccount,
  himalayaFolder,
  himalayaMessageId,
  type HimalayaAccount,
  type HimalayaEnvelope,
  type HimalayaEnvelopeQuery,
  type HimalayaFolder,
  type HimalayaFolderQuery,
  type HimalayaInstance,
  type HimalayaMessage,
  type HimalayaMessageQuery,
  type HimalayaRunInput,
  type HimalayaRunResult,
  type HimalayaService,
} from '../../definitions/himalaya.ts'
import {
  GENERAL_SERVICE,
  serviceOfGeneralService,
  type GeneralService,
  type GeneralServiceConfig,
  type GeneralServiceInstance,
} from '../../definitions/general-service.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  messageOf,
  provideService,
  shellQuote,
  waitForServices,
  type ServiceContext,
} from '../../definitions/support.ts'

export const name = 'himalaya-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'cli'

export const contract = HIMALAYA_CONTRACT

/** Default bound of the soft wait for the general service (ms). */
export const DEFAULT_GENERAL_WAIT_MS = 1500

/** Largest page the driver ever asks himalaya for. */
export const MAX_FETCH = 200

export interface HimalayaImplConfig {
  /** The transport himalaya runs in: a `general-service@1` config. */
  general?: GeneralServiceConfig
  /**
   * The himalaya COMMAND the transport runs (default 'himalaya'). A plain name
   * or an absolute path (e.g. a binary outside the PATH of the target), never a
   * credential value.
   */
  binary?: string
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number
  /** Bound of the soft wait for the general service (ms). */
  generalWaitMs?: number
}

/** The himalaya command an argv line starts with. */
export const DEFAULT_BINARY = 'himalaya'

/** Validates the configured binary token (a command name or an absolute path). */
export function himalayaBinary(value: unknown, field = 'binary'): string {
  if (value === undefined || value === null || value === '') return DEFAULT_BINARY
  const binary = typeof value === 'string' ? value.trim() : ''
  if (binary.length === 0) return DEFAULT_BINARY
  if (!/^[A-Za-z0-9_./:@+-]+$/.test(binary)) {
    throw new ServiceError('invalid-config', `himalaya: '${field}' must be a plain command name or path`, {
      stage: 'himalaya.config',
      details: { field },
    })
  }
  return binary
}

/** Plain tokens the target shell cannot mangle: they travel unquoted. */
const SAFE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/

/** Quotes a token only when the target shell would otherwise change it. */
export function word(value: string): string {
  return SAFE_WORD.test(value) ? value : shellQuote(value)
}

/** The `<command> <subcommand>` words every typed himalaya command starts with. */
const SUBCOMMAND_WORDS = 2

/**
 * himalaya v1.2 declares `-a/--account` on the SUBCOMMANDS, not globally:
 * `himalaya -a x envelope list` is rejected with `unexpected argument '-a'
 * found`, while `himalaya envelope list -a x -o json` works. A subcommand's
 * options PRECEDE its positional query, so the flag is inserted right AFTER the
 * `<command> <subcommand>` words and before the rest of the option list.
 */
export function withAccount(args: readonly string[], account?: string): string[] {
  const list = [...args]
  if (account === undefined) return list
  const at = Math.min(SUBCOMMAND_WORDS, list.length)
  return [...list.slice(0, at), '-a', account, ...list.slice(at)]
}

/**
 * Assembles a himalaya COMMAND LINE from already-validated pieces. The line
 * STARTS WITH THE HIMALAYA BINARY: the general service hands the input to the
 * shell of the TARGET (container / ssh'd machine) exactly once, so the input
 * must be a complete command there - a bare `account list -o json` is not.
 * Every token is quoted only when the target shell would change it.
 */
export function buildArgv(parts: { binary?: string; account?: string; args: readonly string[] }): string {
  const argv = withAccount(parts.args, parts.account).map((part) => word(part))
  return `${himalayaBinary(parts.binary)} ${argv.join(' ')}`.trim()
}

/**
 * The command line of the ESCAPE HATCH: `args` is an ALREADY-BUILT, already
 * quoted ARGV FRAGMENT (everything AFTER the binary), so it is appended
 * verbatim; only the binary and the account flag are added here - the flag goes
 * into the SUBCOMMAND option list (see `withAccount`), before the positionals.
 */
export function buildRunArgv(parts: { binary?: string; account?: string; args: string }): string {
  const binary = himalayaBinary(parts.binary)
  if (parts.account === undefined) return `${binary} ${parts.args}`.trim()
  const flag = `-a ${word(parts.account)}`
  const match = /^\s*(\S+)\s+(\S+)([\s\S]*)$/.exec(parts.args)
  if (match === null) return `${binary} ${flag} ${parts.args}`.trim()
  return `${binary} ${match[1]} ${match[2]} ${flag}${match[3]}`
}

/** Parses a himalaya `-o json` answer (a JSON document or a JSON string). */
export function parseJson(output: string, what: string): unknown {
  const text = output.trim()
  if (text.length === 0) {
    throw new ServiceError('malformed-output', `himalaya: empty answer for ${what}`, { stage: 'himalaya.parse' })
  }
  try {
    const first = JSON.parse(text) as unknown
    // `message read -o json` answers a JSON STRING containing a JSON document.
    if (typeof first === 'string') return JSON.parse(first)
    return first
  } catch (error) {
    throw new ServiceError('malformed-output', `himalaya: cannot parse the ${what} answer: ${messageOf(error)}`, {
      stage: 'himalaya.parse',
      details: { what, sample: text.slice(0, 200) },
    })
  }
}

function asArray(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  throw new ServiceError('malformed-output', `himalaya: ${what} expects a JSON array`, {
    stage: 'himalaya.parse',
    details: { what, got: typeof value },
  })
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new ServiceError('malformed-output', `himalaya: ${what} expects a JSON object`, {
    stage: 'himalaya.parse',
    details: { what, got: typeof value },
  })
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Maps one himalaya envelope (the CLI's own JSON shape) to the Definition's. */
export function toEnvelope(raw: unknown): HimalayaEnvelope {
  const record = asRecord(raw, "an 'envelope list' entry")
  const flagsRaw = record.flags ?? record['flags']
  const flags = Array.isArray(flagsRaw) ? flagsRaw.map((flag) => text(flag)) : text(flagsRaw).length > 0 ? [text(flagsRaw)] : []
  return {
    id: text(record.id ?? record['uid']),
    flags,
    subject: text(record.subject),
    from: text((record.from as Record<string, unknown> | undefined)?.addr ?? record.from),
    to: text(
      Array.isArray(record.to)
        ? (record.to as Record<string, unknown>[]).map((entry) => text(entry.addr ?? entry.name)).filter(Boolean).join(', ')
        : (record.to as Record<string, unknown> | undefined)?.addr ?? record.to,
    ),
    date: text(record.date),
    hasAttachment: Array.isArray(record.attachments) ? (record.attachments as unknown[]).length > 0 : false,
  }
}

/** The `himalaya@1` service bound to ONE general-service instance. */
export function createHimalayaService(
  general: GeneralServiceInstance | (() => GeneralServiceInstance),
  options: { binary?: string } = {},
): HimalayaService {
  const binary = himalayaBinary(options.binary)
  // A FUNCTION means "resolve the instance on first need": the general-service
  // instance is then created at CALL time rather than at load (see createLateBinding).
  const target = (): GeneralServiceInstance => (typeof general === 'function' ? general() : general)

  const invoke = async (argv: string, label: string, account?: string): Promise<string> => {
    const result = await target().call(argv)
    if (result.code !== 0) {
      throw new ServiceError('non-zero-exit', `himalaya: '${label}' exited ${String(result.code)}: ${(result.stderr ?? result.output).trim().slice(0, 400)}`, {
        stage: 'himalaya.call',
        details: { label, code: result.code, account: account ?? null },
      })
    }
    return result.output
  }

  /** Typed path: the pieces are assembled into a COMPLETE command line. */
  const call = (args: readonly string[], account?: string): Promise<string> =>
    invoke(buildArgv({ binary, ...(account === undefined ? {} : { account }), args }), args.join(' '), account)

  /** ESCAPE HATCH: `args` is an argv fragment (everything after the binary). */
  const callRaw = (args: string, account?: string): Promise<string> =>
    invoke(buildRunArgv({ binary, ...(account === undefined ? {} : { account }), args }), args, account)

  const service: HimalayaInstance = {
    contract: HIMALAYA_CONTRACT,
    provider: providerId,
    accounts: async (): Promise<HimalayaAccount[]> => {
      const parsed = parseJson(await call(['account', 'list', '-o', 'json']), 'account list')
      return asArray(parsed, 'account list').map((entry) => {
        const record = asRecord(entry, 'an account entry')
        return {
          name: text(record.name),
          backend: text(record.backend),
          default: record.default === true,
        }
      })
    },
    folders: async (query: HimalayaFolderQuery = {}): Promise<HimalayaFolder[]> => {
      const account = himalayaAccount(query.account)
      const parsed = parseJson(await call(['folder', 'list', '-o', 'json'], account), 'folder list')
      return asArray(parsed, 'folder list').map((entry) => ({
        name: typeof entry === 'string' ? entry : text(asRecord(entry, 'a folder entry').name),
      }))
    },
    envelopeList: async (query: HimalayaEnvelopeQuery = {}): Promise<HimalayaEnvelope[]> => {
      const account = himalayaAccount(query.account)
      const folder = himalayaFolder(query.folder)
      const args: string[] = ['envelope', 'list', '-o', 'json']
      const pageSize = query.pageSize === undefined ? MAX_FETCH : Math.min(Math.max(1, Math.floor(query.pageSize)), MAX_FETCH)
      args.push('--page-size', String(pageSize))
      if (folder !== undefined) args.push(folder)
      // OPTIONS BEFORE THE POSITIONAL QUERY (himalaya quirk 2).
      if (query.query !== undefined && query.query.trim().length > 0) args.push(query.query.trim())
      const parsed = parseJson(await call(args, account), 'envelope list')
      return asArray(parsed, 'envelope list').map((entry) => toEnvelope(entry))
    },
    messageRead: async (query: HimalayaMessageQuery): Promise<HimalayaMessage> => {
      const id = himalayaMessageId(query.id)
      const account = himalayaAccount(query.account)
      const folder = himalayaFolder(query.folder)
      const args: string[] = ['message', 'read', '-o', 'json']
      if (query.noHeaders === true) args.push('--no-headers')
      if (folder !== undefined) args.push('--folder', folder)
      args.push(id)
      const raw = await call(args, account)
      let parsed: unknown
      try {
        parsed = parseJson(raw, 'message read')
      } catch {
        // The CLI answered plain text: honour it rather than failing the read.
        return { text: raw }
      }
      if (typeof parsed === 'string') return { text: parsed, raw: raw.trim() }
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        return { text: text(record.text ?? record.body ?? record.content), raw: raw.trim() }
      }
      return { text: raw }
    },
    run: async (input: HimalayaRunInput): Promise<HimalayaRunResult> => {
      const account = himalayaAccount(input.account)
      const output = await callRaw(input.args, account)
      return { output, code: 0 }
    },
  }
  return service
}

/** The service a consumer sees: configured, or a structured not-configured one. */
export function createNotConfiguredService(reason: string): HimalayaService {
  const fail = (): never => {
    throw new ServiceError('not-configured', `himalaya: ${reason}`, { stage: 'himalaya.apply' })
  }
  return {
    contract: HIMALAYA_CONTRACT,
    provider: providerId,
    describe: () => `not configured (${reason})`,
    accounts: async () => fail(),
    folders: async () => fail(),
    envelopeList: async () => fail(),
    messageRead: async () => fail(),
    run: async () => fail(),
  }
}

/**
 * Instance-style binding that tolerates a LATE-arriving transport.
 *
 * The core loader is SEQUENTIAL and walks the plugin directories of a source in
 * SORTED order (`workbench/src/loader.ts`: `discoverPluginDirs(...).sort()` then
 * `for (const discovery of ...) await loadDiscovered(...)`), so a transport
 * provider whose plugin directory sorts AFTER this one is simply not loaded yet
 * when `apply()` runs - the same reality `email-himalaya` handles by resolving
 * the himalaya service at CALL time. The FIRST attempt happens at load, so the
 * config is validated before any call and a transport that is genuinely ABSENT
 * is reported then; but it is not fatal: every call retries the factory, so a
 * provider that loads milliseconds later is picked up, while a missing one keeps
 * failing with the SAME named error. No fallback transport, no host run.
 */
export interface LateBinding {
  /** The bound instance; creates it on first need and throws the create error when it cannot. */
  instance(): GeneralServiceInstance
  /** The first create error while unbound (null once bound) - the load-time report. */
  error(): unknown
}

/** Wraps a general-service instance FACTORY in the retrying binding above. */
export function createLateBinding(factory: () => GeneralServiceInstance): LateBinding {
  let bound: GeneralServiceInstance | undefined
  let firstError: unknown
  return {
    instance: (): GeneralServiceInstance => {
      if (bound !== undefined) return bound
      try {
        bound = factory()
      } catch (error) {
        firstError = error
        throw error
      }
      return bound
    },
    error: () => (bound === undefined ? firstError : null),
  }
}

export async function apply(ctx: ServiceContext, config: HimalayaImplConfig = {}): Promise<void> {
  assertPolicyDeclared(import.meta.url, { execution: 'remote', capabilities: [HIMALAYA] })
  if (config.general === undefined) {
    provideService(ctx, HIMALAYA, createNotConfiguredService('no `general` transport configured for himalaya'))
    loggerOf(ctx, name).info('not configured (no `general` config row): calls answer a structured error')
    return
  }
  // SOFT, BOUNDED ordering hint: the general service is the transport selector.
  await waitForServices(ctx, [GENERAL_SERVICE], {
    timeoutMs: config.generalWaitMs ?? DEFAULT_GENERAL_WAIT_MS,
    pollMs: 25,
  })
  const general: GeneralService | undefined = serviceOfGeneralService(ctx)
  if (general === undefined) {
    // The GENERAL SERVICE being absent is NOT a load failure (R4-11): report
    // loaded/not-configured and answer calls with a structured error.
    provideService(
      ctx,
      HIMALAYA,
      createNotConfiguredService(`the '${GENERAL_SERVICE}' service is not loaded (enable core/general-service-impl)`),
    )
    loggerOf(ctx, name).error(`not configured (the '${GENERAL_SERVICE}' service is not loaded); calls answer a structured error`)
    return
  }
  const transport = config.general
  // Instance-style: the transport is validated HERE, at load, BEFORE any call
  // (a type whose service is missing fails the creation - never a fallback), but
  // the binding is RETRIED per call so a provider that loads LATER is picked up
  // while an absent capability keeps failing with the same named error.
  const binding = createLateBinding(() => general.create(transport))
  try {
    binding.instance()
  } catch (error) {
    loggerOf(ctx, name).error(
      `the configured '${String(transport.type)}' transport is not ready (${messageOf(error)}); ` +
        'the general-service instance is re-created on the next call - a provider that loads later is picked up, ' +
        'a missing capability keeps failing with this error (never a host fallback)',
    )
  }
  provideService(ctx, HIMALAYA, createHimalayaService(() => binding.instance(), { binary: config.binary }))
}

export default { name, inject: [], apply }
