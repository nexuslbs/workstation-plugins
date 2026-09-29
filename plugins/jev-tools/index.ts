// External workstation plugin: JEV (TypeSafe "System One") as dsh TOOLS.
//
// Jev is TypeSafe's flagship System One model (https://docs.typesafe.ai): it does
// not generate text, it answers TYPED questions about a piece of `state` and
// returns calibrated probabilities/confidence a caller can branch on in code.
// The only public surface is ONE HTTP endpoint:
//
//   POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer <API_KEY>
//   { state, model: "jev-latest", questions: { <id>: Question } }
//   -> { model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }
//
// This plugin exposes that endpoint as native dsh tools (`ctx.tools.register` +
// `defineTool`, typed parameter maps, `output.render` = `renderValue`), so a dsh
// agent (any role profile) can make a STRUCTURED decision instead of a free-text
// judgement: `jev_noul` (yes/no probability), `jev_choice` (one option out of a
// closed set + the full distribution), `jev_score` (an ordered rubric level),
// `jev_batch` (several questions in ONE call, the speculative fan-out pattern)
// and `jev status` (introspection: is the credential defined).
//
// CREDENTIAL-GATED BY DESIGN (the operator's requirement: "the agents should not
// see Jev yet, but the plugin should be ready to use once the Jev credentials are
// defined"). Two independent gates, both implemented here:
//
//   (a) THE ROW IS NOT IN THE ROSTER. `plugins/jev-tools` is not a row of
//       config/workstation.yml yet, so the service never loads it. Activation is
//       ONE live call: `POST /api/tool/call {"tool":"plugin_add","params":{
//       "id":"jev-tools","layer":"config", ...}}` (no container restart).
//   (b) THE PLUGIN REGISTERS NOTHING WITHOUT ITS CREDENTIAL. `apply` resolves the
//       credential NAME (default `JEV_API_KEY`) through the harness credentials
//       service BEFORE registering any tool: unresolved -> ZERO tools are
//       registered and the reason is logged. So even a row that IS mounted while
//       the credential is missing stays invisible to every agent.
//
// The credential is a NAME, never a value: values live in the dsh credential
// store ($DSH_HOME/.credentials.yaml) and are resolved at CALL time; this file
// never sees, prints or persists one. Every failure path answers a TYPED body
// (`{ ok: false, error: { reason, code, stage, message, details } }`) instead of
// throwing, so the reason survives the tools seam and a caller can branch on it
// (in particular `jev.credentials-missing`, which is raised WITHOUT attempting
// any network call).

import { appendFileSync } from 'node:fs'

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'jev-tools'

/** Where the credential NAME may come from (names only, never values). */
export interface Config {
  /** Credential NAME resolved at call time (default `JEV_API_KEY`). */
  credential?: string
  /** TypeSafe API root (default `https://api.typesafe.ai`). */
  baseUrl?: string
  /** Default model (default `jev-latest`; see https://docs.typesafe.ai/models). */
  model?: string
  /** One HTTP round trip bound, milliseconds (default 60000, bounded 1000..600000). */
  timeoutMs?: number
  /** Refuse a `state` larger than this many chars (default 200000). */
  maxStateChars?: number
  /**
   * Visibility gate.
   * `credential` (default): tools are registered ONLY when the credential NAME
   * resolves; without it the plugin registers NOTHING (agents do not see Jev).
   * `always`: diagnostic/verification mode - the tools are registered even with
   * no credential, and every call answers the typed `jev.credentials-missing`
   * error. Use it to PROVE the credential-missing path without a real key; never
   * as the resting state.
   */
  gate?: 'credential' | 'always'
  /**
   * Optional diagnostic log file. When set, the plugin appends one line per gate
   * decision and per tool call (pid, credential NAME, whether it resolved, the
   * number of tools registered) so an operator can see WHY a tool is invisible.
   * It never contains a credential value.
   */
  debugLog?: string
}

/** The dsh credential resolution result (values are never logged). */
interface ResolvedCredential {
  value: string
  source?: string
}

