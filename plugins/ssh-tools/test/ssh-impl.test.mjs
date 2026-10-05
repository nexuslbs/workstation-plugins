// Regression test for the `ssh@1` PROVIDER (core/ssh-impl, provider `ssh-cli`).
//
//   node --test plugins/ssh-tools/test/ssh-impl.test.mjs
//
// NO harness, NO model call, NO network and NO ssh server: it applies the plugin
// against a fake service context, drives `createSshService` with a FAKE child
// runner and a FAKE credentials capability, and inspects the exact argv, the
// 0600 temp-key lifecycle and the structured errors.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { apply, createSshService, name, providerId } from '../../../core/ssh-impl/index.ts'

/** A minimal plugin context that captures `ctx.provide`. */
function makeProviderContext() {
  const provided = {}
  const ctx = {
    provide(serviceName, value) {
      provided[serviceName] = value
    },
    get(serviceName) {
      return provided[serviceName]
    },
  }
  return { ctx, provided }
}

/** A fake child runner that records every call. */
function fakeRunner(record, outcome) {
  return async (argv, options) => {
    record.push({ argv, options })
    return outcome ?? { output: 'ok\n', code: 0, stderr: '', durationMs: 5, truncated: false, timedOut: false }
  }
}

/** A structured ServiceError guard (name + code). */
function isServiceError(code) {
  return (error) => {
    assert.equal(error.name, 'ServiceError')
    assert.equal(error.code, code)
    return true
  }
}

test('the module exports the plugin name and the provider id', () => {
  assert.equal(name, 'ssh-impl')
  assert.equal(providerId, 'ssh-cli')
  assert.equal(typeof apply, 'function')
})

test('a row config with NO host LOADS; validation happens per call', async () => {
  const { ctx, provided } = makeProviderContext()
  assert.doesNotThrow(() => apply(ctx, {}), 'apply() must not validate its own row config')
  const service = provided.ssh
  assert.ok(service, "apply() did not provide the 'ssh' service")
  assert.equal(service.contract, 'ssh@1')
  assert.equal(service.provider, 'ssh-cli')
  assert.match(service.describe(), /not configured/)
  await assert.rejects(service.run('echo hi'), (error) => {
    assert.equal(error.name, 'ServiceError')
    assert.equal(error.code, 'invalid-config')
    assert.equal(error.stage, 'ssh.validate')
    assert.match(error.message, /host/)
    return true
  })
})

test('create() validates immediately; the row service defers', () => {
  const { ctx } = makeProviderContext()
  const service = createSshService({}, ctx, { runProcess: fakeRunner([]) })
  assert.throws(() => service.create({}), isServiceError('invalid-config'))
  assert.throws(() => service.create({ host: '   ' }), isServiceError('invalid-config'))
  assert.doesNotThrow(() => service.create({ host: 'root@example.internal:2222' }))
})

