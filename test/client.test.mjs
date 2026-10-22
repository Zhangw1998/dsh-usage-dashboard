/**
 * 客户端 UI 的渲染测试。
 *
 * 用一个极小的 fake React（按组件类型持有 hook 槽）跑真实的 UsageSection，
 * 断言的是**结构与非零值语义**，不是像素：
 *  - 费用两个口径分开渲染，未定价显示「未定价」而不是 ¥0；
 *  - 三维筛选（时间/项目/Provider）会真正改变渲染出的数据；
 *  - 项目表可展开出 Provider 下钻；
 *  - 空数据、加载态、错误态都有对应输出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const HOUR = 3600000
const NOW = Date.now()
const dayOf = ms => new Date(ms + 8 * HOUR).toISOString().slice(0, 10)

/** 构造一条事实行 */
const fact = (over = {}) => ({
  t: NOW - 2 * HOUR, day: dayOf(NOW - 2 * HOUR), hour: 12,
  project: '/w/alpha', provider: 'deepseek-official', model: 'deepseek-flash',
  inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 0, calls: 1,
  cost: 12.5, planCost: null, currency: 'CNY', ...over,
})

/** 最小可用的 scan，所有视图都从 facts 聚合 */
function makeScan(facts) {
  const tokensOf = f => (f.inputTokens || 0) + (f.outputTokens || 0) + (f.cacheReadTokens || 0) + (f.cacheWriteTokens || 0)
  const byProvider = new Map(), byProject = new Map()
  for (const f of facts) {
    byProvider.set(f.provider, (byProvider.get(f.provider) || 0) + tokensOf(f))
    byProject.set(f.project, (byProject.get(f.project) || 0) + tokensOf(f))
  }
  return {
    facts,
    routes: [],
    providers: [...byProvider].map(([provider, totalTokens]) => ({
      provider, totalTokens, modelCount: 1, costs: {}, planCosts: {},
      subscriptionModels: 0, unpricedModels: 0, tiered: false,
    })),
    projects: [...byProject].map(([project, totalTokens]) => ({
      project, totalTokens, sessions: 3, costs: {}, planCosts: {}, providers: [],
    })),
    daily: [],
    hourly: {},
    errors: [], warnings: [],
    sessionCount: 7,
    firstTime: NOW - 30 * 86400000, lastTime: NOW,
    totals: { totalTokens: facts.reduce((n, f) => n + tokensOf(f), 0), costs: {}, planCosts: {}, unpricedModels: 0 },
    pricing: {}, defaults: {}, pricingPath: '',
    scannedAt: NOW,
  }
}

