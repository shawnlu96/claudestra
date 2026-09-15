export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * 这台机器支持什么（BFF 代理 Bridge GET /api/v1/capabilities）。
 * 目前只有「有没有装 Pi」—— 没装时网页**不显示任何 Pi 入口**（新建 agent 里不出现
 * 运行时选择），让只用 Claude Code 的用户完全无感（owner 2026-09-14）。
 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const data = await bridgeGet<{ piAvailable?: boolean }>("/capabilities", { timeoutMs: 4000 });
    return NextResponse.json({ data: { piAvailable: data?.piAvailable === true } });
  } catch {
    // 桥接不可达时**当作没有 Pi**（安全方向：不显示一个点了会报错的选项）
    return NextResponse.json({ data: { piAvailable: false } });
  }
}
