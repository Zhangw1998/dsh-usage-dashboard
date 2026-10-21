/**
 * 统一聚合层：把 host 的事实表按「时间 × 项目 × Provider × 模型」筛选后，
 * 产出所有视图需要的形状。
 *
 * 设计要点（本次重构的核心）：
 *  - KPI、趋势、Provider 排名、项目明细全部来自同一份 facts 与同一组筛选条件，
 *    所以同一个数字在不同模块之间天然对账，不会再出现「24H 显示 A、项目合计显示 B」。
 *  - 费用分两个口径，永不合并：`cost`（按量计价的预估）与 `planCost`（订阅折算）。
 *    未定价的行两者都是 null —— 绝不当成 0。
 *  - 不同币种各自累计，不引入汇率假设。
 */

export const HOUR = 3600000
export const DAY = 86400000
/** 数据按北京时间（UTC+8）分桶，与 host 一致 */
export const TZ_OFFSET = 8 * HOUR

/** 时间戳 → 北京时间的「YYYY-MM-DD」 */
export const dayOf = ms => new Date(ms + TZ_OFFSET).toISOString().slice(0, 10)

/** 时间戳 → 北京时间当天 00:00 对应的真实时间戳 */
export function dayStart(ms) {
  const shifted = ms + TZ_OFFSET
  return Math.floor(shifted / DAY) * DAY - TZ_OFFSET
}

/** 范围定义：窗口长度与粒度 */
export const RANGES = [
  { key: 'today', label: '今天', days: 1, gran: 'hour' },
  { key: '24h', label: '24H', hours: 24, gran: 'hour' },
  { key: '7d', label: '7D', days: 7, gran: 'day' },
  { key: '30d', label: '30D', days: 30, gran: 'day' },
  { key: '90d', label: '90D', days: 90, gran: 'week' },
  { key: 'all', label: '全部', days: 0, gran: 'day' },
  { key: 'custom', label: '自定义', days: 0, gran: 'day' },
]
export const RANGE_KEYS = RANGES.map(r => r.key)

/**
 * 解析范围为绝对时间窗 [from, to)，to = now。
 * 今天 = 北京时间今天 00:00 起；24H = 滚动 24 小时窗口（两者语义不同）。
 */
export function resolveWindow(rangeKey, nowMs, custom) {
  const now = nowMs
  if (rangeKey === 'custom') {
    if (!custom || !custom.from) return { from: dayStart(now), to: now + 1, label: '自定义' }
    const from = Date.parse(custom.from + 'T00:00:00+08:00')
    const toDay = custom.to || dayOf(now)
    const to = Date.parse(toDay + 'T00:00:00+08:00') + DAY
    return {
      from: Number.isFinite(from) ? from : dayStart(now),
      to: Number.isFinite(to) ? to : now + 1,
      label: '自定义',
    }
  }
  const spec = RANGES.find(r => r.key === rangeKey) || RANGES[3]
  if (spec.key === 'today') return { from: dayStart(now), to: now + 1, label: spec.label }
  if (spec.key === '24h') return { from: now - 24 * HOUR, to: now + 1, label: spec.label }
  if (!spec.days) return { from: -Infinity, to: now + 1, label: spec.label }
  // 近 N 天：从 (N-1) 天前的 00:00 起，含今天共 N 个自然日
  return { from: dayStart(now) - (spec.days - 1) * DAY, to: now + 1, label: spec.label }
}

/** 上一窗口（用于环比）。无界范围没有上期。 */
export function previousWindow(win, rangeKey) {
  if (rangeKey === 'all' || rangeKey === 'custom') return null
  if (!Number.isFinite(win.from)) return null
  const span = win.to - win.from
  return { from: win.from - span, to: win.from }
}

const emptyAcc = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, calls: 0,
  cost: {}, planCost: {}, unpricedTokens: 0,
})

function addFact(acc, f) {
  acc.calls += f.calls || 0
  acc.input += f.inputTokens || 0
  acc.output += f.outputTokens || 0
  acc.cacheRead += f.cacheReadTokens || 0
  acc.cacheWrite += f.cacheWriteTokens || 0
  const t = (f.inputTokens || 0) + (f.outputTokens || 0) + (f.cacheReadTokens || 0) + (f.cacheWriteTokens || 0)
  acc.tokens += t
  // 费用二选一，绝不相加：有 cost 记 cost，否则有 planCost 记 planCost，都没有算未定价
  if (Number.isFinite(f.cost)) acc.cost[f.currency] = (acc.cost[f.currency] || 0) + f.cost
  else if (Number.isFinite(f.planCost)) acc.planCost[f.currency] = (acc.planCost[f.currency] || 0) + f.planCost
  else acc.unpricedTokens += t
  return acc
}

/** 把金额桶相加（同币种） */
export function mergeMoney(...buckets) {
  const out = {}
  for (const b of buckets) for (const [c, n] of Object.entries(b || {})) out[c] = (out[c] || 0) + n
  return out
}

/** 环比：上期为 0/缺失时返回 null，绝不假装 0% */
export function ratio(cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null
  return (cur - prev) / prev
}

