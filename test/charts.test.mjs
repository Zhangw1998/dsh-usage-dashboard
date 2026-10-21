/**
 * 聚合层与图表格式化的单元测试。
 *
 * 重点覆盖本次重构的两个核心保证：
 *  1. 同一组筛选下，各视图的 token/费用必须能对账（这是旧版「24H 与项目合计不一致」的根因）；
 *  2. 费用两个口径（cost / planCost）永不合并，未定价绝不当 0，跨币种绝不相加。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOUR, DAY, dayOf, dayStart, resolveWindow, previousWindow, buildView, ratio,
  mergeMoney, projectBase, share, sumMoney, RANGES, RANGE_KEYS,
} from '../view-model.js'
import { compact, deltaLabel, tr } from '../chart-kit.js'

const NOW = Date.parse('2026-10-20T14:05:00+08:00')
const fact = (over = {}) => ({
  t: NOW - 2 * HOUR, day: dayOf(NOW - 2 * HOUR), hour: 12,
  project: '/w/alpha', provider: 'p1', model: 'm1',
  inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 0,
  cost: 1.5, planCost: null, currency: 'CNY', ...over,
})
const tokensOf = f => (f.inputTokens || 0) + (f.outputTokens || 0) + (f.cacheReadTokens || 0) + (f.cacheWriteTokens || 0)
const scanOf = facts => ({
  facts,
  totals: { totalTokens: facts.reduce((n, f) => n + tokensOf(f), 0) },
  projects: [],
})

// ---------------- 时间窗 ----------------

await test('dayStart is Beijing midnight, not local midnight', () => {
  // 北京 2026-10-20 00:00 === UTC 2026-10-19T16:00Z
  assert.equal(new Date(dayStart(NOW)).toISOString(), '2026-10-19T16:00:00.000Z')
})

await test('today starts at Beijing midnight; 24h is a rolling window — they differ', () => {
  const today = resolveWindow('today', NOW)
  const h24 = resolveWindow('24h', NOW)
  assert.equal(new Date(today.from).toISOString(), '2026-10-19T16:00:00.000Z')
  // NOW(2026-10-20T14:05+08:00 = 06:05Z) 往前 24 小时
  assert.equal(new Date(h24.from).toISOString(), '2026-10-19T06:05:00.000Z')
  assert.notEqual(today.from, h24.from, '今天与 24H 必须是不同窗口')
})

await test('multi-day windows start at Beijing midnight of the first day', () => {
  const w = resolveWindow('7d', NOW)
  assert.equal(new Date(w.from).toISOString(), '2026-10-13T16:00:00.000Z')
  const span = NOW - w.from
  assert.ok(span > 6 * DAY && span < 7 * DAY, `7D 跨度异常: ${span}`)
})

await test('granularity follows the range', () => {
  const gran = k => RANGES.find(r => r.key === k).gran
  assert.equal(gran('today'), 'hour')
  assert.equal(gran('24h'), 'hour')
  assert.equal(gran('7d'), 'day')
  assert.equal(gran('30d'), 'day')
  assert.equal(gran('90d'), 'week')
})

await test('"all" has no lower bound and no previous window', () => {
  const w = resolveWindow('all', NOW)
  assert.equal(w.from, -Infinity)
  assert.equal(previousWindow(w, 'all'), null)
})

await test('previous window is the equally long window right before', () => {
  const w = resolveWindow('7d', NOW)
  const p = previousWindow(w, '7d')
  assert.equal(p.to, w.from)
  assert.equal(p.to - p.from, w.to - w.from)
})

await test('custom range resolves to whole Beijing days (inclusive end)', () => {
  const w = resolveWindow('custom', NOW, { from: '2026-10-01', to: '2026-10-03' })
  assert.equal(new Date(w.from).toISOString(), '2026-09-30T16:00:00.000Z')
  assert.equal(new Date(w.to).toISOString(), '2026-10-03T16:00:00.000Z')
})

// ---------------- 对账 ----------------

await test('same filters reconcile across every view', () => {
  const facts = [
    fact({ t: NOW - 2 * HOUR }),
    fact({ t: NOW - 30 * HOUR, project: '/w/beta', provider: 'p2', cost: null, planCost: 2, currency: 'USD' }),
    fact({ t: NOW - 10 * DAY, inputTokens: 500, outputTokens: 50, cacheReadTokens: 0 }),
  ]
  const v = buildView(scanOf(facts), { range: '30d' }, NOW)
  assert.equal(v.totals.tokens, v.byProvider.reduce((n, p) => n + p.tokens, 0), 'Provider 合计 = 总量')
  assert.equal(v.totals.tokens, v.byProject.reduce((n, p) => n + p.tokens, 0), '项目合计 = 总量')
  assert.equal(v.totals.tokens, v.series.reduce((n, s) => n + s.tokens, 0), '趋势合计 = 总量')
})

await test('24h excludes facts that 30d includes', () => {
  const facts = [fact({ t: NOW - 2 * HOUR }), fact({ t: NOW - 3 * DAY })]
  const v24 = buildView(scanOf(facts), { range: '24h' }, NOW)
  const v30 = buildView(scanOf(facts), { range: '30d' }, NOW)
  assert.equal(v24.factCount, 1)
  assert.equal(v30.factCount, 2)
  assert.ok(v24.totals.tokens < v30.totals.tokens, '窄窗口的量必须更小')
})

await test('project and provider filters compose', () => {
  const facts = [
    fact({ project: '/w/a', provider: 'p1' }),
    fact({ project: '/w/a', provider: 'p2' }),
    fact({ project: '/w/b', provider: 'p1' }),
  ]
  const scan = scanOf(facts)
  assert.equal(buildView(scan, { range: '30d', project: '/w/a' }, NOW).factCount, 2)
  assert.equal(buildView(scan, { range: '30d', provider: 'p1' }, NOW).factCount, 2)
  const both = buildView(scan, { range: '30d', project: '/w/a', provider: 'p1' }, NOW)
  assert.equal(both.factCount, 1, '组合筛选必须同时生效')
  assert.equal(both.byProject.length, 1)
  assert.equal(both.byProvider.length, 1)
})

await test('filter options come from all data, never shrink after filtering', () => {
  const facts = [fact({ project: '/w/a', provider: 'p1' }), fact({ project: '/w/b', provider: 'p2' })]
  const v = buildView(scanOf(facts), { range: '30d', project: '/w/a' }, NOW)
  assert.deepEqual(v.options.projects.sort(), ['/w/a', '/w/b'])
  assert.deepEqual(v.options.providers.sort(), ['p1', 'p2'])
})

// ---------------- 费用语义 ----------------

await test('cost and planCost never merge into one number', () => {
  const facts = [
    fact({ cost: 1.5, planCost: null, currency: 'CNY' }),
    fact({ cost: null, planCost: 2, currency: 'USD' }),
  ]
  const v = buildView(scanOf(facts), { range: '30d' }, NOW)
  assert.equal(v.totals.cost.CNY, 1.5)
  assert.equal(v.totals.cost.USD, undefined, '折算不得进入 cost')
  assert.equal(v.totals.planCost.USD, 2)
  assert.equal(v.totals.planCost.CNY, undefined)
})

await test('unpriced rows are counted separately, never treated as zero', () => {
  const facts = [fact({ cost: null, planCost: null })]
  const v = buildView(scanOf(facts), { range: '30d' }, NOW)
  assert.deepEqual(v.totals.cost, {})
  assert.deepEqual(v.totals.planCost, {})
  assert.equal(v.totals.unpricedTokens, tokensOf(facts[0]))
})

await test('currencies accumulate separately, never summed across', () => {
  const facts = [fact({ cost: 3, currency: 'CNY' }), fact({ cost: 5, currency: 'USD' })]
  const v = buildView(scanOf(facts), { range: '30d' }, NOW)
  assert.deepEqual(v.totals.cost, { CNY: 3, USD: 5 })
})

await test('mergeMoney adds same currency only', () => {
  assert.deepEqual(mergeMoney({ CNY: 1 }, { CNY: 2, USD: 4 }), { CNY: 3, USD: 4 })
  assert.deepEqual(mergeMoney({}, undefined), {})
})

// ---------------- 环比 ----------------

await test('ratio returns null instead of Infinity when previous is zero', () => {
  assert.equal(ratio(10, 0), null)
  assert.equal(ratio(10, undefined), null)
  assert.equal(ratio(NaN, 5), null)
  assert.equal(ratio(15, 10), 0.5)
  assert.equal(ratio(5, 10), -0.5)
})

// ---------------- 序列 ----------------

await test('series zero-fills buckets so the x-axis stays an even time axis', () => {
  const facts = [fact({ t: NOW - 1 * HOUR }), fact({ t: NOW - 5 * HOUR })]
  const v = buildView(scanOf(facts), { range: '24h' }, NOW)
  assert.equal(v.series.length, 25, '24H 应有 24+1 个小时桶')
  assert.ok(v.series.filter(s => s.tokens === 0).length > 10, '空桶必须补齐')
  for (let i = 1; i < v.series.length; i++) assert.ok(v.series[i].t > v.series[i - 1].t, '桶必须按时间升序')
})

await test('7d produces exactly 7 day buckets', () => {
  const v = buildView(scanOf([fact({ t: NOW - 3 * DAY })]), { range: '7d' }, NOW)
  assert.equal(v.series.length, 7)
})

await test('project rows expose a provider breakdown that sums to the row', () => {
  const facts = [
    fact({ project: '/w/a', provider: 'p1', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 }),
    fact({ project: '/w/a', provider: 'p2', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0 }),
  ]
  const v = buildView(scanOf(facts), { range: '30d' }, NOW)
  const row = v.byProject[0]
  assert.equal(row.providers.length, 2)
  assert.equal(row.providers.reduce((n, p) => n + p.tokens, 0), row.tokens, '下钻合计必须等于项目行')
})

// ---------------- 工具 ----------------

await test('projectBase takes the last path segment', () => {
  assert.equal(projectBase('/Users/me/Company/ComposeEve'), 'ComposeEve')
  assert.equal(projectBase('/Users/me/x/'), 'x')
  assert.equal(projectBase(''), '')
  assert.equal(projectBase(null), '')
})

await test('share guards divide-by-zero', () => {
  assert.equal(share(5, 0), 0)
  assert.equal(share(5, 10), 0.5)
})

await test('sumMoney adds the bucket', () => {
  assert.equal(sumMoney({ CNY: 1, USD: 2 }), 3)
  assert.equal(sumMoney({}), 0)
})

await test('RANGE_KEYS matches RANGES', () => {
  assert.deepEqual(RANGE_KEYS, RANGES.map(r => r.key))
  assert.ok(RANGE_KEYS.includes('24h') && RANGE_KEYS.includes('custom'))
})

// ---------------- 格式化 ----------------

await test('compact formats token counts with units', () => {
  assert.equal(compact(0), '0')
  assert.equal(compact(999), '999')
  assert.equal(compact(1500), '1.5K')
  assert.equal(compact(1e6), '1M')
  assert.equal(compact(1.23e9), '1.23B')
  assert.equal(compact(NaN), '0')
})

await test('deltaLabel hides when there is no comparison', () => {
  assert.equal(deltaLabel(null), '')
  // ≥10% 时取整（避免小数噪声），<10% 保留一位
  assert.equal(deltaLabel(0.123), '+12%')
  assert.equal(deltaLabel(-0.05), '-5.0%')
  assert.equal(deltaLabel(0.5), '+50%')
})

// ---------------- 文案取值（回归） ----------------

await test('tr() accepts the bound locale FUNCTION the host actually passes', () => {
  // 宿主传的是 locale.bind(NS) 得到的函数。曾经把它当对象读（locale.output），
  // 于是图表 tooltip 里全部显示 undefined。
  const bound = key => ({ output: '输出', input: '输入', cacheRead: '缓存读取', total: '总计', unpriced: '未定价' })[key] ?? key
  assert.equal(tr(bound, 'output'), '输出')
  assert.equal(tr(bound, 'unpriced'), '未定价')
  assert.equal(tr(bound, 'missing'), 'missing', '缺失的键回落到键名，而不是 undefined')
})

await test('tr() also accepts a plain dictionary object', () => {
  const dict = { output: 'Output', input: 'Input' }
  assert.equal(tr(dict, 'output'), 'Output')
  assert.equal(tr(dict, 'nope'), 'nope')
  assert.equal(tr(undefined, 'x'), 'x')
})

await test('chart labels never resolve to the string "undefined"', () => {
  // 所有图表内部用到的键，都必须能从绑定的 t 里取到真值
  const keys = ['output', 'input', 'cacheRead', 'cacheWrite', 'total', 'unpriced', 'noData',
    'clickToFilter', 'expand', 'collapse', 'project', 'sessions', 'tokens', 'cost', 'providers']
  const t = k => `[${k}]`
  for (const k of keys) {
    const v = tr(t, k)
    assert.equal(typeof v, 'string', `${k} 必须是字符串`)
    assert.ok(!v.includes('undefined'), `${k} 不能是 undefined`)
  }
})