/** 带持久化 hook 槽的 fake React */
function environment({ scan, seedStorage = {}, request, balances } = {}) {
  let definition, component, dictionaries
  const components = {}
  const slots = { current: null }
  const slotState = new Map()
  const effects = []
  const calls = []

  const React = {
    createElement: (type, props, ...children) =>
      // 与 React 一致：children 既是 props.children，也保留在节点上便于遍历
      ({ type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] }, children }),
    useState: initial => {
      const slot = slots.current
      const i = slot.index++
      if (!(i in slot.state)) slot.state[i] = typeof initial === 'function' ? initial() : initial
      return [slot.state[i], next => { slot.state[i] = typeof next === 'function' ? next(slot.state[i]) : next }]
    },
    useRef: cur => { const s = slots.current, i = s.index++; if (!(i in s.ref)) s.ref[i] = { current: cur }; return s.ref[i] },
    useCallback: fn => { slots.current.index++; return fn },
    useEffect: fn => { slots.current.index++; effects.push(fn) },
    useMemo: fn => { slots.current.index++; return fn() },
  }
  const h = (type, props, ...children) =>
    ({ type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] }, children })

  const store = new Map(Object.entries(seedStorage))
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }

  // 捕获自动刷新定时器：测试里手动推进，不真的等
  const timers = []
  const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  globalThis.clearInterval = () => {}

  // 最小 document：自动刷新要按可见性决定是否跑
  const listeners = new Set()
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (n, fn) => { if (n === 'visibilitychange') listeners.add(fn) },
    removeEventListener: (n, fn) => { listeners.delete(fn) },
  }
  const setVisibility = v => {
    globalThis.document.visibilityState = v
    for (const fn of listeners) fn()
  }

  const winListeners = new Set()
  const win = {
    __ModuleLoader__: { load: d => { definition = d } },
    addEventListener: (n, fn) => winListeners.add(fn),
    removeEventListener: (n, fn) => winListeners.delete(fn),
    dispatchEvent: () => { for (const fn of [...winListeners]) fn(); return true },
  }
  globalThis.window = win
  new Function('window', source)(win)
  const plugin = definition.factory(name => { assert.equal(name, 'react'); return React })
  const t = key => dictionaries.zh[key] ?? key
  plugin.apply({
    locale: { bind: () => t, register: (ns, d) => { dictionaries = d; return () => {} } },
    effect: f => f(),
    slots: { inject: (n, f) => f(), register: (d, c) => { components[d.name] = c; if (d.name === 'settings.section') component = c; return () => {} } },
  })

  const render = node => {
    if (Array.isArray(node)) return node.map(render)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      if (!slotState.has(node.type)) slotState.set(node.type, { index: 0, state: {}, ref: {} })
      const slot = slotState.get(node.type)
      slot.index = 0
      // 保存/恢复父组件的槽：子组件渲染期间 slots.current 会切走，回来必须还原
      const parent = slots.current
      slots.current = slot
      const out = node.type(node.props)
      const rendered = render(out)
      slots.current = parent
      return rendered
    }
    return { ...node, children: node.children.map(render) }
  }
  // 首帧渲染会收集 effect；effect 里的 fetch 是异步的，需要等它落地再重渲染。
  let mounted = false
  const settle = async () => {
    render(h(component, { t }))
    if (!mounted) {
      mounted = true
      for (const fn of effects) fn()
      for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r))
    }
    return render(h(component, { t }))
  }
  const tree = () => render(h(component, { t }))

  globalThis.fetch = async url => {
    calls.push(String(url))
    if (request && String(url).includes('?refresh=1')) return request(String(url))
    const body = String(url).includes('balances') ? (balances ?? { rows: [], checkedAt: NOW })
      : String(url).includes('.pricing') ? { ok: true }
        : { scan }
    return new Response(JSON.stringify(body))
  }
  return {
    tree, settle, dictionaries, effects, calls, store, t, timers, setVisibility, components,
    // 槽位组件有自己的 hook 槽与 effect：先渲染收集 effect，跑完再渲染一次
    renderSlot: async (name, props = {}) => {
      const comp = components[name]
      render(h(comp, { t, ...props }))
      for (const fn of effects.splice(0)) fn()
      for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r))
      return render(h(comp, { t, ...props }))
    },
    restoreTimers: () => { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval },
  }
}

const flatten = node => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  if (!node || typeof node !== 'object') return ''
  // 跳过 <style>：样式表的文本不是界面文案
  if (node.type === 'style') return ''
  return node.children ? flatten(node.children) : ''
}

function all(node, type, out = []) {
  if (Array.isArray(node)) for (const n of node) all(n, type, out)
  else if (node && typeof node === 'object') {
    if (type === '*' || node.type === type) out.push(node)
    all(node.children, type, out)
  }
  return out
}
const byClass = (node, cls) => all(node, '*').filter(n => n && typeof n === 'object' &&
  String(n.props?.className || '').split(/\s+/).includes(cls))
const clickText = (env, text) => {
  const btn = all(env.tree(), 'button').find(b => flatten(b).trim() === text)
  assert.ok(btn, `未找到按钮: ${text}`)
  btn.props.onClick?.({ preventDefault() {} })
}
const buttonTexts = node => all(node, 'button').map(b => flatten(b).trim())

// ---------------- 注册与外壳 ----------------

await test('registers a settings section and pulls the report once', async () => {
  const e = environment({ scan: makeScan([fact()]) })
  await e.settle()
  assert.equal(e.dictionaries.zh.nav, '用量与花费')
  assert.ok(e.calls[0].includes('api/usage.dashboard'), `应请求报告接口，实际 ${e.calls[0]}`)
})

await test('renders the workstation shell: title, filters, kpis, trend, providers, projects', async () => {
  const e = environment({ scan: makeScan([fact()]) })
  const tree = await e.settle()
  const text = flatten(tree)
  assert.ok(text.includes('用量与花费'), '标题')
  assert.ok(text.includes('预估费用'), '费用 KPI')
  assert.ok(text.includes('总 Token'), '总 Token KPI')
  assert.ok(byClass(tree, 'ud-filters').length, '筛选行')
  assert.ok(byClass(tree, 'ud-kpis').length, 'KPI 容器')
  assert.ok(byClass(tree, 'ud-trend').length, '趋势图')
  assert.ok(byClass(tree, 'ud-rank').length, 'Provider 排名')
  assert.ok(byClass(tree, 'ud-table').length, '项目表')
})

