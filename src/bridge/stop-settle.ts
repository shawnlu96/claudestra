/**
 * Stop hook 里 send_to_agent 回程的兜底结算（从 bridge.ts 搬出、依赖注入，单测 tests/stop-settle.test.ts）：
 * target 这一轮没调 reply() 就结束了，拿 drain 出来的 assistant 文字推回 caller（没文字就静默消化）。
 *
 * 以 API 错误结束的一轮（Claude Code 的 StopFailure，或最后一条 assistant 是 isApiErrorMessage——额度墙也是）不结算：那句错误不是答复。
 * Codex 的 StopFailure 不是这个意思，照常结算：撞额度时是 codex-turn-failure 替它补的（⛔ 那句要推给 caller，
 * 它的额度条目不带 isApiErrorMessage），被打断时是 typing-hook 把 Interrupt 映射过来的（那一轮就该结掉，
 * 否则打断后 owner 另问的答复会推给旧 caller）。tests/stop-settle.test.ts。
 * 2026-09-28 撞额度时这里把「You've hit your weekly limit」当 t18/t13a 的答复推给了 PM，还消化了回程簿，
 * 它们之后的真实答复就没了路由。现在回程簿原样留着，等它的真实答复（reply / 下一个正常结束的 Stop）。
 */
import type { MetricEvent } from "../lib/metrics.js";
import { isOwnStopChannel } from "../lib/pushback-scope.js";
import { DEFAULT_RUNTIME } from "../lib/runtimes/index.js";
import { withExpecting, type PendingAgentCall } from "./agent-calls.js";

export interface StopTurn {
  /** 要结算的频道（channelsToClear 里的一个） */
  cid: string;
  /** Stop hook 报上来的频道和它的 ws；candidateWs = cid 当前连接 */
  stopChannelId: string;
  stopWs: unknown;
  candidateWs: unknown;
  event: string;
  /** cid 这个 agent 的 runtime（ClientInfo.runtime；master / 老连接没有 = Claude Code） */
  runtime?: string;
  /** drainChannelWatcher 的结果：text 是兜底要转的文字，apiError = 最后一条 assistant 是 API 错误 */
  drain: { text: string | null; apiError?: boolean };
}

/**
 * 这一轮算不算 cid 自己「答完了」——只有算的才去结算回程簿、API 请求、看门狗。
 * 别人的频道不算（channelsToClear 里还有 pendingReplies 里别人的 intendedReplyChannel，拿别人的收尾结算就是张冠李戴）；
 * 以 API 错误结束的也不算（Codex 的 StopFailure 除外，见文件头）。
 */
export function settlesOwnTurn(t: StopTurn): boolean {
  if (t.drain.apiError) return false;
  if (t.event === "StopFailure" && (t.runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME) return false;
  return isOwnStopChannel(t.cid, t.stopChannelId, t.stopWs, t.candidateWs);
}

/** bridge 的 Stop 处理每个频道调一次：判这一轮算不算 cid 答完、算就结算回程簿。返回判定，API 请求与看门狗照它走 */
export async function settleStopTurn(d: CallerSettleDeps, t: StopTurn): Promise<boolean> {
  const own = settlesOwnTurn(t);
  if (own) await settleCallers(d, t.cid, t.drain.text);
  return own;
}

export interface CallerSettleDeps {
  answerable(cid: string): PendingAgentCall | undefined;
  consume(cid: string, pac: PendingAgentCall): void;
  /** 推回 caller（bridge 的 pushBackToCaller） */
  pushBack(pac: PendingAgentCall, cid: string, body: string): Promise<unknown>;
  /** 好几个 caller 在等、它又没指明答给谁：提醒它分别回 */
  nudgeAmbiguous(cid: string): void;
  metric(name: MetricEvent, callerChannelId: string, meta: Record<string, string>): void;
}

/** 只在 settlesOwnTurn 为真时调（settleStopTurn） */
async function settleCallers(d: CallerSettleDeps, cid: string, drainedText: string | null): Promise<void> {
  const pac = d.answerable(cid);
  if (!pac) {
    d.nudgeAmbiguous(cid);
    return;
  }
  if (!drainedText) {
    // 没文字：静默消化，**不推**。以前推一句「对方没产出，你去追问」会激励 caller 再发一轮 → 聊不停的根因之一；
    // caller 没收到推就不会发起新轮，链条自然断。
    d.consume(cid, pac);
    console.log(`🤫 drain兜底 no-text 静默清 pending: ${pac.targetName} → ${pac.callerName}`);
    d.metric("agent_pushback_drain_silent", pac.callerChannelId, { target: pac.targetName });
    return;
  }
  try {
    const body = withExpecting(pac, `[ℹ️ 对方 (${pac.targetName}) 这轮没用 reply() 工具，下面是 bridge 从 assistant 文字兜底转发的：]\n\n${drainedText}`);
    await d.pushBack(pac, cid, body);
    d.consume(cid, pac);
    console.log(`📨 AGENT PUSH-BACK (drain兜底): ${pac.targetName} → ${pac.callerName}（drain 文字）`);
    d.metric("agent_pushback_drain", pac.callerChannelId, { hadText: "yes" });
  } catch (e) {
    console.error("AGENT PUSH-BACK (drain兜底) 失败:", e);
  }
}
