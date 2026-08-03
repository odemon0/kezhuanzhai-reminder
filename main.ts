/**
 * 可转债新债申购每日提醒
 * ------------------------------------------------------------------
 * 功能：
 *  - 每个工作日（周一至周五）北京时间 09:00 自动运行
 *  - 查询两个来源（东方财富、集思录）当天是否有可转债新债申购
 *  - 两来源一致 → 推送一次；不一致 → 两个来源都推送；均无 → 推送“无新债”
 *  - 推送使用 PushDeer（自建源），并强制使用特定 User-Agent
 *  - 每步打印简单的过程与结果
 *
 * 用法：
 *  本地运行     ： deno task check
 *  部署 Deno Deploy： deno task deploy   （cron 会自动注册）
 *  本地定时     ： crontab 加  `0 9 * * 1-5 cd <目录> && deno task check >> log.txt`
 * ------------------------------------------------------------------
 */
import { loadConfig } from "./config.ts";
import { fetchEastmoney, fetchJisilu, todayStr, Bond, SourceResult } from "./sources.ts";
import { pushDeer } from "./pushdeer.ts";

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
  const cfg = loadConfig();
  const today = todayStr();
  log("1/5", `初始化：今天（北京时间）= ${today}`);

  // 步骤2：来源A 东方财富
  const ra: SourceResult = await fetchEastmoney(today, cfg.dataUserAgent);
  log("2/5", ra.ok
    ? `来源A 东方财富：查询到 ${ra.bonds.length} 只申购`
    : `来源A 东方财富：查询失败 - ${ra.error}`);

  // 步骤3：来源B 集思录
  const rb: SourceResult = await fetchJisilu(today, cfg.dataUserAgent, cfg.jisiluCookie);
  log("3/5", rb.ok
    ? `来源B 集思录：查询到 ${rb.bonds.length} 只申购`
    : `来源B 集思录：查询失败 - ${rb.error}`);

  // 步骤4：比对两来源
  const codesA = new Set(ra.bonds.map((b) => b.code));
  const codesB = new Set(rb.bonds.map((b) => b.code));
  const bothOk = ra.ok && rb.ok;
  const consistent = bothOk && setsEqual(codesA, codesB);
  log("4/5", consistent
    ? "比对：两来源一致"
    : `比对：两来源不一致（A=${ra.bonds.length}, B=${rb.bonds.length}）`);

  // 组装推送内容
  let title: string;
  let content: string;
  if (ra.bonds.length === 0 && rb.bonds.length === 0) {
    // 两来源都无 → 推送“当天无新债”
    title = `可转债新债提醒 ${today}`;
    content = `今天（${today}）中国市场**无**可转债新债申购申请。`;
  } else if (consistent) {
    // 一致 → 推送一次
    const merged = ra.bonds;
    title = `可转债新债提醒 ${today}（${merged.length} 只）`;
    content = `今天（${today}）有可转债新债申购，两来源一致：\n\n` +
      formatBonds(merged, "新债");
  } else {
    // 不一致（含某来源查询失败）→ 两个来源都推送
    const aNote = ra.ok
      ? formatBonds(ra.bonds, "来源A 东方财富")
      : `来源A 东方财富：查询失败（${ra.error}）`;
    const bNote = rb.ok
      ? formatBonds(rb.bonds, "来源B 集思录")
      : `来源B 集思录：查询失败（${rb.error}）`;
    title = `可转债新债提醒 ${today}【来源不一致】`;
    content = `两来源结果不一致，分别列出：\n\n${aNote}\n\n${bNote}`;
  }

  // 步骤5：推送
  if (!cfg.pushdeerKey) {
    log("5/5", `未配置 PUSHDEER_KEY，仅打印不推送。\n标题：${title}\n${content}`);
    return;
  }
  const r = await pushDeer(cfg, title, content);
  log("5/5", `推送 PushDeer：HTTP ${r.status} ${r.ok ? "成功" : "失败"} ${r.text.slice(0, 100)}`);
}

// ---- 调度 ----
// 部署到 Deno Deploy 时注册 cron；本地直接运行一次
const isDeployed = !!Deno.env.get("DENO_DEPLOYMENT_ID");
if (isDeployed) {
  // 注意：Deno.cron 的任务名只允许「字母、数字、空格、连字符、下划线」，不能用中文
  // 每周一至周五 09:00（北京时间）自动运行
  Deno.cron("cb-new-bond-reminder", "0 9 * * 1-5", { timezone: "Asia/Shanghai" }, run);

  // 部署后访问 /run 可手动触发一次检查（方便不本地跑也能验证 PushDeer 配置）
  Deno.serve((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (path === "/run") {
      // 后台执行，避免请求超时；结果去 Logs 看
      run().catch((e) => console.error("手动触发失败：", e));
      return new Response("triggered, check deploy logs", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(
      "kezhai-reminder is running.\ncron: 0 9 * * 1-5 (Asia/Shanghai)\nmanual trigger: GET /run\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  });

  console.log("已注册 cron：cb-new-bond-reminder，每周一至周五 09:00（北京时间）。访问 /run 可手动触发一次。");
} else {
  await run();
}