await test('old three-tab layout is gone', async () => {
  const e = environment({ scan: makeScan([fact()]) })
  const texts = buttonTexts(await e.settle())
  for (const gone of ['总览', '每日']) {
    assert.ok(!texts.includes(gone), `不应再有「${gone}」分页`)
  }
})

// ---------------- 费用语义 ----------------

await test('estimated cost is labelled as an estimate, not a bill', async () => {
  const e = environment({ scan: makeScan([fact()]) })
  const text = flatten(await e.settle())
  assert.ok(text.includes('预估费用'), '主 KPI 必须叫「预估费用」')
  assert.ok(!text.includes('实付'), '不得再出现「实付」这种会被读成账单的措辞')
  assert.ok(!/账单实付|真金白银/.test(text), '不得暗示是真实扣费')
})

await test('subscription plan value renders with ≈ and separately from cost', async () => {
  const scan = makeScan([
    fact({ cost: 10, planCost: null, currency: 'CNY' }),
    fact({ provider: 'workbuddy', cost: null, planCost: 4, currency: 'CNY' }),
  ])
  const e = environment({ scan })
  const text = flatten(await e.settle())
  assert.ok(text.includes('订阅折算'), '应有订阅折算 KPI')
  assert.ok(text.includes('≈'), '折算必须带 ≈')
  const tree = e.tree()
  assert.equal(byClass(tree, 'ud-stat-primary').length, 2, '只有费用与总 Token 是主卡')
  const auxiliary = byClass(tree, 'ud-kpi-foot')[0]
  assert.ok(flatten(auxiliary).includes('订阅折算') && flatten(auxiliary).includes('≈'), '订阅折算收在带标签的辅助信息区')
  assert.ok(!byClass(tree, 'ud-stat-primary').some(card => flatten(card).includes('订阅折算')), '订阅折算不再占一张等高主卡')
})

await test('unpriced usage is labelled, never rendered as ¥0', async () => {
  const scan = makeScan([fact({ cost: null, planCost: null, currency: null })])
  const e = environment({ scan })
  const text = flatten(await e.settle())
  assert.ok(text.includes('未定价'), '未定价必须有明确标注')
  assert.ok(!/¥\s?0(\.00)?/.test(text), '未定价不得显示为 0 元')
})

await test('currencies are not summed together', async () => {
  const scan = makeScan([
    fact({ cost: 3, currency: 'CNY' }),
    fact({ provider: 'openai-codex', cost: 5, currency: 'USD' }),
  ])
  const e = environment({ scan })
  const text = flatten(await e.settle())
  assert.ok(text.includes('¥'), 'CNY 金额')
  assert.ok(text.includes('$'), 'USD 金额')
  assert.ok(!text.includes('¥8'), '不得把 3 CNY 与 5 USD 加成 8')
})

// ---------------- 筛选 ----------------

await test('range segments exist and 24H drives hourly granularity', async () => {
  const e = environment({ scan: makeScan([fact({ t: NOW - 1 * HOUR })]) })
  const texts = buttonTexts(await e.settle())
  for (const label of ['今天', '24H', '7D', '30D', '90D']) assert.ok(texts.includes(label), `缺少范围 ${label}`)
  clickText(e, '24H')
  assert.ok(flatten(e.tree()).includes('按小时'), '24H 必须是小时粒度')
})

await test('project and provider selects are present with an all-option', async () => {
  const scan = makeScan([fact(), fact({ project: '/w/beta', provider: 'workbuddy' })])
  const e = environment({ scan })
  const selects = all(await e.settle(), 'select')
  assert.equal(selects.length, 2, `应有项目与 Provider 两个下拉，实际 ${selects.length}`)
  assert.ok(flatten(selects[0]).includes('全部项目'), '项目下拉要有「全部项目」')
  assert.ok(flatten(selects[1]).includes('全部 Provider'), 'Provider 下拉要有「全部 Provider」')
})

