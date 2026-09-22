export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { authedLegacy } from "@/lib/bff";

/** Claude Code 的模型目录（Bridge 读 CC 自己拉的目录），给三处模型下拉渲染。 */
export const GET = authedLegacy(async () => {
  const json = await bridgeGet<Record<string, unknown>>("/claude-models", { timeoutMs: 10_000 });
  return NextResponse.json({ data: json });
});
