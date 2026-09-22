export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";

/** Claude Code 的模型目录（Bridge 读 CC 自己拉的目录），给三处模型下拉渲染。 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const json = await bridgeGet<Record<string, unknown>>("/claude-models", { timeoutMs: 10_000 });
    return NextResponse.json({ data: json });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
