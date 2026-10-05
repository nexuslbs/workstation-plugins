// Regression test for the `ssh@1` CONSUMER (plugins/ssh-tools): the four
// model-facing tools ssh_run / ssh_status / ssh_copy_to / ssh_copy_from.
//
//   node --test plugins/ssh-tools/test/ssh-tools.test.mjs
//
// NO harness, NO model call, NO network and NO credential: it applies the plugin
// against a fake tool registry and a fake `ssh` service, then inspects the
// registered names/parameters, the per-call bind and the exact remote command
// each handler builds.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply,
  name,
  settings,
  DEFAULT_CONFIG_FILE_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_COPY_BYTES,
  MAX_COPY_BYTES,
} from '../index.ts'
import { shellQuote } from '../../../definitions/support.ts'

/** The model-facing name constraint enforced by the model provider. */
const LEGAL = /^[a-zA-Z0-9_-]+$/
const TOOL_NAMES = ['ssh_run', 'ssh_status', 'ssh_copy_to', 'ssh_copy_from']

/** A fake `ssh@1` service: records create() configs and per-call runs. */
function makeSshService(handler) {
  const created = []
  const runs = []
  const service = {
    contract: 'ssh@1',
    provider: 'fake',
    describe: () => 'fake',
    // The consumer must bind per call through create(), never use the row run.
    run() {
      return Promise.reject(new Error('the consumer must call create(config).run(), not the row run'))
    },
    create(config) {
      created.push(config)
      return {
        contract: 'ssh@1',
        provider: 'fake',
        run(input, options) {
          runs.push({ config, input, options })
          return handler(config, input, options)
        },
      }
    },
  }
  return { service, created, runs }
}

/** A fake tool-registering context resolving `ssh` through ctx.get. */
function makeContext(service) {
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
      return serviceName === 'ssh' ? service : undefined
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, registrations }
}

function register(config = {}, service) {
  const { ctx, registrations } = makeContext(service)
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

const OK = async () => ({ output: 'hi\n', code: 0, stderr: '', durationMs: 7 })

test('the module exports the plugin name and an apply function', () => {
  assert.equal(name, 'ssh-tools')
  assert.equal(typeof apply, 'function')
})

test('registers exactly the four snake_case names, all legal and unique', () => {
  const tools = register({}, makeSshService(OK).service)
  assert.equal(tools.length, 4, 'expected exactly four tools')
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [...TOOL_NAMES].sort())
  for (const toolName of names) {
    assert.match(toolName, LEGAL, `'${toolName}' is not a legal model-facing tool name`)
    assert.ok(!toolName.includes(' '), `'${toolName}' must never contain a space`)
  }
  assert.equal(new Set(names).size, names.length, 'a tool name is registered twice')
})

test('host is REQUIRED on every tool; ssh_run requires command; copy requires both paths', () => {
  const tools = register({}, makeSshService(OK).service)
  for (const toolName of TOOL_NAMES) {
    const tool = toolOf(tools, toolName)
    const properties = propertiesOf(tool)
    assert.equal(properties.host?.type, 'string', `${toolName}: host type`)
    assert.ok(tool.parameters.required?.includes('host'), `${toolName}: host must be required`)
    assert.equal(properties.credential?.type, 'string', `${toolName}: credential type`)
    assert.ok(!properties.host?.enum, `${toolName}: host must not be restricted to a baked-in target`)
  }
  const run = toolOf(tools, 'ssh_run')
  assert.ok(run.parameters.required?.includes('command'), 'ssh_run: command must be required')
  const to = toolOf(tools, 'ssh_copy_to')
  assert.deepEqual(to.parameters.required, ['host', 'localPath', 'remotePath'])
  const from = toolOf(tools, 'ssh_copy_from')
  assert.deepEqual(from.parameters.required, ['host', 'remotePath', 'localPath'])
})

test('a missing host is rejected by the parameter schema before the handler runs', async () => {
  const { service, runs } = makeSshService(OK)
  const tools = register({}, service)
  await assert.rejects(toolOf(tools, 'ssh_run').execute({ command: 'echo hi' }), /host/)
  assert.equal(runs.length, 0)
})

