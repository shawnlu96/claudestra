export const runtime = "nodejs";

import { proxyGet, proxyPost } from "@/lib/bff";

/**
 * v2.21+ project 管理(代理 Bridge /api/v1/projects,全权 token)。
 * GET  → {projects:[{id,name,emoji,dirs,description,agents[]}], unassigned[]}
 * POST → {action:"add"|"edit"|"remove"|"assign", id, ...} 委托 manager CLI
 *        （manager 的校验错误是 bridge 的 4xx，现在按状态码透传，不再一律 502）
 */
export const GET = proxyGet("/projects");
export const POST = proxyPost("/projects");
