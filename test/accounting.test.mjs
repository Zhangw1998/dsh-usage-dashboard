import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { readSessionEvents } from '../zstd-log.js'
import { DEFAULT_PRICING, validatePricing, bandAt, costOf } from '../pricing.js'
import { foldSession, summarize } from '../usage.js'

const at = text => Date.parse(text + '+08:00')
const usage = { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, cacheWriteTokens: 0 }
const event = (type, data = {}, time = at('2026-10-14T10:00:00')) => ({ type, data, time })
const route = (provider = 'deepseek-official', model = 'deepseek-flash') => event('request/header', { header: { config: { provider, model } } })
const message = (u = usage, step = 1) => event('assistant/message', { turn: 1, step, usage: u })
const fixture = [route(), event('step/start', { turn: 1, step: 1 }), message()]

await test('concatenated zstd frames and incomplete final frame', () => {
  const a = zstdCompressSync(Buffer.from(JSON.stringify(route()) + '\n'))
  const b = zstdCompressSync(Buffer.from(JSON.stringify(message()) + '\n'))
  assert.equal(readSessionEvents(Buffer.concat([a, b])).length, 2)
  assert.equal(readSessionEvents(Buffer.concat([a, b.subarray(0, b.length - 2)])).length, 1)
  const damaged = Buffer.from(a); damaged[0] = 0
  assert.throws(() => readSessionEvents(damaged))
})
await test('stream usage is replaced by final sample; retries charge separately', () => {
  const attempt = event('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { ...usage, outputTokens: 10 } } }] })
  const folded = foldSession([route(), attempt, message(), event('llm/retry-started', { turn: 1, step: 1 }), message()])
  assert.equal(folded.samples.length, 2)
  assert.equal(folded.samples.reduce((n, s) => n + s.usage.outputTokens, 0), 2000000)
})
await test('provider switching and compaction remain independently attributable', () => {
  const r = summarize([{ id: 'one', events: [...fixture, route('other'), message(usage, 2), event('compaction/summary', { usage })] }], DEFAULT_PRICING)
  assert.equal(r.providers.length, 2)
  assert.equal(r.routes.find(r => r.provider === 'other').estimatedCost, null)
  assert.equal(r.routes.find(r => r.provider === 'other').compactionTokens, 3000000)
})
await test('fork inherited calls are not billed twice but preserve route context', () => {
  const samples = foldSession([...fixture, message(usage, 2)], fixture.length).samples
  assert.equal(samples.length, 1); assert.equal(samples[0].provider, 'deepseek-official')
})
await test('NaN, negative and unsafe token counts cannot silently alter money', () => {
  assert.throws(() => foldSession([route(), message({ ...usage, inputTokens: -1 })]))
  assert.throws(() => foldSession([route(), message({ ...usage, outputTokens: NaN })]))
})
await test('peak boundaries, weekend, timezone and holiday override', () => {
  const rule = structuredClone(DEFAULT_PRICING['deepseek-official/deepseek-flash'])
  assert.equal(bandAt(rule, at('2026-10-14T09:00:00')), 'peak')
  assert.equal(bandAt(rule, at('2026-10-14T12:00:00')), 'off')
  assert.equal(bandAt(rule, at('2026-10-14T14:00:00')), 'peak')
  assert.equal(bandAt(rule, at('2026-10-14T18:00:00')), 'off')
  assert.equal(bandAt(rule, at('2026-10-10T10:00:00')), 'off')
  rule.schedule.holidays.push('2026-10-14')
  assert.equal(bandAt(rule, at('2026-10-14T10:00:00')), 'off')
  assert.equal(bandAt(rule, undefined), 'unknown')
})
await test('cash calculation uses uncached input, cached read, output and cache write once', () => {
  assert.equal(costOf(usage, { input: 2, cacheRead: .04, output: 8, cacheWrite: 0 }), 10.04)
  assert.equal(summarize([{ id: 'a', events: fixture }], DEFAULT_PRICING).totals.costs.CNY, 10.04)
})
await test('currency separation and zero-price vs unknown vs subscription', () => {
  const custom = validatePricing({
    'usd/m': { mode: 'token', currency: 'USD', off: { input: 3, cacheRead: 0, output: 0, cacheWrite: 0 } },
    'free/m': { mode: 'token', currency: 'CNY', off: { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 } },
    'subscription/m': { mode: 'subscription' },
  })
  const events = [...fixture, ...['usd', 'free', 'subscription', 'unknown'].flatMap((p, i) => [route(p, 'm'), message(usage, i + 2)])]
  const r = summarize([{ id: 'a', events }], { ...DEFAULT_PRICING, ...custom })
  assert.equal(r.totals.costs.CNY, 10.04); assert.equal(r.totals.costs.USD, 3)
  assert.equal(r.routes.find(r => r.provider === 'free').estimatedCost, 0)
  assert.equal(r.routes.find(r => r.provider === 'unknown').estimatedCost, null)
  assert.equal(r.routes.find(r => r.provider === 'subscription').estimatedCost, null)
})
await test('pricing config validates and never prices a different provider by model name', () => {
  assert.throws(() => validatePricing({ x: {} }))
  assert.throws(() => validatePricing({ 'a/b': { mode: 'token', currency: 'CNY', off: { input: -1 } } }))
  assert.equal(summarize([{ id: 'a', events: [route('not-official'), message()] }], DEFAULT_PRICING).routes[0].estimatedCost, null)
})
await test('plan mode is validated with the same rate rules and keeps every band key', () => {
  assert.throws(() => validatePricing({ 'a/b': { mode: 'plan', currency: 'CNY' } }), '缺少单价必须拒绝')
  assert.throws(() => validatePricing({ 'a/b': { mode: 'metered', currency: 'CNY', off: { input: 1, cacheRead: 0, output: 0, cacheWrite: 0 } } }))
  const ok = validatePricing({ 'a/b': { mode: 'plan', currency: 'USD', source: 's', off: { input: 1, cacheRead: 2, output: 3, cacheWrite: 4 } } })
  assert.equal(ok['a/b'].mode, 'plan')
  assert.equal(ok['a/b'].off.cacheWrite, 4, '缓存写入单价不能被丢掉')
})
await test('subscription plans are valued at list prices in a bucket separate from cash', () => {
  // gpt-6-luna 官方牌价 USD 0.1 / 0.01 / 0.5；1M+1M+1M = 0.61
  const r = summarize([{ id: 'a', events: [...fixture, route('openai-codex', 'gpt-6-luna'), message(usage, 2)] }], DEFAULT_PRICING)
  const codex = r.routes.find(x => x.provider === 'openai-codex'), provider = r.providers.find(p => p.provider === 'openai-codex')
  assert.equal(codex.billing, 'plan'); assert.equal(codex.hasPrice, true); assert.equal(codex.unpriced, false)
  assert.equal(codex.currency, 'USD'); assert.equal(codex.estimatedCost, .61)
  assert.equal(provider.planCosts.USD, .61)
  // 折算不是实付：绝不能并进 costs，否则总计会凭空变大
  assert.deepEqual(provider.costs, {})
  assert.equal(r.totals.costs.USD, undefined)
  assert.equal(r.totals.costs.CNY, 10.04, '实付仍只统计按量计费的 provider')
  assert.equal(r.totals.planCosts.USD, .61)
  // 每日用量仍只反映实付，不把折算混进条形图
  assert.ok(r.daily.every(d => d.provider !== 'openai-codex' || d.cost === null), '折算不应计入每日金额')
})
await test('a plan rule keeps peak/off splitting without leaking into cash', () => {
  // deepseek 系的订阅平台按官方元价峰谷折算：10:00 是高峰，21:00 是空闲
  const eveningAt = at('2026-10-14T21:00:00')
  const evening = [event('step/start', { turn: 1, step: 3 }, eveningAt), event('assistant/message', { turn: 1, step: 3, usage }, eveningAt)]
  const r = summarize([{ id: 'a', events: [...fixture, route('workbuddy', 'deepseek-v4.1-flash'), message(usage, 2), ...evening] }], DEFAULT_PRICING)
  const row = r.routes.find(x => x.provider === 'workbuddy')
  const round = n => Math.round(n * 1e9) / 1e9
  assert.equal(row.billing, 'plan'); assert.equal(row.tiered, true); assert.equal(row.currency, 'CNY')
  assert.equal(round(row.peakCost), 10.04); assert.equal(round(row.offCost), 5.02)
  assert.equal(round(row.estimatedCost), 15.06)
  assert.equal(round(r.totals.planCosts.CNY), 15.06)
  assert.equal(r.totals.costs.CNY, 10.04, '实付不受折算影响')
})
await test('a plain subscription rule without rates still shows no amount', () => {
  const custom = validatePricing({ 'planless/m': { mode: 'subscription' } })
  const r = summarize([{ id: 'a', events: [route('planless', 'm'), message()] }], { ...DEFAULT_PRICING, ...custom })
  assert.equal(r.routes[0].billing, 'subscription'); assert.equal(r.routes[0].estimatedCost, null)
  assert.equal(r.totals.planCosts.USD, undefined)
  assert.equal(r.providers[0].subscriptionModels, 1)
})
const sessionAt = (cwd, provider, model, step) => ({ project: cwd, events: [route(provider, model), message(usage, step)] })
await test('usage is grouped by session directory, cash and plan value still kept apart', () => {
  const alpha = sessionAt('/work/alpha', 'deepseek-official', 'deepseek-flash', 1)
  const r = summarize([
    { id: 'a', ...alpha, events: [...alpha.events, message(usage, 2)] },
    { id: 'b', ...sessionAt('/work/beta', 'openai-codex', 'gpt-6-luna', 1) },
    { id: 'c', ...sessionAt('', 'deepseek-official', 'deepseek-flash', 1) },
  ], DEFAULT_PRICING)
  const by = Object.fromEntries(r.projects.map(p => [p.project, p]))
  assert.deepEqual(Object.keys(by).sort(), ['', '/work/alpha', '/work/beta'])
  assert.equal(r.projects[0].project, '/work/alpha', '按用量降序')
  assert.equal(by['/work/alpha'].totalTokens, 6000000)
  assert.equal(by['/work/alpha'].sessions, 1, '同一目录的多个会话算一个项目')
  assert.equal(by['/work/alpha'].costs.CNY, 20.08)
  // provider 拆分要带各自用量与金额，UI 才能直接渲染
  assert.deepEqual(by['/work/alpha'].providers, [{ provider: 'deepseek-official', tokens: 6000000, costs: { CNY: 20.08 }, planCosts: {} }])
  assert.deepEqual(by['/work/beta'].providers.map(p => p.provider), ['openai-codex'])
  assert.equal(by['/work/beta'].providers[0].planCosts.USD, .61, '项目下的 provider 也要分账')
  assert.deepEqual(by['/work/beta'].providers[0].costs, {}, '折算不能进 provider 的实付槽位')
  assert.equal(by['/work/beta'].planCosts.USD, .61)
  assert.deepEqual(by['/work/beta'].costs, {}, '订阅折算不得混进项目的实付里')
  assert.equal(by[''].totalTokens, 3000000, '缺少 cwd 的会话仍要归类，不能丢')
  assert.equal(r.projects.reduce((n, p) => n + p.totalTokens, 0), r.totals.totalTokens, '项目合计必须等于总量')
  assert.equal(r.projects.reduce((n, p) => n + p.sessions, 0), r.sessionCount, '项目会话数之和必须等于会话总数')
})
await test('a project with sessions but no recorded usage still appears', () => {
  const silent = { id: 'slow', project: '/work/silent', events: [route('deepseek-official', 'deepseek-flash')] }
  const r = summarize([{ id: 'a', ...sessionAt('/work/alpha', 'deepseek-official', 'deepseek-flash', 1) }, silent], DEFAULT_PRICING)
  const row = r.projects.find(p => p.project === '/work/silent')
  assert.ok(row, '只有会话没有用量的项目也必须列出，否则会话数对不上')
  assert.equal(row.totalTokens, 0); assert.equal(row.sessions, 1)
})
await test('daily rows carry cash and plan value separately per provider', () => {
  const r = summarize([{ id: 'a', events: [
    route('deepseek-official', 'deepseek-flash'), message(usage, 1),
    route('openai-codex', 'gpt-6-luna'), message(usage, 2),
    route('workbuddy-ai', 'unknown-model'), message(usage, 3),
  ] }], DEFAULT_PRICING)
  const cash = r.daily.find(d => d.provider === 'deepseek-official')
  const plan = r.daily.find(d => d.provider === 'openai-codex')
  const none = r.daily.find(d => d.provider === 'workbuddy-ai')
  assert.equal(cash.cost, 10.04); assert.equal(cash.planCost, null, '按量计费不该有折算值')
  assert.equal(plan.planCost, .61); assert.equal(plan.cost, null, '订阅折算绝不能进实付槽位')
  assert.equal(none.cost, null); assert.equal(none.planCost, null, '未配置价格两边都必须是 null，不是 0')
  // 每日用量里的实付合计不能因为新增折算而变大
  assert.equal(r.daily.reduce((n, d) => n + (Number.isFinite(d.cost) ? d.cost : 0), 0), 10.04)
})
await test('only structural provider errors count, not assistant discussion or tool output', () => {
  const events = [...fixture, event('tool/result', { text: 'Insufficient Balance failure kind:error' }), event('assistant/message', { turn: 1, step: 2, message: 'Insufficient Balance' }), event('turn/end', { reason: { kind: 'error', error: { status: 402, code: 'QUOTA' } } })]
  const r = summarize([{ id: 'a', events }], DEFAULT_PRICING)
  assert.equal(r.errors.length, 1); assert.ok(r.warnings.length)
})

const home = await mkdtemp(join(tmpdir(), 'usage-dashboard-test-'))
process.env.DSH_HOME = home
const { apply, officialBalance } = await import('../host.js?test')
await test('host endpoint: config validation, atomic persistence, separate balance failure', async () => {
  const routes = new Map()
  const ctx = { connection: { fetch: { register: r => routes.set(r.path, r) } }, sessionQuery: {
    listSessions: async () => [{ header: { id: 'fixture' } }], readSession: async () => ({ events: fixture, inheritedEventCount: 0 }),
  }, get: () => undefined }
  apply(ctx)
  const call = (path, options) => routes.get(path.split('?')[0]).fetch(new Request('http://localhost' + path, options))
  const data = await (await call('/api/usage.dashboard')).json()
  assert.equal(data.scan.routes[0].estimatedCost, 10.04)
  const invalid = await call('/api/usage.dashboard.pricing', { method: 'POST', body: '{"bad":{}}' })
  assert.equal(invalid.status, 400)
  const custom = { 'deepseek-official/deepseek-flash': { mode: 'token', currency: 'USD', off: { input: 1, cacheRead: 0, output: 0, cacheWrite: 0 } } }
  assert.equal((await call('/api/usage.dashboard.pricing', { method: 'POST', body: JSON.stringify(custom) })).status, 200)
  const saved = JSON.parse(await readFile(join(home, 'storages/usage-dashboard-pricing.json'), 'utf8'))
  assert.equal(saved['deepseek-official/deepseek-flash'].currency, 'USD')
  // 缓存优先：保存价格后，普通请求先回旧缓存，强制刷新才同步重算
  const stale = await (await call('/api/usage.dashboard')).json()
  assert.equal(stale.scan.stale, true, '应优先返回缓存并标记 stale')
  const reestimated = await (await call('/api/usage.dashboard?refresh=1')).json()
  assert.equal(reestimated.scan.totals.costs.USD, 1)
  const bal = await (await call('/api/usage.dashboard.balances')).json()
  assert.equal(bal.rows[0].status, 'unavailable')
})
await test('disk cache is written and reused across a cold process', async () => {
  const home2 = await mkdtemp(join(tmpdir(), 'usage-cache-test-'))
  process.env.DSH_HOME = home2
  const mod = await import('../host.js?cachetest')
  const routes = new Map()
  const ctx = { connection: { fetch: { register: r => routes.set(r.path, r) } }, sessionQuery: {
    listSessions: async () => [{ header: { id: 'fixture' } }], readSession: async () => ({ events: fixture, inheritedEventCount: 0 }),
  }, get: () => undefined }
  mod.apply(ctx)
  const call = (path, options) => routes.get(path.split('?')[0]).fetch(new Request('http://localhost' + path, options))
  const first = await (await call('/api/usage.dashboard')).json()
  assert.equal(first.scan.stale, undefined, '冷启动首次应同步扫描')
  // 落盘是异步的，等它写完
  let written = false
  for (let i = 0; i < 40 && !written; i++) { await new Promise(r => setTimeout(r, 25)); written = existsSync(join(home2, 'storages/usage-dashboard-cache.json')) }
  assert.ok(written, '扫描结果必须写盘，否则重启后无法秒开')
  const cached = JSON.parse(await readFile(join(home2, 'storages/usage-dashboard-cache.json'), 'utf8'))
  assert.equal(cached.totals.totalTokens, first.scan.totals.totalTokens, '缓存内容必须与扫描结果一致')
  // 模拟新进程：换一个模块实例，内存缓存为空，应立刻返回盘上数据并标记 stale
  const fresh = await import('../host.js?cachetest2')
  const routes2 = new Map()
  fresh.apply({ ...ctx, connection: { fetch: { register: r => routes2.set(r.path, r) } } })
  const t0 = Date.now()
  const res = await (await routes2.get('/api/usage.dashboard').fetch(new Request('http://localhost/api/usage.dashboard'))).json()
  assert.equal(res.scan.stale, true, '冷进程应优先返回磁盘缓存')
  assert.equal(res.scan.totals.totalTokens, first.scan.totals.totalTokens, '缓存数据必须可用')
  assert.ok(Date.now() - t0 < 2000, '缓存响应必须远快于全量扫描')
  process.env.DSH_HOME = home
})
await test('balance sends key only to official origin, forbids redirects and never returns secrets', async () => {
  const secret = 'test-secret'
  const result = await officialBalance(async () => ({ value: secret }), async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer ' + secret)
    return new Response(JSON.stringify({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '-0.80', topped_up_balance: '-0.80', granted_balance: '0.00' }] }))
  })
  assert.equal(result.wallets[0].total, '-0.80'); assert.equal(result.available, false)
  assert.ok(!JSON.stringify(result).includes(secret))
  const invalid = await officialBalance(async () => ({ value: secret }), async () => new Response('{"is_available":true,"balance_infos":[]}'))
  assert.equal(invalid.status, 'failed')
  const httpFailure = await officialBalance(async () => ({ value: secret }), async () => new Response(secret, { status: 401 }))
  assert.equal(httpFailure.status, 'failed'); assert.ok(!JSON.stringify(httpFailure).includes(secret))
})
