/**
 * 可转债「新债申购 + 新债上市」每日提醒
 * ------------------------------------------------------------------
 * 功能：
 *  - 每个工作日（周一至周五）北京时间 09:00 自动运行
 *    （cron 表达式写作 UTC 的 "0 1 * * 2-6"，详见文件末尾调度处的注释）
 *  - 查询两个来源（东方财富、同花顺）当天：
 *      ① 是否有可转债新债【申购】
 *      ② 是否有可转债新债【上市】
 *  - 每个查询：超时/失败后间隔 1 分钟重试，最多尝试 3 次
 *  - 每一类各自交叉验证：两来源一致 → 用合并结果；不一致 → 两个来源都列出待核实
 *  - 申购与上市的结论合并成【一条】PushDeer 推送，标题一眼看出两类结论
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
  KIND_LABEL,
  MAX_ATTEMPTS,
  todayStr,
} from "./sources.ts";
import type { Bond, QueryKind, SourceResult } from "./sources.ts";
import { normalizePushUrl, pushDeer } from "./pushdeer.ts";

const SOURCE_A = "东方财富";
const SOURCE_B = "同花顺";

/**
 * cron 表达式（UTC）。Deno.cron 不支持 timezone，时间一律按 UTC 解释。
 *  - 北京时间 09:00 = UTC 01:00（UTC+8，中国不实行夏令时，全年固定）
 *  - Deno 的星期约定是 1-7 = SUN-SAT，所以「周一至周五」= 2-6
 * 即：UTC 周一~周五 01:00 → 北京时间 周一~周五 09:00
 */
export const CRON_EXPR = "0 1 * * 2-6";
export const CRON_DESC = `${CRON_EXPR} (UTC) = 每周一至周五 09:00 北京时间`;

