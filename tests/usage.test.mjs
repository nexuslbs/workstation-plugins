// Unit tests of the per-agent-call usage accounting (no harness, no model).
//
// They pin the contract the agent-calling tools rely on:
//   * bucket naming matches the harness `projectKey`;
//   * one dict per `assistant/message`, in call order;
//   * a nested `tool/result` usage array is CONCATENATED at the call point;
//   * the LAST entry is the agent's own aggregate;
//   * cost comes from the fixed PRICE_TABLE and carries its provenance, or is
//     null when the model is not in the table (never agent-estimated).

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  PRICE_TABLE,
  collectUsage,
  costOf,
  projectKey,
  usageFromSession,
} from '../shared/usage.ts'

/** One concatenated-frame zstd session log from JSONL events. */
function writeLog(dir, events) {
  const frames = events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(frames))
  return file
}

test('projectKey matches the harness session bucket naming', () => {
  assert.equal(projectKey('/var/lib/workstation/projects/workstation'), '--var-lib-workstation-projects-workstation--')
  assert.equal(projectKey('/var/lib/workstation/projects/default'), '--var-lib-workstation-projects-default--')
})

test('cost comes from the fixed PRICE_TABLE with its provenance, else null', () => {
  const route = 'test-provider/test-model'
  assert.equal(PRICE_TABLE[route], undefined)
  assert.equal(costOf('test-provider', 'test-model', { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }), null)
  PRICE_TABLE[route] = { input: 1, output: 2, cache_read: 0.5, cache_write: 0.25 }
  const cost = costOf('test-provider', 'test-model', { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 })
  delete PRICE_TABLE[route]
  assert.equal(cost.amount_usd, (1000 / 1e6) * 1 + (500 / 1e6) * 2 + (2000 / 1e6) * 0.5)
  assert.equal(cost.is_estimate, true)
  assert.equal(cost.source, 'price_table_v1')
  assert.match(cost.pricing_ref, /PRICE_TABLE/)
})

test('usageFromSession appends one dict per LLM call, splices nested arrays, aggregate LAST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-log-'))
  const nested = [
    { agent: 'websearcher', input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: null, cost: null, provider: 'google', model: 'gemini-2.5-flash', request_id: null, details: { kind: 'llm-call' } },
    { agent: 'websearcher', input_tokens: 0, output_tokens: 0, total_tokens: 15, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: null, cost: null, provider: null, model: null, request_id: null, details: { kind: 'agent-aggregate' } },
  ]
  const log = writeLog(dir, [
    { type: 'session', id: 'session-1', cwd: '/x', delegationDepth: 1 },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120 }, message: { id: 'm1', source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { type: 'tool/result', seq: 4, data: { meta: { _meta: { usage: nested } }, message: { content: [] } } },
    { type: 'assistant/message', seq: 6, data: { turn: 1, step: 2, usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 40 }, message: { id: 'm2', source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
  ])
  const report = usageFromSession(log, 'researcher')
  assert.equal(report.usage.length, 5)
  assert.deepEqual(report.usage.map((entry) => entry.agent), ['researcher', 'websearcher', 'websearcher', 'researcher', 'researcher'])
  assert.deepEqual(report.usage.map((entry) => entry.total_tokens), [120, 15, 15, 40, 160])
  // The children's LLM calls carry their own provider/model; the parent's do too.
  assert.equal(report.usage[0].provider, 'deepseek-official')
  assert.equal(report.usage[0].model, 'deepseek-flash')
  assert.equal(report.usage[3].input_tokens, 30)
  // LAST entry is THIS agent's aggregate of its OWN calls only (120+40 = 160);
  // the concatenated subagent entries above are not folded into it.
  const aggregate = report.usage.at(-1)
  assert.equal(aggregate.details.kind, 'agent-aggregate')
  assert.equal(aggregate.details.llm_calls, 2)
  assert.equal(aggregate.input_tokens, 130)
  assert.equal(aggregate.output_tokens, 30)
  assert.equal(aggregate.total_tokens, 160)
  // Both OWN calls are priced from the table, so the aggregate carries their sum
  // with the same provenance (nested subagent entries are NOT folded in).
  assert.equal(aggregate.cost.source, 'price_table_v1')
  assert.equal(aggregate.cost.amount_usd, 0.000075)
})

test('collectUsage finds the child session by marker and errors when it is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-bucket-'))
  const bucket = projectKey('/w')
  const sessionDir = join(dir, bucket, 'session-abc')
  mkdirSync(sessionDir, { recursive: true })
  writeLog(sessionDir, [
    { type: 'session', id: 'session-abc', createdAt: 1, cwd: '/w' },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '[dsh-usage-run=TOKEN] hello' }] } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 }, message: { source: {} } } },
  ])
  const hit = collectUsage({ sessionsDir: dir, bucket, before: new Set(), marker: '[dsh-usage-run=TOKEN]', agent: 'websearcher' })
  assert.equal(hit.error, undefined)
  assert.equal(hit.usage.length, 2)
  assert.equal(hit.usage[0].agent, 'websearcher')
  assert.equal(hit.usage.at(-1).details.kind, 'agent-aggregate')
  const miss = collectUsage({ sessionsDir: dir, bucket, before: new Set(), marker: '[dsh-usage-run=OTHER]', agent: 'websearcher' })
  assert.match(String(miss.error), /no child session carrying the usage marker/)
  assert.deepEqual(miss.usage, [])
})

// ---------------------------------------------------------------------------
// The agent-calling tools: normal payload unchanged, `_meta` projected
// ---------------------------------------------------------------------------

import { apply as applyAgentRun } from '../plugins/agent-run/index.ts'
import { apply as applyRoleDelegate } from '../plugins/role-delegate/index.ts'

/** Register one plugin against a minimal fake ToolRuntime context. */
function registerPlugin(apply, config) {
  const tools = new Map()
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    effect(callback) { callback(); return () => {} },
    get() { return undefined },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, config)
  return tools
}

test('agent_run and role-delegate render the normal payload WITHOUT _meta', () => {
  const common = { dshHome: '/tmp/usage-home', harnessDir: '/harness', roleProfilesDir: '/tmp/usage-profiles', projectsDir: '/tmp/usage-projects' }
  const agentRun = registerPlugin(applyAgentRun, common).get('agent_run')
  const delegate = registerPlugin(applyRoleDelegate, { ...common, roles: [{ tool: 'vision', role: 'vision-captcha' }] })
  const value = { role: 'researcher', answer: 'A', _meta: { usage: [{ agent: 'researcher' }] } }
  for (const tool of [agentRun, delegate.get('vision'), delegate.get('delegate')].filter(Boolean)) {
    const rendered = JSON.stringify(tool.output.render({}, value))
    assert.equal(rendered.includes('_meta'), false, `${tool.name} must not show _meta to the model`)
    // The normal payload fields survive untouched.
    assert.match(rendered, /researcher/)
    // And the additive `_meta` is projected for the session log / caller.
    const meta = tool.output.presentationMeta({}, value)
    assert.equal(meta._meta.usage[0].agent, 'researcher')
  }
})
