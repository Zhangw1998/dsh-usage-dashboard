# dsh-usage-dashboard

DeepSeek Harness 的用量与花费面板：按项目 / Provider / 模型统计 token 与调用次数，按本地价格配置估算费用，并显示 DeepSeek 账户余额。

Usage & cost dashboard for DeepSeek Harness — token and call counts by project, provider and model, cost estimated from your local price config, plus your DeepSeek account balance.

> 截图使用**合成的演示数据**，不含任何真实账号信息。
> Screenshots use **synthetic demo data** — no real account information.

![概览](docs/shot-overview.png)

<details>
<summary>更多截图 / More screenshots</summary>

![趋势与 Provider 分布](docs/shot-detail.png)

![项目明细](docs/shot-projects.png)

</details>

## 功能 · Features

- **两张主指标 + 一条构成条**：预估费用、总 Token；输入 / 输出 / 缓存读取占比与时序都在同一屏
- **时间范围**：今天 / 24H / 7D / 30D / 90D / 全部 / 自定义，24H 为滚动窗口，与「今天」不等价
- **三个维度联动**：项目、Provider、模型；点击 Provider 行或项目行即可下钻筛选
- **使用趋势**：Token / 费用切换；含缓存 / 不含缓存切换（缓存常占 95% 以上，切掉才能看清输入输出）
- **Provider 分布**：每个 Provider 的输入 / 输出 / 缓存 / 调用次数，条形按构成分段
- **项目明细**：可展开到「该项目用了哪些 Provider」，各自 token 与费用
- **余额**：DeepSeek 官方 API 钱包与登录账号钱包分行显示，充值 / 赠送分开列
- **自动刷新**：页面可见时约每 2 分钟静默更新一次；手动刷新随时可用

## 安装 · Install

需要支持 `dsh plugin` 子命令的 DeepSeek Harness（实测于 `0.2.1-rc.2`）。

```bash
# desktop profile（按你的 profile 名替换 desktop / web）
dsh plugin --profile desktop add github:Zhangw1998/dsh-usage-dashboard
```

装好后重启或刷新 DSH 页面，打开 **设置 → 用量与花费**。

卸载：`dsh plugin --profile desktop remove dsh-usage-dashboard`

## 口径说明 · How the numbers are computed

这部分是本插件刻意做「诚实」的地方，请务必读完。 / These are deliberate honesty choices:

| 名称 | 含义 | 不是什么 |
|---|---|---|
| **预估费用** | 按本地价格配置（含峰谷时段）估算的按量费用 | **不是账单实付金额**。没有读取任何计费记录 |
| **订阅折算** | 订阅 / 套餐制 Provider 的用量按官方牌价折算的参考值，带 `≈` | **不是实际支出**，也不与预估费用相加 |
| **未定价** | 该模型在价格配置里没有规则 | **不是 0 元**。未定价用量单独计数，绝不按 0 计价 |
| **调用次数** | 有 usage 记录的调用条数 | 失败或未回传 usage 的请求不计入，因此可能低于服务商后台 |
| **余额** | 账号钱包余额 | **不能反推累计消费**：余额由多个 API key / 工具共享 |

- **多币种永不跨币种相加**：每个币种单独一行显示。
- **同一份筛选下，所有视图对得上账**：KPI、趋势、Provider 排名、项目明细都从同一张筛选后的事实表聚合，不会出现「总览和明细对不上」。
- **没有数据就显示没有**：范围内无记录时是明确的空态，不是零值图表。

## 隐私与权限 · Privacy & network

这个插件在本机做了什么，全部列在这里：

1. **读取本地会话日志** —— 扫描 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（或 `$DSH_HOME/sessions`），提取每次调用的 token 用量。日志里的对话内容不会被上传，也不会写进本插件的任何输出。
2. **请求一次余额接口** —— 仅当你配置了 `DEEPSEEK_API_KEY` 时，用该 key 请求 `https://api.deepseek.com/user/balance`。**只会向这一个域名发请求**，且禁止重定向。
3. **不写入会话数据** —— 只在 `~/.dsh/storages/` 下写两个文件：用量扫描缓存、价格配置。

没有遥测，没有第三方上报。

## 价格配置 · Pricing config

默认价格规则内置在 `pricing.js`。要覆盖，编辑：

```
~/.dsh/storages/usage-dashboard-pricing.json
```

按 provider 键覆盖峰谷价、币种、计费方式（`token` / `plan` / `subscription` / `unknown`）。写入前会校验，非法配置会被拒绝而不是部分生效。

## 开发 · Development

无需安装任何依赖，只需要 Node ≥ 22。

```bash
node --test test/*.test.mjs   # 78 项测试
node build-client.mjs         # 修改 chart-kit.js / view-model.js 后重新内联到 client.js
```

- `client.js` 是构建产物，必须提交：从 git 安装时没有构建步骤（`prepare` 脚本会在安装时兜底构建）。
- 预览脱敏截图用的演示页：

  ```bash
  python3 -m http.server 8899        # 在仓库根目录
  # 打开 http://127.0.0.1:8899/docs/demo.html
  ```

- 结构：
  - `usage.js` —— 解析会话日志，产出小时粒度的事实表（token、调用数、已算好的费用）
  - `view-model.js` —— 统一聚合层：时间窗、粒度、组合筛选、环比
  - `chart-kit.js` —— 组件与设计系统（只用主题令牌，深浅色自动跟随）
  - `client.js` —— 浏览器半边，由 `build-client.mjs` 内联上面两个模块生成
  - `host.js` —— Host 半边，注册 `/api/usage.dashboard*` 端点

