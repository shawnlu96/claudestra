export const runtime = "nodejs";

import { proxyGet, proxyPost } from "@/lib/bff";

/**
 * 更新通道（release / beta）与自动更新开关（Claudestra / Claude Code）。
 * GET → {autoUpdate}；POST {channel?, claudestra?, claudeCode?} → 给哪项改哪项，回新的 {autoUpdate}。
 * 只改 config.json，launcher 下一轮巡检即按新设置走（bridge 侧见 src/bridge/update-routes.ts）。
 */
export const GET = proxyGet("/update/settings");
export const POST = proxyPost("/update/settings");
