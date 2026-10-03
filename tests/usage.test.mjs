// Unit tests of the per-agent-call usage accounting (no harness, no model).
//
// They pin the contract the agent-calling tools rely on:
//   * bucket naming matches the harness `projectKey`;
//   * one dict per `assistant/message`, in call order;
//   * a nested `tool/result` usage array is CONCATENATED at the call point;
//   * the LAST entry is the agent's own aggregate;
//   * cost comes from the SHARED external definition file
//     `{OMNI_DIR}/config/model_prices.yml` (`shared/pricing.ts`) with its
//     provenance, or is null when the file does not price the route (never
//     agent-estimated);
//   * there is NO time dimension: ONE price class per model, so the cost is a
//     pure function of (provider, model, tokens) - the earlier peak/off-peak
//     layer is REMOVED and a stale file that still carries it is INVALID.
//
// The suite runs against a TEMP omni dir seeded with the documented file, so it
// never depends on the machine's OMNI_DIR and never on the wall clock.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/** The documented definition file: ONE price class per model (no off-peak). */
const FIXTURE = `version: price_table_v3

providers:
  deepseek:
    deepseek-flash:
      input: 0.30
      cached_input: 0.006
      output: 1.20
      cache_write: 0.30
      reasoning: 1.20
    deepseek-v4-flash:
      input: 0.30
      cached_input: 0.006
      output: 1.20
      cache_write: 0.30
      reasoning: 1.20
    deepseek-v4.1-flash:
      input: 0.30
      cached_input: 0.006
      output: 1.20
      cache_write: 0.30
      reasoning: 1.20
    deepseek-v4-pro:
      input: 1.32
      cached_input: 0.044
      output: 3.96
      cache_write: 1.32
      reasoning: 3.96
  google:
    gemini-2.5-flash:
      input: 0.30
      cached_input: 0.03
      output: 2.50
      cache_write: 0.30

aliases:
  deepseek-official: deepseek
  opencode-go: deepseek
`

// A private omni dir for the whole suite: the cost helpers resolve
// `{OMNI_DIR}/config/model_prices.yml` by default.
const omniDir = mkdtempSync(join(tmpdir(), 'usage-pricing-omni-'))
mkdirSync(join(omniDir, 'config'), { recursive: true })
writeFileSync(join(omniDir, 'config', 'model_prices.yml'), FIXTURE)
process.env.OMNI_DIR = omniDir