/** The consumer slice of the harness `credentials@1` service. */
interface CredentialsLike {
  /**
   * Resolves a credential REFERENCE. The harness takes the NAME as a STRING
   * (see the sibling providers of this repository, e.g. `core/sms-twilio`:
   * `credentials.resolve(credentialNameOf(raw))`); the object form is kept as a
   * fallback for a provider that speaks `CredentialRef` instead.
   */
  resolve(ref: unknown): Promise<ResolvedCredential | undefined>
  list?(): Promise<string[]>
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
  credentials?: CredentialsLike
  get?(name: string, strict?: boolean): unknown
}

const DEFAULT_CREDENTIAL = 'JEV_API_KEY'
const DEFAULT_BASE_URL = 'https://api.typesafe.ai'
const DEFAULT_MODEL = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_STATE_CHARS = 200000
const SYSTEMONE_PATH = '/v1/systemone'
/** Jev answers a Score on an ordered rubric: 2..10 levels (TypeSafe API doc). */
const SCORE_MIN_LEVELS = 2
const SCORE_MAX_LEVELS = 10
/** The API caps a Choice at 255 options (TypeSafe API doc). */
const CHOICE_MAX_OPTIONS = 255

/** A trimmed non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A whole number, or `undefined`. */
function int(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

/**
 * The typed failure body every tool answers (never a throw, never a stack).
 * `reason` is the stable machine-readable code a caller branches on.
 */
function failure(reason: string, code: string, stage: string, message: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, error: { reason, code, stage, message, details } }
}

/** The credential-missing answer: NO network call was attempted. */
function missingCredential(credential: string, gate: string): Record<string, unknown> {
  return failure(
    'jev.credentials-missing',
    'missing-credential',
    'credentials',
    `the '${credential}' credential is not defined in the dsh credential store, so no Jev call was attempted`,
    {
      credential,
      gate,
      fix: `define the '${credential}' credential NAME in $DSH_HOME/.credentials.yaml (value never in this repo), then mount the row: plugin_add --layer config`,
    },
  )
}

/** A short, value-free rendering of an upstream error body. */
function upstreamMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body.replace(/\s+/g, ' ').trim().slice(0, 500) || fallback
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>
    for (const key of ['error', 'message', 'detail', 'description']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value.replace(/\s+/g, ' ').trim().slice(0, 500)
      if (value !== null && typeof value === 'object') return JSON.stringify(value).slice(0, 500)
    }
    try {
      return JSON.stringify(record).slice(0, 500)
    } catch {
      return fallback
    }
  }
  return fallback
}

/** The credentials service of the deployment, or undefined. */
function credentialsOf(ctx: PluginContext): CredentialsLike | undefined {
  try {
    const direct = ctx.credentials
    if (direct !== undefined && direct !== null && typeof direct.resolve === 'function') return direct
  } catch {
    /* a strict service access can throw when the provider is absent */
  }
  if (typeof ctx.get !== 'function') return undefined
  try {
    const viaLookup = ctx.get('credentials', false) as CredentialsLike | undefined
    if (viaLookup !== undefined && viaLookup !== null && typeof viaLookup.resolve === 'function') return viaLookup
  } catch {
    /* not available */
  }
  return undefined
}

/**
 * Resolves the credential NAME. Returns the VALUE (which callers must never log)
 * or `undefined` when the store/its provider cannot answer.
 */
