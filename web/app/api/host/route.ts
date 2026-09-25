export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/bff";
import { hostInfoFor } from "@/lib/host/host-info";

/**
 * 主机信息（登录后拉一次）：这次请求是不是来自本机、平台、本机能打开目录的程序。
 * 前端据此决定会话 / project 菜单里要不要出现「在 Finder 中显示 / 在终端打开 / 用 IDE 打开」。
 * 有鉴权：装了什么软件不该暴露给未登录者（所以不塞进公开的 /api/version）。
 */
export const GET = withAuth(async (req) => NextResponse.json(hostInfoFor(req), { headers: { "Cache-Control": "no-store" } }));
