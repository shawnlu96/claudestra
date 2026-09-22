export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 「手机访问」面板（BFF 代理 Bridge GET /api/v1/remote-access）。只读：Tailscale 状态、
 * 每个入口是否可达、证书剩余天数、建议命令。配 serve 这类机器级变更不从网页做。
 * 探测要起子进程、做 TLS 握手，Bridge 侧缓存 60 秒；这里超时给宽一点。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const data = await bridgeGet<Record<string, unknown>>("/remote-access", { timeoutMs: 15000 });
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
