// 配置：从环境变量读取（本地用 .env，Deno Deploy 在控制台设置）
export interface Config {
  pushdeerUrl: string; // PushDeer 自建源推送地址
  pushdeerKey: string; // PushDeer pushkey
  dataUserAgent: string; // 数据源请求使用的 UA（同花顺不带 UA 会被 Nginx 拒绝）
  pushdeerUserAgent: string; // ★ 推送时必须使用的特定 User-Agent
}

export function loadConfig(): Config {
  return {
    pushdeerUrl: Deno.env.get("PUSHDEER_URL") ??
      "https://api2.pushdeer.com/message/push",
    pushdeerKey: Deno.env.get("PUSHDEER_KEY") ?? "",
    dataUserAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // 用户指定：推送 PushDeer 时强制使用的 User-Agent
    pushdeerUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  };
}