await test('choosing a project filters the view and exposes a clear button', async () => {
  const scan = makeScan([
    fact({ project: '/w/alpha' }),
    fact({ project: '/w/beta', inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0, cost: 50 }),
  ])
  const e = environment({ scan })
  const before = flatten(await e.settle())
  all(e.tree(), 'select')[0].props.onChange({ target: { value: '/w/beta' } })
  const after = flatten(e.tree())
  assert.notEqual(before, after, '改变项目筛选必须改变渲染结果')
  assert.ok(after.includes('清除筛选'), '有筛选时要提供清除入口')
  clickText(e, '清除筛选')
  assert.ok(!flatten(e.tree()).includes('清除筛选'), '清除后按钮消失')
})

await test('clicking a provider row filters by it', async () => {
  const scan = makeScan([fact({ provider: 'p1' }), fact({ provider: 'p2' })])
  const e = environment({ scan })
  const rows = byClass(await e.settle(), 'ud-rank-btn')
  assert.ok(rows.length >= 2, 'Provider 排名应有可点击行')
  rows[0].props.onClick()
  assert.ok(flatten(e.tree()).includes('清除筛选'), '点击 Provider 后应进入筛选态')
})

// ---------------- 项目表 ----------------

await test('provider breakdown shows each provider input/output/cache numbers', async () => {
  const scan = makeScan([
    fact({ provider: 'p1', inputTokens: 2_000_000, outputTokens: 300_000, cacheReadTokens: 5_000_000, cost: 9 }),
  ])
  const e = environment({ scan })
  const panel = byClass(await e.settle(), 'ud-rank-row')[0]
  const parts = byClass(panel, 'ud-rank-part').map(p => flatten(p))
  assert.equal(parts.length, 4, '每个 Provider 要有输入/输出/缓存/调用四项明细')
  assert.ok(parts.some(p => p.startsWith('输入') && p.includes('2M')), '输入数值')
  assert.ok(parts.some(p => p.startsWith('输出') && p.includes('300K')), '输出数值')
  assert.ok(parts.some(p => p.startsWith('缓存读取') && p.includes('5M')), '缓存数值')
  assert.ok(parts.some(p => p.startsWith('次调用')), '调用次数')
  // 条形按构成分段，颜色与趋势图一致
  const segs = byClass(panel, 'ud-rank-seg')
  assert.equal(segs.length, 3, '堆叠条应分成输入/缓存/输出三段')
  assert.ok(segs.some(s => String(s.props.className).includes('ud-mix-input')))
  assert.ok(segs.some(s => String(s.props.className).includes('ud-mix-cache')))
  assert.ok(segs.some(s => String(s.props.className).includes('ud-mix-output')))
})

await test('project table exposes expandable rows with a provider drill-down', async () => {
  const scan = makeScan([
    fact({ project: '/w/alpha', provider: 'p1' }),
    fact({ project: '/w/alpha', provider: 'p2' }),
  ])
  const e = environment({ scan })
  const tree = await e.settle()
  // 默认收起：没有下钻块
  assert.equal(byClass(tree, 'ud-sub-list').length, 0, '默认收起')
  // 有展开控件且初始 aria-expanded=false
  const caret = byClass(tree, 'ud-expand')[0]
  assert.ok(caret, '应有展开按钮')
  assert.equal(caret.props['aria-expanded'], false, '默认未展开')
  caret.props.onClick()
  const expanded = e.tree()
  assert.equal(byClass(expanded, 'ud-sub-list').length, 1, '组件类型稳定，重渲染后仍保持展开')
  assert.ok(flatten(byClass(expanded, 'ud-sub-list')).includes('p1'))
  assert.ok(flatten(byClass(expanded, 'ud-sub-list')).includes('p2'))
})

// ---------------- 状态 ----------------

await test('empty range renders an explicit empty state, never a broken chart', async () => {
  const e = environment({ scan: makeScan([]) })
  const tree = await e.settle()
  assert.ok(byClass(tree, 'ud-empty').length >= 1, '空范围必须有空态占位')
  assert.ok(!byClass(tree, 'ud-col').length, '空数据不渲染柱子')
  assert.ok(source.includes('该范围内没有记录'), '空态文案必须存在')
})

await test('loading state names what is happening', async () => {
  // 首帧（fetch 未回填）必须给出加载文案而不是空白
  const e = environment({ scan: null })
  const first = flatten(e.tree())
  assert.ok(first.includes('正在统计'), `首帧应有加载提示，实际: ${first.slice(0, 80)}`)
  assert.ok(source.includes('loadingHint'), '加载态要解释为什么慢')
})

