export const runtime = "nodejs";

import { agentAction } from "@/lib/bff";

/** 更新 Pi 并重启该 agent：代理 Bridge POST /api/v1/agents/:name/pi-update（npm 全局安装 + 重启，给足 6 分钟） */
export const POST = agentAction("pi-update", 360_000);
