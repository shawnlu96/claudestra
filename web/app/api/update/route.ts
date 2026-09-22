export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/**
 * v2.24+ 后端一键升级（owner 2026-09-22：「UI 里最好也加一个手动升级按钮」）。
 *
 * POST → 点火，立刻回 202。**不能等它返回**：`manager update` 会 reload 三个 daemon，
 *        包括正在处理这个请求的 bridge 自己，等于等自己被杀。
 * GET  → 升级日志末尾，前端轮询它看进度；真正的「升完了」靠 /api/version 的 commit
 *        变化来判（bridge 重启期间这个 GET 本身也会短暂失败，属正常）。
 *
 * 前端版本更新（那个「新版本已就绪」胶囊）是另一回事——它只换浏览器里的 bundle。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgePost("/update", {}));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    return NextResponse.json(await bridgeGet("/update/log?tail=40"));
  } catch (e) {
    // bridge 正在重启时这里必然失败 —— 对前端不是错误，是「还在升级」
    return NextResponse.json({ ok: true, lines: [], restarting: true, note: (e as Error).message });
  }
}
