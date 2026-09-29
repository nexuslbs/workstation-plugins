// Regression test for the typed facade tools (plugins/tools-typed): `jq_query`
// and `python_run` over the general-service container seam.
//
//   node --test plugins/tools-typed/test/tools-typed.test.mjs
//
// It needs NO harness, NO model call, NO network and NO container: it applies
// the plugin against a fake tool registry and a fake `general-service`, then
// inspects the registered names/parameters and the exact shell-quoted command
// the handler hands to the container transport.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  name,
  settings,
  DEFAULT_PROJECT_DIR,
  DEFAULT_SERVICE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from '../index.ts'

/** The model-facing name constraint enforced by the model provider. */
const LEGAL = /^[a-zA-Z0-9_-]+$/
const GENERAL_SERVICE = 'general-service'

/** A fake dsh plugin context: captures registrations, optionally resolves a service. */
function makeContext(general) {
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
    get(serviceName) {
      return serviceName === GENERAL_SERVICE ? general : undefined
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, registrations }
}

/** Applies the plugin against a fake context and returns the registrations. */
function register(config = {}, general = undefined) {
  const { ctx, registrations } = makeContext(general)
  apply(ctx, config)
  return registrations
}

function toolOf(registrations, toolName) {
  const found = registrations.find((entry) => entry.name === toolName)
  assert.ok(found, `tool '${toolName}' is not registered (have: ${registrations.map((entry) => entry.name).join(', ')})`)
  return found
}

function propertiesOf(tool) {
  return tool.parameters?.properties ?? {}
}

/** A spy general-service that records every (input, target, options) triple. */
function serviceSpy(answer = { output: '{"a":1}\n', code: 0, durationMs: 3 }) {
  const calls = []
  const service = {
    contract: 'general-service@1',
    provider: 'test',
    create() {
      throw new Error('create() is not used by tools-typed')
    },
    async call(input, target, options) {
      calls.push({ input, target, options })
      return {
        output: answer.output,
        code: answer.code,
        ...(answer.stderr === undefined ? {} : { stderr: answer.stderr }),
        durationMs: answer.durationMs,
        type: 'container',
      }
    },
  }
  return { calls, service }
}

test('the module exports the plugin name and an apply function', () => {
  assert.equal(name, 'tools-typed')
  assert.equal(typeof apply, 'function')
})

test('registers exactly the two single-word snake_case names, all legal', () => {
  const tools = register()
  assert.equal(tools.length, 2, 'expected exactly two tools')
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['jq_query', 'python_run'])
  for (const toolName of names) {
    assert.match(toolName, LEGAL, `'${toolName}' is not a legal model-facing tool name`)
  }
  assert.equal(new Set(names).size, names.length, 'a tool name is registered twice')
})

test('jq_query declares the typed parameters and marks only filter required', () => {
  const tool = toolOf(register(), 'jq_query')
  const properties = propertiesOf(tool)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['filter'])
  assert.equal(properties.filter.type, 'string')
  assert.equal(properties.json.type, 'string')
  assert.equal(properties.file.type, 'string')
  assert.equal(properties.raw.type, 'boolean')
  assert.equal(properties.slurp.type, 'boolean')
  assert.equal(properties.compact.type, 'boolean')
  assert.ok(typeof tool.description === 'string' && tool.description.length > 0, 'no description')
  assert.equal(typeof tool.output.render, 'function')
})

test('python_run declares the typed parameters and marks only code required', () => {
  const tool = toolOf(register(), 'python_run')
  const properties = propertiesOf(tool)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['code'])
  assert.equal(properties.code.type, 'string')
  assert.equal(properties.stdin.type, 'string')
  assert.equal(properties.args.type, 'array')
  assert.equal(properties.args.items.type, 'string')
  assert.equal(properties.cwd.type, 'string')
  assert.equal(properties.timeoutMs.type, 'integer')
  assert.ok(typeof tool.description === 'string' && tool.description.length > 0, 'no description')
})

test('config: empty/absent uses the documented defaults', () => {
  assert.deepEqual(settings(), {
    service: DEFAULT_SERVICE,
    projectDir: DEFAULT_PROJECT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })
  assert.deepEqual(settings({}), {
    service: DEFAULT_SERVICE,
    projectDir: DEFAULT_PROJECT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })
  // empty config still registers both tools (no rows to skip)
  assert.deepEqual(register().map((tool) => tool.name).sort(), ['jq_query', 'python_run'])
  assert.deepEqual(register({}).map((tool) => tool.name).sort(), ['jq_query', 'python_run'])
})

