export const runtime = "nodejs";

import { proxyGet } from "@/lib/bff";

/** 按当前通道查能升到哪个版本（release 查 GitHub 最新正式版，beta 查 origin/main；要联网，给足超时） */
export const GET = proxyGet("/update/check", { timeoutMs: 25_000 });
