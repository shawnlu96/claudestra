export const runtime = "nodejs";

import { proxyGet, proxyPost } from "@/lib/bff";

/**
 * autoCompact 配置(代理 Bridge /api/v1/auto-compact,全权 token)。
 * GET  → {window, idleHours, defaults}
 * POST → {window?, idleHours?, emergency?} 写入 Claudestra config.json
 */
export const GET = proxyGet("/auto-compact");
export const POST = proxyPost("/auto-compact");