/** 当前北京时间，形如 2026-08-06 15:07:13 */
function beijingNow(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** 标题里用的短日期，形如 08-06（年份在正文里，标题省下字数给关键信息） */
function shortDate(d: string): string {
  return d.slice(5);
}

/**
 * 挑一个更规范的简称。
 * 上市首日东财会带 N 前缀（「N曙26转」），同花顺是「曙26转债」——优先用不带 N 的完整名。
 */
function pickName(a: string, b: string): string {
  const aN = /^N/.test(a);
  const bN = /^N/.test(b);
  if (a && !aN && (!b || bN)) return a;
  if (b && !bN && (!a || aN)) return b;
  return a || b;
}

/** 按代码合并两个来源的债券列表（比对已确认一致时使用），名称取更规范的那个 */
function mergeBonds(as: Bond[], bs: Bond[]): Bond[] {
  const byCode = new Map<string, Bond>();
  for (const x of as) byCode.set(x.code, { ...x });
  for (const y of bs) {
    const cur = byCode.get(y.code);
    if (cur) cur.name = pickName(cur.name, y.name);
    else byCode.set(y.code, { ...y });
  }
  return [...byCode.values()].sort((x, z) => x.code.localeCompare(z.code));
}

/**
 * 债券名列表，超过 max 只时截断成「A、B、C 等」，避免标题过长被系统截掉。
 * 不带数量后缀——标题里前面已经写了「N 只」，重复显示会很啰嗦。
 */
function bondNames(bonds: Bond[], max = 3): string {
  const names = bonds.map((b) => b.name).filter(Boolean);
  if (names.length <= max) return names.join("、");
  return names.slice(0, max).join("、") + " 等";
}

/** 明细列表，缩进两格挂在「- 来源X」下面，避免正文层级看起来是平的 */
function formatBonds(bonds: Bond[], label: string): string {
  if (bonds.length === 0) return `${label}：无`;
  const lines = bonds.map((b, i) => `    ${i + 1}. ${b.name}（${b.code}）`);
  return `${label}（${bonds.length} 只）：\n` + lines.join("\n");
}

/** 单个来源的简述，用于「来源不一致」时展示 */
function briefOf(r: SourceResult): string {
  if (!r.ok) return "查询失败";
  return r.bonds.length === 0 ? "无" : `${r.bonds.length} 只`;
}

// ==================== 单类（申购 / 上市）的结论 ====================
type GroupStatus = "ok" | "mismatch" | "failed";

interface Group {
  kind: QueryKind;
  label: string; // 申购 / 上市
  a: SourceResult;
  b: SourceResult;
  status: GroupStatus;
  bonds: Bond[]; // status=ok 时的合并结果
}

function judge(kind: QueryKind, a: SourceResult, b: SourceResult): Group {
  const label = KIND_LABEL[kind];
  if (!a.ok && !b.ok) {
    return { kind, label, a, b, status: "failed", bonds: [] };
  }
  const consistent = a.ok && b.ok &&
    setsEqual(
      new Set(a.bonds.map((x) => x.code)),
      new Set(b.bonds.map((x) => x.code)),
    );
  if (consistent) {
    return {
      kind,
      label,
      a,
      b,
      status: "ok",
      bonds: mergeBonds(a.bonds, b.bonds),
    };
  }
  return { kind, label, a, b, status: "mismatch", bonds: [] };
}

/**
 * 标题里该类别的片段，如「申购 中仑转债」「无上市」「申购待核实 中仑转债」。
 * maxNames：名字上限。两类都有债时收紧到 2，防止标题被手机通知栏截断。
 */
function titlePart(g: Group, maxNames: number): string {
  if (g.status === "failed") return `${g.label}查询失败`;
  if (g.status === "mismatch") {
    // 取两来源并集，让用户至少知道「可能是哪几只」，明细在正文
    const union = mergeBonds(g.a.bonds, g.b.bonds);
    return union.length === 0
      ? `${g.label}待核实`
      : `${g.label}待核实 ${bondNames(union, maxNames)}`;
  }
  if (g.bonds.length === 0) return `无${g.label}`;
  const count = g.bonds.length === 1 ? "" : `${g.bonds.length}只 `;
  return `${g.label} ${count}${bondNames(g.bonds, maxNames)}`;
}

/** 正文里该类别的完整段落 */
function bodySection(g: Group, today: string): string {
  const head = `【${g.label}】`;
  if (g.status === "failed") {
    return `${head}❗ 两个来源均查询失败（各重试 ${MAX_ATTEMPTS} 次，间隔 60 秒）\n` +
      `- ${SOURCE_A}：${g.a.error}\n` +
      `- ${SOURCE_B}：${g.b.error}\n` +
      `→ 请手动确认今日是否有新债${g.label}。`;
  }
  if (g.status === "mismatch") {
    const aNote = g.a.ok
      ? formatBonds(g.a.bonds, `- 来源A ${SOURCE_A}`)
      : `- 来源A ${SOURCE_A}：查询失败（已重试 ${g.a.attempts} 次）- ${g.a.error}`;
    const bNote = g.b.ok
      ? formatBonds(g.b.bonds, `- 来源B ${SOURCE_B}`)
      : `- 来源B ${SOURCE_B}：查询失败（已重试 ${g.b.attempts} 次）- ${g.b.error}`;
    // 区分两种情况：真的对不上 vs 有一边压根没查成（后者不该说成“不一致”）
    const reason = (!g.a.ok || !g.b.ok)
      ? "⚠️ 有来源查询失败，以下结果未经交叉验证，请自行核实："
      : "⚠️ 两来源结果不一致，需人工核实：";
    return `${head}${reason}\n${aNote}\n${bNote}`;
  }
  if (g.bonds.length === 0) {
    return `${head}今日（${today}）无可转债新债${g.label}。（两来源一致）`;
  }
  return `${head}今日（${today}）共 ${g.bonds.length} 只（两来源一致）：\n` +
    g.bonds.map((b, i) => `${i + 1}. ${b.name}（${b.code}）`).join("\n");
}

/** 整体状态 emoji：取两类里最严重的 */
function overallEmoji(gs: Group[]): string {
  if (gs.every((g) => g.status === "failed")) return "❗";
  if (gs.some((g) => g.status !== "ok")) return "⚠️";
  if (gs.some((g) => g.bonds.length > 0)) return "🔔";
  return "⭕";
}

export async function run() {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const today = todayStr();
  log(
    "1/5",
    `初始化：北京时间 ${beijingNow()}（UTC ${
      new Date().toISOString().slice(0, 19).replace("T", " ")
    }）`,
  );
  log(
    "1/5",
    `查询日期（北京时间）= ${today}；查询内容 = 新债申购 + 新债上市；重试策略 = 最多 ${MAX_ATTEMPTS} 次、间隔 60 秒`,
  );
  log(
    "1/5",
    `推送配置：接口 = ${normalizePushUrl(cfg.pushdeerUrl)}；pushkey = ${
      cfg.pushdeerKey
        ? cfg.pushdeerKey.slice(0, 4) + "***(len " + cfg.pushdeerKey.length +
          ")"
        : "未配置"
    }`,
  );

  // 步骤2：并行查询 2 来源 × 2 类别（同花顺两类共用一次 HTTP 请求，内部有缓存）
  log("2/5", "开始并行查询：东方财富/同花顺 × 申购/上市…");
  const ua = cfg.dataUserAgent;
  const onLog = (m: string) => log("2/5", m);
  const [aApply, bApply, aList, bList] = await Promise.all([
    fetchEastmoney(today, ua, "apply", onLog),
    fetchTonghuashun(today, ua, "apply", onLog),
    fetchEastmoney(today, ua, "listing", onLog),
    fetchTonghuashun(today, ua, "listing", onLog),
  ]);

  // 步骤3：汇总
  const desc = (r: SourceResult) =>
    r.ok
      ? `${r.bonds.length} 只${
        r.bonds.length
          ? "（" + r.bonds.map((b) => `${b.name}/${b.code}`).join("、") + "）"
          : ""
      }`
      : `查询失败（尝试 ${r.attempts} 次）- ${r.error}`;
  log("3/5", `汇总·申购：${SOURCE_A} → ${desc(aApply)}`);
  log("3/5", `汇总·申购：${SOURCE_B} → ${desc(bApply)}`);
  log("3/5", `汇总·上市：${SOURCE_A} → ${desc(aList)}`);
  log("3/5", `汇总·上市：${SOURCE_B} → ${desc(bList)}`);

  // 步骤4：各类别独立比对
  const groups: Group[] = [
    judge("apply", aApply, bApply),
    judge("listing", aList, bList),
  ];
  for (const g of groups) {
    const verdict = g.status === "ok"
      ? `两来源一致 → ${g.bonds.length} 只`
      : g.status === "failed"
      ? `两来源均失败（各 ${MAX_ATTEMPTS} 次）`
      : `两来源不一致（${SOURCE_A} ${briefOf(g.a)} / ${SOURCE_B} ${
        briefOf(g.b)
      }）`;
    log("4/5", `比对·${g.label}：${verdict}`);
  }

  // 拼标题：emoji + 日期 + 申购结论｜上市结论
  // 两类都有债时把名字上限收紧到 2，避免标题过长在通知栏被截断
  const bothHaveBonds = groups.filter((g) => g.bonds.length > 0).length === 2;
  const maxNames = bothHaveBonds ? 2 : 3;
  const title = `${overallEmoji(groups)} ${shortDate(today)} ` +
    groups.map((g) => titlePart(g, maxNames)).join("｜");

  // 拼正文
  const content = `📅 ${today}（北京时间 ${beijingNow()}）\n\n` +
    groups.map((g) => bodySection(g, today)).join("\n\n") +
    `\n\n---\n数据来源：${SOURCE_A} / ${SOURCE_B}（交叉验证）`;

  log("4/5", `推送标题：${title}`);

  // 步骤5：推送（申购 + 上市 合并为一条）
  if (!cfg.pushdeerKey) {
    log("5/5", `未配置 PUSHDEER_KEY，仅打印不推送。\n标题：${title}\n${content}`);
    log(
      "5/5",
      `全流程结束，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
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
  log(
    "5/5",
    `全流程结束，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

// ---- 调度 ----
// 部署到 Deno Deploy 时注册 cron；本地直接运行一次
const isDeployed = !!Deno.env.get("DENO_DEPLOYMENT_ID");
if (isDeployed) {
  // ⚠️ Deno.cron 的几个官方约定，踩过坑记下来：
  //  1) 任务名只允许「字母、数字、空格、连字符、下划线」，不能用中文。
  //  2) schedule 只能用 UTC，options 里【没有】timezone 选项（只有 backoffSchedule / signal），
  //     写了会被静默忽略。所以北京时间 09:00 必须自己换算成 UTC 01:00（UTC+8）。
  //  3) 星期字段用 1-7 = SUN-SAT（不是常见的 0-6！），因此周一至周五 = 2-6。
  //     —— 若写成 1-5，实际是「周日到周四」。
  //
  //  结果：UTC 每周一至周五 01:00  ==  北京时间每周一至周五 09:00
  Deno.cron("cb-new-bond-reminder", CRON_EXPR, run);

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
        `cron   : ${CRON_DESC}\n` +
        `now    : 北京时间 ${beijingNow()}\n` +
        "checks : 新债申购 + 新债上市\n" +
        "sources: eastmoney + 10jqka\n" +
        "manual trigger  : GET /run        (完整流程，结果看 Logs)\n" +
        "pushdeer test   : GET /push-test  (只测推送，结果直接返回)\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  });

  console.log(
    `已注册 cron：cb-new-bond-reminder，${CRON_DESC}。当前北京时间 ${beijingNow()}。访问 /run 可手动触发一次。`,
  );
} else {
  await run();
}
