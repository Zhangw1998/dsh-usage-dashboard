/**
 * 图表与基础组件（方案 A：极简深色数据工作台）。
 *
 * 只做渲染，数据由 view-model 算好后传入。颜色只用主题令牌，
 * 因此深浅色主题自动跟随；同一个 Provider 的颜色由调用方按名字固定映射。
 */

const moneyFmt = (n, currency) => Number.isFinite(n)
  ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency || 'CNY', maximumFractionDigits: 2 }).format(n)
  : '—'

/** { CNY: 12.3 } → "¥12.30"；多币种用 " + " 连接，绝不跨币种相加 */
const moneyBucket = bucket => {
  const parts = Object.entries(bucket || {}).filter(([, n]) => Number.isFinite(n))
  return parts.length ? parts.map(([c, n]) => moneyFmt(n, c)).join(' + ') : ''
}

/** 多币种分行：{ CNY, USD } → ["¥12.30", "US$5.00"]，每币种独占一行 */
const moneyLines = bucket => Object.entries(bucket || {})
  .filter(([, n]) => Number.isFinite(n))
  .map(([c, n]) => moneyFmt(n, c))

/** 紧凑数字：1234567 → 1.23M */
export function compact(n) {
  const v = Number(n) || 0
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(Math.round(v))
}

/** 环比文案；null → 不显示（不假装 0%） */
export function deltaLabel(d) {
  if (d === null || d === undefined) return ''
  const p = Math.abs(d) * 100
  const s = p >= 10 ? Math.round(p) : p.toFixed(1)
  return (d > 0 ? '+' : d < 0 ? '-' : '') + s + '%'
}

/**
 * 取文案。宿主传进来的是 locale.bind() 得到的**函数**（用法 t('output')），
 * 不是字典对象。这里兼容两种形态，避免误读成对象属性而得到 undefined。
 *
 * 这个函数是导出给单测用的：曾经把 locale 当对象读，导致图表 tooltip 全部显示
 * undefined —— 那是只有真实渲染才暴露的 bug，所以必须有直接的单测兜住。
 */
export const tr = (locale, key) => typeof locale === 'function' ? locale(key) : (locale?.[key] ?? key)