await test('warnings from the host are surfaced', async () => {
  const scan = makeScan([fact()])
  scan.warnings = ['2 条回复没有 usage，未计入 token']
  const e = environment({ scan })
  assert.ok(flatten(await e.settle()).includes('2 条回复没有 usage'), 'host 的统计提醒要显示出来')
})

// ---------------- 第二轮视觉与刷新交互 ----------------

await test('header uses a labelled icon refresh and successful refresh updates the timestamp', async () => {
  const scan = makeScan([fact()])
  let complete
  const e = environment({ scan, request: () => new Promise(resolve => { complete = resolve }) })
  const initial = await e.settle()
  const refresh = byClass(initial, 'ud-icon-btn')[0]
  assert.equal(refresh.props.title, '刷新用量统计')
  assert.equal(refresh.props['aria-label'], '刷新用量统计')
  assert.equal(flatten(refresh).trim(), '', '默认只有图标，不显示文字按钮')
  assert.equal(all(refresh, 'svg').length, 1)
  assert.equal(refresh.props.disabled, false)
  const before = flatten(byClass(initial, 'ud-updated'))
  refresh.props.onClick()
  const busy = byClass(e.tree(), 'ud-icon-btn')[0]
  assert.equal(busy.props.disabled, true, '进行中禁止重复点击')
  assert.equal(busy.props['aria-busy'], true)
  assert.equal(busy.props['data-busy'], 'true', '旋转样式与请求状态一致')
  complete(new Response(JSON.stringify({ scan: { ...scan, scannedAt: scan.scannedAt + 120000 } })))
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(byClass(e.tree(), 'ud-icon-btn')[0].props.disabled, false)
  assert.notEqual(flatten(byClass(e.tree(), 'ud-updated')), before, '成功后显示新的扫描时间')
})

await test('refresh failure is explicit and preserves the previous data and timestamp', async () => {
  const scan = makeScan([fact()])
  const e = environment({ scan, request: async () => new Response(JSON.stringify({ error: '刷新暂时失败' }), { status: 503 }) })
  const before = await e.settle()
  const oldTime = flatten(byClass(before, 'ud-updated'))
  const oldValues = flatten(byClass(before, 'ud-stat-value'))
  await byClass(before, 'ud-icon-btn')[0].props.onClick()
  const after = e.tree()
  assert.ok(flatten(byClass(after, 'ud-alert-err')).includes('刷新暂时失败'))
  assert.equal(flatten(byClass(after, 'ud-updated')), oldTime, '失败不能伪装成刚更新成功')
  assert.equal(flatten(byClass(after, 'ud-stat-value')), oldValues, '刷新失败保留缓存结果')
  assert.equal(byClass(after, 'ud-icon-btn')[0].props.disabled, false)
})

await test('visual hierarchy has two main cards, equal filter selects and auxiliary tokens', async () => {
  const e = environment({ scan: makeScan([fact()]) })
  const tree = await e.settle()
  assert.equal(byClass(tree, 'ud-stat-primary').length, 2)
  assert.equal(byClass(tree, 'ud-filter-range').length, 1)
  assert.equal(all(byClass(tree, 'ud-filter-selects')[0], 'select').length, 2)
  assert.equal(byClass(tree, 'ud-mix-item').length, 3)
  assert.ok(!flatten(tree).includes('缓存命中率'), '缓存读取占比不是命中率')
  const css = source.slice(source.indexOf('const CHART_CSS'))
  assert.ok(css.includes('.ud-icon-btn:hover:not(:disabled)'))
  assert.ok(css.includes('data-busy="true"'))
  assert.ok(css.includes('prefers-reduced-motion'))
})

await test('call count is aggregated and shown with the totals', async () => {
  const scan = makeScan([
    fact({ provider: 'p1' }), fact({ provider: 'p1' }), fact({ provider: 'p2' }),
  ])
  const e = environment({ scan })
  const foot = byClass(await e.settle(), 'ud-foot-item').map(x => flatten(x))
  assert.ok(foot.some(x => x.startsWith('次调用')), '总计区要有调用次数')
  assert.ok(foot.some(x => x.startsWith('次调用') && x.includes('3')), '三条记录应计 3 次调用')
  // 向下钻取之和必须等于总数
  const rowCalls = byClass(e.tree(), 'ud-rank-row').map(r =>
    Number(flatten(byClass(r, 'ud-rank-part').filter(p => flatten(p).startsWith('次调用'))).replace(/[^0-9]/g, '')))
  assert.equal(rowCalls.reduce((a, b) => a + b, 0), 3, '各 Provider 调用数之和等于总调用数')
})