test('config: malformed values fall back to defaults and never crash', () => {
  const resolved = settings({ service: 123, projectDir: null, timeoutMs: 'nope' })
  assert.deepEqual(resolved, {
    service: DEFAULT_SERVICE,
    projectDir: DEFAULT_PROJECT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })
  assert.equal(settings({ service: '   ', projectDir: '' }).service, DEFAULT_SERVICE)
  assert.equal(settings({ service: 'other-tools' }).service, 'other-tools')
  assert.equal(settings({ projectDir: '/srv/stack' }).projectDir, '/srv/stack')
  assert.equal(settings({ timeoutMs: 10_000_000 }).timeoutMs, MAX_TIMEOUT_MS)
  assert.equal(settings({ timeoutMs: -5 }).timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.deepEqual(register({ service: 123, projectDir: null, timeoutMs: 'nope' }).map((tool) => tool.name).sort(), [
    'jq_query',
    'python_run',
  ])
})

test('jq_query inline mode: shells out through the container transport and parses result', async () => {
  const spy = serviceSpy()
  const tools = register({ service: 'workstation-tools', projectDir: '/opt/omni', timeoutMs: 12345 }, spy.service)
  const body = await toolOf(tools, 'jq_query').execute({ filter: '.a', json: '{"a":1}' })

  assert.equal(body.ok, true)
  assert.equal(body.service, 'workstation-tools')
  assert.equal(body.code, 0)
  assert.deepEqual(body.result, { a: 1 })
  assert.equal(body.output, '{"a":1}\n')
  assert.equal(body.durationMs, 3)
  assert.equal(spy.calls.length, 1)
  assert.equal(spy.calls[0].input, `printf '%s' '{"a":1}' | jq -c '.a'`)
  assert.deepEqual(spy.calls[0].target, {
    type: 'container',
    params: {
      engine: 'docker-compose',
      compose: { project_dir: '/opt/omni', service: 'workstation-tools' },
    },
  })
  assert.deepEqual(spy.calls[0].options, { timeoutMs: 12345 })
})

test('jq_query file mode: flags raw/slurp/compact-bool and quotes every value', async () => {
  const spy = serviceSpy({ output: '1\n2', code: 0, durationMs: 1 })
  const tools = register({}, spy.service)

  const body = await toolOf(tools, 'jq_query').execute({
    filter: '.a',
    file: '/opt/omni/data/x.json',
    raw: true,
    slurp: true,
    compact: false,
  })

  assert.equal(spy.calls[0].input, `jq -r -s '.a' '/opt/omni/data/x.json'`)
  assert.equal(body.output, '1\n2')
  assert.equal(body.result, undefined, 'multi-value stdout is not a single JSON value')

  // an embedded single quote is escaped, never able to break out of the word
  const quoted = serviceSpy()
  const quotedTools = register({}, quoted.service)
  await toolOf(quotedTools, 'jq_query').execute({ filter: '.x', json: "a'b" })
  assert.equal(quoted.calls[0].input, `printf '%s' 'a'\\''b' | jq -c '.x'`)
})

test('python_run: cwd + stdin + args + per-call timeout reach the command', async () => {
  const spy = serviceSpy({ output: "['--flag', 'va lue']\n", code: 0, durationMs: 7 })
  const tools = register({}, spy.service)

  const body = await toolOf(tools, 'python_run').execute({
    code: 'import sys; print(sys.argv[1:])',
    stdin: 'hello',
    args: ['--flag', 'va lue'],
    cwd: '/opt/omni/data',
    timeoutMs: 9000,
  })

  assert.equal(body.ok, true)
  assert.equal(body.code, 0)
  assert.equal(body.stdout, "['--flag', 'va lue']\n")
  assert.equal(
    spy.calls[0].input,
    `cd '/opt/omni/data' && printf '%s' 'hello' | python3 -c 'import sys; print(sys.argv[1:])' '--flag' 'va lue'`,
  )
  assert.deepEqual(spy.calls[0].options, { timeoutMs: 9000 })
  assert.deepEqual(spy.calls[0].target.params.compose, { project_dir: '/opt/omni', service: 'workstation-tools' })

  // the per-call timeout is capped, and the config timeout is the default
  const capped = serviceSpy()
  const cappedTools = register({}, capped.service)
  await toolOf(cappedTools, 'python_run').execute({ code: 'print(1)', timeoutMs: 10_000_000 })
  assert.deepEqual(capped.calls[0].options, { timeoutMs: MAX_TIMEOUT_MS })

  const fromConfig = serviceSpy()
  const fromConfigTools = register({ timeoutMs: 250 }, fromConfig.service)
  await toolOf(fromConfigTools, 'python_run').execute({ code: 'print(1)' })
  assert.deepEqual(fromConfig.calls[0].options, { timeoutMs: 250 })
})

test('invalid input answers a typed body and never calls the container', async () => {
  const spy = serviceSpy()
  const tools = register({}, spy.service)
  const jq = toolOf(tools, 'jq_query')
  const python = toolOf(tools, 'python_run')

  const both = await jq.execute({ filter: '.a', json: '{}', file: '/opt/omni/x.json' })
  assert.equal(both.ok, false)
  assert.equal(both.error, 'invalid-input')

  const neither = await jq.execute({ filter: '.a' })
  assert.equal(neither.ok, false)
  assert.equal(neither.error, 'invalid-input')

  const emptyFilter = await jq.execute({ filter: '   ', json: '{}' })
  assert.equal(emptyFilter.ok, false)
  assert.equal(emptyFilter.error, 'invalid-input')

  const emptyCode = await python.execute({ code: '   ' })
  assert.equal(emptyCode.ok, false)
  assert.equal(emptyCode.error, 'invalid-input')

  assert.equal(spy.calls.length, 0, 'no container call may happen for invalid input')
})

test('missing general-service answers the typed missing-service body', async () => {
  const tools = register()
  for (const toolName of ['jq_query', 'python_run']) {
    const tool = toolOf(tools, toolName)
    const params = toolName === 'jq_query' ? { filter: '.a', json: '{}' } : { code: 'print(1)' }
    const body = await tool.execute(params)
    assert.equal(body.ok, false, `${toolName} answered ${JSON.stringify(body)}`)
    assert.equal(body.error, 'missing-service')
  }
})

test('DISPOSE: the effect disposer unregisters both tools', () => {
  const registrations = []
  let disposer
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
    get() {
      return undefined
    },
    effect(callback) {
      disposer = callback()
    },
  }
  apply(ctx)
  assert.equal(registrations.length, 2)
  disposer()
  assert.equal(registrations.length, 0)
})
