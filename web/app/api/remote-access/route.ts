export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 「手机访问」面板（BFF 代理 Bridge GET /api/v1/remote-access）。只读：Tailscale 状态、
 * 每个入口是否可达、证书剩余天数、建议命令。配 serve 这类机器级变更不从网页做。
 * 探测要起子进程、做 TLS 握手，Bridge 侧缓存 60 秒；这里超时给宽一点。
 */
export const GET = authedLegacy(async (request: Request) => {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const data = await bridgeGet<Record<string, unknown>>(`/remote-access${fresh ? "?fresh=1" : ""}`, { timeoutMs: 15000 });
  return NextResponse.json({ data });
});
