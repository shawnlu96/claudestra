export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgePost } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/**
 * 远程终端输入：代理 Bridge `POST /api/v1/terminal/:termId/input`。
 * body: { id: termId, d: base64(原始字节，xterm onData 的转义序列原样) }
 * 频率可能较高（逐键/微批），Bridge 侧此端点不限流。
 */
export const POST = authedLegacy(async (request: Request) => {
  const { id, d } = (await request.json().catch(() => ({}))) as {
    id?: string;
    d?: string;
  };
  if (!id || !d) {
    return NextResponse.json({ error: "缺少 id/d" }, { status: 400 });
  }
  await bridgePost(`/terminal/${encodeURIComponent(id)}/input`, { d }, { timeoutMs: 5_000 });
  return NextResponse.json({ ok: true });
}, { okFalse: true });
