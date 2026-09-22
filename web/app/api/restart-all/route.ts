export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost } from "@/lib/chat/bridge-api";
import { authed } from "@/lib/bff";

/**
 * v2.24+ 全体重启（owner 2026-09-22：Claude Code 被意外登出后，在一个会话里重新
 * 登录，其它会话照样"未登录"——凭证只在进程启动时读一次，跑着的进程不会回头重读）。
 *
 * POST → 点火，立刻回 202 + runId。**不能等它返回**：十几个 agent 逐个 `--resume`
 *        拉起是分钟级，HTTP 早超时。上一轮没结束时 bridge 回 409 + 那一轮的 runId
 *        （透传，前端接着看它）。
 * GET  → ?run=<runId> 只回本轮的日志行 + done/result；不带 run = 最后一轮（用来接回进行中的）。
 */
export const POST = authed(async () =>
  NextResponse.json(await bridgePost("/restart-all", { includeMaster: true })),
);

export const GET = authed(async (request) => {
  const run = new URL(request.url).searchParams.get("run");
  const q = run && /^\d{1,16}$/.test(run) ? `&run=${run}` : "";
  try {
    return NextResponse.json(await bridgeGet(`/restart-all/log?tail=40${q}`));
  } catch (e) {
    // 读不到日志 ≠ 失败：前端照常继续轮询
    return NextResponse.json({ ok: true, lines: [], note: (e as Error).message });
  }
});
