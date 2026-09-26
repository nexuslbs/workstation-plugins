// Node test suite for plugins/jev-tools.
//
//   node --test plugins/jev-tools/test/jev-tools.test.mjs
//
// It proves, WITHOUT a real Jev/TypeSafe API key and WITHOUT any network call:
//   1. the CREDENTIAL GATE - with the credential NAME unresolved the plugin
//      registers ZERO tools (the "agents do not see Jev yet" requirement);
//   2. the credential-missing CALL path - a registered tool answers the typed
//      `jev.credentials-missing` body instead of throwing (no stack flood);
//   3. argument validation is typed (invalid-arguments), never a crash;
//   4. the HTTP failure mapping (401/429/transport/200-with-missing-answer) and
//      the happy path request/response normalization, with a stubbed fetch.

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../index.ts'

/** Let the plugin's asynchronous gate/registration settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** A fake dsh plugin context: records registrations, resolves ONE credential value. */
function fakeContext({ credentialValue } = {}) {
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {
          const index = registrations.indexOf(definition)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    effect(callback) {
      callback()
    },
    logger: { info() {}, warn() {} },
    credentials: {
      async resolve() {
        return credentialValue === undefined ? undefined : { value: credentialValue, source: 'test' }
      },
      async list() {
        return []
      },
    },
  }
  return { ctx, registrations }
}

/** The tool of a registration list, by name. */
function toolOf(registrations, toolName) {
  const found = registrations.find((entry) => entry.name === toolName)
  assert.ok(found, `tool '${toolName}' is not registered (have: ${registrations.map((entry) => entry.name).join(', ')})`)
  return found
}

const TOOL_NAMES = ['jev_providers', 'jev_evaluate', 'jev_noul', 'jev_choice', 'jev_score', 'jev_batch']
const CREDENTIAL = 'JEV_API_KEY'

/** Valid arguments for every tool (used by the family-wide assertions). */
const VALID_ARGS = {
  'jev_providers': {},
  'jev_evaluate': { state: 'x', questions: '{"q1":{"type":"noul","instructions":"yes?"}}' },
  'jev_noul': { state: 'x', instructions: 'yes?' },
  'jev_choice': { state: 'x', instructions: 'pick', options: ['one', 'two'] },
  'jev_score': { state: 'x', instructions: 'rate', levels: ['low', 'high'] },
  'jev_batch': { state: 'x', questions: '[{"id":"q1","type":"noul","instructions":"yes?"}]' },
}

test('the module exports the plugin name and an apply function', () => {
  assert.equal(name, 'jev-tools')
  assert.equal(typeof apply, 'function')
})

test('GATE: without the credential NO tool is registered', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: undefined })
  apply(ctx, { credential: CREDENTIAL })
  await tick()
  assert.deepEqual(registrations.map((entry) => entry.name), [])
})

test('GATE: an EMPTY credential value counts as missing (no tool registered)', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: '' })
  apply(ctx, { credential: CREDENTIAL })
  await tick()
  assert.deepEqual(registrations.map((entry) => entry.name), [])
})

test('GATE: with the credential defined the typed tools are registered', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: 'test-value-not-a-real-key' })
  apply(ctx, { credential: CREDENTIAL })
  await tick()
  assert.deepEqual(registrations.map((entry) => entry.name).sort(), [...TOOL_NAMES].sort())
  // typed parameter maps are published (JSON Schema compiled at registration)
  const noul = toolOf(registrations, 'jev_noul')
  assert.equal(noul.parameters.type, 'object')
  assert.deepEqual(noul.parameters.required, ['state', 'instructions'])
  assert.equal(typeof noul.output.render, 'function')
})

