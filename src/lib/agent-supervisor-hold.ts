/**
 * 自动流程与监护的分工（i28-S1）：auto-tick 看到「回合失败」卡会把单退回人工交 PM（scheduler-auto-ports.ts codexFailure）。
 * 监护已经认领了这张卡的恢复（同会话发了恢复消息）时，auto-tick 这一轮要让开——不然恢复消息刚发，单就被退回人工了。
 * 只让开「监护认领了恢复、恢复消息没有确定发失败」的那张卡；额度 / 登录、别的回合失败、监护报过上限的，照旧交 PM。
 * 开关关着时调度 pass 不套这一层，auto-tick 与改动前完全一样。tests/agent-supervisor-hold.test.ts。
 */
import type { Database } from "bun:sqlite";
import { listAsks } from "./ledger-asks.js";
import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import type { WorkerObservation, WorkerSession } from "./worker-session.js";
import { stepState, superviseEvents } from "./agent-supervisor-ledger.js";

/** 这个 agent 最新一张开着的回合失败卡由监护认领了恢复、恢复消息没有确定发失败 */
export function supervisorHolds(db: Database, agent: string): boolean {
  const card = listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] }).filter((a) => a.extra.failure === "error")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!card) return false;
  const st = stepState(superviseEvents(db, agent, card.createdAt - 1), card.id, "recover");
  return !!st.claim && st.done?.result !== "failed";
}

/** 监护认领了恢复的回合失败：当成单还在跑（等恢复后的那一轮），不当失败交 PM */
export function heldObservation(seen: WorkerObservation, held: () => boolean): WorkerObservation {
  const failed = (seen.state === "result" && seen.outcome === "failed") || (seen.state === "unknown" && !!seen.failure);
  if (!failed) return seen;
  const kind = seen.state === "result" && seen.outcome === "failed" ? seen.failure.kind : seen.state === "unknown" ? seen.failure?.kind : undefined;
  return kind === "error" && held() ? { state: "running", busy: false } : seen;
}

/** 给 auto-tick 的 worker 套一层：observe 的结果过一遍 heldObservation，其余原样 */
export function withSupervisorHold(deps: AutoTickDeps, db: Database): AutoTickDeps {
  return {
    ...deps,
    worker: (ref) => {
      const w = deps.worker(ref);
      if ("manual" in w) return w;
      const wrapped: WorkerSession = {
        route: w.route, fallbackReason: w.fallbackReason,
        ensure: w.ensure.bind(w), submit: w.submit.bind(w), cancel: w.cancel.bind(w), archive: w.archive.bind(w),
        observe: async (r, order) => heldObservation(await w.observe(r, order), () => supervisorHolds(db, r.agent)),
      };
      return wrapped;
    },
  };
}