// ---------------- 自动刷新 ----------------

await test('there is no periodic polling: refresh happens on entry, expand and manual only', async () => {
  const old = makeScan([fact()])
  old.scannedAt = NOW - 5 * 60 * 1000
  const e = environment({ scan: old })
  await e.settle()
  assert.equal(e.timers.length, 0, '不得再注册任何定时器（挂着不动不应烧 CPU）')
  assert.ok(!source.includes('setInterval'), '源码里不应再有周期轮询')
  assert.ok(source.includes("'shell.overlay'"), '悬浮卡必须挂到 shell.overlay')
})

await test('the floating card shows today cost and tokens, and expands to the breakdown', async () => {
  const scan = makeScan([fact({ cost: 12.5, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 3_000_000 })])
  const e = environment({ scan, balances: { checkedAt: NOW, rows: [
    { provider: 'deepseek-official', status: 'ready', available: true, wallets: [{ currency: 'CNY', total: '128.40' }] },
  ] } })
  await e.settle()
  const pill = await e.renderSlot('shell.overlay')
  const text = flatten(pill)
  assert.ok(!text.includes('今日'), '胶囊里不再显示「今日」（省空间，避免超出）')
  assert.ok(byClass(pill, 'ud-fly-refresh').length === 1, '折叠态只该有一个刷新按钮')
  assert.ok(/¥\s?12\.50/.test(text), '折叠态显示今日费用')
  assert.ok(text.includes('4M') || text.includes('4.1M'), '折叠态显示今日 token')
  // 折叠态自带刷新按钮，且不误触展开
  const refresh = byClass(pill, 'ud-fly-refresh')[0]
  assert.ok(refresh, '折叠胶囊要有刷新按钮')
  assert.equal(all(refresh, 'svg').length, 1, '刷新按钮是图标')
  assert.equal(refresh.props.disabled, false)
  const before = e.calls.filter(c => c.includes('refresh=1')).length
  refresh.props.onClick({ stopPropagation() {} })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.ok(e.calls.filter(c => c.includes('refresh=1')).length > before, '点刷新要真的重算')
  // 展开
  const btn = byClass(pill, 'ud-fly-pill')[0]
  btn.props.onClick()
  const openTree = await e.renderSlot('shell.overlay')
  const openText = flatten(openTree)
  assert.ok(openText.includes('输入') && openText.includes('输出') && openText.includes('缓存读取'))
  assert.ok(openText.includes('次调用'))
  assert.ok(openText.includes('128.40'), '展开后显示 DeepSeek 余额')
})

await test('entering the panel paints from cache, then refreshes once when that cache is old', async () => {
  const old = makeScan([fact()])
  old.scannedAt = NOW - 30 * 60 * 1000          // 半小时前的缓存
  const e = environment({ scan: old })
  await e.settle()
  // 不应该因为「先出缓存」就丢掉首屏
  assert.ok(flatten(e.tree()).includes('DeepSeek 余额') || byClass(e.tree(), 'ud-kpis').length, '进面板要立刻出内容')
  assert.ok(e.calls.filter(c => c.includes('refresh=1')).length >= 1, '旧缓存进入后应补一次最新')
})

await test('entering the panel does not re-scan when the cache is recent', async () => {
  const recent = makeScan([fact()])
  recent.scannedAt = NOW - 10 * 1000             // 10 秒前刚算过
  const e = environment({ scan: recent })
  await e.settle()
  assert.equal(e.calls.filter(c => c.includes('usage.dashboard?refresh=1')).length, 0, '刚算过就别重复扫')
})

const balancesOf = rows => ({ rows, checkedAt: NOW })

await test('the settings switch turns the floating card off and back on', async () => {
  const e = environment({ scan: makeScan([fact()]), seedStorage: {} })
  e.store.set('dsh-usage-dashboard.overlay.enabled', '0')
  await e.settle()
  const off = await e.renderSlot('shell.overlay')
  assert.equal(flatten(off).trim(), '', '关掉后不应渲染悬浮卡')
  const sw = byClass(e.tree(), 'ud-switch')[0]
  assert.ok(sw, '设置页要有一个开关')
  sw.children.find(c => c && c.type === 'input').props.onChange({ target: { checked: true } })
  await new Promise(r => setImmediate(r))
  const on = await e.renderSlot('shell.overlay')
  assert.ok(flatten(on).includes('¥'), '打开后悬浮卡回来')
})

