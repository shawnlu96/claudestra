export const runtime = "nodejs";

import { proxyGet, proxyPost } from "@/lib/bff";

/**
 * mem0 记忆卫生配置(代理 Bridge /api/v1/memory-hygiene,全权 token)。
 * GET  → 当前状态(是否启用/频率/上次/下次运行)
 * POST → {enabled, freq} 写入(bridge 侧同步 cron 任务)
 */
export const GET = proxyGet("/memory-hygiene");
export const POST = proxyPost("/memory-hygiene");
