import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DEFAULT_PRICING, validatePricing } from './pricing.js'
import { summarize } from './usage.js'

export const name = 'usage-dashboard'
export const inject = ['connection', 'sessionQuery']
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CONFIG_PATH = join(HOME, 'storages', 'usage-dashboard-pricing.json')
// 上次扫描结果落盘：进程重启后也能先出数据，再后台重算（缓存优先）。
const CACHE_PATH = join(HOME, 'storages', 'usage-dashboard-cache.json')
const headers = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers })
const decimal = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))

export async function officialBalance(resolve, request = globalThis.fetch) {
  const hit = await resolve('DEEPSEEK_API_KEY')
  if (!hit?.value) return { provider: 'deepseek-official', status: 'unavailable', message: '未配置 API key' }
  try {
    const res = await request('https://api.deepseek.com/user/balance', { redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${hit.value}`, accept: 'application/json' } })
    if (!res.ok) return { provider: 'deepseek-official', status: 'failed', message: `余额查询 HTTP ${res.status}` }
    const text = await res.text()
    if (text.length > 65536) throw new Error('response-size')
    const data = JSON.parse(text)
    if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos) || !data.balance_infos.length) throw new Error('response-schema')
    const wallets = data.balance_infos.map(w => {
      if (!['CNY', 'USD'].includes(w.currency) || !['total_balance', 'topped_up_balance', 'granted_balance'].every(f => decimal(w[f]))) throw new Error('response-schema')
      return { currency: w.currency, total: w.total_balance, toppedUp: w.topped_up_balance, granted: w.granted_balance }
    })
    return { provider: 'deepseek-official', status: 'ready', available: data.is_available, wallets, scope: '账号余额，多个 API key / 工具共享', checkedAt: Date.now() }
  } catch { return { provider: 'deepseek-official', status: 'failed', message: '余额查询失败或响应无效（不代表余额为零）' } }
}

export function apply(ctx) {
  let scanCache, scanPromise, balanceCache, balancePromise
  let revision = 0
  const pricingPath = CONFIG_PATH
  async function pricing() {
    let custom = {}
    try { custom = validatePricing(JSON.parse(await readFile(pricingPath, 'utf8'))) }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('价格配置无法读取，请检查配置文件') }
    return { ...DEFAULT_PRICING, ...custom }
  }
  /** 读磁盘缓存；损坏或缺失都当作没有。 */
  async function readCache() {
    try {
      const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
      return parsed && typeof parsed.scannedAt === 'number' ? parsed : undefined
    } catch { return undefined }
  }
  /** 落盘缓存；失败不影响本次结果。 */
  async function writeCache(value) {
    try {
      await mkdir(join(HOME, 'storages'), { recursive: true })
      const temporary = `${CACHE_PATH}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      await rename(temporary, CACHE_PATH)
    } catch { /* 缓存只是加速手段 */ }
  }
  async function runScan() {
    if (scanPromise) return scanPromise
    const generation = revision
    scanPromise = (async () => {
      const rules = await pricing(), list = await ctx.sessionQuery.listSessions(), records = []
      for (const { header } of list) {
        try {
          const record = await ctx.sessionQuery.readSession(header.id)
          // 项目目录取自会话头部：readSession 不回传 session 事件，只有 listSessions 带 cwd。
          records.push({ id: header.id, project: header.cwd, events: record.events, inheritedEventCount: record.inheritedEventCount })
        } catch { records.push({ id: header.id, error: true }) }
      }
      // defaults 单独发一份，客户端的「重置为内置」才能回到真正的内置规则。
      const result = { ...summarize(records, rules), pricing: rules, defaults: DEFAULT_PRICING, pricingPath }
      if (generation === revision) { scanCache = result; void writeCache(result) }
      return result
    })()
    try { return await scanPromise } finally { scanPromise = undefined }
  }
  /**
   * 缓存优先：能立刻拿到旧结果就先给旧结果，并在后台重算，避免每次进页面都空等十几秒。
   * @param refresh - 强制同步重算（用户点刷新）。
   */
  async function scan(refresh) {
    if (refresh === true) return runScan()
    if (scanCache) return { ...scanCache, stale: false }
    const disk = await readCache()
    if (disk) {
      scanCache = disk
      // 后台刷新：不阻塞响应，下次请求（或客户端主动 refresh）即可拿到新数据。
      if (scanPromise === undefined) void runScan().catch(() => {})
      return { ...disk, stale: true }
    }
    return runScan()
  }
  async function balances(refresh) {
    if (balancePromise) return balancePromise
    if (!refresh && balanceCache && Date.now() - balanceCache.checkedAt < 60000) return balanceCache
    balancePromise = (async () => {
      const rows = [], providerNames = new Set(scanCache?.providers.map(p => p.provider) ?? ['deepseek-official'])
      if (providerNames.has('deepseek-official')) {
        const credentials = ctx.get('credentials')
        rows.push(await officialBalance(ref => credentials?.resolve(ref) ?? Promise.resolve({ value: process.env[ref] })))
      }
      if (providerNames.has('deepseek-account')) {
        const account = ctx.get('deepseekAccount')
        try {
          const balance = await account?.getBalance({ version: '0.2.0-rc.2', locale: 'zh', timezoneOffsetSeconds: 28800 })
          rows.push(balance?.status === 'ready'
            ? { provider: 'deepseek-account', status: 'ready', wallets: balance.value.map(w => ({ currency: w.currency, total: w.balance })), scope: '登录账号充值钱包，赠送钱包另列', bonusWallets: balance.bonusWallets }
            : { provider: 'deepseek-account', status: 'unavailable', message: '未登录或账号余额接口不可用' })
        } catch { rows.push({ provider: 'deepseek-account', status: 'failed', message: '账号余额查询失败' }) }
      }
      for (const provider of providerNames) if (!rows.some(r => r.provider === provider)) rows.push({ provider, status: 'unsupported', message: '暂无余额接口适配；不代表余额为零' })
      balanceCache = { rows, checkedAt: Date.now() }; return balanceCache
    })()
    try { return await balancePromise } finally { balancePromise = undefined }
  }
  ctx.connection.fetch.register({ path: '/api/usage.dashboard', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try { return json({ scan: await scan(new URL(request.url).searchParams.get('refresh') === '1') }) }
    catch { return json({ error: '用量扫描失败，请检查价格配置或会话日志' }, 500) }
  } })
  ctx.connection.fetch.register({ path: '/api/usage.dashboard.balances', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try { return json(await balances(new URL(request.url).searchParams.get('refresh') === '1')) }
    catch { return json({ error: '余额查询失败，不代表余额为零' }, 500) }
  } })
  ctx.connection.fetch.register({ path: '/api/usage.dashboard.pricing', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    let validated
    try {
      const text = await request.text()
      if (text.length > 262144) return json({ error: '配置过大' }, 413)
      validated = validatePricing(JSON.parse(text))
    } catch (e) { return json({ error: e.message === 'Unexpected end of JSON input' ? '无效 JSON' : '价格配置无效：请检查货币、非负数值与峰谷时间' }, 400) }
    try {
      await mkdir(join(HOME, 'storages'), { recursive: true })
      // Fixed destination is plugin-owned; no user-supplied filesystem paths.
      const temporary = `${pricingPath}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(validated, null, 2), { mode: 0o600 })
      await rename(temporary, pricingPath)
      revision++; scanCache = undefined
      return json({ ok: true })
    } catch { return json({ error: '无法保存价格配置，原配置未覆盖' }, 500) }
  } })
}
