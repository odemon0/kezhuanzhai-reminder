import type { Config } from "./config.ts";

export interface PushResult {
  ok: boolean;
  status: number;
  url: string; // 实际请求的接口地址
  reason: string; // 成功/失败的判定原因
  text: string; // 原始返回（截断）
}

const PUSH_TIMEOUT_MS = 15_000;
export const PUSH_MAX_ATTEMPTS = 3;
const PUSH_RETRY_DELAY_MS = 10_000; // 推送失败后 10 秒重试

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 规范化 PushDeer 推送地址。
 * PushDeer 的推送接口固定是  <base>/message/push
 * 常见填错：只填了域名（返回 {"PushDeer":"On"}）或填了网页端地址（返回 HTML 页面），
 * 这两种情况 HTTP 都是 200，看起来“成功”其实根本没推送。
 */
export function normalizePushUrl(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "https://api2.pushdeer.com/message/push";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "https://api2.pushdeer.com/message/push";
  }
  u.search = "";
  u.hash = "";

  let p = u.pathname.replace(/\/+$/, ""); // 去掉末尾斜杠
  // 填成网页文件（/index.html、/#/ 之类）时，丢掉最后那段
  if (/\.(html?|php|jsp)$/i.test(p)) p = p.replace(/\/[^/]*$/, "");
  if (!/\/message\/push$/i.test(p)) p = p + "/message/push";

  u.pathname = p;
  return u.toString();
}

/** 判定 PushDeer 的返回到底算不算推送成功 */
function judge(status: number, text: string): { ok: boolean; reason: string } {
  const t = (text ?? "").trim();

  if (t.startsWith("<")) {
    return {
      ok: false,
      reason:
        "返回的是 HTML 网页而不是接口 JSON —— PUSHDEER_URL 指向了 PushDeer 的网页端，应指向 /message/push 接口",
    };
  }

  let j: Record<string, unknown>;
  try {
    j = JSON.parse(t);
  } catch {
    return { ok: false, reason: `响应不是合法 JSON（HTTP ${status}）` };
  }

  // 只填域名根路径时会返回 {"PushDeer":"On"}
  if (j.PushDeer !== undefined && j.code === undefined) {
    return {
      ok: false,
      reason:
        '命中的是服务健康检查接口（返回 {"PushDeer":"On"}），说明地址少了 /message/push',
    };
  }

  const code = j.code;
  if (code !== 0) {
    return {
      ok: false,
      reason: `接口返回 code=${code}${j.error ? "，error=" + j.error : ""}` +
        (code === 80501 ? "（pushkey 错误，检查 PUSHDEER_KEY）" : ""),
    };
  }

  // code=0 但 result 为空 → key 合法但没有绑定可推送的设备
  const result = (j.content as { result?: unknown[] } | undefined)?.result;
  if (Array.isArray(result) && result.length === 0) {
    return {
      ok: false,
      reason: "接口 code=0 但 result 为空 —— pushkey 下没有绑定任何设备，消息无处可送",
    };
  }

  return { ok: true, reason: `code=0，已投递 ${Array.isArray(result) ? result.length : 1} 个设备` };
}

async function pushOnce(
  url: string,
  cfg: Config,
  title: string,
  content: string,
): Promise<PushResult> {
  const body = new URLSearchParams({
    pushkey: cfg.pushdeerKey,
    text: title,
    desp: content,
    type: "markdown",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": cfg.pushdeerUserAgent, // ★ 用户指定的 UA
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "Accept": "application/json",
    },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });

  const text = await res.text();
  const { ok, reason } = judge(res.status, text);
  return { ok, status: res.status, url, reason, text: text.slice(0, 200) };
}

/**
 * 推送到 PushDeer（自建源），失败自动重试。
 * 注意：PushDeer 成功与失败都返回 HTTP 200，必须解析 JSON 的 code 判定，不能只看 res.ok。
 */
export async function pushDeer(
  cfg: Config,
  title: string,
  content: string,
  onLog: (msg: string) => void = () => {},
): Promise<PushResult> {
  const url = normalizePushUrl(cfg.pushdeerUrl);
  if (url !== cfg.pushdeerUrl.trim()) {
    onLog(`推送地址已规范化：${cfg.pushdeerUrl} → ${url}`);
  }

  let last: PushResult = {
    ok: false,
    status: 0,
    url,
    reason: "未执行",
    text: "",
  };

  for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
    try {
      last = await pushOnce(url, cfg, title, content);
      if (last.ok) {
        onLog(`推送成功（第 ${attempt}/${PUSH_MAX_ATTEMPTS} 次尝试）：${last.reason}`);
        return last;
      }
      onLog(`推送未成功（第 ${attempt}/${PUSH_MAX_ATTEMPTS} 次）：${last.reason}｜返回：${last.text}`);
    } catch (e) {
      last = {
        ok: false,
        status: 0,
        url,
        reason: `请求异常：${(e as Error).message}`,
        text: "",
      };
      onLog(`推送异常（第 ${attempt}/${PUSH_MAX_ATTEMPTS} 次）：${last.reason}`);
    }

    // 地址配错属于确定性错误，重试没有意义，直接返回
    if (/HTML 网页|健康检查接口/.test(last.reason)) {
      onLog("这是配置问题（地址不对），重试无意义，已跳过后续尝试。");
      return last;
    }
    if (attempt < PUSH_MAX_ATTEMPTS) {
      onLog(`${PUSH_RETRY_DELAY_MS / 1000} 秒后重试推送…`);
      await sleep(PUSH_RETRY_DELAY_MS);
    }
  }
  return last;
}
