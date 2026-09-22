export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 应答权限卡：代理 Bridge POST /api/v1/agents/:name/answer {kind:"permission"}
 * （fork additive 端点；发键前 Bridge 会 tmuxCapture 重验弹窗在场）。
 *
 * 注意：迁移到 upstream 架构后，权限弹窗的「事件下行」暂缺（upstream 的
 * permission-watcher 只面向 Discord，web-only 模式未启用）——权限卡不会自动
 * 弹出。本路由保留上行能力；agent 默认 bypassPermissions，此卡本就罕见。
 * session-idle 弹窗应答暂不支持（旧 /web/permission 能力，upstream 无对应）。
 */
const ACTION_MAP: Record<string, string> = {
  perm_allow: "allow",
  perm_allow_session: "allow_session",
  perm_deny: "deny",
  allow: "allow",
  allow_session: "allow_session",
  deny: "deny",
};

export const POST = authedLegacy(async (request: Request) => {
  const { agent, action } = await request.json().catch(() => ({}));
  if (!agent || !action) {
    return NextResponse.json({ error: "agent 和 action 不能为空" }, { status: 400 });
  }
  const mapped = ACTION_MAP[String(action)];
  if (!mapped) {
    return NextResponse.json(
      { ok: false, error: `不支持的 action: ${action}（session-idle 应答已随迁移移除）` },
      { status: 501 }
    );
  }
  const result = await bridgePost<{ ok: boolean }>(
    `/agents/${encodeURIComponent(apiAgentName(agent))}/answer`,
    { kind: "permission", action: mapped },
    { timeoutMs: 15_000 }
  );
  return NextResponse.json({ ...result, ok: true });
}, { okFalse: true, errorPrefix: "应答失败: " });
