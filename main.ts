/**
 * 可转债新债申购每日提醒
 * ------------------------------------------------------------------
 * 功能：
 *  - 每个工作日（周一至周五）北京时间 09:00 自动运行
 *  - 查询两个来源（东方财富、同花顺）当天是否有可转债新债申购
 *  - 每个来源：超时/失败后间隔 1 分钟重试，最多尝试 3 次
 *  - 两来源一致 → 推送一次；不一致 → 两个来源都推送；均无 → 推送“无新债”
 *  - 两来源 3 次尝试后都失败 → 推送“无法查询”告警
 *  - 推送使用 PushDeer（自建源），并强制使用特定 User-Agent
 *  - 每步打印简单的过程与结果
 *
 * 用法：
 *  本地运行        ： deno task check
 *  部署 Deno Deploy： 推 GitHub 后自动部署，cron 自动注册；访问 /run 可手动触发一次
 * ------------------------------------------------------------------
 */
import { loadConfig } from "./config.ts";
import {
  fetchEastmoney,
  fetchTonghuashun,
  MAX_ATTEMPTS,
  todayStr,
} from "./sources.ts";
import type { Bond, SourceResult } from "./sources.ts";
import { normalizePushUrl, pushDeer } from "./pushdeer.ts";

const SOURCE_A = "东方财富";
const SOURCE_B = "同花顺";

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function formatBonds(bonds: Bond[], label: string): string {
  if (bonds.length === 0) return `${label}：无`;
  const lines = bonds.map((b, i) => `${i + 1}. ${b.name}（${b.code}）`);
  return `${label}（${bonds.length} 只）：\n` + lines.join("\n");
}

