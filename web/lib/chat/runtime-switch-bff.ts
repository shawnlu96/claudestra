import { NextResponse } from "next/server";
import { bridgeGet, bridgePost, apiAgentName } from "./bridge-api";

/**
 * Pi / Codex 切换器的 BFF 逻辑（鉴权由各自的 route.ts 用 authedLegacy 包，guard 按文件查）：
 * GET 拉选项清单，POST { agent, model?, effort? } 转给桥接的 /agents/:name/<kind>-settings。
 * 两家只差桥接路径和超时（Codex 的切换要等一次重启）。
 */
export interface RuntimeSwitchOpts {
  kind: "pi" | "codex";
  listPath: string;
  listTimeoutMs: number;
  postTimeoutMs: number;
}

export async function runtimeSwitchGet(opts: RuntimeSwitchOpts): Promise<Response> {
  const json = await bridgeGet<Record<string, unknown>>(opts.listPath, { timeoutMs: opts.listTimeoutMs });
  return NextResponse.json({ data: json });
}

export async function runtimeSwitchPost(request: Request, opts: RuntimeSwitchOpts): Promise<Response> {
  const { agent, model, effort } = (await request.json().catch(() => ({}) /* 请求体不是 JSON：按空处理，下面报缺参 */)) as {
    agent?: string;
    model?: string;
    effort?: string;
  };
  if (!agent || typeof agent !== "string") return NextResponse.json({ error: "agent 不能为空" }, { status: 400 });
  if (!model && !effort) return NextResponse.json({ error: "model / effort 至少一项" }, { status: 400 });
  const result = await bridgePost(
    `/agents/${encodeURIComponent(apiAgentName(agent))}/${opts.kind}-settings`,
    { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    { timeoutMs: opts.postTimeoutMs },
  );
  return NextResponse.json(result);
}
