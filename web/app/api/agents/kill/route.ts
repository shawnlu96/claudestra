export const runtime = "nodejs";

import { agentAction } from "@/lib/bff";

/** kill agent：代理 Bridge POST /api/v1/agents/:name/kill（fork additive 端点）。 */
export const POST = agentAction("kill", 60_000);
