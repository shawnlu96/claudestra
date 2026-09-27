/**
 * Codex 的回合以错误结束（额度用完、接口报错）时，Codex 不发任何 hook——0.153 的 hook 里只有 Stop / Interrupt
 * 管回合末，失败的回合两样都不发。于是 bridge 以为它还在跑：状态卡「工作中」，等它答复的 agent 永远等不到。
 *
 * rollout 里失败的回合是 task_complete + error，lib/codex-session.ts 把它翻成错误条目，jsonl-watcher 照常发
 * ⛔（额度，assistant_text rateLimited）或 api_error_turn（其它错误）。这里见到这两种事件、且频道属于 Codex agent，
 * 就替它补一个 StopFailure：走 bridge 正常的回合收尾（状态收敛、drain 把 ⛔ 那句推给等答复的 caller）。
 * Claude Code 失败时自己会发 StopFailure，不补。
 */
import { subscribeEvents } from "./event-bus.js";
import { readRegistryAgents } from "../lib/registry.js";

/** 等 watcher 这一轮扫完再收尾：drain 时 ⛔ 那句还在文字队列里（1.5s 防抖之内），才推得到 caller */
const SETTLE_MS = 500;

export function isTurnFailureEvent(type: string, data: Record<string, unknown>): boolean {
  return type === "api_error_turn" || (type === "assistant_text" && data.rateLimited === true);
}

/** postStopFailure：bridge 给自己的 /hook 发一个 StopFailure（与 typing-hook 同一条路） */
export function startCodexTurnFailureWatch(postStopFailure: (channelId: string) => Promise<void>): void {
  subscribeEvents({}, (evt) => {
    if (!isTurnFailureEvent(evt.type, (evt.data || {}) as Record<string, unknown>)) return;
    void (async () => {
      const agents = await readRegistryAgents().catch((e) => {
        console.error("Codex 回合失败收尾：读 registry 失败，这次不补 StopFailure:", (e as Error).message);
        return [];
      });
      if (agents.find((a) => a.channelId === evt.chatId)?.runtime !== "codex") return;
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      console.log(`⛔ Codex 回合以错误结束（不发 hook）→ 替 ${evt.agent} 补 StopFailure`);
      await postStopFailure(evt.chatId).catch((e) => console.error("Codex 回合失败收尾失败:", (e as Error).message));
    })();
  });
}
