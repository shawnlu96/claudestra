/**
 * Claude Code / Pi over the channel protocol, and the tmux compatibility fallback for a Codex session still on its TUI.
 * Both send through MessagePort (today's send_to_agent path; T48 swaps the port). The fallback cannot be built without a
 * reason, and every receipt it produces carries that reason, so the ledger always shows why a session was typed into.
 */
import { ensureVia, observeVia, orderMismatch, sendReceipt, withHostFailure, type AdapterDeps, type HostFailure, type MessagePort } from "./worker-ports.js";
import { renderWorkOrder } from "./worker-order.js";
import type { ControlReceipt, SubmitReceipt, WorkerSession } from "./worker-session.js";

export interface MessageAdapterOpts extends AdapterDeps {
  port: MessagePort;
}

export function createChannelWorker(o: MessageAdapterOpts): WorkerSession {
  return messageWorker(o, "channel", null);
}

export function createTmuxFallbackWorker(o: MessageAdapterOpts & { reason: string }): WorkerSession {
  const reason = o.reason.trim();
  if (!reason) throw new Error("tmux 回退必须写明原因");
  return messageWorker(o, "tmux", reason);
}

function messageWorker(o: MessageAdapterOpts, route: "channel" | "tmux", fallback: string | null): WorkerSession {
  const why = fallback ? { fallbackReason: fallback } : {};
  return {
    route,
    fallbackReason: fallback,
    ensure: (taskId, role, family) => ensureVia(o, route, taskId, role, family),
    async submit(ref, intentId, order): Promise<SubmitReceipt> {
      const bad = orderMismatch(route, ref, intentId, order);
      if (bad) return { status: "rejected", route, reason: bad, ...why };
      try {
        return sendReceipt(route, intentId, await o.port.send(ref.agent, ref.sessionId, renderWorkOrder(order), intentId), fallback);
      } catch (e) {
        return { status: "unknown", route, reason: `发送中断：${(e as Error).message}`, ...why };
      }
    },
    async observe(ref, order) {
      let live: Awaited<ReturnType<MessagePort["status"]>>;
      try {
        live = await o.port.status(ref.agent, ref.sessionId);
      } catch {
        live = "unknown"; // a failed status read only means unknown liveness; the ledger result check below still runs
      }
      let failed: HostFailure | undefined;
      try {
        failed = await o.port.lastFailure?.(ref.agent, ref.sessionId);
      } catch (e) {
        console.error(`⚠️ [scheduler] 读 ${ref.agent} 的失败来源出错，本轮按没有失败看：${(e as Error).message}`); // 下一轮还会再读
      }
      return withHostFailure(observeVia(o, ref, order, live), failed, live, order);
    },
    async cancel(ref): Promise<ControlReceipt> {
      try {
        return { ...(await o.port.interrupt(ref.agent, ref.sessionId)), ...why };
      } catch (e) {
        return { ok: false, unknown: true, reason: `打断请求中断：${(e as Error).message}`, ...why };
      }
    },
    archive: (ref) => o.sessions.archive(ref),
  };
}
