// Cross-plugin regression test for the LEGAL (model-facing) TOOL NAME contract of
// the four capability CONSUMERS (research gap J / S6 / I1 / I2, 2026-09-29).
//
//   node --test tests/worker-facing-tool-names.test.mjs
//
// WHY IT EXISTS
// The workstation facade (`config/workstation.yml`) and the dsh WORKER profiles
// compose the SAME consumer plugins in two different modes:
//
//   * FACADE  (`workerFacing` absent/false): the omniagent contract, whose tool
//     names contain SPACES (`email list`, `totp code`, `web search`, ...). Those
//     names are served by the facade, never by the model.
//   * WORKER  (`workerFacing: true`): the profile layer of every dsh role. The
//     model provider REJECTS a model-facing tool name outside
//     `^[a-zA-Z0-9_-]+$` (`Invalid 'tools[0].name'`, see the wiki page
//     Reference/Omniagent/Workstation-DSH-Sessions.md §7), so a worker boot MUST
//     NOT register a single space-named tool.
//
// Only the name set of the SELECTED plane may be registered. This test pins
// both planes: a regression that leaks a space-named tool into a worker profile
// fails here instead of crashing every dispatched worker at boot.
//
// It needs NO harness, NO model call, NO network and NO container: it applies the
// plugins against a fake tool registry and inspects the registered names only.

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply as applyEmail } from '../plugins/email-tools/index.ts'
import { apply as applySms } from '../plugins/sms-tools/index.ts'
import { apply as applyTotp } from '../plugins/totp-tools/index.ts'
import { apply as applyWebSearch } from '../plugins/web-search-tools/index.ts'

/** The model-facing name constraint enforced by the model provider. */
const LEGAL = /^[a-zA-Z0-9_-]+$/

/** The facade (omniagent) contract: UNCHANGED by this change, spaces included. */
const FACADE_NAMES = {
  email: ['email accounts', 'email code', 'email get', 'email list', 'email send'],
  sms: ['sms code', 'sms get', 'sms list', 'sms numbers'],
  totp: ['totp code', 'totp list'],
  'web-search': ['web search', 'web search providers'],
}

/** The worker plane: ONLY legal names may exist. */
const WORKER_NAMES = {
  email: ['email_accounts', 'email_code', 'email_get', 'email_list', 'email_send'],
  sms: ['sms_code', 'sms_get', 'sms_list', 'sms_numbers'],
  totp: ['totp_code', 'totp_list'],
  'web-search': ['web_search_grounded', 'web_search_providers'],
}

const APPLY = {
  email: applyEmail,
  sms: applySms,
  totp: applyTotp,
  'web-search': applyWebSearch,
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
  test(`${plane}: workerFacing=true registers ONLY legal names (no spaces)`, () => {
    const names = register(plane, { workerFacing: true })
    assert.deepEqual(sorted(names), WORKER_NAMES[plane], `${plane}: worker plane names changed`)
    for (const name of names) {
      assert.match(name, LEGAL, `${plane}: '${name}' is not a legal model-facing tool name`)
    }
    assert.equal(new Set(names).size, names.length, `${plane}: a tool name is registered twice`)
  })

  test(`${plane}: the facade plane (default) keeps the space-named contract`, () => {
    const names = register(plane)
    assert.deepEqual(sorted(names), FACADE_NAMES[plane], `${plane}: facade names changed`)
    assert.ok(
      names.some((name) => name.includes(' ')),
      `${plane}: the facade plane lost its space-named tools`,
    )
  })

  test(`${plane}: workerFacing=false is the facade plane (explicitly)`, () => {
    assert.deepEqual(register(plane, { workerFacing: false }), register(plane), `${plane}: false must equal the default`)
  })
}
