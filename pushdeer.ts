import { Config } from "./config.ts";

export interface PushResult {
  ok: boolean;
  status: number;
  text: string;
}

// 通过 PushDeer 自建源推送；★ 强制使用配置中的特定 User-Agent
export async function pushDeer(
  cfg: Config,
  title: string,
  content: string,
): Promise<PushResult> {
  const url = new URL(cfg.pushdeerUrl);
  url.searchParams.set("pushkey", cfg.pushdeerKey);
  url.searchParams.set("text", title);
  url.searchParams.set("desp", content);
  url.searchParams.set("type", "markdown");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "User-Agent": cfg.pushdeerUserAgent, // ★ 用户指定的 UA
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