export function createComponents({ React, h }) {

  // 延迟取 hook：测试/宿主的 hook 分发依赖调用时机，提前解构会把闭包钉在旧引用上
  const useState = (...a) => React.useState(...a)

  // ---------- 基础 ----------

  /** 卡片：低调边框 + 12px 圆角，不堆阴影 */
  /** 取 hook；渲染器不支持时返回 null，让组件退化为无状态 */
  const safeState = init => {
    try { return React.useState(init) } catch { return null }
  }

  function Panel({ title, subtitle, tools, children, className, pad }) {
    return h('section', { className: 'ud-panel' + (className ? ' ' + className : '') },
      title || tools ? h('header', { className: 'ud-panel-head' },
        h('div', { className: 'ud-panel-titles' },
          title ? h('h3', { className: 'ud-panel-title' }, title) : null,
          subtitle ? h('p', { className: 'ud-panel-sub' }, subtitle) : null),
        tools ? h('div', { className: 'ud-panel-tools' }, tools) : null) : null,
      h('div', { className: 'ud-panel-body' + (pad === false ? ' ud-pad-none' : '') }, children))
  }

  /** 分段按钮：紧凑、单行、可换行 */
  function Segmented({ options, value, onChange, ariaLabel, size }) {
    return h('div', { className: 'ud-seg' + (size === 'sm' ? ' ud-seg-sm' : ''), role: 'group', 'aria-label': ariaLabel },
      options.map(o => h('button', {
        key: o.key, type: 'button',
        className: 'ud-seg-btn' + (value === o.key ? ' is-on' : ''),
        'aria-pressed': value === o.key,
        title: o.title || undefined,
        onClick: () => onChange(o.key),
      }, o.label)))
  }

  /** 下拉选择（原生 select，窄屏也稳） */
  function Select({ value, onChange, options, ariaLabel, placeholder }) {
    return h('label', { className: 'ud-select' },
      h('select', {
        value: value || '*', 'aria-label': ariaLabel,
        onChange: e => onChange(e.target.value),
      },
        placeholder ? h('option', { value: '*' }, placeholder) : null,
        options.map(o => h('option', { key: o.value, value: o.value }, o.label))))
  }

  /** 空状态 / 加载态 */
  const Empty = ({ text }) => h('div', { className: 'ud-empty' }, text)
  const Loading = ({ text }) => h('div', { className: 'ud-empty ud-loading' }, text)

  // ---------- KPI ----------

  /**
   * 主指标：大数字 + 辅助拆解。
   * helper 放在数字下方，作为该指标的从属信息（输入/输出/缓存并到总量卡下）。
   */
  function StatPrimary({ label, value, hint, delta, tone, children }) {
    const t = h('div', { className: 'ud-stat ud-stat-primary' + (tone ? ' ud-tone-' + tone : '') },
      h('div', { className: 'ud-stat-label' },
        h('span', null, label),
        hint ? h('span', { className: 'ud-i', title: hint, 'aria-label': hint }, '?') : null,
        delta ? h('span', {
          className: 'ud-delta' + (delta.dir > 0 ? ' is-up' : delta.dir < 0 ? ' is-down' : ''),
          title: delta.title,
        }, delta.text) : null),
      h('div', { className: 'ud-stat-value' },
        Array.isArray(value)
          ? value.map((line, i) => h('span', { key: i, className: 'ud-money-line' }, line))
          : value),
      children ? h('div', { className: 'ud-stat-sub' }, children) : null)
    return t
  }

  /** 拆解项：小标签 + 数值，横向并排 */
  function StatParts({ items }) {
    return h('div', { className: 'ud-parts' }, items.filter(Boolean).map(it => h('span', { key: it.key, className: 'ud-part' },
      h('span', { className: 'ud-part-label' }, it.label),
      h('span', { className: 'ud-part-value' }, it.value))))
  }

  // ---------- 趋势图 ----------

  /**
   * 堆叠柱 + 可选折线（费用）。纯 SVG-less：用 flex 柱 + 绝对定位折线。
   * 之所以不用 SVG 折线：窄宽度下柱状更易读，且无需处理响应式 viewBox。
   */
  function TrendChart({ series, mode, granularity, currency, locale, hideCache }) {
    // 交互态是可选的：拿不到 hook 时用常量，保证静态渲染也能出完整结构
    const hoverPair = safeState(null)
    const hover = hoverPair ? hoverPair[0] : null
    const setHover = hoverPair ? hoverPair[1] : () => {}
    if (!series.length) return h(Empty, { text: tr(locale, 'noData') })

    const isCost = mode === 'cost'
    const sumMoney = b => Object.values(b || {}).reduce((x, y) => x + y, 0)
    // 隐藏缓存时，柱高与堆叠都按「输入+输出」算：缓存常占 95%+，全画会压扁其余两段
    const shown = s => hideCache && !isCost ? s.input + s.output : s.tokens
    const valueOf = s => isCost ? sumMoney(s.cost) : shown(s)
    // 全零（范围内确实没量）时给空态，而不是画一排 0 高度的空柱
    if (series.every(s => valueOf(s) <= 0)) return h(Empty, { text: tr(locale, 'noData') })
    const max = Math.max(...series.map(valueOf), 1)
    const n = series.length
    const every = Math.max(1, Math.ceil(n / 6))

    const labelOf = s => {
      if (granularity === 'hour') return String(new Date(s.t + 8 * 3600000).getUTCHours()).padStart(2, '0') + ':00'
      if (granularity === 'week') return s.day.slice(5)
      return n > 14 ? s.day.slice(8) : s.day.slice(5)
    }

    const tipFor = s => {
      const rows = []
      if (isCost) {
        rows.push(h('div', { key: 'm', className: 'ud-tip-row' }, moneyBucket(s.cost) || tr(locale, 'unpriced')))
        if (Object.keys(s.planCost).length) rows.push(h('div', { key: 'p', className: 'ud-tip-row' }, '≈ ' + moneyBucket(s.planCost)))
      } else {
        rows.push(h('div', { key: 'o', className: 'ud-tip-row' }, tr(locale, 'output') + ' ' + compact(s.output)))
        rows.push(h('div', { key: 'i', className: 'ud-tip-row' }, tr(locale, 'input') + ' ' + compact(s.input)))
        rows.push(h('div', { key: 'c', className: 'ud-tip-row' }, tr(locale, 'cacheRead') + ' ' + compact(s.cacheRead + s.cacheWrite)))
        rows.push(h('div', { key: 't', className: 'ud-tip-row ud-tip-total' }, tr(locale, 'total') + ' ' + compact(s.tokens)))
        if (s.unpricedTokens > 0) rows.push(h('div', { key: 'u', className: 'ud-tip-row ud-tip-warn' }, tr(locale, 'unpriced')))
      }
      return [h('div', { key: 'tt', className: 'ud-tip-title' }, labelOf(s)), ...rows]
    }

    const stackFor = s => {
      const total = shown(s)
      if (isCost) return h('div', { className: 'ud-bar ud-bar-cost', style: { height: '100%' } })
      const segs = [
        { k: 'output', v: s.output },
        { k: 'input', v: s.input },
        hideCache ? null : { k: 'cache', v: s.cacheRead + s.cacheWrite },
      ].filter(Boolean)
      return segs.filter(x => x.v > 0).map(x => h('div', {
        key: x.k, className: 'ud-bar ud-bar-' + x.k,
        style: { height: (total > 0 ? x.v / total * 100 : 0) + '%' },
      }))
    }

    const cols = series.map((s, i) => h('div', {
      key: s.t,
      className: 'ud-col' + (hover === i ? ' is-hover' : ''),
      onMouseEnter: () => setHover(i),
      onMouseLeave: () => setHover(null),
      onFocus: () => setHover(i),
      onBlur: () => setHover(null),
      tabIndex: 0,
      role: 'img',
      'aria-label': labelOf(s) + ' ' + compact(valueOf(s)),
    },
      h('div', { className: 'ud-col-stack', style: { height: (valueOf(s) / max * 100) + '%' } }, stackFor(s)),
      hover === i ? h('div', {
        className: 'ud-tip' + (i <= 1 ? ' ud-tip-left' : i >= series.length - 2 ? ' ud-tip-right' : ''),
        role: 'tooltip',
      }, tipFor(s)) : null))

    const ticks = series.map((s, i) => h('span', { key: s.t, className: 'ud-xlabel' }, i % every === 0 ? labelOf(s) : ''))

    return h('div', { className: 'ud-trend' },
      h('div', { className: 'ud-trend-yaxis' },
        h('span', null, isCost ? moneyBucket({ [currency || 'CNY']: max }) : compact(max)),
        h('span', null, '0')),
      h('div', { className: 'ud-trend-main' },
        h('div', { className: 'ud-trend-cols' }, cols),
        h('div', { className: 'ud-trend-xaxis' }, ticks)))
  }

  // ---------- Provider 排名 ----------

  /** 横向占比条列表；点击某行可把它设为筛选条件 */
  function RankList({ items, mode, total, locale, onPick, activeName }) {
    if (!items.length) return h(Empty, { text: tr(locale, 'noData') })
    const sumMoney = b => Object.values(b || {}).reduce((a, c) => a + c, 0)
    const isCost = mode === 'cost'
    return h('ul', { className: 'ud-rank' }, items.map(it => {
      const value = isCost ? sumMoney(it.cost) : it.tokens
      const denom = isCost ? sumMoney(total.cost) : total.tokens
      const pct = denom > 0 ? value / denom * 100 : 0
      // 条形宽度＝占总量比例；内部再按自身构成切分输入 / 缓存 / 输出
      const parts = [
        { k: 'input', v: it.input },
        { k: 'cache', v: it.cacheRead + it.cacheWrite },
        { k: 'output', v: it.output },
      ]
      const self = it.tokens || 1
      const head = h('span', { className: 'ud-rank-head' },
        h('span', { className: 'ud-rank-name' }, it.name),
        h('span', { className: 'ud-rank-val' }, isCost ? (moneyBucket(it.cost) || tr(locale, 'unpriced')) : compact(value)),
        h('span', { className: 'ud-rank-pct' }, pct.toFixed(1) + '%'))
      const segs = isCost ? null : parts.filter(p => p.v > 0).map(p =>
        h('span', { key: p.k, className: 'ud-rank-seg ud-mix-' + p.k, style: { width: (p.v / self * 100) + '%' } }))
      const track = h('span', { className: 'ud-rank-track', 'aria-hidden': 'true' },
        h('span', {
          className: 'ud-rank-fill' + (isCost ? ' is-cost' : ''),
          style: { width: Math.max(pct, 1.5) + '%' },
        }, segs))
      const detail = h('span', { className: 'ud-rank-parts' },
        h('span', { className: 'ud-rank-part' }, tr(locale, 'input') + ' ' + compact(it.input)),
        h('span', { className: 'ud-rank-part' }, tr(locale, 'output') + ' ' + compact(it.output)),
        h('span', { className: 'ud-rank-part' }, tr(locale, 'cacheRead') + ' ' + compact(it.cacheRead + it.cacheWrite)),
        h('span', { className: 'ud-rank-part' }, tr(locale, 'calls') + ' ' + (it.calls || 0).toLocaleString('zh-CN')))
      return h('li', { key: it.name, className: 'ud-rank-row' + (activeName === it.name ? ' is-active' : '') },
        h('button', {
          type: 'button', className: 'ud-rank-btn', onClick: () => onPick && onPick(it.name),
          title: onPick ? tr(locale, 'clickToFilter') : undefined,
        }, head, track, detail))
    }))
  }

  // ---------- 项目表 ----------

  /**
   * 可展开项目表。每个项目一行，点开展示它用过的 Provider 明细。
   * 窄屏隐藏次要列（用 CSS 控制，不靠 JS 探测宽度）。
   */
  function ProjectTable({ rows, sessionOf, locale, onPick, activePath, moneyBucket: mb, openPaths }) {
    const openPair = safeState(() => new Set(openPaths || []))
    const open = openPair ? openPair[0] : new Set(openPaths || [])
    const setOpen = openPair ? openPair[1] : () => {}
    const toggle = key => {
      const next = new Set(open)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      setOpen(next)
    }
    if (!rows.length) return h(Empty, { text: tr(locale, 'noData') })
    return h('div', { className: 'ud-table-wrap' },
      h('table', { className: 'ud-table' },
        h('thead', null, h('tr', null,
          h('th', { className: 'ud-th-name' }, tr(locale, 'project')),
          h('th', { className: 'ud-th-num ud-col-sessions' }, tr(locale, 'sessions')),
          h('th', { className: 'ud-th-num' }, tr(locale, 'tokens')),
          h('th', { className: 'ud-th-num ud-col-io' }, tr(locale, 'input')),
          h('th', { className: 'ud-th-num ud-col-io' }, tr(locale, 'output')),
          h('th', { className: 'ud-th-num' }, tr(locale, 'cost')),
          h('th', { className: 'ud-th-num ud-col-providers' }, tr(locale, 'providers')))),
        h('tbody', null, rows.map(r => {
          const isOpen = open.has(r.path)
          const sessions = sessionOf.get(r.path)
          return [
            h('tr', {
              key: r.path, className: 'ud-tr' + (isOpen ? ' is-open' : '') + (activePath === r.path ? ' is-active' : ''),
            },
              h('td', { className: 'ud-td-name' },
                h('button', {
                  type: 'button', className: 'ud-expand', 'aria-expanded': isOpen,
                  onClick: () => toggle(r.path), title: isOpen ? tr(locale, 'collapse') : tr(locale, 'expand'),
                }, h('span', { className: 'ud-caret' + (isOpen ? ' is-open' : '') }, '›')),
                h('button', {
                  type: 'button', className: 'ud-link', title: tr(locale, 'clickToFilter'),
                  onClick: () => onPick && onPick(r.path),
                }, r.name || tr(locale, 'unknownProject'))),
              h('td', { className: 'ud-td-num ud-col-sessions' }, sessions === undefined ? '—' : String(sessions)),
              h('td', { className: 'ud-td-num' }, compact(r.tokens)),
              h('td', { className: 'ud-td-num ud-col-io' }, compact(r.input)),
              h('td', { className: 'ud-td-num ud-col-io' }, compact(r.output)),
              h('td', { className: 'ud-td-num' }, mb(r.cost) || (Object.keys(r.planCost).length ? '≈ ' + mb(r.planCost) : tr(locale, 'unpriced'))),
              h('td', { className: 'ud-td-num ud-col-providers' }, String(r.providers.length))),
            isOpen ? h('tr', { key: r.path + ':x', className: 'ud-tr-sub' },
              h('td', { colSpan: 7 },
                h('div', { className: 'ud-sub-list' }, r.providers.map(p =>
                  h('div', { key: p.name, className: 'ud-sub-row' },
                    h('span', { className: 'ud-sub-name' }, p.name),
                    h('span', { className: 'ud-sub-num' }, compact(p.tokens)),
                    h('span', { className: 'ud-sub-num ud-col-io' }, '↓' + compact(p.input)),
                    h('span', { className: 'ud-sub-num ud-col-io' }, '↑' + compact(p.output)),
                    h('span', { className: 'ud-sub-money' },
                      mb(p.cost) || (Object.keys(p.planCost).length ? '≈ ' + mb(p.planCost) : tr(locale, 'unpriced')))))))) : null,
          ]
        })))) 
  }

  /**
   * DeepSeek 余额：一行一个钱包（官方 API / 登录账号）。
   * 拿不到时写清原因，绝不当成 0 —— 余额查询失败不等于余额为零。
   */
  function BalanceList({ rows, locale, busy, error, labelOf }) {
    /** 余额构成：充值 / 赠送分开说，不合并成一个数 */
    const detailOf = r => {
      const w = (r.wallets ?? [])[0], parts = []
      if (w && Number.isFinite(Number(w.toppedUp))) parts.push(tr(locale, 'toppedUp') + ' ' + moneyFmt(Number(w.toppedUp), w.currency))
      if (w && Number(w.granted) > 0) parts.push(tr(locale, 'bonus') + ' ' + moneyFmt(Number(w.granted), w.currency))
      const bonus = (r.bonusWallets ?? [])[0]
      if (bonus && Number(bonus.balance) > 0) parts.push(tr(locale, 'bonus') + ' ' + moneyFmt(Number(bonus.balance), bonus.currency))
      return parts.length ? parts.join(' · ') : null
    }
    const valueOf = r => {
      if (r.status === 'ready') {
        const w = (r.wallets ?? [])[0]
        if (!w) return { text: '—', muted: true }
        return { text: moneyFmt(Number(w.total), w.currency), sub: detailOf(r),
          muted: r.available === false, hint: r.available === false ? tr(locale, 'unavailable') : r.scope }
      }
      if (r.status === 'failed') return { text: tr(locale, 'balanceFailed'), muted: true, warn: true, hint: r.message }
      // 未登录就说未登录：宿主给的 message 常常是「暂无适配」，不能拿来当未登录的理由。
      if (r.status === 'unavailable') return { text: tr(locale, 'signedOut'), muted: true, hint: r.message }
      return null
    }
    const usable = rows ?? []
    if (!usable.length) {
      return h('div', { className: 'ud-bal' },
        h('div', { className: 'ud-empty ud-bal-empty' }, error ? tr(locale, 'balanceFailed') : busy ? tr(locale, 'balanceLoading') : tr(locale, 'noAdapter')),
        h('p', { className: 'ud-bal-foot' }, tr(locale, 'balanceHint')))
    }
    return h('div', { className: 'ud-bal' },
      usable.map(r => {
        const v = valueOf(r) ?? { text: '—', muted: true }
        return h('div', { key: r.provider, className: 'ud-bal-row' },
          h('div', { className: 'ud-bal-main' },
            h('span', {
              className: 'ud-bal-name',
              title: [r.provider, r.scope || r.message].filter(Boolean).join(' · ') || undefined,
            }, labelOf ? labelOf(r.provider) : r.provider),
            v.sub ? h('span', { className: 'ud-bal-sub' }, v.sub) : null),
          h('span', {
            className: 'ud-bal-val' + (v.muted ? ' is-muted' : '') + (v.warn ? ' is-warn' : ''),
            title: v.hint || undefined,
          }, v.text))
      }),
      h('p', { className: 'ud-bal-foot' }, tr(locale, 'balanceHint')))
  }

  return { Panel, Segmented, Select, Empty, Loading, StatPrimary, StatParts, TrendChart, RankList, ProjectTable, BalanceList, moneyBucket, moneyLines, compact }
}

