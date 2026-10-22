# dsh-usage-dashboard

**简体中文** · [English](README.md)

DeepSeek Harness 的用量与花费面板：按项目 / Provider / 模型统计 token 与调用次数，按本地价格配置估算费用，并显示 DeepSeek 账户余额。

> 截图使用**合成的演示数据**，不含任何真实账号信息。

![概览](docs/shot-overview.png)

## 功能

- **两张主指标 + 一条构成条**：预估费用、总 Token；输入 / 输出 / 缓存读取的占比与数值同屏可见
- **时间范围**：今天 / 24H / 7D / 30D / 90D / 全部 / 自定义。`24H` 是滚动窗口，与「今天」不等价
- **三个维度联动筛选**：项目、Provider、模型；点击 Provider 行或项目行即可下钻
- **使用趋势**：Token / 费用切换；含缓存 / 不含缓存切换（缓存常占 95% 以上，切掉才看得清输入输出）
- **Provider 分布**：每个 Provider 的输入 / 输出 / 缓存 / 调用次数，条形按构成分段
- **项目明细**：可展开到「该项目用了哪些 Provider」，各自 token 与费用
- **余额**：DeepSeek 官方 API 钱包与登录账号钱包分行显示，充值 / 赠送分开列
- **悬浮卡**：输入页右下角常驻，折叠成 `今日 ¥3.42 · 1.2M` 胶囊，展开看今日明细与余额；可拖动、位置记忆
- **刷新策略**：只有进入详情页 / 展开悬浮卡 / 手动点刷新时才重算，**不做后台轮询**（一次全量扫描约 12 秒，挂着不动不烧 CPU）；数据超过 10 分钟会灰化提示

<details>
<summary>更多截图</summary>

![趋势与 Provider 分布](docs/shot-detail.png)

![项目明细](docs/shot-projects.png)

</details>

## 安装

需要支持 `dsh plugin` 子命令的 DeepSeek Harness（实测于 `0.2.1-rc.2`）。

```bash
# 按你的 profile 名替换 desktop / web
dsh plugin --profile desktop add github:Zhangw1998/dsh-usage-dashboard
```

装好后刷新 DSH 页面，打开 **设置 → 用量与花费**。

卸载：`dsh plugin --profile desktop remove dsh-usage-dashboard`

## 口径说明

这部分是本插件刻意做「诚实」的地方，比图表更重要：

| 名称 | 含义 | 不是什么 |
|---|---|---|
| **预估费用** | 按本地价格配置（含峰谷时段）估算的按量费用 | **不是账单实付金额**，没有读取任何计费记录 |
| **订阅折算** | 订阅 / 套餐制 Provider 的用量按官方牌价折算，带 `≈` | **不是实际支出**，也绝不与预估费用相加 |
| **未定价** | 该模型在价格配置里没有规则 | **不是 0 元**，未定价用量单独计数，绝不按 0 计价 |
| **调用次数** | 有 usage 记录的调用条数 | 失败或未回传 usage 的请求不计入，可能低于服务商后台 |
| **余额** | 账号钱包余额 | **不能反推累计消费**：余额由多个 API key / 工具共享 |

- **多币种永不跨币种相加**，每个币种单独一行。
- **同一筛选下所有视图对得上账**：KPI、趋势、Provider 排名、项目明细都从同一张筛选后的事实表聚合。
- **没数据就说没数据**：空范围是明确的空态，不是零值图表。

## 隐私与网络

本插件在你机器上做的全部事情：

1. **读取本地会话日志** —— 扫描 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（或 `$DSH_HOME/sessions`）提取每次调用的 token 用量。对话内容不会被上传，也不会写进本插件的任何输出。
2. **请求一次余额接口** —— 仅当你配置了 `DEEPSEEK_API_KEY` 时，用该 key 请求 `https://api.deepseek.com/user/balance`。**只会向这一个域名发请求**，且禁止重定向。
3. **只写两个文件** —— 位于 `~/.dsh/storages/`：扫描缓存与价格配置。不写入任何会话数据。

没有遥测，没有第三方上报。

## 价格配置

默认规则内置在 `pricing.js`。要覆盖，编辑：

```
~/.dsh/storages/usage-dashboard-pricing.json
```

可按 provider 键覆盖峰谷价、币种、计费方式（`token` / `plan` / `subscription` / `unknown`）。写入前会校验，非法配置会被拒绝而不是部分生效。

## 开发

无需安装依赖，只需要 Node ≥ 22。

```bash
node --test test/*.test.mjs   # 78 项测试
node build-client.mjs         # 改完 chart-kit.js / view-model.js 后重新内联到 client.js
```

- `client.js` 是构建产物，必须提交：从 git 安装时没有构建步骤（`prepare` 会兜底构建）。
- 预览脱敏截图用的演示页（在仓库根目录起服务）：

```bash
python3 -m http.server 8899
# 打开 http://127.0.0.1:8899/docs/demo.html
```

- 代码结构：
  - `usage.js` —— 解析会话日志，产出小时粒度事实表（token、调用数、已算好的费用）
  - `view-model.js` —— 唯一聚合层：时间窗、粒度、组合筛选、环比
  - `chart-kit.js` —— 组件与设计系统（只用主题令牌，深浅色自动跟随）
  - `client.js` —— 浏览器半边，由 `build-client.mjs` 内联上面两个模块生成
  - `host.js` —— Host 半边，注册 `/api/usage.dashboard*` 端点

## 已知限制

- **一次全量扫描约 10–15 秒**（要重放所有会话日志），所以只在进入/展开/手动时刷新，不做定时轮询；一直停在详情页不动，数字会停在进入那一刻。
- **会话数只在无筛选时精确**：Host 侧会话计数不分时段，有项目 / Provider 筛选时该列显示 `—` 而不是给错的数。
- **余额只支持 DeepSeek**：`deepseek-official`（API key 钱包）与 `deepseek-account`（登录账号钱包）。其他 Provider 无余额接口适配。
- 90D 按周聚合已实现，但需要足够长的历史才会显示多根柱。

## License

MIT