test('ssh_run binds the host per call, defaults the credential from config and returns the result', async () => {
  const { service, created, runs } = makeSshService(OK)
  const tools = register({ privateKeyName: 'SSH_PRIVATE_KEY', configFilePath: '/etc/ssh/config' }, service)
  const body = await toolOf(tools, 'ssh_run').execute({
    host: 'root@example.internal:2222',
    command: 'echo hi',
  })
  assert.equal(body.host, 'root@example.internal:2222')
  assert.equal(body.code, 0)
  assert.equal(body.output, 'hi\n')
  assert.equal(body.durationMs, 7)
  assert.deepEqual(created[0], {
    host: 'root@example.internal:2222',
    configFilePath: '/etc/ssh/config',
    privateKeyName: 'SSH_PRIVATE_KEY',
  })
  assert.equal(runs[0].input, 'echo hi')
  assert.deepEqual(runs[0].options, {}, 'no per-call timeout means an empty options override')
})

test('an explicit credential parameter overrides the config privateKeyName', async () => {
  const { service, created } = makeSshService(OK)
  const tools = register({ privateKeyName: 'DEFAULT_KEY', configFilePath: '/etc/ssh/config' }, service)
  await toolOf(tools, 'ssh_run').execute({ host: 'h', command: 'true', credential: 'OTHER_KEY' })
  assert.equal(created[0].privateKeyName, 'OTHER_KEY')
})

test('ssh_status is NON-throwing: reachable=true on success, false plus the raw reason on failure', async () => {
  const ok = makeSshService(async () => ({ output: '', code: 0, stderr: '', durationMs: 4 }))
  const okBody = await toolOf(register({}, ok.service), 'ssh_status').execute({ host: 'h:22' })
  assert.equal(okBody.reachable, true)
  assert.equal(okBody.code, 0)
  assert.equal(okBody.durationMs, 4)

  const bad = makeSshService(async () => {
    throw new Error('Connection refused')
  })
  const badBody = await toolOf(register({}, bad.service), 'ssh_status').execute({ host: 'h:22' })
  assert.equal(badBody.reachable, false)
  assert.match(badBody.reason, /Connection refused/)

  // A non-zero exit is a reachable=false answer too, with the raw stderr.
  const refused = makeSshService(async () => ({
    output: '',
    code: 255,
    stderr: 'Permission denied (publickey,password).',
    durationMs: 6,
  }))
  const refusedBody = await toolOf(register({}, refused.service), 'ssh_status').execute({ host: 'h:22' })
  assert.equal(refusedBody.reachable, false)
  assert.equal(refusedBody.code, 255)
  assert.match(refusedBody.stderr, /Permission denied/)
})

test('ssh_status answers reachable=false (never throws) when the ssh service is missing', async () => {
  const tools = register({}, undefined)
  const body = await toolOf(tools, 'ssh_status').execute({ host: 'h:22' })
  assert.equal(body.reachable, false)
  assert.match(body.reason, /ssh/)
  assert.equal(body.error, 'missing-service')
})

test('ssh_run answers a structured missing-service when no ssh provider is loaded', async () => {
  const tools = register({}, undefined)
  await assert.rejects(toolOf(tools, 'ssh_run').execute({ host: 'h', command: 'true' }), (error) => {
    assert.equal(error.name, 'ServiceError')
    assert.equal(error.code, 'missing-service')
    return true
  })
})

