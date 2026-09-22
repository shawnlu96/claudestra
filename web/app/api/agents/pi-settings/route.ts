export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet, bridgePost, apiAgentName } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * Pi agent 切换模型 / 思考档位。
 *
 * 为什么不能复用 claude-settings：那条注入的是 Claude Code 的 `/model`、`/effort`；
 * Pi 的 `/model` 是**打开选择器**的交互语义（未验证收不收参数），语义不同。
 * 这里走 Pi 扩展注册的确定性命令：`/claudestra-model <provider/id>`、
 * `/claudestra-thinking <level>`（扩展内部直接调 setModel/setThinkingLevel）。
 *
 * GET  → 可选模型清单（桥接读 ~/.pi/agent/models.json），给选择面板渲染。
 * POST → { agent, model?, effort? } 注入切换。
 */
export const GET = authedLegacy(async () => {
  const json = await bridgeGet<Record<string, unknown>>("/pi-models", { timeoutMs: 10_000 });
  return NextResponse.json({ data: json });
});

export const POST = authedLegacy(async (request: Request) => {
  const { agent, model, effort } = (await request.json().catch(() => ({}))) as {
    agent?: string;
    model?: string;
    effort?: string;
  };
  if (!agent || typeof agent !== "string") {
    return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  }
  if (!model && !effort) {
    return NextResponse.json({ error: "model / effort 至少一项" }, { status: 400 });
  }
  const result = await bridgePost(
    `/agents/${encodeURIComponent(apiAgentName(agent))}/pi-settings`,
    { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    { timeoutMs: 20_000 }
  );
  return NextResponse.json(result);
}, { okFalse: true });
