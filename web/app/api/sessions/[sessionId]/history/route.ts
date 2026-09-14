export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";

/**
 * 任意会话的历史（BFF 代理 Bridge GET /api/v1/sessions/:sessionId/history）。
 *
 * 为什么不用 /api/chat/history：那条走的是 /agents/:name/history/:sessionId，只认
 * registry 里的 agent。侧栏「未纳管会话」里绝大多数没有 agent 名字，只能走这条。
 * 返回结构与聊天页的历史一致（messages / hasMore），只读展示直接复用。
 *
 * 定位靠 runtime + cwd（清单里都给了）：Pi 的会话文件名带时间戳，光有 id 推不出路径。
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> }
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { sessionId } = await ctx.params;
  const url = new URL(request.url);
  const qs = new URLSearchParams();
  for (const key of ["runtime", "cwd", "limit", "before"] as const) {
    const v = url.searchParams.get(key);
    if (v) qs.set(key, v);
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    const json = await bridgeGet<Record<string, unknown>>(
      `/sessions/${encodeURIComponent(sessionId)}/history${suffix}`,
      { timeoutMs: 25_000 }
    );
    return NextResponse.json({ data: json });
  } catch (e) {
    const err = e as Error & { status?: number };
    return NextResponse.json(
      {
        error:
          err.status === 404
            ? await st("会话文件已不在磁盘上", "Session file is gone from disk")
            : `${await st("读取历史失败", "History read failed")}: ${err.message}`,
      },
      { status: err.status === 404 ? 404 : 502 }
    );
  }
}