/**
 * 方案 A 的样式。8px 间距体系、12px 圆角、低对比分隔线；
 * 颜色全部来自 --dsw-alias-*，深浅色自动跟随。
 */
export const CHART_CSS = `
/* ============================================================
   用量与花费 · 视觉系统 v2
   原则：8px 间距、10-12px 圆角、弱边框、克制的对比层次。
   颜色只走 --dsw-alias-* 主题令牌，深浅色自动跟随。
   ============================================================ */

[data-usage-dashboard]{
  --ud-s1:4px; --ud-s2:8px; --ud-s3:12px; --ud-s4:16px; --ud-s5:24px;
  --ud-r:10px; --ud-r-sm:8px;
  font-size:13px; line-height:20px;
  color:var(--dsw-alias-label-primary);
  container-type:inline-size; container-name:ud;
  /* 图表语义色：与主题强调色族对齐，深浅色都可用 */
  --ud-c-input:var(--dsw-alias-state-business-primary);
  --ud-c-output:color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 65%, var(--dsw-alias-state-error-primary));
  --ud-c-cache:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-state-success-secondary));
  --ud-hairline:var(--dsw-alias-border-l1);
}

[data-usage-dashboard] .ud-stack{display:flex;flex-direction:column;gap:var(--ud-s4)}

/* ---------------- 页头 ---------------- */
[data-usage-dashboard] .ud-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--ud-s3)}
[data-usage-dashboard] .ud-head-text{min-width:0}
[data-usage-dashboard] .ud-h1{margin:0;font-size:19px;line-height:26px;font-weight:600;letter-spacing:-.015em}
[data-usage-dashboard] .ud-lede{margin:1px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-head-actions{display:flex;align-items:center;gap:var(--ud-s2);flex:none;padding-top:2px}
[data-usage-dashboard] .ud-updated{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}

/* 图标按钮：无背景，hover 微亮，28px 正方 */
[data-usage-dashboard] .ud-icon-btn{width:28px;height:28px;padding:0;border:0;border-radius:var(--ud-r-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;transition:background .12s ease,color .12s ease}
[data-usage-dashboard] .ud-icon-btn:hover:not(:disabled){
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);
  color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-icon-btn:active:not(:disabled){transform:scale(.96)}
[data-usage-dashboard] .ud-icon-btn:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-icon-btn[data-busy="true"] svg{animation:ud-rot .9s linear infinite}
@keyframes ud-rot{to{transform:rotate(360deg)}}

/* ---------------- 筛选 ---------------- */
[data-usage-dashboard] .ud-filters{display:flex;flex-direction:column;gap:var(--ud-s2)}
[data-usage-dashboard] .ud-filter-row{display:flex;align-items:center;gap:var(--ud-s2);min-width:0}
[data-usage-dashboard] .ud-filter-range{flex-wrap:wrap}
[data-usage-dashboard] .ud-filter-selects{display:grid;grid-template-columns:1fr 1fr;gap:var(--ud-s2)}

/* 分段控件：统一 28px 高，选中用中性高对比而非纯白大块 */
[data-usage-dashboard] .ud-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--ud-r-sm);
  background:var(--dsw-alias-bg-layer-2);min-width:0;flex-wrap:wrap}
[data-usage-dashboard] .ud-seg-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;
  font-size:12px;height:24px;padding:0 9px;border-radius:6px;cursor:pointer;white-space:nowrap;
  transition:background .12s ease,color .12s ease}
[data-usage-dashboard] .ud-seg-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
[data-usage-dashboard] .ud-seg-btn.is-on{
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-primary);font-weight:600}
[data-usage-dashboard] :is(.ud-icon-btn,.ud-btn,.ud-seg-btn,.ud-clear,.ud-link,.ud-expand):focus-visible{
  outline:2px solid var(--ud-c-cache);outline-offset:2px}
[data-usage-dashboard] .ud-seg-sm .ud-seg-btn{height:22px;padding:0 8px;font-size:11px}

/* 下拉：与分段控件等高 */
[data-usage-dashboard] .ud-select{display:flex;min-width:0}
[data-usage-dashboard] .ud-select select{width:100%;height:28px;padding:0 26px 0 9px;border-radius:var(--ud-r-sm);
  border:1px solid var(--ud-hairline);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer;appearance:none;transition:border-color .12s ease,background .12s ease;
  background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary) 50%),
                   linear-gradient(135deg,var(--dsw-alias-label-tertiary) 50%,transparent 50%);
  background-position:calc(100% - 14px) 12px,calc(100% - 10px) 12px;
  background-size:4px 4px,4px 4px;background-repeat:no-repeat}
[data-usage-dashboard] .ud-select select:hover{border-color:var(--dsw-alias-border-l3);background-color:var(--dsw-alias-interactive-bg-hover)}
[data-usage-dashboard] .ud-select select:focus-visible{outline:2px solid var(--ud-c-output);outline-offset:1px}
[data-usage-dashboard] .ud-clear{align-self:flex-start;border:0;background:none;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-size:12px;cursor:pointer;padding:0;height:20px}
[data-usage-dashboard] .ud-clear:hover{color:var(--ud-c-output)}

/* ---------------- KPI ---------------- */
[data-usage-dashboard] .ud-kpis{display:flex;flex-direction:column;gap:var(--ud-s2)}
[data-usage-dashboard] .ud-kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--ud-s2)}
[data-usage-dashboard] .ud-stat{min-width:0;padding:var(--ud-s3) var(--ud-s3) 11px;
  border:1px solid var(--ud-hairline);border-radius:var(--ud-r);background:var(--dsw-alias-bg-layer-1)}
[data-usage-dashboard] .ud-stat-label{display:flex;align-items:center;gap:5px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);min-width:0}
[data-usage-dashboard] .ud-stat-label > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-usage-dashboard] .ud-i{flex:none;width:13px;height:13px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);
  display:inline-flex;align-items:center;justify-content:center;font-size:9px;cursor:help;
  color:var(--dsw-alias-label-tertiary);line-height:1}
[data-usage-dashboard] .ud-delta{margin-left:auto;flex:none;font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-delta.is-up{color:var(--ud-c-cache)}
[data-usage-dashboard] .ud-delta.is-down{color:var(--dsw-alias-state-warn-label)}
/* 主数值：白（主文字色），只有强调场景才用青绿 */
[data-usage-dashboard] .ud-stat-value{margin-top:3px;font-size:28px;line-height:36px;font-weight:600;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--dsw-alias-label-primary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-usage-dashboard] .ud-stat-value .ud-money-line{display:block}
[data-usage-dashboard] .ud-stat-value .ud-money-line + .ud-money-line{font-size:13px;line-height:18px;font-weight:500;
  color:var(--dsw-alias-label-tertiary);letter-spacing:0}
[data-usage-dashboard] .ud-stat-sub{margin-top:var(--ud-s2)}

/* 构成条：一条细横条 + 图例，替代"三张等高卡" */
[data-usage-dashboard] .ud-mix{display:flex;flex-direction:column;gap:6px}
[data-usage-dashboard] .ud-mix-track{display:flex;height:5px;border-radius:999px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
[data-usage-dashboard] .ud-mix-seg{display:block;height:100%}
[data-usage-dashboard] .ud-mix-input{background:var(--ud-c-input)}
[data-usage-dashboard] .ud-mix-output{background:var(--ud-c-output)}
[data-usage-dashboard] .ud-mix-cache{background:var(--ud-c-cache)}
[data-usage-dashboard] .ud-mix-legend{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--ud-s2);min-width:0}
[data-usage-dashboard] .ud-mix-item{display:flex;align-items:baseline;gap:5px;min-width:0;font-size:11px;line-height:16px}
[data-usage-dashboard] .ud-mix-label{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-usage-dashboard] .ud-mix-val{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums;margin-left:auto}
[data-usage-dashboard] .ud-mix-pct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
[data-usage-dashboard] .ud-kpi-foot{display:flex;flex-wrap:wrap;gap:var(--ud-s2) var(--ud-s4);align-items:baseline;
  padding-top:2px}
[data-usage-dashboard] .ud-foot-item{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:16px;min-width:0}
[data-usage-dashboard] .ud-foot-label{color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-foot-val{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-weight:500}

/* ---------------- 面板 ---------------- */
[data-usage-dashboard] .ud-panel{border:1px solid var(--ud-hairline);border-radius:var(--ud-r);
  background:var(--dsw-alias-bg-layer-1);min-width:0}
[data-usage-dashboard] .ud-panel-head{display:flex;align-items:center;justify-content:space-between;gap:var(--ud-s2);
  padding:11px var(--ud-s3);border-bottom:1px solid var(--ud-hairline);flex-wrap:wrap}
[data-usage-dashboard] .ud-panel-titles{min-width:0}
[data-usage-dashboard] .ud-panel-title{margin:0;font-size:13px;line-height:18px;font-weight:600;
  color:var(--dsw-alias-label-primary);letter-spacing:-.005em}
[data-usage-dashboard] .ud-panel-sub{margin:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-panel-tools{display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap}
[data-usage-dashboard] .ud-panel-body{padding:var(--ud-s3)}
[data-usage-dashboard] .ud-panel-body.ud-pad-none{padding:0}
[data-usage-dashboard] .ud-split{display:flex;flex-direction:column;gap:var(--ud-s4)}

/* ---------------- 趋势图 ---------------- */
[data-usage-dashboard] .ud-trend{display:flex;gap:6px;min-width:0}
[data-usage-dashboard] .ud-trend-yaxis{display:flex;flex-direction:column;justify-content:space-between;
  width:42px;flex:none;text-align:right;font-size:10px;line-height:14px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;padding-bottom:16px}
[data-usage-dashboard] .ud-trend-main{flex:1;min-width:0;display:flex;flex-direction:column}
[data-usage-dashboard] .ud-trend-cols{position:relative;display:flex;align-items:flex-end;gap:2px;
  height:150px;min-width:0;
  /* 低对比网格线：三条水平参考线 */
  background-image:linear-gradient(to top,var(--ud-hairline) 1px,transparent 1px);
  background-size:100% 33.333%;
  background-position:0 100%}
[data-usage-dashboard] .ud-col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;
  justify-content:flex-end;position:relative;cursor:default;outline:none}
[data-usage-dashboard] .ud-col-stack{width:100%;display:flex;flex-direction:column;
  border-radius:2px 2px 0 0;overflow:hidden;min-height:1px;
  transition:opacity .12s ease}
[data-usage-dashboard] .ud-col.is-hover .ud-col-stack{opacity:.8}
[data-usage-dashboard] .ud-col:focus-visible .ud-col-stack{outline:2px solid var(--ud-c-output);outline-offset:1px}
[data-usage-dashboard] .ud-bar{width:100%}
[data-usage-dashboard] .ud-bar-input{background:var(--ud-c-input)}
[data-usage-dashboard] .ud-bar-output{background:var(--ud-c-output)}
[data-usage-dashboard] .ud-bar-cache{background:var(--ud-c-cache);opacity:.85}
[data-usage-dashboard] .ud-bar-cost{background:var(--ud-c-cache);opacity:.9}
[data-usage-dashboard] .ud-trend-xaxis{display:flex;gap:2px;margin-top:6px;height:14px}
[data-usage-dashboard] .ud-trend-xaxis .ud-xlabel{flex:1 1 0;min-width:0;text-align:center;font-size:10px;
  line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;
  font-variant-numeric:tabular-nums;opacity:.9}
/* Tooltip：向下展开，避免被面板顶边裁切 */
[data-usage-dashboard] .ud-tip{position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);
  z-index:20;min-width:116px;max-width:220px;padding:7px 9px;border-radius:var(--ud-r-sm);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);
  box-shadow:0 8px 22px rgba(0,0,0,.22);pointer-events:none}
[data-usage-dashboard] .ud-tip-left{left:0;transform:none}
[data-usage-dashboard] .ud-tip-right{left:auto;right:0;transform:none}
[data-usage-dashboard] .ud-tip-title{font-size:11px;font-weight:600;margin-bottom:3px;color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-tip-row{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;white-space:nowrap;display:flex;justify-content:space-between;gap:12px}
[data-usage-dashboard] .ud-tip-total{border-top:1px solid var(--ud-hairline);margin-top:4px;padding-top:4px;
  color:var(--dsw-alias-label-primary);font-weight:600}
[data-usage-dashboard] .ud-tip-warn{color:var(--dsw-alias-state-warn-label)}

/* 图例 */
[data-usage-dashboard] .ud-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;
  color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-legend-item{display:flex;align-items:center;gap:5px}
[data-usage-dashboard] .ud-swatch{width:8px;height:8px;border-radius:2px;flex:none}
[data-usage-dashboard] .ud-swatch-input{background:var(--ud-c-input)}
[data-usage-dashboard] .ud-swatch-output{background:var(--ud-c-output)}
[data-usage-dashboard] .ud-swatch-cache{background:var(--ud-c-cache)}

/* ---------------- Provider 排名 ---------------- */
[data-usage-dashboard] .ud-rank{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
[data-usage-dashboard] .ud-rank-row{padding:3px 6px;border-radius:6px;transition:background .12s ease}
[data-usage-dashboard] .ud-rank-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-usage-dashboard] .ud-rank-row.is-active{background:var(--dsw-alias-interactive-bg-hover-solid)}
[data-usage-dashboard] .ud-rank-btn{display:flex;flex-direction:column;gap:2px;
  width:100%;border:0;background:none;padding:0;font:inherit;cursor:pointer;
  text-align:left;color:inherit}
[data-usage-dashboard] .ud-rank-head{display:grid;grid-template-columns:minmax(90px,1fr) auto 46px;
  align-items:baseline;gap:var(--ud-s2)}
[data-usage-dashboard] .ud-rank-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-rank-val{font-size:12px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
[data-usage-dashboard] .ud-rank-pct{font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary);text-align:right}
[data-usage-dashboard] .ud-rank-track{display:block;height:3px;border-radius:2px;
  background:var(--dsw-alias-bg-layer-2);overflow:hidden}
[data-usage-dashboard] .ud-rank-fill{display:flex;height:100%;border-radius:2px;overflow:hidden;min-width:2px}
[data-usage-dashboard] .ud-rank-fill.is-cost{background:var(--ud-c-cache)}
[data-usage-dashboard] .ud-rank-seg{display:block;height:100%}
/* 输入 / 输出 / 缓存 三行明细：与条形同色，方便对照 */
[data-usage-dashboard] .ud-rank-parts{display:flex;flex-wrap:wrap;gap:0 10px;font-size:11px;
  line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
[data-usage-dashboard] .ud-rank-part{white-space:nowrap}

/* ---------------- 项目表 ---------------- */
[data-usage-dashboard] .ud-table-wrap{overflow-x:auto;scrollbar-width:thin}
[data-usage-dashboard] .ud-table{width:100%;border-collapse:collapse;font-size:12px;min-width:0}
[data-usage-dashboard] .ud-table th{font-weight:500;font-size:11px;color:var(--dsw-alias-label-tertiary);
  text-align:left;padding:0 var(--ud-s2) 8px;white-space:nowrap;background:transparent}
[data-usage-dashboard] .ud-table .ud-th-num{text-align:right}
[data-usage-dashboard] .ud-table .ud-th-name{width:40%}
[data-usage-dashboard] .ud-table td{padding:6px var(--ud-s2);border-top:1px solid var(--ud-hairline);
  font-variant-numeric:tabular-nums;white-space:nowrap}
[data-usage-dashboard] .ud-table .ud-td-num{text-align:right;color:var(--dsw-alias-label-secondary)}
[data-usage-dashboard] .ud-tr{transition:background .12s ease}
[data-usage-dashboard] .ud-tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
[data-usage-dashboard] .ud-tr.is-open td{background:var(--dsw-alias-bg-layer-2)}
[data-usage-dashboard] .ud-tr.is-active td{background:var(--dsw-alias-interactive-bg-hover-solid)}
[data-usage-dashboard] .ud-td-name{display:flex;align-items:center;gap:2px;min-width:0}
[data-usage-dashboard] .ud-expand{border:0;background:none;padding:0 2px;cursor:pointer;
  color:var(--dsw-alias-label-tertiary);font:inherit;line-height:1;flex:none}
[data-usage-dashboard] .ud-expand:hover{color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-caret{display:inline-block;transition:transform .13s ease;font-size:13px}
[data-usage-dashboard] .ud-caret.is-open{transform:rotate(90deg)}
[data-usage-dashboard] .ud-link{border:0;background:none;padding:0;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  min-width:0;text-align:left}
[data-usage-dashboard] .ud-link:hover{color:var(--ud-c-output)}
[data-usage-dashboard] .ud-tr-sub td{background:var(--dsw-alias-bg-layer-2);padding:8px var(--ud-s3) 10px}
[data-usage-dashboard] .ud-sub-list{display:flex;flex-direction:column;gap:3px}
[data-usage-dashboard] .ud-sub-row{display:grid;grid-template-columns:minmax(0,1fr) 66px 52px 52px auto;
  gap:var(--ud-s2);align-items:baseline;font-size:11px;color:var(--dsw-alias-label-secondary)}
[data-usage-dashboard] .ud-sub-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-usage-dashboard] .ud-sub-num{text-align:right;font-variant-numeric:tabular-nums}
[data-usage-dashboard] .ud-sub-money{text-align:right;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary)}

/* ---------------- 悬浮卡（输入页常驻） ---------------- */
[data-usage-dashboard].ud-fly-host{position:static}
[data-usage-dashboard] .ud-fly{position:fixed;z-index:30;min-width:0;display:flex;align-items:center;
  gap:2px;padding-right:4px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--ud-r);
  background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.28);
  cursor:grab;touch-action:none;user-select:none;color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-fly:active{cursor:grabbing}
[data-usage-dashboard] .ud-fly-open{width:236px;padding:10px 12px;display:flex;flex-direction:column;
  align-items:stretch;gap:0}
[data-usage-dashboard] .ud-fly-pill{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 4px 0 12px;
  background:none;color:inherit;font-size:12px;cursor:pointer;
  border-radius:var(--ud-r);font-variant-numeric:tabular-nums}
[data-usage-dashboard] .ud-fly-refresh{width:24px;height:24px;padding:0;border:0;border-radius:6px;
  background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none;
  display:inline-flex;align-items:center;justify-content:center;transition:background .12s ease,color .12s ease}
[data-usage-dashboard] .ud-fly-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-fly-refresh:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-fly-refresh[disabled] svg{animation:ud-rot .9s linear infinite}
[data-usage-dashboard] .ud-fly-dot{width:6px;height:6px;border-radius:50%;background:var(--ud-c-cache);flex:none}
[data-usage-dashboard] .ud-fly.is-stale .ud-fly-dot{background:var(--dsw-alias-label-dimmed)}
[data-usage-dashboard] .ud-fly.is-stale .ud-fly-v{color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-fly-tag{font-size:11px;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-fly-sep{color:var(--dsw-alias-label-dimmed)}
[data-usage-dashboard] .ud-fly-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
[data-usage-dashboard] .ud-fly-title{font-size:12px;font-weight:600}
[data-usage-dashboard] .ud-fly-time{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums}
[data-usage-dashboard] .ud-fly-btn{width:24px;height:24px;padding:0;border:0;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  transition:background .12s ease,color .12s ease}
[data-usage-dashboard] .ud-fly-btn:hover{background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary)}
[data-usage-dashboard] .ud-fly-kpi{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:1px 0}
[data-usage-dashboard] .ud-fly-kpi-l{font-size:11px;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-fly-kpi-v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
[data-usage-dashboard] .ud-fly-parts{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:6px;font-size:10px;
  line-height:15px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
[data-usage-dashboard] .ud-fly-bal{margin-top:8px;padding-top:7px;border-top:1px solid var(--ud-hairline);
  display:flex;flex-direction:column;gap:2px}
[data-usage-dashboard] .ud-fly-bal-row{display:flex;justify-content:space-between;gap:8px;font-size:10px;
  line-height:15px;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-fly-bal-v{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
[data-usage-dashboard] .ud-fly-warn{margin-top:6px;font-size:10px;line-height:14px;
  color:var(--dsw-alias-state-warn-label)}

/* ---------------- 余额 / 额度 ---------------- */
[data-usage-dashboard] .ud-bal{display:flex;flex-direction:column}
[data-usage-dashboard] .ud-bal-row{display:flex;align-items:baseline;gap:var(--ud-s3);padding:6px 0;min-width:0}
[data-usage-dashboard] .ud-bal-row + .ud-bal-row{border-top:1px solid var(--ud-hairline)}
[data-usage-dashboard] .ud-bal-main{display:flex;align-items:baseline;gap:var(--ud-s2);min-width:0;flex-wrap:wrap}
[data-usage-dashboard] .ud-bal-name{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-usage-dashboard] .ud-bal-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
[data-usage-dashboard] .ud-bal-val{margin-left:auto;flex:none;font-size:14px;line-height:20px;font-weight:600;
  color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
[data-usage-dashboard] .ud-bal-val.is-muted{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-bal-val.is-warn{color:var(--dsw-alias-state-warn-label)}
[data-usage-dashboard] .ud-bal-foot{margin:var(--ud-s2) 0 0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-bal-empty{padding:14px 8px;font-size:12px}

[data-usage-dashboard] .ud-foot-row{display:flex;align-items:center;justify-content:space-between;gap:12px;
  flex-wrap:wrap}
[data-usage-dashboard] .ud-switch{display:inline-flex;align-items:center;gap:6px;font-size:11px;
  color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
[data-usage-dashboard] .ud-switch input{width:13px;height:13px;margin:0;cursor:pointer;accent-color:var(--ud-c-cache)}
[data-usage-dashboard] .ud-switch:hover{color:var(--dsw-alias-label-secondary)}

/* ---------------- 状态 ---------------- */
[data-usage-dashboard] .ud-empty{padding:32px 8px;text-align:center;font-size:12px;
  color:var(--dsw-alias-label-tertiary)}
[data-usage-dashboard] .ud-loading{animation:ud-pulse 1.5s ease-in-out infinite}
@keyframes ud-pulse{0%,100%{opacity:.55}50%{opacity:1}}
[data-usage-dashboard] .ud-alert{display:flex;gap:var(--ud-s2);align-items:flex-start;border-radius:var(--ud-r-sm);
  padding:8px 10px;font-size:11px;line-height:17px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary)}
[data-usage-dashboard] .ud-alert-err{color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
[data-usage-dashboard] .ud-retry{margin-top:var(--ud-s2)}

/* ---------------- 自适应（容器查询：跟随面板真实宽度） ---------------- */
@container ud (min-width:640px){
  [data-usage-dashboard] .ud-split{display:grid;
    grid-template-columns:minmax(0,1.55fr) minmax(240px,1fr);gap:var(--ud-s4);align-items:start}
  [data-usage-dashboard] .ud-trend-cols{height:170px}
}
@container ud (max-width:639px){
  [data-usage-dashboard] .ud-table .ud-col-io{display:none}
}
@container ud (max-width:519px){
  [data-usage-dashboard] .ud-col-sessions{display:none}
  [data-usage-dashboard] .ud-mix-item{flex-wrap:wrap;gap:2px 4px}
  [data-usage-dashboard] .ud-mix-pct{display:none}
}
@container ud (max-width:419px){
  [data-usage-dashboard] .ud-col-providers{display:none}
  [data-usage-dashboard] .ud-stat-value{font-size:24px;line-height:32px}
  [data-usage-dashboard] .ud-head{flex-wrap:wrap;gap:8px}
  [data-usage-dashboard] .ud-head-actions{margin-left:auto}
  [data-usage-dashboard] .ud-mix-legend{grid-template-columns:1fr;gap:2px}
  /* 极窄时工具栏独占一行，否则标题和控件挤在一起会撑出横向溢出 */
  [data-usage-dashboard] .ud-panel-head{gap:6px}
  [data-usage-dashboard] .ud-panel-tools{width:100%;justify-content:flex-end}
  [data-usage-dashboard] .ud-seg-btn{padding:0 7px;font-size:11px}
  /* 名字列不再保底 90px，否则整行会撑出横向溢出 */
  [data-usage-dashboard] .ud-rank-head{grid-template-columns:minmax(0,1fr) auto 38px;gap:6px}
  /* 极窄时每隔三个才显示一个刻度，否则数字被切成半个 */
  [data-usage-dashboard] .ud-trend-xaxis .ud-xlabel:nth-child(3n+2),
  [data-usage-dashboard] .ud-trend-xaxis .ud-xlabel:nth-child(3n){display:none}
}
@media (prefers-reduced-motion:reduce){
  [data-usage-dashboard] .ud-icon-btn[data-busy="true"] svg{animation:none}
  [data-usage-dashboard] *{transition:none!important}
}
`