test('CREDENTIAL-MISSING PATH: a registered tool answers a typed error, never a throw', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: undefined })
  apply(ctx, { credential: CREDENTIAL, gate: 'always' })
  await tick()
  assert.equal(registrations.length, TOOL_NAMES.length)

  let fetchCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('the credential-missing path must not reach the network')
  }
  try {
    const body = await toolOf(registrations, 'jev_noul').execute({ state: 'a ticket', instructions: 'Is it urgent?' })
    assert.equal(body.ok, false)
    assert.equal(body.error.reason, 'jev.credentials-missing')
    assert.equal(body.error.code, 'missing-credential')
    assert.equal(body.error.details.credential, CREDENTIAL)
    assert.equal(fetchCalls, 0, 'no HTTP call may be attempted without the credential')
    assert.equal(typeof body.error.message, 'string')

    // every call-capable tool answers the same typed body (the family is consistent)
    for (const toolName of ['jev_evaluate', 'jev_choice', 'jev_score', 'jev_batch']) {
      const answer = await toolOf(registrations, toolName).execute(VALID_ARGS[toolName])
      assert.equal(answer.ok, false, `${toolName} answered ${JSON.stringify(answer)}`)
      assert.equal(answer.error.reason, 'jev.credentials-missing')
    }
    assert.equal(fetchCalls, 0)

    // introspection is honest about the gap without any secret
    const providers = await toolOf(registrations, 'jev_providers').execute({})
    assert.equal(providers.ok, true)
    assert.equal(providers.credentialConfigured, false)
    assert.equal(providers.credential, CREDENTIAL)
    assert.equal(JSON.stringify(providers).includes('test-value'), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('ARGUMENTS: a malformed question set is typed, never a crash', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: 'test-value-not-a-real-key' })
  apply(ctx, { credential: CREDENTIAL })
  await tick()

  const cases = [
    ['jev_score', { state: 'x', instructions: 'rate', levels: ['only-one'] }],
    ['jev_choice', { state: 'x', instructions: 'pick', options: ['only'] }],
    ['jev_batch', { state: 'x', questions: '[{"id":"q","type":"nope","instructions":"?"}]' }],
    ['jev_batch', { state: 'x', questions: '[{"id":"q","type":"noul",instructions: BAD' }],
    ['jev_evaluate', { state: 'x', questions: '{"q":{"type":"nope","instructions":"?"}}' }],
    ['jev_evaluate', { state: 'x', questions: '{}' }],
    ['jev_evaluate', { state: 'x', questions: '{"q":{"type":"choice","instructions":"pick","criteria":{"only":null}}}' }],
  ]
  for (const [toolName, params] of cases) {
    const body = await toolOf(registrations, toolName).execute(params)
    assert.equal(body.ok, false, `${toolName} answered ${JSON.stringify(body)}`)
    assert.equal(body.error.reason, 'jev.invalid-arguments', `${toolName} answered ${JSON.stringify(body)}`)
  }

  // A DECLARED-schema violation (a MISSING REQUIRED parameter) is rejected by the
  // tools provider BEFORE the handler runs - that is the harness contract, and the
  // rejection is a readable, path-qualified ToolArgsError, not a stack flood.
  await assert.rejects(
    () => toolOf(registrations, 'jev_noul').execute({ instructions: 'yes?' }),
    (error) => {
      assert.equal(error.name, 'ToolArgsError')
      assert.match(error.message, /state: missing required parameter/)
      return true
    },
  )
})