async function credentialValue(credentials: CredentialsLike | undefined, name: string, onError?: (message: string) => void): Promise<string | undefined> {
  if (credentials === undefined) return undefined
  // The harness resolves a NAME STRING first (that is how every sibling provider
  // of this repository calls it); a provider that only speaks the `CredentialRef`
  // object form is still served by the fallback. An unresolved name is NOT an
  // error: it is the gate's closed state.
  try {
    const byName = await credentials.resolve(name)
    const value = typeof byName?.value === 'string' ? byName.value : undefined
    if (value !== undefined && value.length > 0) return value
  } catch (error) {
    onError?.(`credential resolve('${name}') threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  try {
    const byRef = await credentials.resolve({ name })
    const value = typeof byRef?.value === 'string' ? byRef.value : undefined
    return value !== undefined && value.length > 0 ? value : undefined
  } catch (error) {
    onError?.(`credential resolve({ name: '${name}' }) threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The questions/state builders (`Question` shapes of the TypeSafe API).
// ---------------------------------------------------------------------------

/** One Question as the API accepts it (`type` + `instructions` + `criteria`). */
type Question = Record<string, unknown>

/** A Noul (yes/no) question. */
function noulQuestion(instructions: unknown, criteria?: { yes?: unknown; no?: unknown }): Question {
  const question: Question = { type: 'noul', instructions }
  const trueCriteria = criteria?.yes
  const falseCriteria = criteria?.no
  if (trueCriteria !== undefined || falseCriteria !== undefined) {
    question.criteria = {
      ...(trueCriteria === undefined ? {} : { true: trueCriteria }),
      ...(falseCriteria === undefined ? {} : { false: falseCriteria }),
    }
  }
  return question
}

/** A Choice question: a closed option set, each option with its rubric description. */
function choiceQuestion(instructions: unknown, criteria: Record<string, unknown>): Question {
  return { type: 'choice', instructions, criteria }
}

/** A Score question: an ORDERED rubric of 2..10 levels. */
function scoreQuestion(instructions: unknown, criteria: unknown[]): Question {
  return { type: 'score', instructions, criteria }
}

/** True for a plain object (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accepts a structured value DIRECTLY (the facade plane can pass an object or an
 * array) or as a JSON STRING. The string form is the ONLY one a MODEL can use:
 * the chat API validates every tool schema and rejects the DSH `json` parameter
 * KIND (`Invalid schema for function 'jev_batch': "json" is not valid under any
 * of the schemas listed in the 'anyOf' keyword`), so every structured parameter
 * is declared `string` and parsed here. A non-JSON-looking string is passed
 * through untouched (it is plain text state or a plain instruction).
 */
function jsonOf(value: unknown, where: string): { ok: true; value: unknown } | { ok: false; body: Record<string, unknown> } {
  if (typeof value !== 'string') return { ok: true, value }
  const text = value.trim()
  if (text.length === 0) return { ok: true, value }
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch (error) {
      return {
        ok: false,
        body: failure('jev.invalid-arguments', 'invalid-arguments', where, `the JSON string is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { value: text.slice(0, 200) }),
      }
    }
  }
  return { ok: true, value }
}

/**
 * The `criteria` map of a Choice: an object `{ option: description|null }`, or an
 * array of option names (accepted as a shorthand: every option gets `null`).
 */
function choiceCriteriaOf(rawInput: unknown, where: string): { ok: true; criteria: Record<string, unknown> } | { ok: false; body: Record<string, unknown> } {
  const parsedInput = jsonOf(rawInput, where)
  if (!parsedInput.ok) return parsedInput
  const raw = parsedInput.value
  if (Array.isArray(raw)) {
    const criteria: Record<string, unknown> = {}
    for (const entry of raw) {
      const option = str(entry)
      if (option === undefined) {
        return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, "every entry of 'options' must be a non-empty string", { options: raw }) }
      }
      criteria[option] = null
    }
    if (Object.keys(criteria).length < 2) {
      return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, "'options' must list at least 2 options", { options: raw }) }
    }
    return { ok: true, criteria }
  }
  if (isPlainObject(raw)) {
    if (Object.keys(raw).length < 2) {
      return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, "'options' must define at least 2 options", { options: raw }) }
    }
    if (Object.keys(raw).length > CHOICE_MAX_OPTIONS) {
      return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, `a Choice takes at most ${CHOICE_MAX_OPTIONS} options`, { count: Object.keys(raw).length }) }
    }
    return { ok: true, criteria: raw }
  }
  return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, "'options' must be an object { option: description|null } or an array of option names", { options: raw }) }
}

/** The `criteria` array of a Score: 2..10 ordered level descriptions. */
function scoreCriteriaOf(rawInput: unknown, where: string): { ok: true; criteria: unknown[] } | { ok: false; body: Record<string, unknown> } {
  const parsedInput = jsonOf(rawInput, where)
  if (!parsedInput.ok) return parsedInput
  const raw = parsedInput.value
  if (!Array.isArray(raw)) {
    return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, "'levels' must be an ARRAY of ordered level descriptions", { levels: raw }) }
  }
  if (raw.length < SCORE_MIN_LEVELS || raw.length > SCORE_MAX_LEVELS) {
    return { ok: false, body: failure('jev.invalid-arguments', 'invalid-arguments', where, `a Score takes between ${SCORE_MIN_LEVELS} and ${SCORE_MAX_LEVELS} levels`, { count: raw.length }) }
  }
  return { ok: true, criteria: raw }
}

// ---------------------------------------------------------------------------
// The HTTP call.
// ---------------------------------------------------------------------------

interface CallSettings {
  baseUrl: string
  model: string
  timeoutMs: number
  maxStateChars: number
}

/** ONE TypeSafe System One call; a typed body on any failure (never a throw). */
async function callSystemOne(
  settings: CallSettings,
  apiKey: string,
  state: unknown,
  questions: Record<string, Question>,
): Promise<Record<string, unknown>> {
  let payload: string
  try {
    payload = JSON.stringify({ state, model: settings.model, questions })
  } catch (error) {
    return failure('jev.invalid-arguments', 'invalid-arguments', 'request', `'state'/'questions' are not JSON serializable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const stateChars = JSON.stringify(state ?? null)?.length ?? 0
  if (stateChars > settings.maxStateChars) {
    return failure('jev.invalid-arguments', 'invalid-arguments', 'request', `'state' is ${stateChars} chars, above the ${settings.maxStateChars} cap`, { stateChars, maxStateChars: settings.maxStateChars })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  const url = `${settings.baseUrl.replace(/\/+$/, '')}${SYSTEMONE_PATH}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: payload,
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    return failure(
      aborted ? 'jev.timeout' : 'jev.transport-error',
      aborted ? 'timeout' : 'transport-error',
      'http',
      aborted
        ? `the TypeSafe API did not answer within ${settings.timeoutMs} ms`
        : `the TypeSafe API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      { url, method: 'POST', timeoutMs: settings.timeoutMs },
    )
  } finally {
    clearTimeout(timer)
  }

  const raw = await response.text().catch(() => '')
  let body: unknown = raw
  try {
    body = raw.length === 0 ? undefined : JSON.parse(raw)
  } catch {
    body = raw
  }

  if (!response.ok) {
    const status = response.status
    const mapped = status === 401 || status === 403
      ? ['jev.unauthorized', 'unauthorized', 'the TypeSafe API rejected the API key (Authorization header)']
      : status === 422
        ? ['jev.invalid-request', 'invalid-request', 'the TypeSafe API rejected the request body (malformed question or missing field)']
        : status === 429
          ? ['jev.rate-limited', 'rate-limited', 'the TypeSafe API rate limit was exceeded; retry with backoff']
          : status === 529
            ? ['jev.overloaded', 'overloaded', 'the TypeSafe API is temporarily overloaded; retry shortly']
            : ['jev.upstream-error', 'upstream-error', `the TypeSafe API answered HTTP ${status}`]
    return failure(mapped[0], mapped[1], 'upstream', mapped[2], {
      httpStatus: status,
      upstream: upstreamMessage(body, raw.slice(0, 500)),
    })
  }

  if (!isPlainObject(body)) {
    return failure('jev.invalid-response', 'invalid-response', 'response', 'the TypeSafe API answered a non-object body', { body: raw.slice(0, 500) })
  }
  const answers = body.answers
  if (!isPlainObject(answers)) {
    return failure('jev.invalid-response', 'invalid-response', 'response', "the TypeSafe API answer carries no 'answers' map", { keys: Object.keys(body) })
  }
  const missing = Object.keys(questions).filter((id) => !Object.hasOwn(answers, id))
  if (missing.length > 0) {
    return failure('jev.invalid-response', 'invalid-response', 'response', 'the TypeSafe API answered fewer questions than were asked', { missing })
  }
  return { ok: true, model: body.model, answers, usage: body.usage }
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

/** The resolved row settings. */
interface Settings {
  credential: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxStateChars: number
  gate: 'credential' | 'always'
  debugLog: string | undefined
}

/** The tools this plugin declares (name + description + parameter map + body). */
function definitions(ctx: PluginContext, settings: Settings): ToolDefinition[] {
  const credentials = credentialsOf(ctx)
  const call: CallSettings = {
    baseUrl: settings.baseUrl,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    maxStateChars: settings.maxStateChars,
  }

  /** Resolve the key, or answer the typed credential-missing body. */
  const keyOrBody = async (): Promise<{ key: string } | { body: Record<string, unknown> }> => {
    const key = await credentialValue(credentials, settings.credential)
    if (key === undefined) return { body: missingCredential(settings.credential, settings.gate) }
    return { key }
  }

  /** Evaluate a NAMED question (id -> Question) against the state. */
  const evaluate = async (stateInput: unknown, questions: Record<string, Question>, id: string, model?: unknown): Promise<Record<string, unknown>> => {
    const parsedState = jsonOf(stateInput, 'state')
    if (!parsedState.ok) return parsedState.body
    const state = parsedState.value
    if (state === undefined || state === null || state === '') {
      return failure('jev.invalid-arguments', 'invalid-arguments', 'request', "'state' is required and must not be empty", { parameter: 'state' })
    }
    const resolved = await keyOrBody()
    if ('body' in resolved) return resolved.body
    const override = str(model)
    const answer = await callSystemOne(override === undefined ? call : { ...call, model: override }, resolved.key, state, questions)
    if (answer.ok !== true) return answer
    const answers = answer.answers as Record<string, unknown>
    return { ok: true, model: answer.model, id, answer: answers[id], answers, usage: answer.usage }
  }

  const providers = defineTool({
    name: 'jev_providers',
    description:
      'Reports the Jev (TypeSafe System One) integration state WITHOUT any secret: the credential NAME and whether it is currently resolvable in the dsh credential store, the API base URL and endpoint, the default model, the visibility gate and the tools this plugin registers. Use it to tell a configuration gap from a failed call.',
    parameters: {},
    execute: async () => {
      const key = await credentialValue(credentials, settings.credential)
      return {
        ok: true,
        tool: name,
        credential: settings.credential,
        credentialConfigured: key !== undefined,
        credentialsServiceAvailable: credentials !== undefined,
        baseUrl: settings.baseUrl,
        endpoint: SYSTEMONE_PATH,
        model: settings.model,
        gate: settings.gate,
        tools: ['jev_providers', 'jev_evaluate', 'jev_noul', 'jev_choice', 'jev_score', 'jev_batch'],
        docs: 'https://docs.typesafe.ai/api',
      }
    },
    output: { schema: {}, render: renderValue },
  })

  const noul = defineTool({
    name: 'jev_noul',
    description:
      'Asks Jev (TypeSafe System One) a YES/NO question about `state` and answers the probability that it is yes (0..1), with optional descriptions of what yes/no mean. A structured, calibrated decision - use it for routing, gating, guardrails and any boolean judgement a downstream branch depends on. The Jev credential is a NAME resolved at call time; a missing credential answers a typed `jev.credentials-missing` error instead of failing the run.',
    parameters: {
      state: { type: 'string', required: true, description: 'the content to evaluate: a string; for STRUCTURED state pass a JSON string, e.g. {"ticket":"..."}' },
      instructions: { type: 'string', required: true, description: 'the yes/no question, e.g. "Does this message convey urgency?"' },
      criteria_yes: { type: 'string', description: 'optional: what a yes (value near 1) means' },
      criteria_no: { type: 'string', description: 'optional: what a no (value near 0) means' },
    },
    execute: async (params) => evaluate(params.state, { noul: noulQuestion(params.instructions, { yes: params.criteria_yes, no: params.criteria_no }) }, 'noul'),
    output: { schema: {}, render: renderValue },
  })

  const choice = defineTool({
    name: 'jev_choice',
    description:
      'Asks Jev (TypeSafe System One) to pick ONE option out of a closed set you define and answers the chosen option plus the full probability distribution and the confidence. Use it for classification and intent routing where the labels are fixed in code. The Jev credential is a NAME resolved at call time; a missing credential answers a typed `jev.credentials-missing` error instead of failing the run.',
    parameters: {
      state: { type: 'string', required: true, description: 'the content to evaluate: a string; for STRUCTURED state pass a JSON string' },
      instructions: { type: 'string', required: true, description: 'what to decide, e.g. "Which team should handle this?"' },
      options: { type: 'array', items: { type: 'string' }, required: true, description: 'the closed option set as option NAMES (2..255); for a per-option rubric pass a JSON object string { option: description|null } or use jev_evaluate' },
    },
    execute: async (params) => {
      const built = choiceCriteriaOf(params.options, 'jev_choice')
      if (!built.ok) return built.body
      return evaluate(params.state, { choice: choiceQuestion(params.instructions, built.criteria) }, 'choice')
    },
    output: { schema: {}, render: renderValue },
  })

  const score = defineTool({
    name: 'jev_score',
    description:
      'Asks Jev (TypeSafe System One) to rate `state` against an ORDERED rubric you define and answers the probability-weighted score, the level legend, the level probabilities and the confidence. Use it to turn a fuzzy quality/intensity judgement into a number code can threshold. The Jev credential is a NAME resolved at call time; a missing credential answers a typed `jev.credentials-missing` error instead of failing the run.',
    parameters: {
      state: { type: 'string', required: true, description: 'the content to rate: a string; for STRUCTURED state pass a JSON string' },
      instructions: { type: 'string', required: true, description: 'what to rate, e.g. "How frustrated is the customer?"' },
      levels: { type: 'array', items: { type: 'string' }, required: true, description: 'the ordered rubric: 2..10 level descriptions, from lowest to highest' },
    },
    execute: async (params) => {
      const built = scoreCriteriaOf(params.levels, 'jev_score')
      if (!built.ok) return built.body
      return evaluate(params.state, { score: scoreQuestion(params.instructions, built.criteria) }, 'score')
    },
    output: { schema: {}, render: renderValue },
  })

  const evaluateTool = defineTool({
    name: 'jev_evaluate',
    description:
      'Evaluates ONE state against a MAP of typed Jev (TypeSafe System One) questions in a SINGLE call and answers every result keyed by the id you chose: questions = { <id>: { type: "noul"|"choice"|"score", instructions, criteria? } }, where criteria is the option map of a choice, the ordered levels of a score, or { true, false } for a noul. This is the canonical TypeSafe API shape (see https://docs.typesafe.ai/api) and the batching the vendor measures at ~12x cheaper than separate calls - use it for speculative fan-out and multi-dimension review. The Jev credential is a NAME resolved at call time; a missing credential answers a typed `jev.credentials-missing` error instead of failing the run.',
    parameters: {
      state: { type: 'string', required: true, description: 'the content to evaluate: a string; for STRUCTURED state pass a JSON string' },
      questions: { type: 'string', required: true, description: 'a JSON string holding the non-empty OBJECT map { id: { type, instructions, criteria? } }; type is noul (yes/no), choice (one of a closed set) or score (an ordered rubric)' },
      model: { type: 'string', description: 'optional model override (default: the row config, jev-latest)' },
    },
    execute: async (params) => {
      const parsedQuestions = jsonOf(params.questions, 'jev_evaluate')
      if (!parsedQuestions.ok) return parsedQuestions.body
      const raw = parsedQuestions.value
      if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
        return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_evaluate', "'questions' must be a non-empty OBJECT map { id: { type, instructions, criteria? } }", { questions: raw })
      }
      const questions: Record<string, Question> = {}
      for (const [id, entry] of Object.entries(raw)) {
        if (!isPlainObject(entry)) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_evaluate', `question '${id}' must be an object { type, instructions, criteria? }`, { id })
        }
        const type = str(entry.type)?.toLowerCase()
        if (type === undefined) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_evaluate', `question '${id}' needs a 'type' (noul, choice or score)`, { id })
        }
        if (type === 'noul') {
          const criteria = isPlainObject(entry.criteria) ? entry.criteria : undefined
          questions[id] = noulQuestion(entry.instructions, { yes: criteria?.true, no: criteria?.false })
        } else if (type === 'choice') {
          const built = choiceCriteriaOf(entry.criteria, 'jev_evaluate')
          if (!built.ok) return built.body
          questions[id] = choiceQuestion(entry.instructions, built.criteria)
        } else if (type === 'score') {
          const built = scoreCriteriaOf(entry.criteria, 'jev_evaluate')
          if (!built.ok) return built.body
          questions[id] = scoreQuestion(entry.instructions, built.criteria)
        } else {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_evaluate', `question '${id}' has an unknown type '${entry.type}' (expected noul, choice or score)`, { id, type: entry.type })
        }
        if (questions[id].instructions === undefined || questions[id].instructions === null) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_evaluate', `question '${id}' needs 'instructions'`, { id })
        }
      }
      return evaluate(params.state, questions, 'questions', params.model)
    },
    output: { schema: {}, render: renderValue },
  })

  const batch = defineTool({
    name: 'jev_batch',
    description:
      'Asks Jev (TypeSafe System One) SEVERAL typed questions about ONE state in a SINGLE call (TypeSafe reports this batching as ~12x cheaper and ~10x faster than separate calls) and answers every result keyed by the id you chose. Each question is { id, type: "noul"|"choice"|"score", instructions, criteria? }; use it for speculative fan-out and multi-dimension review. The Jev credential is a NAME resolved at call time; a missing credential answers a typed `jev.credentials-missing` error instead of failing the run.',
    parameters: {
      state: { type: 'string', required: true, description: 'the content to evaluate: a string; for STRUCTURED state pass a JSON string' },
      questions: { type: 'string', required: true, description: 'a JSON string holding an array of { id, type, instructions, criteria? } objects; criteria = the option map of a choice, the ordered levels of a score, or { true, false } for a noul' },
    },
    execute: async (params) => {
      const parsedQuestions = jsonOf(params.questions, 'jev_batch')
      if (!parsedQuestions.ok) return parsedQuestions.body
      const raw = parsedQuestions.value
      if (!Array.isArray(raw) || raw.length === 0) {
        return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_batch', "'questions' must be a non-empty ARRAY of { id, type, instructions, criteria? }", { questions: raw })
      }
      const questions: Record<string, Question> = {}
      for (const entry of raw) {
        if (!isPlainObject(entry)) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_batch', 'every entry of \'questions\' must be an object', { entry })
        }
        const id = str(entry.id)
        const type = str(entry.type)?.toLowerCase()
        if (id === undefined || type === undefined) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_batch', "every entry of 'questions' needs an 'id' and a 'type'", { entry })
        }
        if (Object.hasOwn(questions, id)) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_batch', `duplicate question id '${id}'`, { id })
        }
        if (type === 'noul') {
          const criteria = isPlainObject(entry.criteria) ? entry.criteria : undefined
          questions[id] = noulQuestion(entry.instructions, { yes: criteria?.true, no: criteria?.false })
        } else if (type === 'choice') {
          const built = choiceCriteriaOf(entry.criteria, 'jev_batch')
          if (!built.ok) return built.body
          questions[id] = choiceQuestion(entry.instructions, built.criteria)
        } else if (type === 'score') {
          const built = scoreCriteriaOf(entry.criteria, 'jev_batch')
          if (!built.ok) return built.body
          questions[id] = scoreQuestion(entry.instructions, built.criteria)
        } else {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_batch', `question '${id}' has an unknown type '${entry.type}' (expected noul, choice or score)`, { id, type: entry.type })
        }
        if (questions[id].instructions === undefined || questions[id].instructions === null) {
          return failure('jev.invalid-arguments', 'invalid-arguments', 'jev_batch', `question '${id}' needs 'instructions'`, { id })
        }
      }
      const resolved = await keyOrBody()
      if ('body' in resolved) return resolved.body
      const answer = await callSystemOne(call, resolved.key, params.state, questions)
      if (answer.ok !== true) return answer
      return { ok: true, model: answer.model, ids: Object.keys(questions), answers: answer.answers, usage: answer.usage }
    },
    output: { schema: {}, render: renderValue },
  })

  return [providers, evaluateTool, noul, choice, score, batch]
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const settings: Settings = {
    credential: str(config.credential) ?? DEFAULT_CREDENTIAL,
    baseUrl: str(config.baseUrl) ?? DEFAULT_BASE_URL,
    model: str(config.model) ?? DEFAULT_MODEL,
    timeoutMs: Math.min(Math.max(int(config.timeoutMs) ?? DEFAULT_TIMEOUT_MS, 1000), 600000),
    maxStateChars: Math.max(int(config.maxStateChars) ?? DEFAULT_MAX_STATE_CHARS, 1000),
    gate: config.gate === 'always' ? 'always' : 'credential',
    debugLog: str(config.debugLog),
  }
  const debug = (message: string): void => {
    if (settings.debugLog === undefined) return
    try {
      appendFileSync(settings.debugLog, `${new Date().toISOString()} pid=${process.pid} jev-tools: ${message}\n`)
    } catch {
      /* diagnostics are best effort */
    }
  }
  const log = (message: string): void => {
    try {
      ctx.logger?.info?.(message)
    } catch {
      /* logging is best effort */
    }
  }

  // THE GATE: `ctx.effect` is registered SYNCHRONOUSLY (so the fiber owns the
  // disposer) while the credential probe is asynchronous. Without the credential
  // (and with the default gate) NO tool is registered, so no agent can see Jev.
  ctx.effect(() => {
    let disposers: Array<() => void> = []
    let disposed = false
    debug(`apply: gate=${settings.gate} credential=${settings.credential} baseUrl=${settings.baseUrl}`)
    void (async () => {
      const credentials = credentialsOf(ctx)
      debug(`gate probe: credentialsService=${credentials === undefined ? 'ABSENT' : 'present'}`)
      const key = settings.gate === 'always' ? 'diagnostic' : await credentialValue(credentials, settings.credential, debug)
      debug(`gate probe: '${settings.credential}' resolved=${key === undefined ? 'NO (gate closed)' : 'YES (gate open)'}`)
      if (disposed) return
      if (key === undefined) {
        log(`jev-tools: GATED - the '${settings.credential}' credential is not defined; no jev tool registered (gate=${settings.gate})`)
        return
      }
      disposers = definitions(ctx, settings).map((definition) => ctx.tools.register(definition))
      debug(`registered ${disposers.length} tools: ${definitions(ctx, settings).map((definition) => definition.name).join(', ')}`)
      log(`jev-tools: registered ${disposers.length} tools (credential '${settings.credential}' defined, gate=${settings.gate}, baseUrl=${settings.baseUrl})`)
    })()
    return () => {
      disposed = true
      debug(`dispose: unregistering ${disposers.length} tools`)
      for (const dispose of disposers) dispose()
      disposers = []
    }
  })
}

// `credentials` is injected on PURPOSE: cordis activates this plugin only once
// the harness credentials service is ready, so the apply-time gate probe cannot
// race the boot order (raw evidence: without the injection the probe reported
// `credentialsService=ABSENT` 28 ms after apply and the gate stayed closed even
// with the credential defined). A deployment without the credentials seam has no
// way to resolve the NAME, so not activating is the correct gate state.
export default { name, inject: ['tools', 'credentials'], apply }
