export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { HttpError, authed } from "@/lib/bff";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { openDirectory, requestIsLocal } from "@/lib/host/host-info";

/**
 * 用本机程序打开某个会话的工作目录。客户端只传会话名 + 打开方式 id：目录由 bridge 的 agent
 * 快照（registry 的 cwd）解析，命令由 lib/host/openers 的候选表拼——路径和命令都不接受外部输入。
 * 非本机来源一律 403（前端本就不渲染入口，这里是兜底）。
 */
export const POST = authed(async (req) => {
  if (!requestIsLocal(req)) throw new HttpError(403, "只能在本机打开");
  const { name, target } = (await req.json().catch(() => ({}) /* 空或畸形 body 当空对象，下面按字段校验回 400 */)) as { name?: unknown; target?: unknown };
  if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "name 不能为空");
  if (typeof target !== "string" || !target) throw new HttpError(400, "target 不能为空");
  const { agents } = (await bridgeGet("/agents")) as { agents?: { name: string; cwd?: string }[] };
  const hit = (agents ?? []).find((a) => a.name === name || a.name === `agent-${name}`);
  if (!hit) throw new HttpError(404, "没有这个会话");
  if (!hit.cwd) throw new HttpError(404, "会话没有记录工作目录");
  const r = await openDirectory(target, hit.cwd);
  if (!r.ok) throw new HttpError(422, r.error);
  return NextResponse.json({ ok: true, dir: hit.cwd });
});
