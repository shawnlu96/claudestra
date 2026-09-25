export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { HttpError, authed } from "@/lib/bff";
import { bridgeGet } from "@/lib/chat/bridge-api";
import { openDirectory, requestIsLocal } from "@/lib/host/host-info";

/**
 * 用本机程序打开某个 project 的目录。project 可能有多个 dirs，客户端传其中一个的**下标**；
 * 目录本身仍由 bridge 的 /projects 解析，路径不接受外部输入。非本机来源 403（前端不渲染入口，这里兜底）。
 */
export const POST = authed(async (req) => {
  if (!requestIsLocal(req)) throw new HttpError(403, "只能在本机打开");
  const { id, target, index } = (await req.json().catch(() => ({}) /* 空或畸形 body 当空对象，下面按字段校验回 400 */)) as { id?: unknown; target?: unknown; index?: unknown };
  if (typeof id !== "string" || !id) throw new HttpError(400, "id 不能为空");
  if (typeof target !== "string" || !target) throw new HttpError(400, "target 不能为空");
  const i = typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
  const { projects } = (await bridgeGet("/projects")) as { projects?: { id: string; dirs?: string[] }[] };
  const p = (projects ?? []).find((x) => x.id === id);
  if (!p) throw new HttpError(404, "没有这个 project");
  const dir = p.dirs?.[i];
  if (!dir) throw new HttpError(404, "project 没有这个目录");
  const r = await openDirectory(target, dir);
  if (!r.ok) throw new HttpError(422, r.error);
  return NextResponse.json({ ok: true, dir });
});
