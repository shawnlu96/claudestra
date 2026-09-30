/**
 * Codex over the ACP host: structured turns, structured failures and session/cancel. No TUI parsing, no keys.
 * A quota / auth failure is a result, not a retry signal: the scheduler escalates it; the quota channel owns the choice.
 */
import type { AcpFailure } from "./acp/failures.js";
import { ensureVia, observeVia, sendReceipt, type AdapterDeps, type LiveState, type SendResult } from "./worker-ports.js";
import { renderWorkOrder } from "./worker-order.js";
import type { ControlReceipt, SubmitReceipt, WorkerSession } from "./worker-session.js";

/** Host turn state as reported by the ACP host (session/prompt pending = busy); lastFailure is the latest failed turn. */
export interface AcpTurnState {
  live: LiveState;
  lastFailure?: { failure: AcpFailure; afterKey: string | null };
}

export interface AcpPort {
  prompt(agent: string, sessionId: string, text: string, key: string): Promise<SendResult>;
  turnState(agent: string, sessionId: string): Promise<AcpTurnState>;
  cancel(agent: string, sessionId: string): Promise<ControlReceipt>;
}

export function createAcpWorker(o: AdapterDeps & { port: AcpPort }): WorkerSession {
  return {
    route: "acp",
    ensure: (taskId, role, family) => family === "codex" ? ensureVia(o, "acp", taskId, role, family)
      : Promise.resolve({ kind: "manual", reason: "ACP 路径只承载 Codex 会话" }),
    async submit(ref, intentId, order): Promise<SubmitReceipt> {
      if (ref.transport !== "acp") return { status: "rejected", route: "acp", reason: `session 宿主是 ${ref.transport}，不是 ACP` };
      if (order.dedupKey !== intentId) return { status: "rejected", route: "acp", reason: "任务单去重键与调度意图不一致" };
      try {
        return sendReceipt("acp", intentId, await o.port.prompt(ref.agent, ref.sessionId, renderWorkOrder(order), intentId), null);
      } catch (e) {
        return { status: "unknown", route: "acp", reason: `ACP 投递中断：${(e as Error).message}` };
      }
    },
    async observe(ref, order) {
      let state: AcpTurnState;
      try { state = await o.port.turnState(ref.agent, ref.sessionId); } catch (e) { state = { live: "unknown" }; void e; /* unreadable host = unknown liveness; ledger facts still decide a finished result */ }
      const seen = observeVia(o, ref, order, state.live);
      const failed = state.lastFailure;
      if (seen.state === "result" || !failed || state.live === "busy") return seen;
      // A failure counts only when the host tied it to our key; an unattributed one may predate this order.
      if (failed.afterKey === null) return { state: "unknown", reason: `宿主报了未归属本单的失败（${failed.failure.kind}）` };
      if (failed.afterKey !== order.dedupKey) return seen;
      return { state: "result", outcome: "failed", failure: { kind: failed.failure.kind, message: failed.failure.message } };
    },
    async cancel(ref) {
      try { return await o.port.cancel(ref.agent, ref.sessionId); }
      catch (e) { return { ok: false, unknown: true, reason: `session/cancel 中断：${(e as Error).message}` }; }
    },
    archive: (ref) => o.sessions.archive(ref),
  };
}
