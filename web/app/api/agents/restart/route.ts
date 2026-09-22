export const runtime = "nodejs";

import { agentAction } from "@/lib/bff";

/** restart agent：代理 Bridge POST /api/v1/agents/:name/restart（fork additive 端点）。 */
export const POST = agentAction("restart", 90_000);
