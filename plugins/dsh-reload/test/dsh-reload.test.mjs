// Test for the dsh-reload plugin (plugins/dsh-reload): the imperative
// in-process reload of ONE running dsh plugin row THROUGH THE PROVEN SEAM.
//
//   node --test plugins/dsh-reload/test/dsh-reload.test.mjs
//
// It needs NO harness, NO model call and NO network. The fake Loader reconciles
// from the watched HOME patch file exactly like the harness does (writing the
// patch fires a re-composition; await() applies it), so the test exercises the
// SAME remove+add seam the running plugin_remove / plugin_add tools drive. A
// temp OMNI_DIR makes the pricing provenance deterministic.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, evictPrefix, moduleFromPatchText, name } from '../index.ts'

/** The model-facing tool-name constraint. */
const LEGAL = /^[a-zA-Z0-9_-]+$/

const PREFIX = '/var/lib/workstation/sources/'
const ENTRY_URL = 'file:///var/lib/workstation/sources/workstation-plugins/plugins/agent-run/index.ts?rev=20261003-pricing'
const ENTRY_SPEC = '/var/lib/workstation/sources/workstation-plugins/plugins/agent-run/index.ts?rev=20261003-pricing'
const SHARED_URL = 'file:///var/lib/workstation/sources/workstation-plugins/shared/usage.ts'

/** id -> the tool name its row registers once mounted. */
const ROW_TOOLS = { 'agent-run': 'agent_run', 'live-fixture': 'fixture_ping' }

/** Read the rows the fake HOME patch declares (strip the generation header). */
function readPatchRows(file) {
  const body = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  if (body.trim().length === 0) return []
  const groups = JSON.parse(body)
  const rows = []
  for (const group of groups) for (const row of (group.insert ?? [])) rows.push(row)
  return rows
}

/**
 * A fake harness: a real HOME patch file plus the two surfaces the seam drives
 * (the tool registry and the Loader). `loader.await()` applies the patch to the
 * mounted set, which is what the harness' own re-composition does.
 */
function makeHarness({ patches = [], cacheKeys = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reload-'))
  const patchFile = join(dir, 'cordis.patch.yml')
  const body = patches.length === 0 ? '[]' : JSON.stringify([{ insert: patches }], null, 2)
  writeFileSync(patchFile, `# plugin-live generation=test\n${body}\n`)

  const registrations = []
  const mounted = new Map()
  const calls = { removed: [], created: [] }
  const group = { data: [], tree: { write() {} }, async create() {}, remove() {} }

  const tools = {
    register(definition) { registrations.push(definition); return () => {} },
    schemas() {
      const rowNames = [...mounted.keys()].map((id) => ({ name: ROW_TOOLS[id] ?? `${id}_tool` }))
      return [...registrations.map((definition) => ({ name: definition.name })), ...rowNames]
    },
  }

  const loader = {
    root: group,
    internal: { loadCache: new Map(cacheKeys.map((key) => [key, {}])) },
    entries() {
      return [...mounted.entries()].map(([id, module]) => ({
        id,
        options: { id, name: module },
        fiber: { state: 'active' },
        parent: group,
      }))
    },
    async await() {
      const declared = new Map(readPatchRows(patchFile).map((row) => [row.id, row.name]))
      for (const id of [...mounted.keys()]) {
        if (!declared.has(id)) { mounted.delete(id); calls.removed.push(id) }
      }
      for (const [id, module] of declared) {
        if (!mounted.has(id)) { mounted.set(id, module); calls.created.push(id) }
      }
    },
  }

  const ctx = {
    tools,
    loader,
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    get(key) { return key === 'profileContext' ? { home: dir, overlays: [] } : undefined },
  }
  return { ctx, registrations, calls, loader, dir, patchFile }
}

/** Write a minimal valid price table under a temp OMNI_DIR and point the env at it. */
function usePriceFixture() {
  const omni = mkdtempSync(join(tmpdir(), 'dsh-reload-omni-'))
  mkdirSync(join(omni, 'config'), { recursive: true })
  writeFileSync(join(omni, 'config', 'model_prices.yml'), [
    'version: price_table_v3',
    'providers:',
    '  deepseek:',
    '    deepseek-flash:',
    '      input: 0.30',
    '      cached_input: 0.006',
    '      output: 1.20',
    '      cache_write: 0.30',
    '',
  ].join('\n'))
  const previous = process.env.OMNI_DIR
  process.env.OMNI_DIR = omni
  return { omni, restore() { if (previous === undefined) delete process.env.OMNI_DIR; else process.env.OMNI_DIR = previous } }
}

test('dsh-reload: registers one legally named dsh_reload tool requiring id', () => {
  const { ctx, registrations } = makeHarness()
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
    [SHARED_URL, {}],
    ['file:///somewhere/else/index.ts', {}],
    ['node:fs', {}],
  ])
  const outcome = evictPrefix(PREFIX, cache)
  assert.deepEqual(outcome.urls, [ENTRY_URL, SHARED_URL].sort())
  assert.equal(cache.has(ENTRY_URL), false)
  assert.equal(cache.has('file:///somewhere/else/index.ts'), true)
  assert.equal(cache.has('node:fs'), true)
  assert.equal(cache.size, 2)
})