const {
  PRICES_FILE,
  collectUsage,
  costOf,
  loadPriceTable,
  parsePriceYaml,
  priceFilePath,
  projectKey,
  usageFromSession,
} = await import('../shared/usage.ts')

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? 'value'}: got ${actual}, want ${expected}`)
}

/** One concatenated-frame zstd session log from JSONL events. */
function writeLog(dir, events) {
  const frames = events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(frames))
  return file
}

/** A temp definition file (never the suite's shared one). */
function writePrices(name, text) {
  const dir = mkdtempSync(join(tmpdir(), `usage-pricing-${name}-`))
  const path = join(dir, 'model_prices.yml')
  if (text !== null) writeFileSync(path, text)
  return path
}

test('projectKey matches the harness session bucket naming', () => {
  assert.equal(projectKey('/var/lib/workstation/projects/workstation'), '--var-lib-workstation-projects-workstation--')
  assert.equal(projectKey('/var/lib/workstation/projects/default'), '--var-lib-workstation-projects-default--')
})

test('the default file is {OMNI_DIR}/config/model_prices.yml', () => {
  assert.equal(PRICES_FILE, 'model_prices.yml')
  assert.equal(priceFilePath(), join(omniDir, 'config', 'model_prices.yml'))
  assert.equal(loadPriceTable().status, 'loaded')
})

test('cost is priced from the shared file with provenance and NO time dimension', () => {
  const table = loadPriceTable()
  const tokens = { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 0 }
  // 1,000,000 * 0.30 + 200,000 cache-hit * 0.006 + 100,000 * 1.20 = 0.4212.
  const expected = (1_000_000 / 1e6) * 0.3 + (200_000 / 1e6) * 0.006 + (100_000 / 1e6) * 1.2
  const first = costOf('deepseek-official', 'deepseek-flash', tokens, table)
  close(first.amount_usd, expected, 'amount')
  assert.equal(first.is_estimate, true)
  assert.equal(first.source, 'model_prices.yml')
  assert.match(first.pricing_ref, /^config\/model_prices\.yml@price_table_v3#[0-9a-f]{16}$/)
  // The cost block carries NO rate class, NO call time and NO multiplier: the
  // cost path takes no timestamp at all.
  assert.equal(first.rate_class, undefined, 'no rate class on a single-class cost')
  assert.equal(first.call_time, undefined, 'no call time on a single-class cost')
  assert.equal(first.off_peak_factor, undefined)
  // The SAME call is priced identically however often it is computed.
  const again = costOf('deepseek-official', 'deepseek-flash', tokens, table)
  assert.deepEqual(again, first)
})

test('a route absent from a valid file stays unpriced (null), never fabricated', () => {
  const table = loadPriceTable()
  assert.equal(costOf('acme', 'mystery-model', { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, table), null)
})

test('missing / empty files yield a numeric 0 cost, never an error', () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const missing = loadPriceTable(join(mkdtempSync(join(tmpdir(), 'usage-missing-')), 'model_prices.yml'))
  assert.equal(missing.status, 'missing')
  const missingCost = costOf('deepseek-official', 'deepseek-flash', tokens, missing)
  assert.equal(missingCost.amount_usd, 0)
  assert.equal(missingCost.pricing_ref, 'config/model_prices.yml#missing')
  const empty = loadPriceTable(writePrices('empty', '\n# nothing here\n'))
  assert.equal(empty.status, 'empty')
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, empty).amount_usd, 0)
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, empty).pricing_ref, 'config/model_prices.yml#empty')
})

test('an invalid file stores NO cost (null), never an error and never a 0', () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const invalid = loadPriceTable(writePrices('invalid', 'providers: [not a map\n  :::\n  - oops\n'))
  assert.equal(invalid.status, 'invalid')
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, invalid), null)
})

test('a stale file with the REMOVED time-aware keys is rejected (strict schema)', () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const staleFiles = [
    // the removed file-level off-peak calendar
    'off_peak:\n  default_class: off-peak\n  weekdays_only: true\n  holiday_dates: []\n  windows:\n    - start: "01:00"\n      end: "04:00"\n      class: peak\nproviders:\n  deepseek:\n    deepseek-flash:\n      input: 0.30\n      cached_input: 0.006\n      output: 1.20\n      cache_write: 0.30\n',
    // the removed per-route multiplier
    'providers:\n  deepseek:\n    deepseek-flash:\n      input: 0.30\n      cached_input: 0.006\n      output: 1.20\n      cache_write: 0.30\n      off_peak_factor: 0.5\n',
    // any other key outside the canonical schema
    'future_top_level: yes\nproviders:\n  deepseek:\n    deepseek-flash:\n      input: 0.30\n      cached_input: 0.006\n      output: 1.20\n      cache_write: 0.30\n',
    'providers:\n  deepseek:\n    deepseek-flash:\n      input: 0.30\n      cached_input: 0.006\n      output: 1.20\n      cache_write: 0.30\n      rate_class: peak\n',
  ]
  staleFiles.forEach((stale, index) => {
    const table = loadPriceTable(writePrices(`stale-${index}`, stale))
    assert.equal(table.status, 'invalid', `stale file #${index} must be REJECTED, never tolerated`)
    assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, table), null, `stale file #${index} must store no cost`)
  })
  // The SAME rates in the canonical schema DO price: the rejection is about the
  // schema, not about the rates.
  const canonical = loadPriceTable(writePrices('canonical', FIXTURE))
  close(costOf('deepseek-official', 'deepseek-flash', tokens, canonical).amount_usd, 0.3, 'canonical control')
})

test('the built-in YAML subset parser reads the documented file and rejects garbage', () => {
  const parsed = parsePriceYaml(FIXTURE)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.version, 'price_table_v3')
  assert.equal(parsed.providers.deepseek['deepseek-flash'].input, 0.3)
  assert.equal(parsed.providers.deepseek['deepseek-flash'].cached_input, 0.006)
  assert.equal(parsed.providers.deepseek['deepseek-flash'].off_peak_factor, undefined)
  assert.equal(parsed.aliases['deepseek-official'], 'deepseek')
  assert.equal(parsed.offPeak, undefined, 'no off-peak calendar exists any more')
  assert.equal(parsePriceYaml('providers: [not a map\n  :::\n  - oops\n'), undefined)
  assert.equal(parsePriceYaml('providers:\n  deepseek:\n    m1\n'), undefined)
  // Strict schema at the parser level too.
  assert.equal(parsePriceYaml('off_peak:\n  default_class: peak\nproviders:\n  deepseek:\n    m1:\n      input: 1.0\n'), undefined)
  assert.equal(parsePriceYaml('providers:\n  deepseek:\n    m1:\n      input: 1.0\n      off_peak_factor: 0.5\n'), undefined)
})

