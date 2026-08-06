# kezhai-reminder · 可转债新债每日提醒

每个工作日北京时间 **09:00** 自动查询当天中国市场的可转债**新债申购**与**新债上市**，
双数据源交叉验证后，通过 **PushDeer** 推送一条提醒。**没有新债也会推送**，确保每天都有确定性的结论。

跑在 [Deno Deploy](https://console.deno.com) 免费额度内，零成本、无需服务器。

---

## 特性

- **双源交叉验证**：东方财富 + 同花顺，两源一致才下结论；不一致或单边失败会明确标注「待核实」
- **申购 + 上市合并推送**：两类结论合在一条消息里，标题一眼看完
- **失败自动重试**：单次请求 20s 超时，失败后间隔 60s 重试，最多 3 次；三次都失败则推送告警
- **每步打印日志**：`[1/5]` ~ `[5/5]` 五步过程全程可见，方便在 Deploy Logs 里排查
- **手动触发入口**：部署后访问 `/run` 立即跑一次，`/push-test` 单独测推送连通性

## 推送效果

| 场景 | 标题 |
|---|---|
| 有申购 + 有上市 | `🔔 08-06 申购 中仑转债｜上市 曙26转债` |
| 有申购 + 无上市 | `🔔 08-06 申购 2只 先锋转债、中仑转债｜无上市` |
| 无申购 + 有上市 | `🔔 08-06 无申购｜上市 曙26转债` |
| 都没有 | `⭕ 08-06 无申购｜无上市` |
| 两源不一致 | `⚠️ 08-06 申购待核实 先锋转债、中仑转债｜上市 曙26转债` |
| 查询全失败 | `❗ 08-06 申购查询失败｜上市查询失败` |

正文分【申购】【上市】两段，列出债券名称与代码，或失败原因。

## 文件结构

| 文件 | 作用 |
|---|---|
| `main.ts` | 主流程编排、结论判定、标题正文拼装、cron 注册与 HTTP 入口 |
| `sources.ts` | 两个数据源的抓取与解析、超时重试逻辑 |
| `pushdeer.ts` | PushDeer 推送、接口地址规范化、返回结果真伪判定 |
| `config.ts` | 环境变量读取与 User-Agent 配置 |
| `deno.json` | 本地任务定义 |
| `.env.example` | 环境变量模板 |

## 数据源

| 来源 | 接口 | 申购日字段 | 上市日字段 |
|---|---|---|---|
| 东方财富 | `datacenter-web.eastmoney.com/api/data/v1/get`（`RPT_BOND_CB_LIST`） | `PUBLIC_START_DATE` | `LISTING_DATE` |
| 同花顺 | `data.10jqka.com.cn/ipo/kzz/` | `sub_date` | `listing_date` |

均为公开接口，**无需 key 或 cookie**。

## 部署到 Deno Deploy

1. 把代码推到 GitHub 仓库（**不要提交 `.env`**）
2. 打开 [console.deno.com](https://console.deno.com) → **New Project** → 从 GitHub 导入，入口文件选 `main.ts`
3. 在 **Settings → Environment Variables**（Production 环境）添加：

   | 变量 | 说明 |
   |---|---|
   | `PUSHDEER_URL` | PushDeer 接口地址，如 `https://your-domain.com/message/push` |
   | `PUSHDEER_KEY` | 你的 pushkey |

4. 部署完成后，在 **Cron** 标签页应看到 `cb-new-bond-reminder · 0 1 * * 2-6`
5. 访问 `https://你的域名/push-test` 验证推送是否正常

> **PushDeer 自建源必须公网可达。** Deno Deploy 运行在云端，访问不到家庭局域网地址。

## 本地运行

```bash
cp .env.example .env    # 填入 PUSHDEER_URL 和 PUSHDEER_KEY
deno task check         # 立即执行一次完整流程
```

未配置 `PUSHDEER_KEY` 时只打印不推送，方便调试。

## HTTP 入口（部署后可用）

| 路径 | 作用 |
|---|---|
| `/` | 查看运行状态、cron 配置、当前北京时间 |
| `/run` | 手动触发一次完整检查（后台执行，结果看 Logs） |
| `/push-test` | 只测 PushDeer 连通性，结果直接显示在浏览器 |

## 实现要点

踩过的坑，改代码前建议先看一眼：

- **cron 表达式是 UTC**。`Deno.cron` 没有 `timezone` 选项（写了会被静默忽略），
  且星期约定是 `1-7 = SUN-SAT`（不是常见的 `0-6`）。
  所以「周一至周五北京时间 09:00」= `0 1 * * 2-6`。
- **cron 任务名不能用中文**，只允许字母、数字、空格、连字符、下划线。
- **东财分页参数是 `pageNumber` / `pageSize`**，写成 `page` / `page_size` 会被静默忽略并返回过期数据。
- **东财 `LISTING_DATE` 不带 filter 时返回 null**，必须用 `filter=(LISTING_DATE='...')` 精确查。
- **东财当天无数据时返回 `code: 9201`**，这是正常的「今天没有」，不能当失败去重试。
- **同花顺必须带 User-Agent**，否则返回 `Nginx forbidden.`。
- **上市首日东财简称带 N 前缀**（`N曙26转` vs 同花顺 `曙26转债`），
  所以两源比对**只按代码比，不按名称比**。
- **PushDeer 无论成败都返回 HTTP 200**，必须看 JSON 里的 `code` 字段判定
  （成功 `code:0` 且 `result` 非空；`80501` 是 key 错误）。

## 调整配置

| 想改什么 | 改哪里 |
|---|---|
| 执行时间 | `main.ts` 的 `CRON_EXPR`（注意是 UTC，星期 `1-7=SUN-SAT`） |
| 重试次数 / 间隔 / 超时 | `sources.ts` 的 `MAX_ATTEMPTS` / `RETRY_DELAY_MS` / `TIMEOUT_MS` |
| 推送标题格式 | `main.ts` 的 `titlePart()` 与 `overallEmoji()` |
| 推送正文格式 | `main.ts` 的 `bodySection()` |

## 已知限制

- **不跳过法定节假日**：cron 只排除周末，节假日仍会运行（届时两源均为 0，推送「无申购｜无上市」）
- 免费档单区域运行，访问国内接口延迟略高，但实测均在 1s 内
