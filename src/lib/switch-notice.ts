/**
 * 切模型 / effort 确认框的巡检决策（T41c）：watcher 看到的框一律只通知 owner，不代按。
 * 会按键的只有 runSwitchCommand（lib/tmux-helper.ts）——同一次调用里注入、等框、核对目标完全一致、只按一次。
 * 异步「登记意图、之后见框代按」在第 2 轮审查后整个拿掉：框的来源核对不了（排队、CC 主动提议同目标框），
 * 要恢复另开卡。bridge/permission-watcher.ts 负责抓屏、发通知。单测 tests/switch-notice.test.ts。
 */
import { screenFingerprint } from "./send-key-guard.js";
import { detectSwitchConfirmPrompt, type SwitchConfirmPrompt } from "./tmux-helper.js";

export type SwitchBoxAction =
  | { act: "none" }
  | { act: "notify"; p: SwitchConfirmPrompt; box: string };

/** 底部停着「Switch model?」/「Change effort level?」真框 → 通知（box = 框指纹，给通知去重用）；否则 none */
export function switchBoxAction(pane: string): SwitchBoxAction {
  const p = detectSwitchConfirmPrompt(pane);
  return p ? { act: "notify", p, box: screenFingerprint(pane) } : { act: "none" };
}

/** channelId → 已发过网页 session_anomaly 的那张框 / Discord 已发成功的那张框（分开记：Discord 失败重试时网页不重复报） */
const switchEmitted = new Map<string, string>();
const switchNotified = new Map<string, string>();

/**
 * 这张框（box = screenFingerprint）这一轮要发什么：同一张框只报一次，关了再弹一张新的照报。网页事件在进程内发、
 * 不会失败，排上就记；Discord 发成功才记（markSwitchNotified），失败下一轮重试。
 */
export function switchNoticePlan(channelId: string, box: string): { web: boolean; discord: boolean } {
  const key = `switch|${box}`;
  const web = switchEmitted.get(channelId) !== key;
  switchEmitted.set(channelId, key);
  return { web, discord: switchNotified.get(channelId) !== key };
}

export function markSwitchNotified(channelId: string, box: string): void {
  switchNotified.set(channelId, `switch|${box}`);
}

/** 框关了：两边的去重都清掉 */
export function clearSwitchNotice(channelId: string): void {
  switchEmitted.delete(channelId);
  switchNotified.delete(channelId);
}
