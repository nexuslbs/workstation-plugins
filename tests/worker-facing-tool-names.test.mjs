// Cross-plugin regression test for the TOOL NAME contract of the capability
// CONSUMERS plus the typed facade tools (research gap J / S6 / I1 / I2,
// 2026-09-29; dsh-convention rename, 2026-09-29; tools-typed, 2026-09-29).
//
//   node --test tests/worker-facing-tool-names.test.mjs
//
// WHY IT EXISTS
// The model provider REJECTS a model-facing tool name outside `^[a-zA-Z0-9_-]+$`
// (`Invalid 'tools[0].name'`). Every tool of this repository is therefore
// snake_case. The space-named facade names (`email list`, `totp code`,
// `web search`, ...) were the historical exception and are gone: the snake_case
// name is THE name, registered once with the same parameters and behaviour.
//
// This test pins the single legal name set so a regression that reintroduces a
// space-named tool fails here instead of crashing every dispatched worker at boot.
//
// It needs NO harness, NO model call, NO network and NO container: it applies the
// plugins against a fake tool registry and inspects the registered names only.

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply as applyEmail } from '../plugins/email-tools/index.ts'
import { apply as applySms } from '../plugins/sms-tools/index.ts'
import { apply as applyTotp } from '../plugins/totp-tools/index.ts'
import { apply as applyWebSearch } from '../plugins/web-search-tools/index.ts'
import { apply as applyToolsTyped } from '../plugins/tools-typed/index.ts'

/** The model-facing name constraint enforced by the model provider. */
const LEGAL = /^[a-zA-Z0-9_-]+$/

/** The snake_case names every consumer must register. */
const TOOL_NAMES = {
  email: ['email_accounts', 'email_code', 'email_get', 'email_list', 'email_send'],
  sms: ['sms_code', 'sms_get', 'sms_list', 'sms_numbers'],
  totp: ['totp_code', 'totp_list'],
  'web-search': ['web_search_grounded', 'web_search_providers'],
  'tools-typed': ['jq_query', 'python_run'],
}

const APPLY = {
  email: applyEmail,
  sms: applySms,
  totp: applyTotp,
  'web-search': applyWebSearch,
  'tools-typed': applyToolsTyped,
}

/**
 * Apply one consumer against a capturing tool registry.
 *
 * The capability services are never resolved at REGISTRATION time (every handler
 * resolves them per call), so a permissive stub is enough: this test cares about
 * the registered NAMES, and it never executes a handler.
 */
function register(plane, config = {}) {
  const names = []
  const ctx = {
    tools: {
      register: (definition) => {
        names.push(definition.name)
        return () => {}
      },
    },
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  const stub = () => async () => ({})
  for (const key of ['email', 'sms', 'totp', 'web-search', 'webSearch', 'services', 'kernel', 'logger']) {
    ctx[key] = new Proxy({}, { get: () => stub })
  }
  APPLY[plane](ctx, config)
  return names
}

const sorted = (values) => [...values].sort()

for (const plane of Object.keys(APPLY)) {
  test(`${plane}: registers ONLY the snake_case names`, () => {
    const names = register(plane)
    assert.deepEqual(sorted(names), TOOL_NAMES[plane], `${plane}: tool name set changed`)
    for (const name of names) {
      assert.match(name, LEGAL, `${plane}: '${name}' is not a legal model-facing tool name`)
    }
    assert.equal(new Set(names).size, names.length, `${plane}: a tool name is registered twice`)
  })

  test(`${plane}: a legacy workerFacing flag cannot change the names`, () => {
    assert.deepEqual(register(plane, { workerFacing: true }), register(plane), `${plane}: workerFacing must be ignored`)
  })
}
