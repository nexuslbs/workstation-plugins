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
//   * the rate class (peak / off-peak) is selected from the CALL time in UTC.
//
// The suite runs against a TEMP omni dir seeded with the documented file, so it
// never depends on the machine's OMNI_DIR and never on the wall clock: the
// tests that must be deterministic pass an explicit instant.
//
// 2026-10-05 is a Monday (inside the configured 01:00-04:00 / 06:00-10:00 UTC
// peak windows at 02:00Z, outside them at 20:00Z); 2026-10-03 is a Saturday.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/** The documented definition file: DeepSeek peak rates + the off-peak calendar. */
const FIXTURE = `version: price_table_v2

off_peak:
  timezone: UTC
  default_class: off-peak
  weekdays_only: true
  holiday_dates: []
  windows:
    - start: "01:00"
      end: "04:00"
      class: peak
    - start: "06:00"
      end: "10:00"
      class: peak

providers:
  deepseek:
    deepseek-flash:
      input: 0.30
      cached_input: 0.006
      output: 1.20
      cache_write: 0.30
      off_peak_factor: 0.5
  google:
    gemini-2.5-flash:
      input: 0.30
      cached_input: 0.03
      output: 2.50
      cache_write: 0.30

aliases:
  deepseek-official: deepseek
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

const PEAK = Date.parse('2026-10-05T02:00:00Z')
const OFF_PEAK = Date.parse('2026-10-05T20:00:00Z')

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

test('cost is priced from the shared file: peak vs off-peak chosen by the CALL time', () => {
  const table = loadPriceTable()
  const tokens = { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 0 }
  // The dsh/workstation entries carry the FRESH (cache-miss) input in `input`
  // and the hits in `cached_input_tokens` (see the aggregate field semantics in
  // usage_entries.rs), so no subtraction happens here:
  // 1,000,000 * 0.30 + 200,000 cache-hit * 0.006 + 100,000 * 1.20.
  const expectedPeak = (1_000_000 / 1e6) * 0.3 + (200_000 / 1e6) * 0.006 + (100_000 / 1e6) * 1.2
  const peak = costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, table)
  const off = costOf('deepseek-official', 'deepseek-flash', tokens, OFF_PEAK, table)
  close(peak.amount_usd, expectedPeak, 'peak amount')
  assert.equal(peak.rate_class, 'peak')
  assert.equal(peak.call_time, '2026-10-05T02:00:00Z')
  assert.equal(peak.off_peak_factor, undefined, 'no multiplier is reported on a peak call')
  assert.equal(peak.is_estimate, true)
  assert.equal(peak.source, 'model_prices.yml')
  assert.match(peak.pricing_ref, /^config\/model_prices\.yml@price_table_v2#[0-9a-f]{16}$/)
  // The SAME call at 20:00Z is off-peak: EVERY bucket is halved.
  close(off.amount_usd, expectedPeak / 2, 'off-peak amount')
  assert.equal(off.rate_class, 'off-peak')
  assert.equal(off.off_peak_factor, 0.5)
  assert.equal(off.call_time, '2026-10-05T20:00:00Z')
  assert.equal(off.pricing_ref, peak.pricing_ref)
})

test('window boundaries are start-inclusive, end-exclusive (and weekends are off-peak)', () => {
  const table = loadPriceTable()
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const cases = [
    ['2026-10-05T00:59:00Z', 'off-peak'],
    ['2026-10-05T01:00:00Z', 'peak'],
    ['2026-10-05T03:59:00Z', 'peak'],
    ['2026-10-05T04:00:00Z', 'off-peak'],
    ['2026-10-05T05:59:00Z', 'off-peak'],
    ['2026-10-05T06:00:00Z', 'peak'],
    ['2026-10-05T09:59:00Z', 'peak'],
    ['2026-10-05T10:00:00Z', 'off-peak'],
    // Saturday 02:00Z sits inside a window but DeepSeek bills weekends fully
    // off-peak.
    ['2026-10-03T02:00:00Z', 'off-peak'],
    ['2026-10-04T02:00:00Z', 'off-peak'],
  ]
  for (const [iso, expected] of cases) {
    const cost = costOf('deepseek-official', 'deepseek-flash', tokens, Date.parse(iso), table)
    assert.equal(cost.rate_class, expected, `at ${iso}`)
  }
})

test('editing the calendar changes the cost with no rebuild (and holidays are configurable)', () => {
  const holidaySeed = FIXTURE.replace('  holiday_dates: []', '  holiday_dates: ["2026-10-05"]')
  assert.ok(holidaySeed.includes('2026-10-05'))
  const holidayPath = writePrices('holiday', holidaySeed)
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const base = costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, loadPriceTable())
  close(base.amount_usd, 0.3, 'peak before the calendar edit')
  const holiday = costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, loadPriceTable(holidayPath))
  assert.equal(holiday.rate_class, 'off-peak')
  close(holiday.amount_usd, 0.15, 'holiday = half')
  // The original file is untouched: the same route is peak again.
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, loadPriceTable()).rate_class, 'peak')
})

test('a call with NO timestamp falls back to peak and never errors', () => {
  const table = loadPriceTable()
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const at of [null, undefined, Number.NaN]) {
    const cost = costOf('deepseek-official', 'deepseek-flash', tokens, at, table)
    assert.equal(cost.rate_class, 'peak', `at=${String(at)}`)
    assert.equal(cost.call_time, null)
    close(cost.amount_usd, 0.3, 'peak fallback')
  }
})

test('a route without off_peak_factor is never discounted (flat-priced provider)', () => {
  const table = loadPriceTable()
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const cost = costOf('google', 'gemini-2.5-flash', tokens, OFF_PEAK, table)
  assert.equal(cost.rate_class, 'peak')
  close(cost.amount_usd, 0.3, 'gemini stays at the list rate')
})

test('an unknown route stays unpriced (null), never fabricated', () => {
  const table = loadPriceTable()
  assert.equal(costOf('acme', 'mystery-model', { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, PEAK, table), null)
})

test('missing / empty / malformed files yield a numeric 0 cost, never an error', () => {
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  const missing = loadPriceTable(join(mkdtempSync(join(tmpdir(), 'usage-missing-')), 'model_prices.yml'))
  assert.equal(missing.status, 'missing')
  const missingCost = costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, missing)
  assert.equal(missingCost.amount_usd, 0)
  assert.equal(missingCost.pricing_ref, 'config/model_prices.yml#missing')
  const empty = loadPriceTable(writePrices('empty', '\n# nothing here\n'))
  assert.equal(empty.status, 'empty')
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, empty).amount_usd, 0)
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, empty).pricing_ref, 'config/model_prices.yml#empty')
  const invalid = loadPriceTable(writePrices('invalid', 'providers: [not a map\n  :::\n  - oops\n'))
  assert.equal(invalid.status, 'invalid')
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, invalid).amount_usd, 0)
  assert.equal(costOf('deepseek-official', 'deepseek-flash', tokens, PEAK, invalid).pricing_ref, 'config/model_prices.yml#invalid')
})

test('an unusable off_peak block falls back to peak without erroring', () => {
  const broken = writePrices('bad-block', 'off_peak:\n  default_class: nope\nproviders:\n  deepseek:\n    deepseek-flash:\n      input: 0.30\n      output: 1.20\n      off_peak_factor: 0.5\n')
  const table = loadPriceTable(broken)
  assert.equal(table.status, 'loaded', 'a bad calendar never invalidates the RATES')
  assert.equal(table.offPeak, null)
  const cost = costOf('deepseek-official', 'deepseek-flash', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, OFF_PEAK, table)
  assert.equal(cost.rate_class, 'peak')
  close(cost.amount_usd, 0.3, 'peak fallback')
})

test('the built-in YAML subset parser reads the documented file and rejects garbage', () => {
  const parsed = parsePriceYaml(FIXTURE)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.version, 'price_table_v2')
  assert.equal(parsed.providers.deepseek['deepseek-flash'].input, 0.3)
  assert.equal(parsed.providers.deepseek['deepseek-flash'].cached_input, 0.006)
  assert.equal(parsed.providers.deepseek['deepseek-flash'].off_peak_factor, 0.5)
  assert.equal(parsed.aliases['deepseek-official'], 'deepseek')
  assert.equal(parsed.offPeak.defaultClass, 'off-peak')
  assert.equal(parsed.offPeak.weekdaysOnly, true)
  assert.deepEqual(parsed.offPeak.windows, [
    { start: 60, end: 240, class: 'peak' },
    { start: 360, end: 600, class: 'peak' },
  ])
  assert.equal(parsePriceYaml('providers: [not a map\n  :::\n  - oops\n'), undefined)
  assert.equal(parsePriceYaml('providers:\n  deepseek:\n    m1\n'), undefined)
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
  for (const [at, expected] of [[PEAK, 0.3], [OFF_PEAK, 0.15]]) {
    const cost = costOf('deepseek-official', 'deepseek-flash', tokens, at, shipped)
    assert.equal(cost.rate_class, at === PEAK ? 'peak' : 'off-peak')
    close(cost.amount_usd, expected, `shipped file at ${new Date(at).toISOString()}`)
  }
})

test('usageFromSession prices EVERY call at its own time, aggregate LAST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-times-'))
  const log = writeLog(dir, [
    { type: 'session', id: 'session-times', createdAt: PEAK, cwd: '/x', delegationDepth: 0 },
    // 02:00Z Monday: peak.
    { type: 'assistant/message', seq: 2, timestamp: '2026-10-05T02:00:00Z', data: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500 }, message: { id: 'm1', source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    // 20:00Z Monday: off-peak.
    { type: 'assistant/message', seq: 4, time: '2026-10-05T20:00:00Z', data: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500 }, message: { id: 'm2', source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
  ])
  const report = usageFromSession(log, 'researcher')
  assert.equal(report.usage.length, 3)
  assert.equal(report.usage[0].cost.rate_class, 'peak')
  assert.equal(report.usage[0].cost.call_time, '2026-10-05T02:00:00Z')
  close(report.usage[0].cost.amount_usd, 0.0009, 'peak call')
  assert.equal(report.usage[1].cost.rate_class, 'off-peak')
  assert.equal(report.usage[1].cost.call_time, '2026-10-05T20:00:00Z')
  assert.equal(report.usage[1].cost.off_peak_factor, 0.5)
  close(report.usage[1].cost.amount_usd, 0.00045, 'off-peak call')
  const aggregate = report.usage.at(-1)
  assert.equal(aggregate.details.kind, 'agent-aggregate')
  assert.equal(aggregate.cost.source, 'model_prices.yml')
  assert.match(aggregate.cost.pricing_ref, /^config\/model_prices\.yml@/)
  close(aggregate.cost.amount_usd, 0.00135, 'aggregate = peak + off-peak')
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
  // Both OWN calls are priced from the shared file, so the aggregate carries
  // their sum with the same provenance (nested subagent entries are NOT folded
  // in). No event carries a timestamp: both fall back to the PEAK rate.
  assert.equal(aggregate.cost.source, 'model_prices.yml')
  assert.match(aggregate.cost.pricing_ref, /^config\/model_prices\.yml@/)
  close(aggregate.cost.amount_usd, 0.000075, 'peak aggregate')
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

test('the compiled PRICE_TABLE is gone: cost comes from the shared file', () => {
  const usage = readFileSync(new URL('../shared/usage.ts', import.meta.url), 'utf8')
  const pricing = readFileSync(new URL('../shared/pricing.ts', import.meta.url), 'utf8')
  assert.equal(usage.includes('PRICE_TABLE'), false, 'the compiled PRICE_TABLE must be gone from usage.ts')
  assert.match(pricing, /cached_input/, 'the canonical field names come from the shared file')
  assert.match(pricing, /cache_read/, 'the dsh cache_read -> cached_input mapping stays documented')
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
