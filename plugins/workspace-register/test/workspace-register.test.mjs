// Node test suite for plugins/workspace-register (the `workspace_register`
// backfill tool) and its shared registration helper.
//
//   node --test plugins/workspace-register/test/workspace-register.test.mjs
//
// It proves, WITHOUT the harness, a model call, a network or a container:
//   * the tool is registered snake_case with an OPTIONAL `project` parameter;
//   * `backfillWorkspaces` groups stored headers by CANONICAL cwd and attaches
//     ONLY the sessions whose cwd equals the workspace path;
//   * the flow is idempotent end to end (a second pass attaches nothing);
//   * an explicit `project` restricts the pass to one directory;
//   * an unresolvable project directory is reported in `errors`, never fatal.
//
// The REAL registry's cwd validation, persistence round-trip and
// `sessionIds` getter are exercised in the scratch integration test (raw
// evidence captured in the commit report), not here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../index.ts'
import { backfillWorkspaces, projectNames, sanitizeProject } from '../registration.ts'

/** A fake Workspace entity: same surface as the registry entity, no validation. */
function workspace(path, title) {
  return {
    id: `id-${path}`,
    path,
    title,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    sessionIds: [],
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
    },
  }
}

/** A fake registry: idempotent create by canonical path + list. */
function registry() {
  const entities = new Map()
  return {
    entities,
    list() {
      return [...entities.values()]
    },
    async create(path, title) {
      if (!entities.has(path)) entities.set(path, workspace(path, title ?? path.split('/').pop()))
      return entities.get(path)
    },
  }
}

/** A fake session persistence: fixed stored headers. */
function persistence(headers) {
  return {
    async list() {
      return headers.map((header) => ({ header }))
    },
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-register-test-'))
  const projectsDir = join(root, 'projects')
  mkdirSync(join(projectsDir, 'alpha'), { recursive: true })
  mkdirSync(join(projectsDir, 'beta'), { recursive: true })
  return { root, projectsDir }
}

test('the plugin registers the snake_case "workspace_register" tool with an optional project', () => {
  assert.equal(name, 'workspace-register')
  const registrations = []
  const ctx = {
    tools: { register: (definition) => { registrations.push(definition); return () => {} } },
    effect: (callback) => { callback() },
    workspaceRegistry: registry(),
    sessionPersistence: persistence([]),
  }
  apply(ctx, {})
  const tool = registrations.find((entry) => entry.name === 'workspace_register')
  assert.ok(tool, 'the plugin must register the "workspace_register" tool')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['project'])
  assert.equal(tool.parameters.required, undefined, 'project must be optional (omit = all projects)')
})

test('backfill groups by canonical cwd, attaches only matching sessions, and is idempotent', async () => {
  const fix = fixture()
  try {
    const alpha = join(fix.projectsDir, 'alpha')
    const beta = join(fix.projectsDir, 'beta')
    const elsewhere = join(fix.root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const reg = registry()
    const store = persistence([
      { id: 'a-1', cwd: alpha },
      { id: 'a-2', cwd: alpha },
      { id: 'a-mismatch', cwd: elsewhere },
      { id: 'b-1', cwd: beta },
      { id: 'no-cwd' },
    ])

    const first = await backfillWorkspaces({ registry: reg, persistence: store, projectsDir: fix.projectsDir })
    assert.deepEqual(first.workspaces.map((entry) => entry.project), ['alpha', 'beta'])
    assert.equal(first.totals.workspaces, 2)
    assert.equal(first.totals.sessions, 3, 'only the three matching sessions are attached')
    assert.equal(first.totals.attached, 3)
    assert.equal(first.totals.skipped, 0)
    assert.equal(first.totals.created, 2)
    assert.deepEqual(first.errors, [])

    const alphaEvidence = first.workspaces.find((entry) => entry.project === 'alpha')
    assert.deepEqual([...alphaEvidence.sessionIds].sort(), ['a-1', 'a-2'])
    assert.ok(!alphaEvidence.sessionIds.includes('a-mismatch'), 'a cwd mismatch must never be attached')
    assert.equal(first.workspaces.find((entry) => entry.project === 'beta').sessionIds[0], 'b-1')

    // IDEMPOTENT: a second pass creates nothing and attaches nothing.
    const second = await backfillWorkspaces({ registry: reg, persistence: store, projectsDir: fix.projectsDir })
    assert.equal(second.totals.created, 0)
    assert.equal(second.totals.attached, 0)
    assert.equal(second.totals.sessions, 3)
    assert.deepEqual(
      second.workspaces.map((entry) => entry.sessionIds.slice().sort()),
      first.workspaces.map((entry) => entry.sessionIds.slice().sort()),
    )
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('an explicit project restricts the pass and an unresolvable directory is reported, not fatal', async () => {
  const fix = fixture()
  try {
    const reg = registry()
    const store = persistence([{ id: 'a-1', cwd: join(fix.projectsDir, 'alpha') }])
    const onlyAlpha = await backfillWorkspaces({
      registry: reg,
      persistence: store,
      projectsDir: fix.projectsDir,
      project: 'ALPHA',
    })
    assert.deepEqual(onlyAlpha.workspaces.map((entry) => entry.project), ['alpha'])
    assert.equal(onlyAlpha.totals.attached, 1)

    const missing = await backfillWorkspaces({
      registry: registry(),
      persistence: persistence([]),
      projectsDir: fix.projectsDir,
      project: 'does-not-exist',
    })
    assert.equal(missing.workspaces.length, 0)
    assert.equal(missing.errors.length, 1)
    assert.match(missing.errors[0].error, /does not resolve/)
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})

test('projectNames enumerates only real project directories, sorted', () => {
  const fix = fixture()
  try {
    assert.deepEqual(projectNames(fix.projectsDir), ['alpha', 'beta'])
    assert.equal(sanitizeProject('  Alpha/Pipeline  '), 'alpha-pipeline')
  } finally {
    rmSync(fix.root, { recursive: true, force: true })
  }
})
