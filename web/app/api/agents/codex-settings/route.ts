export const runtime = "nodejs";

import { authedLegacy } from "@/lib/bff";
import { runtimeSwitchGet, runtimeSwitchPost, type RuntimeSwitchOpts } from "@/lib/chat/runtime-switch-bff";

/**
 * Codex agent 切换模型 / 推理档位。
 *
 * 与 pi-settings / claude-settings 的区别：Codex 没有能带参数的切换命令（TUI 的 /model 是选择器），
 * 桥接写 registry 后重启、接着原会话——所以 POST 要等一次重启（通常几秒），超时放宽到 60s。
 *
 * GET  → 模型目录（桥接跑 `codex debug models`），给选择面板渲染。
 * POST → { agent, model?, effort? } 切换。
 */
const OPTS: RuntimeSwitchOpts = { kind: "codex", listPath: "/codex-models", listTimeoutMs: 20_000, postTimeoutMs: 60_000 };
export const GET = authedLegacy(() => runtimeSwitchGet(OPTS));
export const POST = authedLegacy((request: Request) => runtimeSwitchPost(request, OPTS), { okFalse: true });
