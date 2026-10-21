import { bandAt, costOf } from './pricing.js'
export const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'cacheWriteTokens']
const zero = () => Object.fromEntries(TOKEN_FIELDS.map(f => [f, 0]))
function usageOf(event) {
  if (event.data?.usage) return event.data.usage
  const chunks = event.data?.stream ?? []
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i].chunk ?? chunks[i]
    if (c.type === 'usage') return c.usage
  }
}

// Replacement samples settle one attempt; retries are separate billed attempts.
export function foldSession(events, inheritedEventCount = 0) {
  let route = ['unknown', 'unknown'], stepTime, retryTime, missingUsage = 0
  const attempts = new Map(), samples = new Map(), failures = []
  for (let i = 0; i < events.length; i++) {
    const ev = events[i], d = ev.data ?? {}
    if (ev.type === 'request/header' && d.header?.config?.provider) route = [d.header.config.provider, d.header.config.model ?? 'unknown']
    if (ev.type === 'request/context' && d.provider) route = [d.provider, d.model ?? 'unknown']
    if (ev.type === 'step/start') { stepTime = ev.time; retryTime = undefined }
    if (ev.type === 'llm/retry-started') {
      const k = `${d.turn}/${d.step}`; attempts.set(k, (attempts.get(k) ?? 0) + 1); retryTime = ev.time
    }
    if (i < inheritedEventCount) continue
    if (ev.type === 'turn/end' && d.reason?.kind === 'error') {
      const error = d.reason.error
      if (error?.status === 402 || error?.code === 'QUOTA') failures.push({ time: ev.time, provider: route[0], status: error.status, code: error.code })
    }
    if (!['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(ev.type)) continue
    const raw = usageOf(ev)
    if (!raw) { if (ev.type === 'assistant/message') missingUsage++; continue }
    const usage = zero()
    for (const f of TOKEN_FIELDS) {
      const n = raw[f] ?? 0
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`无效 token 计数: ${f}`)
      usage[f] = n
    }
    const kind = ev.type === 'compaction/summary' ? 'compaction' : 'chat'
    const key = kind === 'compaction' ? `compaction:${i}` : `${d.turn}/${d.step}/${attempts.get(`${d.turn}/${d.step}`) ?? 0}`
    const time = kind === 'compaction' ? ev.time : (retryTime ?? stepTime ?? ev.time)
    samples.set(key, { provider: route[0], model: route[1], usage, time, kind })
  }
  return { samples: [...samples.values()], failures, missingUsage }
}

export function summarize(records, pricing) {
  const rows = new Map(), days = new Map(), projectRows = new Map(), warnings = [], errors = [], times = []
  // 按天 × 24 小时分桶：前端可据此算出任意范围内的「星期×小时」热力图
  const hourly = new Map()
  // 事实表（小时粒度，带全维度）：前端按「时间 × 项目 × Provider」任意组合筛选后
  // 都从这一张表聚合，各视图不可能再用到不同的时间窗口。
  const facts = new Map()
  let missingUsage = 0
  for (const record of records) {
    if (record.error) { warnings.push(`${record.id}: 无法读取会话，已跳过`); continue }
    const folded = foldSession(record.events, record.inheritedEventCount ?? 0)
    // 项目目录由调用方从会话头部带进来；缺失时归到空 key，样本不丢。
    const project = typeof record.project === 'string' ? record.project : ''
    // 读到会话就登记项目：没有 usage 的会话也要出现，各项目会话数之和才等于总数。
    if (!projectRows.has(project)) projectRows.set(project, { project, ...zero(), totalTokens: 0, sessionIds: new Set(), byProvider: new Map(), costs: {}, planCosts: {} })
    projectRows.get(project).sessionIds.add(record.id)
    missingUsage += folded.missingUsage
    errors.push(...folded.failures.map(f => ({ ...f, sessionId: record.id })))
    for (const sample of folded.samples) {
      const key = `${sample.provider}/${sample.model}`, rule = pricing[key] ?? (sample.provider === 'openai-codex' ? { mode: 'subscription' } : undefined)
      if (!rows.has(key)) rows.set(key, { key, provider: sample.provider, model: sample.model, ...zero(), calls: 0,
        sessionIds: new Set(), compactionTokens: 0, peakCost: 0, offCost: 0, flatCost: 0, unknownTimeTokens: 0, rule: rule ?? null })
      const row = rows.get(key); row.sessionIds.add(record.id); row.calls++
      for (const f of TOKEN_FIELDS) row[f] += sample.usage[f]
      const tokenCount = Object.values(sample.usage).reduce((a, b) => a + b, 0)
      if (sample.kind === 'compaction') row.compactionTokens += tokenCount
      let cost = null, band = 'off'
      // plan 与 token 用同一套算法，只是去处不同：token 是实付，plan 是官方牌价折算。
      if (rule?.mode === 'token' || rule?.mode === 'plan') {
        band = bandAt(rule, sample.time)
        if (band === 'unknown') row.unknownTimeTokens += tokenCount
        else { cost = costOf(sample.usage, rule[band]); row[rule.peak ? `${band}Cost` : 'flatCost'] += cost }
      }
      if (Number.isFinite(sample.time)) {
        times.push(sample.time)
        // 按北京时间（UTC+8）的小时归集，供分时热力图使用
        const hd = new Date(sample.time + 480 * 60000)
        const hDay = hd.toISOString().slice(0, 10), hHour = hd.getUTCHours()
        // 事实行：rounded hour 作为时间桶键，费用已在此算好（峰谷价只在这里判一次）
        const hStart = Math.floor(sample.time / 3600000) * 3600000
        const fk = `${hStart}|${project}|${sample.provider}|${sample.model}`
        if (!facts.has(fk)) facts.set(fk, { t: hStart, day: hDay, hour: hHour, project, provider: sample.provider,
          model: sample.model, ...zero(), calls: 0, cost: null, planCost: null, currency: rule?.currency ?? null })
        const fact = facts.get(fk)
        // 一条 usage 记录＝一次调用；按同一事实桶累加，才能按时段/筛选统计
        fact.calls += 1
        for (const f of TOKEN_FIELDS) fact[f] += sample.usage[f]
        if (!hourly.has(hDay)) hourly.set(hDay, { tokens: new Array(24).fill(0), cost: new Array(24).fill(0) })
        const slot = hourly.get(hDay)
        slot.tokens[hHour] += tokenCount
        if (cost !== null) slot.cost[hHour] += cost
        // 带上项目：每日明细要能拆到「哪个项目用了哪个 provider」。
        const day = new Date(sample.time + 480 * 60000).toISOString().slice(0, 10), dk = `${key}|${project}|${day}`
        // 实付与订阅折算各占一个槽位，和 provider 卡片同一套口径，绝不混算。
        if (!days.has(dk)) days.set(dk, { provider: sample.provider, model: sample.model, day, project, ...zero(),
          cost: rule?.mode === 'token' ? 0 : null, planCost: rule?.mode === 'plan' ? 0 : null, currency: rule?.currency ?? null })
        const daily = days.get(dk)
        for (const f of TOKEN_FIELDS) daily[f] += sample.usage[f]
        const bucket = rule?.mode === 'plan' ? 'planCost' : 'cost'
        if (cost !== null && daily[bucket] !== null) daily[bucket] += cost
        // 事实行的费用同样分账：token 记 cost，plan 记 planCost，未定价两者都是 null
        if (cost !== null) fact[bucket] = (fact[bucket] ?? 0) + cost
      }
      // 项目维度：按会话所属目录归集，实付与折算同样分账，并按 provider 再拆一层。
      const proj = projectRows.get(project)
      proj.totalTokens += tokenCount
      for (const f of TOKEN_FIELDS) proj[f] += sample.usage[f]
      if (!proj.byProvider.has(sample.provider)) proj.byProvider.set(sample.provider, { tokens: 0, costs: {}, planCosts: {} })
      const slot = proj.byProvider.get(sample.provider)
      slot.tokens += tokenCount
      if (cost !== null) {
        const bucket = rule.mode === 'plan' ? 'planCosts' : 'costs'
        proj[bucket][rule.currency] = (proj[bucket][rule.currency] ?? 0) + cost
        slot[bucket][rule.currency] = (slot[bucket][rule.currency] ?? 0) + cost
      }
    }
  }
  const routes = [...rows.values()].map(r => {
    const { sessionIds, ...rest } = r
    // billing 供 UI 决定展示：实付 / 订阅折算 / 订阅制 / 未配置；tiered 决定是否展示峰谷。
    const mode = r.rule?.mode ?? 'unknown', priced = mode === 'token' || mode === 'plan'
    return { ...rest, sessions: sessionIds.size, totalTokens: TOKEN_FIELDS.reduce((n, f) => n + r[f], 0),
      estimatedCost: priced ? r.peakCost + r.offCost + r.flatCost : null,
      currency: r.rule?.currency ?? null, billing: mode, tiered: priced && r.rule?.peak != null,
      hasPrice: priced, unpriced: mode === 'unknown' }
  }).sort((a, b) => b.totalTokens - a.totalTokens)
  const providers = []
  for (const row of routes) {
    let p = providers.find(p => p.provider === row.provider)
    if (!p) { p = { provider: row.provider, ...zero(), totalTokens: 0, modelCount: 0, costs: {}, planCosts: {}, unpricedModels: 0, subscriptionModels: 0, tiered: false }; providers.push(p) }
    p.modelCount++; p.totalTokens += row.totalTokens
    for (const f of TOKEN_FIELDS) p[f] += row[f]
    // 分账：订阅制的钱不是按量付的，并进“已定价估算”会让总计失真。
    const bucket = row.billing === 'token' ? p.costs : row.billing === 'plan' ? p.planCosts : null
    if (bucket) {
      bucket[row.currency] = (bucket[row.currency] ?? 0) + row.estimatedCost
      p.tiered = p.tiered || row.tiered
    } else if (row.billing === 'subscription') p.subscriptionModels++
    else p.unpricedModels++
  }
  const costs = {}, planCosts = {}, totalTokens = routes.reduce((n, r) => n + r.totalTokens, 0)
  for (const p of providers) {
    for (const [currency, cost] of Object.entries(p.costs)) costs[currency] = (costs[currency] ?? 0) + cost
    for (const [currency, cost] of Object.entries(p.planCosts)) planCosts[currency] = (planCosts[currency] ?? 0) + cost
  }
  const projects = [...projectRows.values()]
    .map(({ sessionIds, byProvider, ...rest }) => ({ ...rest, sessions: sessionIds.size,
      // provider 拆分按用量降序，UI 直接渲染即可
      providers: [...byProvider.entries()].map(([provider, b]) => ({ provider, ...b })).sort((a, b) => b.tokens - a.tokens) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
  if (missingUsage) warnings.push(`${missingUsage} 条回复没有 usage，未计入 token；请求失败但服务端扣费的情况也可能漏记`)
  if (routes.some(r => r.unknownTimeTokens)) warnings.push('部分峰谷请求缺少时间，未估算对应费用')
  const factList = [...facts.values()].sort((a, b) => a.t - b.t)
  return { routes, providers, projects, facts: factList, hourly: Object.fromEntries(hourly),
    daily: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)), errors,
    warnings, sessionCount: records.filter(r => !r.error).length, firstTime: times.length ? Math.min(...times) : null,
    lastTime: times.length ? Math.max(...times) : null, totals: { totalTokens, costs, planCosts, unpricedModels: routes.filter(r => r.unpriced).length }, scannedAt: Date.now() }
}