## 已知限制 · Known limitations

- **一次全量扫描约 10–15 秒**（要重放所有会话日志），所以自动刷新间隔设为约 2 分钟，而不是几十秒。
- **会话数只在不筛选时精确**：Host 侧的会话计数不分时段，因此有项目 / Provider 筛选时该列显示 `—` 而不是给一个错的数。
- **余额只支持 DeepSeek**：`deepseek-official`（API key 钱包）与 `deepseek-account`（登录账号钱包）。其他 Provider 没有余额接口适配。
- 90D 按周聚合已实现，但需要足够长的历史才会显示多根柱。

## License

MIT

---

# English

A usage and cost dashboard for **DeepSeek Harness (DSH)**: token and call counts broken down by project, provider and model, cost estimated from your local price config, and your DeepSeek account balance — all on one screen inside *Settings → Usage & Cost*.

## Features

- **Two primary KPIs plus one composition bar** — estimated cost, total tokens, and the input / output / cache-read split in a single glance.
- **Ranges** — Today, rolling 24H, 7D, 30D, 90D, All, custom. `24H` is a rolling window and is *not* the same as "today".
- **Three combinable filters** — project, provider, model. Click a provider row or a project row to drill in.
- **Trend chart** — toggle between tokens and cost; toggle cache in or out (cache is usually >95% of all tokens, so hiding it is the only way to see the input/output shape).
- **Provider breakdown** — input / output / cache / call count per provider, with the bar segmented by composition.
- **Project table** — expand a row to see which providers that project used, with tokens and cost each.
- **Balance** — DeepSeek API-key wallet and logged-in account wallet on separate rows, with top-up and bonus listed apart.
- **Auto refresh** — about every 2 minutes while the page is visible, silent; manual refresh always available.

## Install

Requires a DSH build that ships the `dsh plugin` subcommand (tested on `0.2.1-rc.2`).

```bash
# replace "desktop" with your profile name
dsh plugin --profile desktop add github:Zhangw1998/dsh-usage-dashboard
```

Reload DSH, then open **Settings → Usage & Cost**.

Uninstall: `dsh plugin --profile desktop remove dsh-usage-dashboard`

## How the numbers are computed

These are deliberate honesty choices, and they matter more than the charts:

| Label | What it is | What it is *not* |
|---|---|---|
| **Estimated cost** | Per-token cost estimated from your local price config, including peak/off-peak bands | **Not a billed amount** — no billing records are read |
| **Plan value** | Subscription usage valued at list prices, prefixed with `≈` | **Not money spent**, and never added to estimated cost |
| **Unpriced** | Models with no rule in the price config | **Not zero** — unpriced usage is counted separately and never priced at 0 |
| **Calls** | Calls that carried a usage report | Failed or usage-less requests are not counted, so this can be lower than your provider's dashboard |
| **Balance** | Account wallet balance | **Cannot be used to infer cumulative spend** — one balance is shared by many keys/tools |

- **Currencies are never summed across** — each currency gets its own line.
- **Every view reconciles under the same filters** — KPIs, trend, provider ranking and project table all aggregate from one filtered fact table, so totals and detail cannot disagree.
- **No data means no data** — an empty range renders an explicit empty state, not a flat zero chart.

## Privacy and network access

Everything this plugin does on your machine, in full:

1. **Reads local session logs** — scans `~/.dsh/sessions/**/session.v4.jsonl.zstd` (or `$DSH_HOME/sessions`) to extract per-call token usage. Conversation content is never uploaded and never copied into this plugin's output.
2. **Makes one balance request** — only if `DEEPSEEK_API_KEY` is configured, it calls `https://api.deepseek.com/user/balance` with that key. **That is the only host it ever contacts**, and redirects are refused.
3. **Writes two files** — under `~/.dsh/storages/`: the scan cache and the price config. No session data is written.

No telemetry, no third-party reporting.

## Development

No dependencies; Node ≥ 22 only.

```bash
node --test test/*.test.mjs   # 78 tests
node build-client.mjs         # re-inline chart-kit.js + view-model.js into client.js
```

- `client.js` is a build artifact and must stay committed — installing from git performs no build step (`prepare` covers it anyway).
- Preview the sanitized screenshots with synthetic data:

  ```bash
  python3 -m http.server 8899   # from the repo root
  # open http://127.0.0.1:8899/docs/demo.html
  ```

- Layout of the code:
  - `usage.js` — parses session logs into an hourly fact table (tokens, call counts, cost already computed)
  - `view-model.js` — the single aggregation layer: time windows, granularity, composable filters, period comparison
  - `chart-kit.js` — components and design system (theme tokens only; light and dark follow automatically)
  - `client.js` — the browser half, generated by inlining the two modules above
  - `host.js` — the host half, registering the `/api/usage.dashboard*` endpoints

## Known limitations

- **A full scan takes ~10–15 s** (it replays every session log), which is why auto refresh runs every ~2 minutes rather than every few seconds.
- **Session counts are exact only without filters** — the host does not bucket sessions by time, so that column shows `—` under a project/provider filter instead of a wrong number.
- **Balance is DeepSeek-only** — `deepseek-official` (API-key wallet) and `deepseek-account` (logged-in wallet). Other providers have no balance adapter.
- Weekly aggregation for 90D is implemented but needs enough history to show more than one bar.

## License

MIT