test('HTTP: 401 is mapped to a typed unauthorized body (no throw)', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: 'test-value-not-a-real-key' })
  apply(ctx, { credential: CREDENTIAL })
  await tick()

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid api key' }), { status: 401, headers: { 'content-type': 'application/json' } })
  try {
    const body = await toolOf(registrations, 'jev_noul').execute({ state: 'x', instructions: 'yes?' })
    assert.equal(body.ok, false)
    assert.equal(body.error.reason, 'jev.unauthorized')
    assert.equal(body.error.details.httpStatus, 401)
    assert.equal(body.error.details.upstream, 'invalid api key')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('HTTP: 429 and a transport failure are typed, and the happy path is normalized', async () => {
  const { ctx, registrations } = fakeContext({ credentialValue: 'test-value-not-a-real-key' })
  apply(ctx, { credential: CREDENTIAL, baseUrl: 'https://api.typesafe.ai/' })
  await tick()

  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('{"error":"rate limit"}', { status: 429 })
    const limited = await toolOf(registrations, 'jev_noul').execute({ state: 'x', instructions: 'yes?' })
    assert.equal(limited.error.reason, 'jev.rate-limited')

    globalThis.fetch = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' })
    }
    const transport = await toolOf(registrations, 'jev_choice').execute(VALID_ARGS['jev_choice'])
    assert.equal(transport.error.reason, 'jev.transport-error')

    let seen = undefined
    globalThis.fetch = async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { score: { type: 'score', score: 1.05, legend: { 0: 'Calm', 1: 'Frustrated' }, probabilities: { 0: 0.05, 1: 0.95 }, confidence: 0.92 } },
        usage: { input_tokens: 304, output_tokens: 18 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const happy = await toolOf(registrations, 'jev_score').execute({ state: '{"ticket":"my payouts fail"}', instructions: 'How frustrated?', levels: ['Calm', 'Frustrated'] })
    assert.equal(happy.ok, true)
    assert.equal(happy.id, 'score')
    assert.equal(happy.answer.score, 1.05)
    assert.equal(happy.usage.input_tokens, 304)
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(seen.init.method, 'POST')
    assert.equal(seen.init.headers.authorization, 'Bearer test-value-not-a-real-key')
    assert.equal(seen.init.headers['content-type'], 'application/json')
    const sent = JSON.parse(seen.init.body)
    assert.equal(sent.model, 'jev-latest')
    assert.deepEqual(sent.state, { ticket: 'my payouts fail' })
    assert.deepEqual(sent.questions.score.criteria, ['Calm', 'Frustrated'])
    assert.equal(sent.questions.score.type, 'score')

    // a model override reaches the request body
    globalThis.fetch = async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({ model: 'jev-preview', answers: { q1: { type: 'noul', noul: 0.9 } }, usage: {} }), { status: 200 })
    }
    const overridden = await toolOf(registrations, 'jev_evaluate').execute({ ...VALID_ARGS['jev_evaluate'], model: 'jev-preview' })
    assert.equal(overridden.ok, true)
    assert.equal(JSON.parse(seen.init.body).model, 'jev-preview')
    assert.equal(overridden.answers.q1.noul, 0.9)

    globalThis.fetch = async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {} }), { status: 200 })
    const incomplete = await toolOf(registrations, 'jev_noul').execute({ state: 'x', instructions: 'yes?' })
    assert.equal(incomplete.error.reason, 'jev.invalid-response')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('PROVIDERS: reports the credential NAME and whether it resolves, never a value', async () => {
  const missing = fakeContext({ credentialValue: undefined })
  apply(missing.ctx, { credential: CREDENTIAL, gate: 'always' })
  await tick()
  const off = await toolOf(missing.registrations, 'jev_providers').execute({})
  assert.equal(off.ok, true)
  assert.equal(off.credential, CREDENTIAL)
  assert.equal(off.credentialConfigured, false)
  assert.equal(off.endpoint, '/v1/systemone')
  assert.equal(off.baseUrl, 'https://api.typesafe.ai')
  assert.deepEqual(off.tools, TOOL_NAMES)

  const present = fakeContext({ credentialValue: 'test-value-not-a-real-key' })
  apply(present.ctx, { credential: CREDENTIAL })
  await tick()
  const on = await toolOf(present.registrations, 'jev_providers').execute({})
  assert.equal(on.credentialConfigured, true)
})

test('DISPOSE: the effect disposer unregisters every tool', async () => {
  const registrations = []
  let disposer = undefined
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {
          const index = registrations.indexOf(definition)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    effect(callback) {
      disposer = callback()
    },
    logger: { info() {}, warn() {} },
    credentials: { async resolve() { return { value: 'test-value-not-a-real-key' } } },
  }
  apply(ctx, { credential: CREDENTIAL })
  await tick()
  assert.equal(registrations.length, TOOL_NAMES.length)
  disposer()
  assert.equal(registrations.length, 0)
})
