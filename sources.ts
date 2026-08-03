// 两个数据源：东方财富（来源A）、集思录（来源B）
// 统一返回 { ok, bonds, error? } 结构，任一来源失败不影响另一来源

export interface Bond {
  code: string;
  name: string;
  applyDate: string;
}

export interface SourceResult {
  ok: boolean;
  bonds: Bond[];
  error?: string;
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

// 从一条记录里找出“申购日期”字段（不依赖单一固定字段名）
// 实测：东方财富用 PUBLIC_START_DATE；集思录用 cell.apply_date
function extractApplyDate(rec: Record<string, unknown>): string {
  const priority = [
    "APPLY_DATE",
    "PUBLIC_START_DATE",
    "SECURITY_START_DATE",
    "BOND_START_DATE",
  ];
  for (const k of priority) {
    const v = rec[k];
    if (v != null) {
      const m = String(v).match(/\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
    }
  }
  // 兜底：扫描所有 key，匹配 apply / public_start / 申购
  for (const [k, v] of Object.entries(rec)) {
    if (/apply|public_start|申购/i.test(k) && v != null) {
      const m = String(v).match(/\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
    }
  }
  return "";
}

// 来源A：东方财富 可转债列表（按“网上申购起始日”过滤出今天）
export async function fetchEastmoney(today: string, ua: string): Promise<SourceResult> {
  try {
    const base = "https://datacenter-web.eastmoney.com/api/data/v1/get";
    const all: Record<string, unknown>[] = [];
    let page = 1;
    // 分页拉全（接口默认分页，避免漏掉今天的债）
    while (true) {
      const params = new URLSearchParams({
        reportName: "RPT_BOND_CB_LIST",
        columns: "ALL",
        source: "WEB",
        client: "WEB",
        page: String(page),
        page_size: "5000",
      });
      const res = await fetch(`${base}?${params.toString()}`, {
        headers: {
          "User-Agent": ua,
          "Referer": "https://data.eastmoney.com/kzz/",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows: Record<string, unknown>[] = json?.result?.data ?? [];
      all.push(...rows);
      const pages: number = json?.result?.pages ?? 1;
      if (page >= pages) break;
      page++;
    }

    const bonds: Bond[] = [];
    for (const r of all) {
      const applyDate = extractApplyDate(r);
      if (applyDate !== today) continue;
      const code = String(r.SECURITY_CODE ?? "").trim();
      const name = String(r.SECURITY_NAME_ABBR ?? r.SECURITY_NAME ?? "").trim();
      if (code) bonds.push({ code, name, applyDate });
    }
    return { ok: true, bonds };
  } catch (e) {
    return { ok: false, bonds: [], error: (e as Error).message };
  }
}

// 来源B：集思录 新债申购列表（pre_list）
export async function fetchJisilu(
  today: string,
  ua: string,
  cookie: string,
): Promise<SourceResult> {
  try {
    const url = "https://www.jisilu.cn/data/cbnew/pre_list/";
    const body = new URLSearchParams({ progress: "", rp: "50", page: "1" });
    const headers: Record<string, string> = {
      "User-Agent": ua,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://www.jisilu.cn/data/cbnew/pre/",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (cookie) headers["Cookie"] = cookie;

    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows: { cell?: Record<string, unknown> }[] = json?.rows ?? [];

    const bonds: Bond[] = [];
    for (const row of rows) {
      const cell = row?.cell ?? {};
      const applyDate = String(cell.apply_date ?? cell.APPLY_DATE ?? "").slice(0, 10);
      if (applyDate !== today) continue;
      const code = String(cell.bond_id ?? cell.BOND_ID ?? "").trim();
      const name = String(cell.bond_nm ?? cell.BOND_NM ?? "").trim();
      if (code) bonds.push({ code, name, applyDate });
    }
    return { ok: true, bonds };
  } catch (e) {
    return { ok: false, bonds: [], error: (e as Error).message };
  }
}