/** 项目路径 → 末段目录名 */
export function projectBase(path) {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 主入口：筛选 + 聚合 */
export function buildView(scan, filters, nowMs) {
  const rangeKey = filters.range || '30d'
  const win = resolveWindow(rangeKey, nowMs, filters.custom)
  const prevWin = previousWindow(win, rangeKey)

  const projectFilter = filters.project && filters.project !== '*' ? filters.project : null
  const providerFilter = filters.provider && filters.provider !== '*' ? filters.provider : null
  const modelFilter = filters.model && filters.model !== '*' ? filters.model : null

  const pass = f =>
    (!projectFilter || f.project === projectFilter) &&
    (!providerFilter || f.provider === providerFilter) &&
    (!modelFilter || f.model === modelFilter)

  const inWin = [], inPrev = []
  for (const f of scan.facts || []) {
    if (f.t >= win.from && f.t < win.to) {
      if (pass(f)) inWin.push(f)
    } else if (prevWin && f.t >= prevWin.from && f.t < prevWin.to && pass(f)) {
      inPrev.push(f)
    }
  }

  const totals = inWin.reduce((a, f) => addFact(a, f), emptyAcc())
  const prevTotals = inPrev.reduce((a, f) => addFact(a, f), emptyAcc())

  const gran = (RANGES.find(r => r.key === rangeKey) || {}).gran || 'day'
  const series = bucketize(inWin, win, gran, nowMs)

  const group = (keyFn) => {
    const m = new Map()
    for (const f of inWin) {
      const k = keyFn(f)
      if (!k) continue
      if (!m.has(k)) m.set(k, { name: k, ...emptyAcc() })
      addFact(m.get(k), f)
    }
    return [...m.values()].sort((a, b) => b.tokens - a.tokens)
  }
  const byProvider = group(f => f.provider)
  const byModel = group(f => f.model)

  // 项目：带 provider 下钻
  const projectMap = new Map()
  for (const f of inWin) {
    const k = f.project || ''
    if (!projectMap.has(k)) projectMap.set(k, { path: k, name: projectBase(k), ...emptyAcc(), providers: new Map() })
    const p = projectMap.get(k)
    addFact(p, f)
    if (!p.providers.has(f.provider)) p.providers.set(f.provider, { name: f.provider, ...emptyAcc() })
    addFact(p.providers.get(f.provider), f)
  }
  const byProject = [...projectMap.values()]
    .map(p => ({ ...p, providers: [...p.providers.values()].sort((a, b) => b.tokens - a.tokens) }))
    .sort((a, b) => b.tokens - a.tokens)

  // 会话数只在「未按维度筛选」时严格成立（host 的会话数不分时段），筛选时留空避免误导
  const sessionOf = new Map()
  if (!projectFilter && !providerFilter && !modelFilter) {
    for (const p of scan.projects || []) sessionOf.set(p.project || '', p.sessions || 0)
  }

  // 筛选器可选项：来自全部数据，不受当前筛选影响（否则选项会消失）
  const allFacts = scan.facts || []
  const options = {
    projects: [...new Set(allFacts.map(f => f.project).filter(Boolean))].sort(),
    providers: [...new Set(allFacts.map(f => f.provider).filter(Boolean))].sort(),
    models: [...new Set(allFacts.map(f => f.model).filter(Boolean))].sort(),
  }

  return {
    rangeKey, win, prevWin, gran,
    totals, prevTotals,
    series,
    byProvider, byProject, byModel,
    sessionOf,
    options,
    filters: { project: projectFilter, provider: providerFilter, model: modelFilter },
    factCount: inWin.length,
    allTokens: (scan.totals && scan.totals.totalTokens) || 0,
  }
}

/** 按粒度把事实行分桶，并补齐范围内所有桶（含空桶） */
function bucketize(facts, win, gran, nowMs) {
  const keyOf = t => {
    if (gran === 'hour') return Math.floor(t / HOUR) * HOUR
    if (gran === 'week') {
      const d = new Date(t + TZ_OFFSET)
      return dayStart(t) - ((d.getUTCDay() + 6) % 7) * DAY // 周一为周首
    }
    return dayStart(t)
  }
  const m = new Map()
  const ensure = k => {
    if (!m.has(k)) m.set(k, { t: k, day: dayOf(k), ...emptyAcc() })
    return m.get(k)
  }
  for (const f of facts) addFact(ensure(keyOf(f.t)), f)

  if (Number.isFinite(win.from)) {
    const step = gran === 'hour' ? HOUR : gran === 'week' ? 7 * DAY : DAY
    let cursor = keyOf(win.from)
    const last = keyOf(Math.min(win.to - 1, nowMs))
    let guard = 0
    while (cursor <= last && guard++ < 400) {
      ensure(cursor)
      cursor += step
    }
  }
  return [...m.values()].sort((a, b) => a.t - b.t)
}

/** 占比 */
export function share(value, total) {
  return total > 0 ? value / total : 0
}

/** 金额桶求和（用于排序 / 占比，单币种场景） */
export function sumMoney(bucket) {
  return Object.values(bucket || {}).reduce((a, b) => a + b, 0)
}
