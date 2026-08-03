// 两个数据源：东方财富（来源A）、同花顺（来源B）
// 统一返回 { ok, bonds, error? } 结构，任一来源失败不影响另一来源
// 每个来源自带「超时 + 失败后间隔 1 分钟重试，最多 3 次」的能力

export interface Bond {
  code: string;
  name: string;
  applyDate: string;
}

export interface SourceResult {
  ok: boolean; // 是否成功拿到数据（成功但 0 只 也算 ok）
  bonds: Bond[];
  error?: string; // 最后一次失败原因
  attempts: number; // 实际尝试次数
}

// ---- 重试策略（可按需调整）----
export const MAX_ATTEMPTS = 3; // 最多尝试 3 次
export const RETRY_DELAY_MS = 60_000; // 失败后等待 1 分钟再试
export const TIMEOUT_MS = 20_000; // 单次请求 20 秒超时

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 北京时间今天，格式 YYYY-MM-DD（Deno Deploy 运行在 UTC，必须用上海时区算“今天”）
export function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// 带超时的 JSON 请求
async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<any> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回非 JSON（前80字符）：${text.slice(0, 80)}`);
  }
}

/**
 * 通用重试包装：
 *  - 抛异常（超时/网络错误/HTTP 非 200/接口异常）→ 视为失败，等待 RETRY_DELAY_MS 后重试
 *  - 正常返回（哪怕是空数组，代表“今天确实没有新债”）→ 立即成功返回，不重试
 */
export async function withRetry(
  label: string,
  fn: () => Promise<Bond[]>,
  onLog: (msg: string) => void,
): Promise<SourceResult> {
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const bonds = await fn();
      onLog(
        `${label}：第 ${attempt}/${MAX_ATTEMPTS} 次尝试成功（耗时 ${
          Date.now() - t0
        }ms），命中 ${bonds.length} 只`,
      );
      return { ok: true, bonds, attempts: attempt };
    } catch (e) {
      lastErr = (e as Error)?.message ?? String(e);
      onLog(
        `${label}：第 ${attempt}/${MAX_ATTEMPTS} 次尝试失败（耗时 ${
          Date.now() - t0
        }ms）- ${lastErr}`,
      );
      if (attempt < MAX_ATTEMPTS) {
        onLog(`${label}：${RETRY_DELAY_MS / 1000} 秒后重试…`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  onLog(`${label}：连续 ${MAX_ATTEMPTS} 次失败，放弃。最后错误：${lastErr}`);
  return { ok: false, bonds: [], error: lastErr, attempts: MAX_ATTEMPTS };
}

// ==================== 来源A：东方财富 ====================
// 实测要点：
//  1. 分页参数是 pageNumber / pageSize（不是 page / page_size，写错会拿到过期数据！）
//  2. 申购日期字段是 PUBLIC_START_DATE（没有 APPLY_DATE）
//  3. 直接用 filter 精确查当天，一次请求搞定，不需要拉全量
//  4. 当天无数据时返回 {"result":null,"success":false,"message":"返回数据为空","code":9201}
//     —— 这是正常的“今天没有新债”，不能当作错误去重试
async function eastmoneyOnce(today: string, ua: string): Promise<Bond[]> {
  const params = new URLSearchParams({
    reportName: "RPT_BOND_CB_LIST",
    columns: "ALL",
    source: "WEB",
    client: "WEB",
    sortColumns: "PUBLIC_START_DATE",
    sortTypes: "-1",
    pageNumber: "1",
    pageSize: "50",
    filter: `(PUBLIC_START_DATE='${today}')`,
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const json = await fetchJson(url, {
    "User-Agent": ua,
    "Referer": "https://data.eastmoney.com/kzz/",
    "Accept": "application/json, text/plain, */*",
  });

  // 空结果：正常情况，返回空数组
  if (json?.code === 9201 || json?.message === "返回数据为空") return [];
  // 其他 success=false：真异常，抛出触发重试
  if (json?.success === false) {
    throw new Error(`接口异常 code=${json?.code} msg=${json?.message}`);
  }

  const rows: Record<string, unknown>[] = json?.result?.data ?? [];
  const bonds: Bond[] = [];
  for (const r of rows) {
    const applyDate = String(r.PUBLIC_START_DATE ?? "").slice(0, 10);
    if (applyDate !== today) continue;
    const code = String(r.SECURITY_CODE ?? "").trim();
    const name = String(r.SECURITY_NAME_ABBR ?? r.SECURITY_NAME ?? "").trim();
    if (code) bonds.push({ code, name, applyDate });
  }
  return bonds;
}

export function fetchEastmoney(
  today: string,
  ua: string,
  onLog: (msg: string) => void,
): Promise<SourceResult> {
  return withRetry("来源A 东方财富", () => eastmoneyOnce(today, ua), onLog);
}

// ==================== 来源B：同花顺 ====================
// 接口：https://data.10jqka.com.cn/ipo/kzz/  直接返回 JSON（不是 HTML）
// 实测要点：
//  1. 必须带 User-Agent，否则返回 "Nginx forbidden."
//  2. 返回 {status_code:0, status_msg:"ok", list:[{sub_date, bond_code, bond_name, code, name, ...}]}
//  3. list 是全量历史（约 950 条）且包含未来待申购的债，本地按 sub_date 过滤当天
async function tonghuashunOnce(today: string, ua: string): Promise<Bond[]> {
  const url = "https://data.10jqka.com.cn/ipo/kzz/";
  const json = await fetchJson(url, {
    "User-Agent": ua,
    "Referer": "https://data.10jqka.com.cn/ipo/kzz/",
    "Accept": "application/json, text/plain, */*",
  });

  if (json?.status_code !== 0) {
    throw new Error(`接口异常 status_code=${json?.status_code} msg=${json?.status_msg}`);
  }
  const list: Record<string, unknown>[] = json?.list ?? [];
  // 全量列表正常有几百条；为空说明接口被限流或改版，抛错触发重试
  if (list.length === 0) throw new Error("返回 list 为空（疑似被限流或接口改版）");

  const bonds: Bond[] = [];
  for (const r of list) {
    const applyDate = String(r.sub_date ?? "").slice(0, 10);
    if (applyDate !== today) continue;
    const code = String(r.bond_code ?? "").trim();
    const name = String(r.bond_name ?? "").trim();
    if (code) bonds.push({ code, name, applyDate });
  }
  return bonds;
}

export function fetchTonghuashun(
  today: string,
  ua: string,
  onLog: (msg: string) => void,
): Promise<SourceResult> {
  return withRetry("来源B 同花顺", () => tonghuashunOnce(today, ua), onLog);
}
