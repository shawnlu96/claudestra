export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { saveUploads, attachmentBlock } from "@/lib/uploads";

/**
 * 把用户消息（可带上传文件）投给指定 agent（fire-and-forget，wait=0）。
 *
 * 两种 body：
 *  - JSON     {agent, text}                纯文本
 *  - multipart agent + text + files[]      带附件：文件存到工作目录
 *    ~/.claude-orchestrator/web/uploads/，把绝对路径注入 text 末尾，agent 用 Read 查看。
 *
 * 代理 Bridge POST /api/v1/agents/:name/messages（JSON）；输出经 /api/chat/stream 回来。
 * agent 离线时 Bridge 返 409 → 这里转 502（前端据此解锁并提示）。
 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let agent = "";
  let text = "";
  let attachBlock = "";
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      agent = String(form.get("agent") || "");
      text = String(form.get("text") || "");
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (files.length) attachBlock = attachmentBlock(await saveUploads(files));
    } else {
      const body = (await request.json().catch(() => ({}))) as {
        agent?: string;
        text?: string;
      };
      agent = String(body.agent || "");
      text = String(body.text || "");
    }
  } catch (e) {
    return NextResponse.json(
      { error: `请求解析失败: ${(e as Error).message}` },
      { status: 400 }
    );
  }

  const finalText = `${text.trim()}${attachBlock}`.trim();
  if (!agent || !finalText) {
    return NextResponse.json({ error: "agent 和内容不能为空" }, { status: 400 });
  }

  try {
    const r = await bridgePost<{ ok: boolean; slash?: boolean; ccText?: string }>(
      `/agents/${encodeURIComponent(apiAgentName(agent))}/messages`,
      { text: finalText, wait: 0 },
      { timeoutMs: 15_000 }
    );
    // slash: bridge 走了 tmux 直通（CC 原生解释,无常规回合）——前端据此不进「正在回复」态
    return NextResponse.json({ data: { ok: true, slash: !!r.slash, ccText: r.ccText } });
  } catch (e) {
    // 503 + retryable = agent 活着、只是消息链路在重连 —— 透传给前端自动重试，
    // 不能和「真离线」一样报死（owner 2026-07-25 报误弹「已断开」）。
    const err = e as Error & { status?: number; retryable?: boolean };
    const retryable = err.retryable === true || err.status === 503;
    return NextResponse.json(
      { error: `发送失败: ${err.message}`, retryable },
      { status: retryable ? 503 : 502 }
    );
  }
}
