/**
 * 监护的探活（i28-S1）：调度服务每轮的观察、认领后的复核、`manager restart --expect` 拿锁后的复核（manager/restart-expect.ts）走同一份，
 * 三处判「还是不是那样」才对得上。tmux 版只看窗口在不在，ACP 版看宿主四态（worker-liveness.ts）；读失败一律 unknown，绝不当成「没了」。
 */
import { MASTER_SESSION, tmuxRawStrict } from "./tmux-helper.js";
import { probeAcpWorker, type WorkerLiveness } from "./worker-liveness.js";
import { stuckSince, type ActivityRecord } from "./agent-supervisor-activity.js";
import type { Look } from "./agent-supervisor-judge.js";
import type { Supervised } from "./agent-supervisor-scope.js";

/** tmux 版 agent 只看窗口在不在；读失败 = 不知道（绝不当成「没了」） */
async function windowLiveness(agent: string): Promise<"running" | "no_window" | "unknown"> {
  try {
    const names = (await tmuxRawStrict(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"])).split("\n");
    return names.includes(agent) ? "running" : "no_window";
  } catch {
    return "unknown"; // tmux 读失败：这一轮不知道，监护不判死
  }
}

/** 生产的探活：按 registry 里的 transport 分 */
export const probeSupervised = (s: Supervised): Promise<WorkerLiveness> => (s.transport === "acp" ? probeAcpWorker(s.agent) : windowLiveness(s.agent));

export interface LookIo {
  probe(s: Supervised): Promise<WorkerLiveness>;
  activity(agent: string): ActivityRecord | null;
  now(): number;
}

/** 看一眼：四态 + 卡住证据（只对 ACP，宿主心跳见 agent-supervisor-activity.ts）。时刻取在探活之后，探活本身要等 */
export async function lookAt(s: Supervised, io: LookIo, stuckMs: number): Promise<Look> {
  const liveness = await io.probe(s);
  const since = s.transport === "acp" ? stuckSince(io.activity(s.agent), s.sessionId, io.now(), stuckMs) : null;
  return { liveness, stuckSince: since };
}