test('dsh-reload: one execute removes and re-adds through the seam and asserts the tool set', async () => {
  const prices = usePriceFixture()
  try {
    const { ctx, registrations, calls, loader, patchFile } = makeHarness({
      patches: [{ id: 'agent-run', name: ENTRY_SPEC }],
      cacheKeys: [ENTRY_URL, SHARED_URL, 'file:///somewhere/else/index.ts'],
    })
    await loader.await() // the harness mounts the row at boot
    apply(ctx)
    const tool = registrations.find((definition) => definition.name === 'dsh_reload')

    const result = await tool.execute({ id: 'agent-run' })

    assert.equal(result.ok, true)
    assert.equal(result.id, 'agent-run')
    assert.equal(result.module, ENTRY_SPEC)
    assert.equal(result.resolved_from, 'loader')
    assert.equal(result.disposed, true)
    assert.equal(result.mounted, true)
    assert.equal(result.postcondition_ok, true)
    assert.equal(result.fallback_used, false)
    assert.deepEqual([...result.tools_after].sort(), [...result.tools_before].sort())
    assert.ok(result.tools_before.includes('agent_run'))
    assert.ok(result.tools_before.includes('dsh_reload'))
    assert.deepEqual(result.tools_added, [])
    assert.deepEqual(result.tools_removed, [])

    // The whole source graph was evicted, but a foreign cache key survived.
    assert.ok(result.evicted.includes(ENTRY_URL))
    assert.ok(result.evicted.includes(SHARED_URL))
    assert.equal(result.evicted.includes('file:///somewhere/else/index.ts'), false)
    assert.equal(result.require_cache_evicted, 0)

    // The row went through the same dispose+mount cycle the tools drive.
    // created has two entries: the harness boot mount, then the reload mount.
    assert.deepEqual(calls.removed, ['agent-run'])
    assert.deepEqual(calls.created, ['agent-run', 'agent-run'])
    const rows = readPatchRows(patchFile)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'agent-run')

    // The pricing provenance comes from the freshly loaded shared module.
    assert.equal(result.pricing.version, 'price_table_v3')
    assert.equal(result.pricing.source, 'model_prices.yml')
    assert.match(result.pricing.pricing_ref, /^config\/model_prices\.yml@price_table_v3#[0-9a-f]{16}$/)
  } finally {
    prices.restore()
  }
})

test('dsh-reload: resolves the module from the live config file when the tree has no row', async () => {
  const { ctx, registrations, dir } = makeHarness()
  const configFile = join(dir, 'workstation.yml')
  writeFileSync(configFile, `- {"insert":[{"id":"not-mounted","name":"${ENTRY_SPEC}"}]}\n`)
  apply(ctx, { configFile })
  const tool = registrations.find((definition) => definition.name === 'dsh_reload')

  const result = await tool.execute({ id: 'not-mounted' })

  assert.equal(result.module, ENTRY_SPEC)
  assert.equal(result.resolved_from, 'config-file')
  // Not declared in a live layer: the seam cannot dispose/re-add it, so it is
  // reported honestly instead of a fabricated success.
  assert.equal(result.mounted, false)
  assert.equal(result.ok, false)
  assert.deepEqual(result.declared_before, { live: false, config: false })
  assert.match(result.warning, /not declared in a live layer/)
})

test('dsh-reload: refuses loudly when the ESM loadCache is unavailable', async () => {
  const { ctx, registrations } = makeHarness()
  ctx.loader.internal = undefined
  apply(ctx)
  await assert.rejects(
    () => registrations[0].execute({ id: 'agent-run' }),
    /loadCache is unavailable/,
  )
})