export async function run() {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const today = todayStr();
  log("1/5", `初始化：今天（北京时间）= ${today}；重试策略 = 最多 ${MAX_ATTEMPTS} 次、间隔 60 秒`);
  log(
    "1/5",
    `推送配置：接口 = ${normalizePushUrl(cfg.pushdeerUrl)}；pushkey = ${
      cfg.pushdeerKey ? cfg.pushdeerKey.slice(0, 4) + "***(len " + cfg.pushdeerKey.length + ")" : "未配置"
    }`,
  );

  // 步骤2：并行查询两个来源（各自内部带超时与重试，过程逐条打印）
  log("2/5", "开始并行查询两个来源…");
  const [ra, rb]: [SourceResult, SourceResult] = await Promise.all([
    fetchEastmoney(today, cfg.dataUserAgent, (m) => log("2/5", m)),
    fetchTonghuashun(today, cfg.dataUserAgent, (m) => log("2/5", m)),
  ]);

  // 步骤3：汇总
  const descA = ra.ok
    ? `${ra.bonds.length} 只${ra.bonds.length ? "（" + ra.bonds.map((b) => `${b.name}/${b.code}`).join("、") + "）" : ""}`
    : `查询失败（尝试 ${ra.attempts} 次）- ${ra.error}`;
  const descB = rb.ok
    ? `${rb.bonds.length} 只${rb.bonds.length ? "（" + rb.bonds.map((b) => `${b.name}/${b.code}`).join("、") + "）" : ""}`
    : `查询失败（尝试 ${rb.attempts} 次）- ${rb.error}`;
  log("3/5", `汇总：来源A ${SOURCE_A} → ${descA}`);
  log("3/5", `汇总：来源B ${SOURCE_B} → ${descB}`);

  // 步骤4：比对
  const codesA = new Set(ra.bonds.map((b) => b.code));
  const codesB = new Set(rb.bonds.map((b) => b.code));
  const bothFailed = !ra.ok && !rb.ok;
  const bothOk = ra.ok && rb.ok;
  const consistent = bothOk && setsEqual(codesA, codesB);

  let title: string;
  let content: string;

  if (bothFailed) {
    // 两来源都失败 → 推送“无法查询”告警
    log("4/5", `比对：跳过（两来源均在 ${MAX_ATTEMPTS} 次尝试后失败）`);
    title = `⚠️ 可转债新债查询失败 ${today}`;
    content = `今天（${today}）两个数据源均**无法查询**，已各重试 ${MAX_ATTEMPTS} 次（间隔 60 秒）。\n\n` +
      `- 来源A ${SOURCE_A}：${ra.error}\n` +
      `- 来源B ${SOURCE_B}：${rb.error}\n\n` +
      `请手动确认今日是否有新债申购。`;
  } else if (consistent) {
    log("4/5", "比对：两来源一致");
    if (ra.bonds.length === 0) {
      // 一致且都为 0 → 当天无新债
      title = `可转债新债提醒 ${today}`;
      content = `今天（${today}）中国市场**无**可转债新债申购申请。\n\n（${SOURCE_A} 与 ${SOURCE_B} 两来源结果一致）`;
    } else {
      // 一致且有债 → 推送一次
      title = `可转债新债提醒 ${today}（${ra.bonds.length} 只）`;
      content = `今天（${today}）有可转债新债申购，两来源一致：\n\n` +
        formatBonds(ra.bonds, "新债") +
        `\n\n（来源：${SOURCE_A} / ${SOURCE_B}）`;
    }
  } else {
    // 不一致（含其中一个来源查询失败）→ 两个来源都推送
    log("4/5", `比对：两来源不一致（A=${ra.ok ? ra.bonds.length + " 只" : "失败"}, B=${rb.ok ? rb.bonds.length + " 只" : "失败"}）`);
    const aNote = ra.ok
      ? formatBonds(ra.bonds, `来源A ${SOURCE_A}`)
      : `来源A ${SOURCE_A}：查询失败（已重试 ${ra.attempts} 次）- ${ra.error}`;
    const bNote = rb.ok
      ? formatBonds(rb.bonds, `来源B ${SOURCE_B}`)
      : `来源B ${SOURCE_B}：查询失败（已重试 ${rb.attempts} 次）- ${rb.error}`;
    title = `可转债新债提醒 ${today}【来源不一致】`;
    content = `今天（${today}）两来源结果不一致，分别列出：\n\n${aNote}\n\n${bNote}`;
  }

  // 步骤5：推送
  if (!cfg.pushdeerKey) {
    log("5/5", `未配置 PUSHDEER_KEY，仅打印不推送。\n标题：${title}\n${content}`);
    log("5/5", `全流程结束，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return;
  }
  try {
    const r = await pushDeer(cfg, title, content, (m) => log("5/5", m));
    log(
      "5/5",
      `推送 PushDeer：${r.ok ? "✅ 成功" : "❌ 失败"}（HTTP ${r.status}，接口 ${r.url}）— ${r.reason}`,
    );
    if (!r.ok) log("5/5", `原始返回：${r.text}`);
  } catch (e) {
    log("5/5", `推送 PushDeer 异常：${(e as Error).message}`);
  }
  log("5/5", `全流程结束，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

// ---- 调度 ----
// 部署到 Deno Deploy 时注册 cron；本地直接运行一次
const isDeployed = !!Deno.env.get("DENO_DEPLOYMENT_ID");
if (isDeployed) {
  // 注意：Deno.cron 的任务名只允许「字母、数字、空格、连字符、下划线」，不能用中文
  // 每周一至周五 09:00（北京时间）自动运行
  Deno.cron("cb-new-bond-reminder", "0 9 * * 1-5", { timezone: "Asia/Shanghai" }, run);

  // 部署后访问 /run 可手动触发一次检查（方便不本地跑也能验证 PushDeer 配置）
  Deno.serve(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    // 单独测试 PushDeer 是否真的能推送（结果直接在浏览器里显示，不用翻 Logs）
    if (path === "/push-test") {
      const cfg = loadConfig();
      const endpoint = normalizePushUrl(cfg.pushdeerUrl);
      if (!cfg.pushdeerKey) {
        return new Response(`❌ 未配置 PUSHDEER_KEY\n接口地址：${endpoint}\n`, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const r = await pushDeer(
        cfg,
        "PushDeer 连通性测试",
        `这是一条来自 kezhai-reminder 的测试消息。\n\n时间：${new Date().toISOString()}`,
        (m) => console.log(`[push-test] ${m}`),
      );
      return new Response(
        `${r.ok ? "✅ 推送成功" : "❌ 推送失败"}\n` +
          `接口地址：${r.url}\n` +
          `HTTP 状态：${r.status}\n` +
          `判定原因：${r.reason}\n` +
          `原始返回：${r.text}\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (path === "/run") {
      // 后台执行，避免请求超时（最坏情况含重试要几分钟）；结果去 Logs 看
      run().catch((e) => console.error("手动触发失败：", e));
      return new Response("triggered, check deploy logs", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(
      "kezhai-reminder is running.\n" +
        "cron: 0 9 * * 1-5 (Asia/Shanghai)\n" +
        "sources: eastmoney + 10jqka\n" +
        "manual trigger  : GET /run        (完整流程，结果看 Logs)\n" +
        "pushdeer test   : GET /push-test  (只测推送，结果直接返回)\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  });

  console.log("已注册 cron：cb-new-bond-reminder，每周一至周五 09:00（北京时间）。访问 /run 可手动触发一次。");
} else {
  await run();
}
