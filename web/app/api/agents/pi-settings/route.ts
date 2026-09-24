export const runtime = "nodejs";

import { authedLegacy } from "@/lib/bff";
import { runtimeSwitchGet, runtimeSwitchPost, type RuntimeSwitchOpts } from "@/lib/chat/runtime-switch-bff";

/**
 * Pi agent 切换模型 / 思考档位。
 *
 * 为什么不能复用 claude-settings：那条注入的是 Claude Code 的 `/model`、`/effort`；
 * Pi 的 `/model` 是**打开选择器**的交互语义（未验证收不收参数），语义不同。
 * 这里走 Pi 扩展注册的确定性命令：`/claudestra-model <provider/id>`、
 * `/claudestra-thinking <level>`（扩展内部直接调 setModel/setThinkingLevel）。
 *
 * GET  → 可选模型清单（桥接读 ~/.pi/agent/models.json），给选择面板渲染。
 * POST → { agent, model?, effort? } 注入切换。
 */
const OPTS: RuntimeSwitchOpts = { kind: "pi", listPath: "/pi-models", listTimeoutMs: 10_000, postTimeoutMs: 20_000 };
export const GET = authedLegacy(() => runtimeSwitchGet(OPTS));
export const POST = authedLegacy((request: Request) => runtimeSwitchPost(request, OPTS), { okFalse: true });
