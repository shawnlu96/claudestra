export const runtime = "nodejs";

import { agentAction } from "@/lib/bff";

/** 永久移除 agent（kill + registry 条目删除,归档保留）：
 *  代理 Bridge POST /api/v1/agents/:name/remove（fork additive 端点）。
 *  owner 2026-07-14:「临时起的 agent 不想在列表里污染我,永久删除」。 */
export const POST = agentAction("remove", 60_000);