test('ssh_copy_to builds the base64 single-command seam and reports the byte count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tools-test-'))
  const local = path.join(dir, 'payload.txt')
  fs.writeFileSync(local, 'abc')
  const { service, runs } = makeSshService(OK)
  const tools = register({ maxCopyBytes: 1024 }, service)
  const body = await toolOf(tools, 'ssh_copy_to').execute({
    host: 'h',
    localPath: local,
    remotePath: '/tmp/remote.txt',
  })
  assert.equal(body.direction, 'to-remote')
  assert.equal(body.bytes, 3)
  assert.equal(body.code, 0)
  assert.equal(
    runs[0].input,
    `printf %s ${shellQuote(Buffer.from('abc').toString('base64'))} | base64 -d > '/tmp/remote.txt'`,
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ssh_copy_to REJECTS a file above the transfer bound with a structured error and no run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tools-test-'))
  const local = path.join(dir, 'big.bin')
  fs.writeFileSync(local, Buffer.alloc(64, 1))
  const { service, runs } = makeSshService(OK)
  const tools = register({ maxCopyBytes: 8 }, service)
  await assert.rejects(
    toolOf(tools, 'ssh_copy_to').execute({ host: 'h', localPath: local, remotePath: '/tmp/x' }),
    (error) => {
      assert.equal(error.name, 'ServiceError')
      assert.equal(error.code, 'invalid-input')
      assert.equal(error.stage, 'ssh-tools.copy_to')
      assert.equal(error.details.maxCopyBytes, 8)
      return true
    },
  )
  assert.equal(runs.length, 0, 'no remote command may run for an oversized file')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ssh_copy_from decodes base64 into the local file and rejects malformed/truncated answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-tools-test-'))
  const out = path.join(dir, 'nested', 'out.bin')
  const payload = Buffer.from('from-remote-bytes')
  const ok = makeSshService(async () => ({
    output: payload.toString('base64'),
    code: 0,
    stderr: '',
    durationMs: 3,
  }))
  const body = await toolOf(register({ maxCopyBytes: 1024 }, ok.service), 'ssh_copy_from').execute({
    host: 'h',
    remotePath: '/tmp/x',
    localPath: out,
  })
  assert.equal(body.direction, 'from-remote')
  assert.equal(body.bytes, payload.byteLength)
  assert.equal(fs.readFileSync(out).toString(), 'from-remote-bytes')
  assert.equal(ok.runs[0].input, `base64 -w0 < '/tmp/x'`)

  const junk = makeSshService(async () => ({ output: 'not base64 !!!', code: 0, stderr: '', durationMs: 1 }))
  await assert.rejects(
    toolOf(register({}, junk.service), 'ssh_copy_from').execute({ host: 'h', remotePath: '/tmp/x', localPath: path.join(dir, 'junk') }),
    (error) => error.code === 'malformed-output',
  )

  const cut = makeSshService(async () => ({ output: 'YWJj', code: 0, stderr: '', durationMs: 1, truncated: true }))
  await assert.rejects(
    toolOf(register({}, cut.service), 'ssh_copy_from').execute({ host: 'h', remotePath: '/tmp/x', localPath: path.join(dir, 'cut') }),
    (error) => error.code === 'malformed-output',
  )

  const failed = makeSshService(async () => ({ output: '', code: 1, stderr: 'no such file', durationMs: 1 }))
  await assert.rejects(
    toolOf(register({}, failed.service), 'ssh_copy_from').execute({ host: 'h', remotePath: '/tmp/x', localPath: path.join(dir, 'failed') }),
    (error) => {
      assert.equal(error.code, 'non-zero-exit')
      assert.match(error.message, /exit code 1/)
      return true
    },
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('config: defaults are documented and malformed values never crash', () => {
  assert.deepEqual(settings(), {
    configFilePath: DEFAULT_CONFIG_FILE_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxCopyBytes: DEFAULT_MAX_COPY_BYTES,
  })
  assert.deepEqual(settings({}), {
    configFilePath: DEFAULT_CONFIG_FILE_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxCopyBytes: DEFAULT_MAX_COPY_BYTES,
  })
  const resolved = settings({ configFilePath: '   ', privateKeyName: '  ', timeoutMs: -1, maxCopyBytes: 10_000_000 })
  assert.equal(resolved.configFilePath, DEFAULT_CONFIG_FILE_PATH)
  assert.equal(resolved.privateKeyName, undefined)
  assert.equal(resolved.timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.equal(resolved.maxCopyBytes, MAX_COPY_BYTES)
})

test('DISPOSE: the effect disposer unregisters all four tools', () => {
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
  assert.equal(registrations.length, 4)
  disposer()
  assert.equal(registrations.length, 0)
})
