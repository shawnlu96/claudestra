export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

interface RuntimeInfo {
  id: string;
  label: string;
  available: boolean;
}

/**
 * 可建 agent 的运行时清单（BFF 代理 Bridge GET /api/v1/runtimes，v2.24+）。
 * 新建 agent 的运行时下拉据此决定显示哪些：available=false 的不显示（没装 codex 的人无感）。
 * 只转 id / label / available——bridge 的 hint 里带本机路径，不往浏览器送。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const json = await bridgeGet<{ runtimes?: RuntimeInfo[] }>("/runtimes", { timeoutMs: 30_000 });
    const runtimes = (json.runtimes ?? []).map((r) => ({ id: r.id, label: r.label, available: r.available === true }));
    return NextResponse.json({ data: { runtimes } });
  } catch {
    // 桥接不可达 / 老 bridge 没有这个端点：当作只有默认运行时（安全方向：不显示点了会报错的选项）
    return NextResponse.json({ data: { runtimes: [] } });
  }
}
