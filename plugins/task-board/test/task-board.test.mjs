// Offline regression test for the shared task board plugin.
//
//   node --test plugins/task-board/test/task-board.test.mjs
//
// It needs NO harness, NO model call, NO network and NO container: it applies
// the plugin against a fake tool registry, then drives the registered tools
// directly. Two plugin instances pointed at ONE queuePath simulate two separate
// worker processes sharing the file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.ts'

const LEGAL = /^[a-zA-Z0-9_-]+$/
const TOOL_NAMES = ['task_board_post', 'task_board_list', 'task_board_claim', 'task_board_complete', 'task_board_get']

/** Apply the plugin and return the registered definitions by name. */
function load(config) {
  const tools = new Map()
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, config)
  return tools
}

function tempQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'task-board-test-'))
  return { dir, queuePath: join(dir, 'board.json') }
}

test('task-board: registers the five legal snake_case tools once', () => {
  const tools = load({ role: 'developer', queuePath: join(tempQueue().dir, 'board.json') })
  assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort())
  for (const name of TOOL_NAMES) assert.match(name, LEGAL)
  assert.ok(tools.get('task_board_post').parameters.required.includes('title'))
  assert.ok(tools.get('task_board_post').parameters.required.includes('evidence_required'))
  assert.ok(tools.get('task_board_complete').parameters.required.includes('evidence'))
  assert.ok(tools.get('task_board_complete').parameters.required.includes('artifact'))
})

