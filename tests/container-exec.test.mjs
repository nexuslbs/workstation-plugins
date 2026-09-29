// Regression test for the container-exec consumer (gap-analysis E2/E4/E5/E6/E8,
// decisions B/D/E/F/M): one `<id>_exec` tool per configured concern row, all
// with LEGAL model-facing names (`^[a-zA-Z0-9_-]+$` - the model provider
// rejects space-named tools, see worker-facing-tool-names.test.mjs).
//
//   node --test tests/container-exec.test.mjs
//
// It needs NO harness, NO model call, NO network and NO container: it applies
// the plugin against a fake tool registry and inspects the registered names +
// the tool parameters only.

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../plugins/container-exec/index.ts'

const LEGAL = /^[a-zA-Z0-9_-]+$/

const CONCERNS = {
  datasci: { service: 'workstation-datasci', image: 'ghcr.io/nexuslbs/omni-images/workstation-datasci:0.0.1' },
  office: { service: 'workstation-office', image: 'ghcr.io/nexuslbs/omni-images/workstation-office:0.0.1' },
  media: { service: 'workstation-media', image: 'ghcr.io/nexuslbs/omni-images/workstation-media:0.0.1' },
}

function register(config = {}) {
  const tools = []
  const ctx = {
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
    get: () => undefined,
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx, config)
  return tools
}

test('container-exec: one <id>_exec tool per configured concern, all legal names', () => {
  const tools = register({ concerns: CONCERNS })
  assert.equal(tools.length, 3, 'expected exactly one tool per concern row')
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['datasci_exec', 'media_exec', 'office_exec'])
  for (const name of names) {
    assert.match(name, LEGAL, `'${name}' is not a legal model-facing tool name`)
  }
  assert.equal(new Set(names).size, names.length, 'a tool name is registered twice')
})

test('container-exec: every tool declares command + run parameters', () => {
  const tools = register({ concerns: CONCERNS })
  for (const tool of tools) {
    // defineTool compiles the author-form parameter map to JSON Schema:
    // the registered definition carries `parameters.properties.<name>`.
    const properties = tool.parameters?.properties ?? tool.parameters ?? {}
    assert.equal(properties.command?.type, 'string', `${tool.name}: command must be a string`)
    assert.equal(properties.run?.type, 'boolean', `${tool.name}: run must be a boolean`)
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name}: no description`)
  }
})

test('container-exec: no concerns configured -> no tools registered', () => {
  assert.deepEqual(register({}), [])
  assert.deepEqual(register(), [])
})

test('container-exec: a row without a service/image is skipped (no crash)', () => {
  const tools = register({
    concerns: {
      broken: { service: '', image: '' },
      datasci: CONCERNS.datasci,
    },
  })
  assert.deepEqual(tools.map((tool) => tool.name), ['datasci_exec'])
})