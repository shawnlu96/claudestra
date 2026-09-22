export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { authed } from "@/lib/bff";

/**
 * v2.24+ 后端一键升级（owner 2026-09-22：「UI 里最好也加一个手动升级按钮」）。
 *
 * POST → 点火，立刻回 202 + runId。**不能等它返回**：`manager update` 会 reload 三个
 *        daemon，包括正在处理这个请求的 bridge 自己，等于等自己被杀。上一次没结束
 *        时 bridge 回 409 + runId（透传）。
 * GET  → ?run=<runId> 只回本轮的日志行 + done/result（「已是最新」也在 result 里）；
 *        bridge 重启期间这个 GET 本身会短暂失败，属正常，前端另靠 /api/version 的
 *        commit 变化兜底判完成。
 *
 * 前端版本更新（那个「新版本已就绪」胶囊）是另一回事——它只换浏览器里的 bundle。
 */
export const POST = authed(async () => NextResponse.json(await bridgePost("/update", {})));

export const GET = authed(async (request) => {
  const run = new URL(request.url).searchParams.get("run");
  const q = run && /^\d{1,16}$/.test(run) ? `&run=${run}` : "";
  try {
    return NextResponse.json(await bridgeGet(`/update/log?tail=40${q}`));
  } catch (e) {
    // bridge 正在重启时这里必然失败 —— 对前端不是错误，是「还在升级」
    return NextResponse.json({ ok: true, lines: [], restarting: true, note: (e as Error).message });
  }
});