test('the SHARED definition file prices the same route the same way', (t) => {
  // Cross-side parity fixture: when the runner is given the real deployed file
  // (`MODEL_PRICES_SEED`) it must price exactly like the built-in fixture, which
  // is what the omniagent core asserts too (`pricing.rs`
  // `seed_agrees_with_the_dsh_side_price_table_fixture`).
  const seedPath = process.env.MODEL_PRICES_SEED
  if (seedPath === undefined || !existsSync(seedPath)) {
    t.skip('MODEL_PRICES_SEED not set: no deployed file to compare against')
    return
  }
  const shipped = loadPriceTable(seedPath)
  assert.equal(shipped.status, 'loaded', `shipped file must load: ${seedPath}`)
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const fixture = loadPriceTable()
  for (const [provider, model] of [
    ['deepseek-official', 'deepseek-flash'],
    ['deepseek-official', 'deepseek-v4-flash'],
    ['deepseek-official', 'deepseek-v4-pro'],
    ['google', 'gemini-2.5-flash'],
  ]) {
    const a = costOf(provider, model, tokens, shipped)
    const b = costOf(provider, model, tokens, fixture)
    assert.notEqual(a, null, `${provider}/${model} must be priced by the shipped file`)
    assert.notEqual(b, null, `${provider}/${model} must be priced by the fixture`)
    // The two FILES hold different bytes, so their `pricing_ref` content hash
    // differs by construction: the parity contract is the PRICE (amount, source,
    // estimate flag) plus the same file version, not the hash.
    assert.deepEqual(
      { amount: a.amount_usd, source: a.source, estimate: a.is_estimate },
      { amount: b.amount_usd, source: b.source, estimate: b.is_estimate },
      `${provider}/${model} must price identically on both sides`,
    )
    const refA = String(a.pricing_ref)
    const refB = String(b.pricing_ref)
    assert.equal(
      refA.split('#')[0],
      refB.split('#')[0],
      `${provider}/${model} must carry the same file identity on both sides`,
    )
  }
})

test('usageFromSession prices every call from its own route with no time dimension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-log-cost-'))
  const log = writeLog(dir, [
    { type: 'session', id: 'session-1', createdAt: 1, cwd: '/x' },
    { type: 'assistant/message', seq: 2, time: '2026-10-05T02:00:00Z', data: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500 }, message: { id: 'm1', source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    // A different wall clock, the same cost: there is no rate class any more.
    { type: 'assistant/message', seq: 4, time: '2026-10-05T20:00:00Z', data: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500 }, message: { id: 'm2', source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
  ])
  const report = usageFromSession(log, 'researcher')
  assert.equal(report.usage.length, 3)
  assert.equal(report.usage[0].cost.rate_class, undefined)
  assert.equal(report.usage[1].cost.call_time, undefined)
  assert.equal(report.usage[1].cost.off_peak_factor, undefined)
  close(report.usage[0].cost.amount_usd, 0.0009, 'call 1')
  close(report.usage[1].cost.amount_usd, 0.0009, 'call 2 (same cost at a different time)')
  const aggregate = report.usage.at(-1)
  assert.equal(aggregate.details.kind, 'agent-aggregate')
  assert.equal(aggregate.cost.source, 'model_prices.yml')
  assert.match(aggregate.cost.pricing_ref, /^config\/model_prices\.yml@/)
  close(aggregate.cost.amount_usd, 0.0018, 'aggregate = call 1 + call 2')
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
  // Both OWN calls are priced from the shared file with its ONE rate set, so
  // the aggregate carries their sum with the same provenance (nested subagent
  // entries are NOT folded in).
  assert.equal(aggregate.cost.source, 'model_prices.yml')
  assert.match(aggregate.cost.pricing_ref, /^config\/model_prices\.yml@/)
  close(aggregate.cost.amount_usd, 0.000075, 'aggregate')
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

test('the compiled PRICE_TABLE is gone AND the time-aware layer is gone', () => {
  const usage = readFileSync(new URL('../shared/usage.ts', import.meta.url), 'utf8')
  const pricing = readFileSync(new URL('../shared/pricing.ts', import.meta.url), 'utf8')
  assert.equal(usage.includes('PRICE_TABLE'), false, 'the compiled PRICE_TABLE must be gone from usage.ts')
  assert.match(pricing, /cached_input/, 'the canonical field names come from the shared file')
  // No time-aware pricing trace in the CODE (comments may explain the removal).
  const codeOnly = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  for (const banned of ['off_peak', 'off-peak', 'offpeak', 'RateClass', 'holiday_dates', 'weekdays_only', 'rate_class', 'call_time']) {
    assert.equal(
      codeOnly(usage).includes(banned),
      false,
      `usage.ts code must not carry any time-aware pricing trace ('${banned}')`,
    )
    assert.equal(
      codeOnly(pricing).includes(banned),
      false,
      `pricing.ts code must not carry any time-aware pricing trace ('${banned}')`,
    )
  }
  assert.equal(loadPriceTable().providers.deepseek['deepseek-flash'].cached_input, 0.006)
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
