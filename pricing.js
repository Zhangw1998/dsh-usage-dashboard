// Prices are keyed by both provider and model. Never borrow another provider's bill.
export const OFFICIAL_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
export const OPENAI_SOURCE = 'https://platform.openai.com/docs/pricing'
// 2026 published holiday calendar; other years can be entered in the pricing editor.
const holidays = [[1, 1, 3], [2, 15, 23], [4, 4, 6], [5, 1, 5], [6, 19, 21], [9, 25, 27], [10, 1, 7]].flatMap(([month, start, end]) => Array.from({ length: end - start + 1 }, (_, i) => `2026-${String(month).padStart(2, '0')}-${String(start + i).padStart(2, '0')}`))
const schedule = { timezoneOffsetMinutes: 480, weekdays: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]], holidays }
const rates = (input, cacheRead, output, cacheWrite = 0) => ({ input, cacheRead, output, cacheWrite })
// 订阅 / 套餐制 provider：这些钱不是按量付的，单价只用来把用量折算成「官方牌价参考值」，
// 所以另记 planCosts，绝不并进已支付估算。各家用自己公布的货币与档位，不引入汇率假设。
const planRule = (currency, source, off, peak) => ({ mode: 'plan', currency, source, off, ...(peak ? { peak, schedule } : {}) })
const dsPlan = key => [key, planRule('CNY', OFFICIAL_SOURCE, rates(1, .02, 4), rates(2, .04, 8))]
export const DEFAULT_PRICING = {
  ...Object.fromEntries(['deepseek-official', 'deepseek-account'].flatMap(provider => [
    [`${provider}/deepseek-flash`, { mode: 'token', currency: 'CNY', source: OFFICIAL_SOURCE, peak: rates(2, .04, 8), off: rates(1, .02, 4), schedule }],
    [`${provider}/deepseek-v4-pro`, { mode: 'token', currency: 'CNY', source: OFFICIAL_SOURCE, peak: rates(9, .3, 27), off: rates(4.5, .15, 13.5), schedule }],
  ])),
  ...Object.fromEntries([
    dsPlan('workbuddy/deepseek-v4.1-flash'),
    dsPlan('workbuddy-ai/deepseek-v4.1-flash'),
    dsPlan('ark-coding/deepseek-v4-1-flash-260910'),
    dsPlan('arkcli-coding-plan/deepseek-v4-1-flash'),
    // gpt-6.1-sol 没有公开定价，按同族 gpt-6-sol 推断，可在价格配置里覆盖
    ['openai-codex/gpt-6-luna', planRule('USD', OPENAI_SOURCE, rates(.1, .01, .5, .125))],
    ['openai-codex/gpt-6.1-sol', planRule('USD', OPENAI_SOURCE, rates(2, .2, 10, 2.5))],
  ]),
}
export const RATE_KEYS = ['input', 'cacheRead', 'output', 'cacheWrite']

export function validatePricing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) throw new Error('价格配置必须是对象，最多 500 个模型')
  const result = {}
  for (const [key, rule] of Object.entries(value)) {
    if (!/^[^\s/]{1,100}\/.{1,200}$/.test(key) || !rule || typeof rule !== 'object') throw new Error('价格键必须是 provider/model')
    if (!['token', 'subscription', 'plan', 'unknown'].includes(rule.mode)) throw new Error(`${key}: 计费方式无效`)
    if (rule.mode === 'subscription' || rule.mode === 'unknown') { result[key] = { mode: rule.mode }; continue }
    if (!['CNY', 'USD'].includes(rule.currency)) throw new Error(`${key}: 货币必须是 CNY 或 USD`)
    const normalized = { mode: rule.mode, currency: rule.currency }
    for (const band of ['off', ...(rule.peak ? ['peak'] : [])]) {
      if (!rule[band] || typeof rule[band] !== 'object') throw new Error(`${key}: 缺少单价`)
      normalized[band] = {}
      for (const field of RATE_KEYS) {
        const n = rule[band][field]
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e6) throw new Error(`${key}: ${field} 单价必须是 0–1000000 的有限数值`)
        normalized[band][field] = n
      }
    }
    if (rule.peak) {
      const s = rule.schedule
      if (!s || !Number.isInteger(s.timezoneOffsetMinutes) || Math.abs(s.timezoneOffsetMinutes) > 840
        || !Array.isArray(s.weekdays) || s.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)
        || !Array.isArray(s.windows) || !s.windows.length || s.windows.length > 24
        || s.windows.some(w => !Array.isArray(w) || w.length !== 2 || w.some(n => !Number.isInteger(n)) || w[0] < 0 || w[1] > 1440 || w[0] >= w[1])
        || !Array.isArray(s.holidays) || s.holidays.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error(`${key}: 峰谷时间配置无效`)
      normalized.schedule = { timezoneOffsetMinutes: s.timezoneOffsetMinutes, weekdays: [...s.weekdays], windows: s.windows.map(w => [...w]), holidays: [...s.holidays] }
    }
    if (typeof rule.source === 'string') normalized.source = rule.source.slice(0, 500)
    result[key] = normalized
  }
  return result
}

export function bandAt(rule, time) {
  if (!rule?.peak) return 'off'
  if (!Number.isFinite(time)) return 'unknown'
  const s = rule.schedule, d = new Date(time + s.timezoneOffsetMinutes * 60000)
  const day = d.toISOString().slice(0, 10), minute = d.getUTCHours() * 60 + d.getUTCMinutes()
  return !s.holidays.includes(day) && s.weekdays.includes(d.getUTCDay()) && s.windows.some(([start, end]) => minute >= start && minute < end) ? 'peak' : 'off'
}

export function costOf(usage, band) {
  return (usage.inputTokens * band.input + usage.cacheReadTokens * band.cacheRead + usage.outputTokens * band.output + usage.cacheWriteTokens * band.cacheWrite) / 1e6
}