test('run() hands ONE argv array to the child; no host shell; remote command is one element', async () => {
  const record = []
  const { ctx } = makeProviderContext()
  const service = createSshService(
    { host: 'root@example.internal:2222', configFilePath: '/opt/omni/data/ssh/config' },
    ctx,
    { runProcess: fakeRunner(record) },
  )
  const result = await service.run("echo 'a b'; touch /tmp/x")
  assert.equal(result.code, 0)
  assert.equal(record.length, 1)
  const { argv, options } = record[0]
  assert.ok(Array.isArray(argv), 'argv is not an array')
  assert.ok(argv.every((entry) => typeof entry === 'string'), 'argv must be strings only')
  assert.equal(argv[0], 'ssh')
  assert.deepEqual(argv.slice(1, 4), ['-F', '/opt/omni/data/ssh/config', '-p'])
  assert.equal(argv[4], '2222')
  assert.equal(argv[argv.length - 2], 'root@example.internal')
  const remote = argv[argv.length - 1]
  assert.match(remote, /^sh -c '/, 'the remote command must be wrapped once as `sh -c <quoted input>`')
  assert.ok(remote.includes('echo'), 'the input did not reach the remote command')
  assert.ok(!argv.includes('shell'), 'no host shell may appear in the launcher argv')
  assert.equal(options.stage, 'ssh.run')
  assert.equal(options.timeoutMs, 30_000)
  assert.equal(options.maxOutputBytes, 4 * 1024 * 1024)
})

test('privateKeyName resolves at CALL time into a 0600 temp file removed after the call', async () => {
  const FAKE_KEY = 'FAKE-TEST-PRIVATE-KEY-MATERIAL-do-not-use'
  const record = []
  let statDuring
  const runner = async (argv, options) => {
    const index = argv.indexOf('-i')
    const keyPath = index >= 0 ? argv[index + 1] : undefined
    statDuring = keyPath === undefined ? undefined : fs.statSync(keyPath)
    record.push({ argv, options, keyPath })
    return { output: 'ok\n', code: 0, stderr: '', durationMs: 2, truncated: false, timedOut: false }
  }
  const { ctx } = makeProviderContext()
  const service = createSshService({ host: 'h.example', privateKeyName: 'SSH_PRIVATE_KEY' }, ctx, {
    runProcess: runner,
    credentialsOf: () => ({
      resolve: async (ref) => {
        // The harness CredentialRef is a BRANDED STRING; the provider must pass
        // the NAME STRING (an object key misses the string-keyed store).
        assert.equal(ref, 'SSH_PRIVATE_KEY')
        return { value: FAKE_KEY }
      },
    }),
  })
  await service.run('true')

  assert.ok(statDuring, 'the child runner never saw an -i key path')
  assert.equal(statDuring.mode & 0o777, 0o600, 'the key file must be mode 0600')
  const keyPath = record[0].keyPath
  assert.ok(!fs.existsSync(keyPath), 'the key file must be removed after the call')
  assert.ok(record[0].argv.includes('-i'))
  assert.ok(record[0].argv.includes('-o'))
  assert.ok(record[0].argv.includes('IdentitiesOnly=yes'))
  assert.ok(!JSON.stringify(record[0].argv).includes(FAKE_KEY), 'the key VALUE must never reach argv')
  assert.ok(!JSON.stringify(record[0].options).includes(FAKE_KEY), 'the key VALUE must never reach the runner options')
})

// REGRESSION (unit-e acceptance, 2026-10-05): the provider used to call
// `ctx.credentials.resolve({ name: credentialName })`. The harness CredentialRef
// is a BRANDED STRING and its local provider does `this.values.get(ref)` on a
// `Map<string, string>`, so the OBJECT key always missed and EVERY ssh call
// failed at stage `ssh.credentials` before any transport. This fake store keys
// STRICTLY on strings: an object argument misses, so the old code cannot pass.
test('REGRESSION: the credential NAME resolves through a STRING-KEYED store and the argv is exact', async () => {
  const FAKE_KEY = 'FAKE-REGRESSION-KEY-MATERIAL-do-not-use'
  // The exact lookup shape of credentials-local: Map<string, string>, get(ref).
  const store = new Map([['SSH_PRIVATE_KEY', FAKE_KEY]])
  const seen = []
  const record = []
  const { ctx } = makeProviderContext()
  const service = createSshService({ host: 'h.example', privateKeyName: 'SSH_PRIVATE_KEY' }, ctx, {
    runProcess: async (argv, options) => {
      record.push({ argv, options })
      return { output: 'ok\n', code: 0, stderr: '', durationMs: 2, truncated: false, timedOut: false }
    },
    credentialsOf: () => ({
      resolve: async (ref) => {
        seen.push(ref)
        // The harness reference is a branded string; the object form is NOT a
        // key of the store and must miss.
        assert.equal(typeof ref, 'string', 'the credential must be passed as the NAME STRING, not an object')
        return store.has(ref) ? { value: store.get(ref) } : undefined
      },
    }),
  })

  const result = await service.run('true')
  assert.equal(result.code, 0)
  assert.deepEqual(seen, ['SSH_PRIVATE_KEY'], 'resolve() must be called once with the NAME STRING')
  assert.equal(record.length, 1, 'a string-keyed lookup must resolve and start exactly one child')

  const { argv, options } = record[0]
  const keyIndex = argv.indexOf('-i')
  assert.ok(keyIndex >= 0, 'the resolver value must be materialised into an -i key path')
  const keyPath = argv[keyIndex + 1]
  assert.match(keyPath, /ssh-impl-key-.+\/id_key$/, 'the key path must be the per-call temp file')
  assert.deepEqual(argv, ['ssh', '-i', keyPath, '-o', 'IdentitiesOnly=yes', 'h.example', "sh -c 'true'"])
  assert.equal(options.stage, 'ssh.run')
  assert.ok(!JSON.stringify(argv).includes(FAKE_KEY), 'the key VALUE must never reach argv')
  assert.ok(!fs.existsSync(keyPath), 'the key file must be removed after the call')
})

test('the temp key is removed even when the child FAILS', async () => {
  let keyPath
  const runner = async (argv) => {
    const index = argv.indexOf('-i')
    keyPath = index >= 0 ? argv[index + 1] : undefined
    throw new Error('boom')
  }
  const { ctx } = makeProviderContext()
  const service = createSshService({ host: 'h.example', privateKeyName: 'SSH_PRIVATE_KEY' }, ctx, {
    runProcess: runner,
    credentialsOf: () => ({ resolve: async () => ({ value: 'FAKE-KEY' }) }),
  })
  await assert.rejects(service.run('true'), /boom/)
  assert.ok(keyPath && !fs.existsSync(keyPath), 'the key file outlived a failing call')
})

test('a credential that does not resolve is a structured error NAMING it, and NO child is started', async () => {
  const record = []
  const { ctx } = makeProviderContext()
  const service = createSshService({ host: 'h.example', privateKeyName: 'SSH_PRIVATE_KEY' }, ctx, {
    runProcess: fakeRunner(record),
    credentialsOf: () => ({ resolve: async () => undefined }),
  })
  await assert.rejects(service.run('true'), (error) => {
    assert.equal(error.name, 'ServiceError')
    assert.equal(error.code, 'not-configured')
    assert.equal(error.stage, 'ssh.credentials')
    assert.equal(error.details.credential, 'SSH_PRIVATE_KEY')
    assert.match(error.message, /SSH_PRIVATE_KEY/)
    return true
  })
  assert.equal(record.length, 0, 'an unresolved credential must never fall back to an unauthenticated attempt')
})

test('a missing credentials capability is missing-service and names the credential', async () => {
  const { ctx } = makeProviderContext()
  const service = createSshService({ host: 'h.example', privateKeyName: 'SSH_PRIVATE_KEY' }, ctx, {
    runProcess: fakeRunner([]),
    credentialsOf: () => undefined,
  })
  await assert.rejects(service.run('true'), (error) => {
    assert.equal(error.code, 'missing-service')
    assert.equal(error.details.credential, 'SSH_PRIVATE_KEY')
    assert.match(error.message, /SSH_PRIVATE_KEY/)
    return true
  })
})

test('per-call timeoutMs/maxOutputBytes override the config defaults', async () => {
  const record = []
  const { ctx } = makeProviderContext()
  const service = createSshService({ host: 'h.example', timeoutMs: 1111, maxOutputBytes: 2222 }, ctx, {
    runProcess: fakeRunner(record),
  })
  await service.run('true', { timeoutMs: 9999, maxOutputBytes: 8888 })
  assert.equal(record[0].options.timeoutMs, 9999)
  assert.equal(record[0].options.maxOutputBytes, 8888)
})
