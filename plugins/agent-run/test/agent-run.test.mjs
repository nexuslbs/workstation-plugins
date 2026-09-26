// Node test suite for plugins/agent-run (the `agent run` seam of the facade).
//
//   node --test plugins/agent-run/test/agent-run.test.mjs
//
// It proves, WITHOUT the real harness, WITHOUT a model call and WITHOUT any
// network access, the IDEMPOTENT ROLE PROVISIONING contract that broke in
// production (thread 3263): `ensureRole()` used to `mkdirSync()` the profile
// directory BEFORE running the harness CLI, and the CLI refuses an existing
// profile directory
//
//   Error: dsh: profile directory <dir> already exists; choose an unused
//   profile name
//
// so a never-seen role became PERMANENTLY undispatchable
// (`agent run: role '<role>' could not be provisioned (no profile at ...)`).
// The plugin now initialises the role in a TEMP home and RENAMES the finished
// profile into place, and decides on the MANIFEST (never on the init exit
// code, which the real CLI has been observed to return non-zero even after
// writing a valid profile).
//
// A fake CLI reproduces those three real behaviours exactly:
//   1. an EXISTING profile directory is refused with the harness' own words;
//   2. the init may write the manifest and THEN exit non-zero;
//   3. a genuine init failure writes NO manifest.

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../index.ts'

const FAKE_CLI = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const role = process.argv[2]
const rest = process.argv.slice(3)
const isInit = rest.includes('--from-default-profile')
const home = process.env.DSH_HOME
const profileDir = join(home, 'profiles', role)
if (process.env.FAKE_CLI_CALLS) appendFileSync(process.env.FAKE_CLI_CALLS, (isInit ? 'init ' : 'run ') + role + '\\n')

if (isInit) {
  if (existsSync(profileDir)) {
    console.error('Error: dsh: profile directory ' + profileDir + ' already exists; choose an unused profile name')
    process.exit(1)
  }
  mkdirSync(profileDir, { recursive: true })
  if (process.env.FAKE_INIT_MANIFEST === 'no') {
    console.error('dsh: init aborted before writing a manifest')
    process.exit(3)
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: role, version: '0.0.0' }))
  if (process.env.FAKE_INIT_EXIT === 'nonzero') {
    console.error('dsh: warning: init exited non-zero AFTER writing the profile')
    process.exit(2)
  }
  process.exit(0)
}

if (process.env.FAKE_WORKER_FAIL === '1') {
  console.error('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"')
  process.exit(1)
}
console.log(JSON.stringify({ role, answer: 'ok' }))
process.exit(0)
`

/** One isolated fixture: a fake harness (fake CLI) + a temp DSH_HOME + role definitions. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-run-test-'))
  const harnessDir = join(root, 'harness')
  mkdirSync(join(harnessDir, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(harnessDir, 'apps', 'cli', 'lib', 'bin.js'), FAKE_CLI)
  const dshHome = join(root, 'dsh-home')
  const roleProfilesDir = join(root, 'role-profiles')
  mkdirSync(roleProfilesDir, { recursive: true })
  const calls = join(root, 'calls.log')
  return { root, harnessDir, dshHome, roleProfilesDir, calls }
}

/** Run a body with extra environment for the fake CLI, restoring it afterwards. */
async function withEnv(env, body) {
  const previous = new Map()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Load the plugin against a fixture and return its registered `agent run` tool. */
function toolFor(fix) {
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    effect(callback) {
      callback()
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, {
    harnessDir: fix.harnessDir,
    dshHome: fix.dshHome,
    roleProfilesDir: fix.roleProfilesDir,
    defaultRole: 'developer',
    timeoutSecs: 30,
  })
  const tool = registrations.find((entry) => entry.name === 'agent run')
  assert.ok(tool, 'the plugin must register the "agent run" tool')
  return tool
}

/** The fake-CLI invocations recorded so far (e.g. ['init researcher', 'run researcher']). */
function callsOf(fix) {
  if (!existsSync(fix.calls)) return []
  return readFileSync(fix.calls, 'utf8').trim().split('\n').filter((line) => line.length > 0)
}

/** A role definition (cordis.patch.yml) as shipped in the user repo. */
function defineRole(fix, role) {
  const dir = join(fix.roleProfilesDir, role)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), `# patch for ${role}\n`)
}

const manifestOf = (fix, role) => join(fix.dshHome, 'profiles', role, 'package.json')