test('task-board: post -> list -> claim -> complete -> get round trip persists evidence and artifact', async () => {
  const { dir, queuePath } = tempQueue()
  try {
    const worker = load({ role: 'developer', queuePath, maxEntries: 100 })
    const peer = load({ role: 'tester', queuePath, maxEntries: 100 })

    const posted = await worker.get('task_board_post').execute({
      title: 'run the acceptance battery',
      objective: 'execute the battery and paste raw output',
      assignee_role: 'tester',
      evidence_required: 'raw node --test output with exit status',
      project: 'task4027',
      timeoutSecs: 600,
    })
    assert.equal(posted.posted, true)
    assert.equal(posted.entry.status, 'open')
    assert.equal(posted.entry.from_role, 'developer')
    assert.equal(posted.entry.evidence_required, 'raw node --test output with exit status')
    const id = posted.entry.id

    const listed = await peer.get('task_board_list').execute({ assignee_role: 'tester' })
    assert.equal(listed.count, 1)
    assert.equal(listed.entries[0].id, id)
    assert.equal(listed.entries[0].status, 'open')
    assert.equal(listed.entries[0].claimant, null)

    const claimed = await peer.get('task_board_claim').execute({ id })
    assert.equal(claimed.claimed, true)
    assert.equal(claimed.entry.status, 'claimed')
    assert.equal(claimed.entry.claimant, 'tester')

    const completed = await peer.get('task_board_complete').execute({
      id,
      evidence: '# tests 5\n# pass 5\n# fail 0',
      artifact: 'sha256:deadbeef',
    })
    assert.equal(completed.completed, true)
    assert.equal(completed.entry.status, 'completed')
    assert.equal(completed.entry.evidence, '# tests 5\n# pass 5\n# fail 0')
    assert.equal(completed.entry.artifact, 'sha256:deadbeef')

    const fetched = await worker.get('task_board_get').execute({ id })
    assert.equal(fetched.entry.id, id)
    assert.equal(fetched.entry.status, 'completed')
    assert.equal(fetched.entry.evidence, '# tests 5\n# pass 5\n# fail 0')
    assert.equal(fetched.entry.artifact, 'sha256:deadbeef')

    const onDisk = JSON.parse(readFileSync(queuePath, 'utf8'))
    assert.equal(onDisk.entries.length, 1)
    assert.equal(onDisk.entries[0].evidence, '# tests 5\n# pass 5\n# fail 0')
    assert.equal(onDisk.entries[0].artifact, 'sha256:deadbeef')
    assert.equal(existsSync(`${queuePath}.lock`), false, 'the advisory lock must be released')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-board: completion refuses missing or empty evidence/artifact', async () => {
  const { dir, queuePath } = tempQueue()
  try {
    const worker = load({ role: 'developer', queuePath })
    const posted = await worker.get('task_board_post').execute({
      title: 'x',
      objective: 'y',
      assignee_role: 'developer',
      evidence_required: 'z',
    })
    const id = posted.entry.id
    await assert.rejects(
      () => worker.get('task_board_complete').execute({ id, evidence: '', artifact: 'a' }),
      /evidence.*non-empty/,
    )
    await assert.rejects(
      () => worker.get('task_board_complete').execute({ id, evidence: 'e', artifact: '   ' }),
      /artifact.*non-empty/,
    )
    await assert.rejects(
      () => worker.get('task_board_complete').execute({ id, evidence: 'e' }),
      /artifact/,
    )
    const entry = await worker.get('task_board_get').execute({ id })
    assert.equal(entry.entry.status, 'open', 'a refused completion must not settle the entry')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-board: role scoping hides entries from unrelated roles but shows them to the assignee and orchestrators', async () => {
  const { dir, queuePath } = tempQueue()
  try {
    const poster = load({ role: 'developer', queuePath })
    const assignee = load({ role: 'tester', queuePath })
    const stranger = load({ role: 'author', queuePath })
    const orchestrator = load({ role: 'orchestrator', queuePath })

    const posted = await poster.get('task_board_post').execute({
      title: 'peer task',
      objective: 'do it',
      assignee_role: 'tester',
      evidence_required: 'raw proof',
    })
    assert.equal((await assignee.get('task_board_list').execute({})).count, 1)
    assert.equal((await poster.get('task_board_list').execute({})).count, 1)
    assert.equal((await orchestrator.get('task_board_list').execute({})).count, 1)
    assert.equal((await stranger.get('task_board_list').execute({})).count, 0)
    await assert.rejects(
      () => stranger.get('task_board_get').execute({ id: posted.entry.id }),
      /not visible/,
    )
    await assert.rejects(
      () => stranger.get('task_board_claim').execute({ id: posted.entry.id }),
      /not visible/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-board: claim is refused for a peer the entry is not assigned to', async () => {
  const { dir, queuePath } = tempQueue()
  try {
    const poster = load({ role: 'developer', queuePath })
    const other = load({ role: 'author', queuePath })
    const posted = await poster.get('task_board_post').execute({
      title: 'only tester',
      objective: 'do it',
      assignee_role: 'tester',
      evidence_required: 'raw proof',
    })
    // author cannot see it at all; an orchestrator can see it but must not claim
    // a task assigned to a specific peer role.
    const orchestrator = load({ role: 'orchestrator', queuePath })
    await assert.rejects(
      () => orchestrator.get('task_board_claim').execute({ id: posted.entry.id }),
      /cannot be claimed by/,
    )
    assert.equal((await other.get('task_board_list').execute({})).count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-board: bounded queue evicts the oldest settled entry deterministically', async () => {
  const { dir, queuePath } = tempQueue()
  try {
    const board = load({ role: 'orchestrator', queuePath, maxEntries: 2 })
    const first = await board.get('task_board_post').execute({ title: 'one', objective: 'o', assignee_role: '*', evidence_required: 'e' })
    const second = await board.get('task_board_post').execute({ title: 'two', objective: 'o', assignee_role: '*', evidence_required: 'e' })
    await board.get('task_board_complete').execute({ id: first.entry.id, evidence: 'e', artifact: 'a' })
    assert.equal((await board.get('task_board_list').execute({})).count, 2)

    const third = await board.get('task_board_post').execute({ title: 'three', objective: 'o', assignee_role: '*', evidence_required: 'e' })
    const after = await board.get('task_board_list').execute({})
    assert.equal(after.count, 2)
    assert.deepEqual(after.entries.map((entry) => entry.id), [second.entry.id, third.entry.id])
    assert.equal(existsSync(`${queuePath}.lock`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-board: a full board with no settled entry rejects the post', async () => {
  const { dir, queuePath } = tempQueue()
  try {
    const board = load({ role: 'orchestrator', queuePath, maxEntries: 1 })
    await board.get('task_board_post').execute({ title: 'one', objective: 'o', assignee_role: '*', evidence_required: 'e' })
    await assert.rejects(
      () => board.get('task_board_post').execute({ title: 'two', objective: 'o', assignee_role: '*', evidence_required: 'e' }),
      /queue is full/,
    )
    assert.equal(JSON.parse(readFileSync(queuePath, 'utf8')).entries.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
