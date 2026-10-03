// Regression test for plugins/role-delegate: the generic `delegate` tool MUST
// forward the requested `role` end to end.
//
// The bug (found live 2026-10-03, session-208e6e08 / session-e2999e5a): the
// `register()` wrapper rebuilt the handler params as
// {objective, project, timeoutSecs} and DROPPED `role`, so the generic handler
// always read `params.role === undefined` and fell back to `defaultRole`
// (websearcher). Every `delegate {role: 'developer'}` therefore ran the
// `websearcher` profile and reported role=websearcher.
//
// This test FAILS on the old wrapper (the first assertion already sees
// role=websearcher) and passes once the wrapper forwards `role` and the handler
// validates it against the role tree.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.ts'

// A fake harness CLI: it records `run <role>` and prints the child answer on
// stdout. In headless non-JSON mode stdout IS the final answer, which is exactly
// what the plugin reads back.
const FAKE_CLI = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const role = process.argv[2]
if (process.env.FAKE_CLI_CALLS) appendFileSync(process.env.FAKE_CLI_CALLS, 'run ' + role + '\\n')
console.log('answer-from-' + role)
process.exit(0)
`

/** One isolated fixture: fake harness CLI + temp DSH_HOME + role tree + project dir. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'role-delegate-test-'))
  const harnessDir = join(root, 'harness')
  mkdirSync(join(harnessDir, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(harnessDir, 'apps', 'cli', 'lib', 'bin.js'), FAKE_CLI)
  const dshHome = join(root, 'dsh-home')
  const roleProfilesDir = join(root, 'role-profiles')
  const projectsDir = join(root, 'projects')
  // The role tree is the same source the plugin validates against: one directory
  // per role. Pre-provision each profile manifest so ensureProfile() is a no-op.
  for (const role of ['developer', 'tester', 'vision-captcha', 'websearcher']) {
    mkdirSync(join(roleProfilesDir, role), { recursive: true })
    writeFileSync(join(roleProfilesDir, role, 'cordis.patch.yml'), `# patch for ${role}\n`)
    mkdirSync(join(dshHome, 'profiles', role), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', role, 'package.json'), JSON.stringify({ name: role, version: '0.0.0' }))
  }
  mkdirSync(projectsDir, { recursive: true })
  const calls = join(root, 'calls.log')
  // The plugin spawns the fake CLI with {...process.env}, so the fixture points
  // the fake at its own call log. Each test overwrites this with its own path.
  process.env.FAKE_CLI_CALLS = calls
  return { root, harnessDir, dshHome, roleProfilesDir, projectsDir, calls }
}

/** Register the plugin against a fixture and return the tool definitions by name. */
function toolsFor(fix, config = {}) {
  const registrations = new Map()
  const ctx = {
    tools: { register(def) { registrations.set(def.name, def); return () => {} } },
    effect(callback) { callback(); return () => {} },
    logger: { info() {}, warn() {} },
  }
  const previousDepth = process.env.DSH_DELEGATE_DEPTH
  process.env.DSH_DELEGATE_DEPTH = '0'
  try {
    apply(ctx, {
      harnessDir: fix.harnessDir,
      dshHome: fix.dshHome,
      roleProfilesDir: fix.roleProfilesDir,
      projectsDir: fix.projectsDir,
      provisionScript: join(fix.root, 'no-such-provisioner.sh'),
      timeoutSecs: 30,
      ...config,
    })
  } finally {
    if (previousDepth === undefined) delete process.env.DSH_DELEGATE_DEPTH
    else process.env.DSH_DELEGATE_DEPTH = previousDepth
  }
  return registrations
}

/** The fake-CLI invocations recorded so far, e.g. ['run developer']. */
function callsOf(fix) {
  if (!existsSync(fix.calls)) return []
  return readFileSync(fix.calls, 'utf8').trim().split('\n').filter((line) => line.length > 0)
}

test('the generic delegate tool forwards the requested role (regression: role was dropped)', async () => {
  const fix = fixture()
  try {
    const tools = toolsFor(fix)
    const delegate = tools.get('delegate')
    assert.ok(delegate, 'the generic delegate tool must be registered')
    const result = await delegate.execute({ role: 'developer', objective: 'reply FIX_OK_DEV', project: 'p1' })
    assert.equal(result.role, 'developer', 'the result must name the requested role')
    assert.equal(result.tool, 'delegate:developer', 'the tool name must reflect the requested role')
    assert.match(result.command, /developer/, `the command must spawn the requested role: ${result.command}`)
    assert.deepEqual(callsOf(fix), ['run developer'], 'the child process must receive the requested role as argv[2]')
    assert.equal(result.answer, 'answer-from-developer')
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('the generic delegate tool uses the default role when role is omitted', async () => {
  const fix = fixture()
  try {
    const tools = toolsFor(fix, { defaultRole: 'websearcher' })
    const result = await tools.get('delegate').execute({ objective: 'no role here' })
    assert.equal(result.role, 'websearcher')
    assert.equal(result.tool, 'delegate:websearcher')
    assert.deepEqual(callsOf(fix), ['run websearcher'])
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('a DECLARED role tool keeps running its own role when called by its own name', async () => {
  const fix = fixture()
  try {
    const tools = toolsFor(fix, { roles: [{ tool: 'vision', role: 'vision-captcha' }] })
    const result = await tools.get('vision').execute({ objective: 'solve it' })
    assert.equal(result.role, 'vision-captcha')
    assert.equal(result.tool, 'vision')
    assert.deepEqual(callsOf(fix), ['run vision-captcha'])
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('the generic delegate tool rejects an unsupported role and lists the valid ones', async () => {
  const fix = fixture()
  try {
    const tools = toolsFor(fix)
    await assert.rejects(
      () => tools.get('delegate').execute({ role: 'not-a-role', objective: 'x' }),
      (error) => {
        assert.match(error.message, /not-a-role/)
        for (const role of ['developer', 'tester', 'vision-captcha', 'websearcher']) {
          assert.match(error.message, new RegExp(role), `the error must list the valid role '${role}'`)
        }
        assert.deepEqual(callsOf(fix), [], 'an invalid role must never spawn a child')
        return true
      },
    )
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})