await test('account balance is shown again, with top-up and bonus split apart', async () => {
  const e = environment({ scan: makeScan([fact()]), balances: balancesOf([
    { provider: 'deepseek-official', status: 'ready', available: true,
      wallets: [{ currency: 'CNY', total: '558.63', toppedUp: '423.54', granted: '135.08' }],
      scope: '账号余额，多个 API key / 工具共享', checkedAt: NOW },
  ]) })
  const tree = await e.settle()
  const panel = byClass(tree, 'ud-bal')[0]
  assert.ok(panel, '余额面板必须渲染')
  const text = flatten(panel)
  assert.ok(text.includes('DeepSeek 官方 API'), 'DeepSeek 钱包要用可读名字显示')
  assert.ok(text.includes('558.63'), '必须显示账号余额')
  assert.ok(text.includes('423.54') && text.includes('135.08'), '充值/赠送分开显示')
  assert.ok(text.includes('余额属于账号'), '必须说明余额是账号共享的')
})

await test('a failed balance lookup is never rendered as zero', async () => {
  const e = environment({ scan: makeScan([fact()]), balances: balancesOf([
    { provider: 'deepseek-official', status: 'failed', message: '余额查询失败或响应无效（不代表余额为零）' },
  ]) })
  const text = flatten(byClass(await e.settle(), 'ud-bal')[0])
  assert.ok(text.includes('查询失败'))
  assert.ok(!/¥\s?0(\.00)?\b/.test(text), '查询失败不能显示成 0 元')
})

await test('only the two DeepSeek wallets are listed', async () => {
  const e = environment({ scan: makeScan([fact()]), balances: balancesOf([
    { provider: 'deepseek-official', status: 'ready', available: true, wallets: [{ currency: 'CNY', total: '10.00' }] },
    { provider: 'deepseek-account', status: 'ready', wallets: [{ currency: 'CNY', total: '2.00' }] },
    { provider: 'openai-codex', status: 'unsupported', message: '暂无余额接口适配；不代表余额为零' },
    { provider: 'ark-coding', status: 'unsupported', message: '暂无余额接口适配；不代表余额为零' },
  ]) })
  const panel = byClass(await e.settle(), 'ud-bal')[0]
  const rows = byClass(panel, 'ud-bal-row')
  assert.equal(rows.length, 2, '只保留 DeepSeek 的两个钱包')
  const text = flatten(panel)
  assert.ok(text.includes('DeepSeek 官方 API') && text.includes('DeepSeek 登录账号'))
  assert.ok(!text.includes('codex') && !text.includes('ark-coding') && !text.includes('workbuddy'), '不显示其他供应商')
})

await test('balance panel explains itself when nothing is available', async () => {
  const e = environment({ scan: makeScan([fact()]), balances: balancesOf([]) })
  const panel = byClass(await e.settle(), 'ud-bal')[0]
  assert.ok(flatten(panel).includes('暂无 DeepSeek 余额信息'))
})

// ---------------- 本地化 ----------------

await test('zh and en dictionaries have identical keys', async () => {
  const e = environment({ scan: makeScan([fact()]) })
  assert.deepEqual(Object.keys(e.dictionaries.zh).sort(), Object.keys(e.dictionaries.en).sort())
  for (const dict of [e.dictionaries.zh, e.dictionaries.en]) {
    for (const [k, v] of Object.entries(dict)) {
      assert.equal(typeof v, 'string', `${k} 必须是字符串`)
      assert.ok(v.length > 0, `${k} 不得为空`)
    }
  }
})

// ---------------- 主题 ----------------

await test('stylesheet uses only theme tokens, never hardcoded colours', async () => {
  const cssStart = source.indexOf('const CHART_CSS')
  assert.ok(cssStart > 0, 'client.js 必须包含 CHART_CSS')
  const css = source.slice(cssStart, cssStart + 20000)
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert.deepEqual(hex, [], `不得硬编码十六进制颜色，发现 ${hex.slice(0, 5)}`)
  assert.ok(css.includes('var(--dsw-alias-'), '必须使用主题令牌')
})
