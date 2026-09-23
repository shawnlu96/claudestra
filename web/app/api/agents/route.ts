export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { loadAgents } from "@/lib/chat/agents";
import { bridgePost } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";
import { getUnreadCounts, pruneUnread } from "@/lib/push/dispatcher";

/** agent 列表：代理 Bridge GET /api/v1/agents（master 在 token scope 内时置顶入列）。 */
export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  try {
    const list = await loadAgents();
    // 未读数合并(2026-09-16):服务端计数,键为去掉 agent- 前缀的短名(与 push_read 同键)。
    // 侧栏每 15s 轮询本接口,未读随之刷新,不另开长连接。
    // 列表里已经没有的 agent(已删除 / master)的未读先清掉,否则 App 角标永远归不了零
    if (list.length) pruneUnread(list.map((a) => a.name));
    const unread = getUnreadCounts();
    const data = list.map((a) => {
      const n = unread[a.name.replace(/^agent-/, "")] ?? 0;
      return n > 0 ? { ...a, unread: n } : a;
    });
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { error: `${await st("Bridge 不可达", "Bridge unreachable")}: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}

/** 新建 agent：代理 Bridge POST /api/v1/agents（fork additive 端点，内部 runManager create）。 */
export async function POST(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { name, dir, purpose, model, effort, project, runtime, piBase } = await request.json().catch(() => ({}));
  if (!name || !dir || typeof name !== "string" || typeof dir !== "string") {
    return NextResponse.json({ error: "name 和 dir 不能为空" }, { status: 400 });
  }
  try {
    // create 会 spawn Claude Code，可能要 10-30s
    const result = await bridgePost(
      "/agents",
      {
        name: name.trim(),
        dir: dir.trim(),
        purpose,
        // 可选钉模型/effort(session 级 CLI flag,不碰全局 settings.json)
        ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
        ...(typeof effort === "string" && effort.trim() ? { effort: effort.trim() } : {}),
        // v2.21+ 可选归属 project(缺省 manager 按 dir 自动归属)
        ...(typeof project === "string" && project.trim() ? { project: project.trim() } : {}),
        // v2.23+ 运行时：Web 上也能建 Pi agent（此前只能命令行）；v2.24+ 不再在这里列白名单，
        // 由 bridge 按运行时注册表校验（不认识的 400 带可用清单），加运行时 BFF 不用跟着改
        ...(typeof runtime === "string" && runtime.trim() ? { runtime: runtime.trim() } : {}),
        ...(typeof piBase === "string" && piBase.trim() ? { piBase: piBase.trim() } : {}),
      },
      { timeoutMs: 90_000 }
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 }
    );
  }
}
