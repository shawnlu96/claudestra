/**
 * Codex over the ACP host: structured turns, structured failures and session/cancel. No TUI parsing, no keys.
 * A quota / auth failure is a result, not a retry signal: the scheduler escalates it; the quota channel owns the choice.
 */
import { ensureVia, observeVia, orderMismatch, sendReceipt, withHostFailure, type AdapterDeps, type HostFailure, type LiveState, type SendResult } from "./worker-ports.js";
import { renderWorkOrder } from "./worker-order.js";
import type { ControlReceipt, SubmitReceipt, WorkerSession } from "./worker-session.js";

/** Host turn state as reported by the ACP host (session/prompt pending = busy); lastFailure is the latest failed turn. */
export interface AcpTurnState {
  live: LiveState;
  lastFailure?: HostFailure;
}

export interface AcpPort {
  prompt(agent: string, sessionId: string, text: string, key: string): Promise<SendResult>;
  turnState(agent: string, sessionId: string): Promise<AcpTurnState>;
  cancel(agent: string, sessionId: string): Promise<ControlReceipt>;
}

export function createAcpWorker(o: AdapterDeps & { port: AcpPort }): WorkerSession {
  return {
    route: "acp",
    fallbackReason: null,
    ensure: (taskId, role, family) => family === "codex" ? ensureVia(o, "acp", taskId, role, family)
      : Promise.resolve({ kind: "manual", reason: "ACP 路径只承载 Codex 会话" }),
    async submit(ref, intentId, order): Promise<SubmitReceipt> {
      const bad = orderMismatch("acp", ref, intentId, order);
      if (bad) return { status: "rejected", route: "acp", reason: bad };
      try {
        return sendReceipt("acp", intentId, await o.port.prompt(ref.agent, ref.sessionId, renderWorkOrder(order), intentId), null);
      } catch (e) {
        return { status: "unknown", route: "acp", reason: `ACP 投递中断：${(e as Error).message}` };
      }
    },
    async observe(ref, order) {
      let state: AcpTurnState;
      try {
        state = await o.port.turnState(ref.agent, ref.sessionId);
      } catch {
        state = { live: "unknown" }; // an unreadable host only means unknown liveness; ledger facts still decide a finished result
      }
      return withHostFailure(observeVia(o, ref, order, state.live), state.lastFailure, state.live, order);
    },
    async cancel(ref) {
      try { return await o.port.cancel(ref.agent, ref.sessionId); }
      catch (e) { return { ok: false, unknown: true, reason: `session/cancel 中断：${(e as Error).message}` }; }
    },
    archive: (ref) => o.sessions.archive(ref),
  };
}
