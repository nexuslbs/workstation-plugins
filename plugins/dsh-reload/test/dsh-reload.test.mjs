// Test for the dsh-reload plugin (plugins/dsh-reload): the imperative
// in-process reload of ONE running dsh plugin row.
//
//   node --test plugins/dsh-reload/test/dsh-reload.test.mjs
//
// It needs NO harness, NO model call, NO network and NO container: it applies
// the plugin against a fake tool registry and a fake Loader tree, then checks
// the eviction, the module resolution and the dispose+remount orchestration.
// The Node-internal loadCache recipe itself is exercised against a real cache
// via a plain Map and (out of band) a real internal loader.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, evictPrefix, moduleFromPatchText, name } from '../index.ts'

/** The model-facing tool-name constraint. */
const LEGAL = /^[a-zA-Z0-9_-]+$/

const PREFIX = '/var/lib/workstation/sources/'
const ENTRY_URL = 'file:///var/lib/workstation/sources/workstation-plugins/plugins/agent-run/index.ts?rev=20261003-pricing'
const ENTRY_SPEC = '/var/lib/workstation/sources/workstation-plugins/plugins/agent-run/index.ts?rev=20261003-pricing'

/** A fake Loader tree: one live entry plus the EntryGroup dispose/mount seam. */
function makeLoader(cache, entrySpec = undefined) {
  const calls = { removed: [], created: [] }
  const store = []
  const group = {
    data: [],
    tree: { write() {} },
    remove(id) {
      calls.removed.push(id)
      const index = store.findIndex((entry) => entry.options?.id === id)
      if (index >= 0) store.splice(index, 1)
      const dataIndex = group.data.findIndex((options) => options?.id === id)
      if (dataIndex >= 0) group.data.splice(dataIndex, 1)
    },
    async create(options) {
      calls.created.push(options)
      store.push({ options, fiber: { state: 'active' }, parent: group })
      return options.id
    },
  }
  if (entrySpec !== undefined) {
    const entry = { options: entrySpec, fiber: { state: 'active' }, parent: group }
    store.push(entry)
    group.data.push(entrySpec)
  }
  return {
    loader: {
      root: group,
      internal: { loadCache: cache },
      entries() { return store },
      async await() {},
    },
    calls,
  }
}

/** A fake dsh plugin context: captures registrations and applies effects eagerly. */
function makeContext(loader) {
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
      schemas() {
        return registrations.map((definition) => ({ name: definition.name }))
      },
    },
    loader,
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, registrations }
}

test('dsh-reload: registers one legally named dsh_reload tool requiring id', () => {
  const { loader } = makeLoader(new Map())
  const { ctx, registrations } = makeContext(loader)
  apply(ctx)
  assert.equal(name, 'dsh-reload')
  assert.equal(registrations.length, 1)
  const tool = registrations[0]
  assert.equal(tool.name, 'dsh_reload')
  assert.ok(LEGAL.test(tool.name), `illegal model-facing tool name: ${tool.name}`)
  assert.deepEqual(tool.parameters.required, ['id'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['id', 'module', 'prefix'])
})

test('dsh-reload: moduleFromPatchText reads managed JSON and block rows', () => {
  const managed = `# plugin-live:managed\n- {"insert":[{"id":"agent-run","name":"${ENTRY_SPEC}"}]}\n`
  assert.equal(moduleFromPatchText(managed, 'agent-run'), ENTRY_SPEC)
  const block = `- id: agent-run\n  name: "/var/lib/workstation/sources/x/index.ts"\n`
  assert.equal(moduleFromPatchText(block, 'agent-run'), '/var/lib/workstation/sources/x/index.ts')
  assert.equal(moduleFromPatchText(managed, 'other-row'), undefined)
})

test('dsh-reload: evictPrefix deletes only the matching cache keys', () => {
  const cache = new Map([
    [ENTRY_URL, {}],
    ['file:///var/lib/workstation/sources/workstation-plugins/shared/usage.ts', {}],
    ['file:///somewhere/else/index.ts', {}],
    ['node:fs', {}],
  ])
  const outcome = evictPrefix(PREFIX, cache)
  assert.deepEqual(outcome.urls, [ENTRY_URL, 'file:///var/lib/workstation/sources/workstation-plugins/shared/usage.ts'].sort())
  assert.equal(cache.has(ENTRY_URL), false)
  assert.equal(cache.has('file:///somewhere/else/index.ts'), true)
  assert.equal(cache.has('node:fs'), true)
  assert.equal(cache.size, 2)
})

test('dsh-reload: one execute disposes, evicts and remounts at the SAME specifier', async () => {
  const cache = new Map([
    [ENTRY_URL, {}],
    ['file:///var/lib/workstation/sources/workstation-plugins/shared/usage.ts', {}],
    ['file:///somewhere/else/index.ts', {}],
  ])
  const { loader, calls } = makeLoader(cache, { id: 'agent-run', name: ENTRY_SPEC })
  const { ctx, registrations } = makeContext(loader)
  apply(ctx)

  const result = await registrations[0].execute({ id: 'agent-run' })

  assert.equal(result.ok, true)
  assert.equal(result.id, 'agent-run')
  assert.equal(result.module, ENTRY_SPEC)
  assert.equal(result.resolved_from, 'loader')
  assert.equal(result.disposed, true)
  assert.equal(result.mounted, true)
  assert.deepEqual(result.evicted, [ENTRY_URL, 'file:///var/lib/workstation/sources/workstation-plugins/shared/usage.ts'].sort())
  assert.equal(result.require_cache_evicted, 0)
  assert.equal(result.next, undefined)

  // The old row was disposed through its own group, then re-created at the SAME name.
  assert.deepEqual(calls.removed, ['agent-run'])
  assert.equal(calls.created.length, 1)
  assert.equal(calls.created[0].id, 'agent-run')
  assert.equal(calls.created[0].name, ENTRY_SPEC)

  // The non-plugin cache entry survived; the row is live again.
  assert.equal(cache.has('file:///somewhere/else/index.ts'), true)
  const live = [...loader.entries()]
  assert.equal(live.length, 1)
  assert.equal(live[0].options.id, 'agent-run')
  assert.equal(live[0].fiber.state, 'active')
})

test('dsh-reload: falls back to the live config file when the tree has no row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reload-'))
  const configFile = join(dir, 'workstation.yml')
  writeFileSync(configFile, `- {"insert":[{"id":"not-mounted","name":"${ENTRY_SPEC}"}]}\n`)

  const cache = new Map([[ENTRY_URL, {}]])
  const { loader, calls } = makeLoader(cache)
  const { ctx, registrations } = makeContext(loader)
  apply(ctx, { configFile })

  const result = await registrations[0].execute({ id: 'not-mounted' })

  assert.equal(result.module, ENTRY_SPEC)
  assert.equal(result.resolved_from, 'config-file')
  assert.equal(result.disposed, false)
  assert.equal(result.mounted, true)
  assert.deepEqual(result.evicted, [ENTRY_URL])
  assert.equal(calls.created[0].name, ENTRY_SPEC)
})

test('dsh-reload: refuses loudly when the ESM loadCache is unavailable', async () => {
  const { loader } = makeLoader(new Map())
  loader.internal = undefined
  const { ctx, registrations } = makeContext(loader)
  apply(ctx)
  await assert.rejects(
    () => registrations[0].execute({ id: 'agent-run' }),
    /loadCache is unavailable/,
  )
})