test('the plugin is the agent-run seam and registers the typed "agent run" tool', () => {
  const fix = fixture()
  try {
    assert.equal(name, 'agent-run')
    const tool = toolFor(fix)
    assert.equal(tool.name, 'agent run')
    assert.deepEqual(
      Object.keys(tool.parameters.properties).sort(),
      ['objective', 'role', 'template', 'timeoutSecs', 'workdir'],
      'the tool must publish the delegation parameters (role/objective/template/workdir/timeoutSecs)',
    )
    assert.ok(tool.parameters.required.includes('objective'), 'objective is the only required parameter')
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('a NEW role is provisioned on the FIRST call (no mkdir before the CLI init)', async () => {
  const fix = fixture()
  try {
    defineRole(fix, 'researcher')
    const tool = toolFor(fix)
    await withEnv({ FAKE_CLI_CALLS: fix.calls }, async () => {
      const result = await tool.execute({ role: 'researcher', objective: 'say ok' })
      assert.equal(result.exitCode, 0, 'the worker run must succeed')
      assert.ok(existsSync(manifestOf(fix, 'researcher')), 'the role manifest must exist after the first call')
      assert.ok(
        readFileSync(join(fix.dshHome, 'profiles', 'researcher', 'cordis.patch.yml'), 'utf8').includes('patch for researcher'),
        'the role patch must be copied into the provisioned profile',
      )
      assert.ok(
        result.provisioningNotes.some((note) => note.includes('created from the headless default profile')),
        `provisioning must be reported, notes: ${JSON.stringify(result.provisioningNotes)}`,
      )
      // exactly ONE init (in the staging home) + ONE worker run
      assert.deepEqual(callsOf(fix), ['init researcher', 'run researcher'])
    })
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('a manifest-less LEFTOVER dir (interrupted boot) is replaced, not fatal', async () => {
  const fix = fixture()
  try {
    defineRole(fix, 'researcher')
    mkdirSync(join(fix.dshHome, 'profiles', 'researcher'), { recursive: true }) // no package.json
    const tool = toolFor(fix)
    await withEnv({ FAKE_CLI_CALLS: fix.calls }, async () => {
      const result = await tool.execute({ role: 'researcher', objective: 'say ok' })
      assert.equal(result.exitCode, 0)
      assert.ok(existsSync(manifestOf(fix, 'researcher')), 'the leftover must be replaced by a real profile')
      // no staging leftovers in the profiles dir
      assert.deepEqual(
        readFileSync(join(fix.dshHome, 'profiles', 'researcher', 'package.json'), 'utf8').includes('researcher'),
        true,
      )
    })
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('the second call to the same role is IDEMPOTENT (no second init)', async () => {
  const fix = fixture()
  try {
    const tool = toolFor(fix)
    await withEnv({ FAKE_CLI_CALLS: fix.calls }, async () => {
      const first = await tool.execute({ role: 'developer', objective: 'one' })
      const second = await tool.execute({ role: 'developer', objective: 'two' })
      assert.equal(first.exitCode, 0)
      assert.equal(second.exitCode, 0)
      assert.ok(
        second.provisioningNotes.some((note) => note.includes('already provisioned')),
        `the second call must report the existing profile, notes: ${JSON.stringify(second.provisioningNotes)}`,
      )
      assert.deepEqual(callsOf(fix), ['init developer', 'run developer', 'run developer'])
    })
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('an init that exits NON-ZERO after writing the manifest still provisions (manifest decides)', async () => {
  const fix = fixture()
  try {
    const tool = toolFor(fix)
    await withEnv({ FAKE_CLI_CALLS: fix.calls, FAKE_INIT_EXIT: 'nonzero' }, async () => {
      const result = await tool.execute({ role: 'tester', objective: 'say ok' })
      assert.equal(result.exitCode, 0, 'the worker run must still succeed')
      assert.ok(existsSync(manifestOf(fix, 'tester')))
      assert.ok(
        result.provisioningNotes.some((note) => note.includes('init exit 2')),
        `the non-zero init exit must be reported, notes: ${JSON.stringify(result.provisioningNotes)}`,
      )
    })
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('a role that genuinely cannot be provisioned stays LOUD', async () => {
  const fix = fixture()
  try {
    const tool = toolFor(fix)
    await withEnv({ FAKE_CLI_CALLS: fix.calls, FAKE_INIT_MANIFEST: 'no' }, async () => {
      await assert.rejects(
        () => tool.execute({ role: 'ghost-role', objective: 'say ok' }),
        /could not be provisioned/,
      )
      assert.equal(existsSync(manifestOf(fix, 'ghost-role')), false, 'no fake manifest may appear')
    })
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('a worker that dies at the model is returned with its exit code, not swallowed', async () => {
  const fix = fixture()
  try {
    const tool = toolFor(fix)
    await withEnv({ FAKE_CLI_CALLS: fix.calls, FAKE_WORKER_FAIL: '1' }, async () => {
      const result = await tool.execute({ role: 'developer', objective: 'say ok' })
      assert.equal(result.exitCode, 1)
      assert.match(result.stderrTail, /MISSING_CREDENTIAL/)
    })
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})
