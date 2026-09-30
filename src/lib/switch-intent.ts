/**
 * 切模型 / effort 确认框的代按与通知决策（T41c）：只有 Claudestra 刚注入、登记过精确目标意图、框里目标完全一致的那张才代按，
 * 一张框只按一次；其余只通知 owner。bridge/permission-watcher.ts 负责抓屏、发键、发通知。单测 tests/switch-intent.test.ts。
 */
import { screenFingerprint } from "./send-key-guard.js";
import { modelTargetKey, sameModelTarget } from "./switch-target.js";
import { detectSwitchConfirmPrompt, effortDialogLevel, paneLooksIdle, type SwitchConfirmPrompt } from "./tmux-helper.js";

/** 切模型意图表：bridge 自己注入 /model 时登记「agent → 目标模型」，watcher 见框先对意图——目标完全一致才代按。
 *  CC 用量保护会主动弹同款框提议降级（同家族旧版本也算），没有意图 / 目标对不上的框一律只通知。
 *  意图只覆盖「注入 → 框画出来」这一小段：上限 60s；过了宽限、会话空闲又没框 = 命令已落地（或被吞），立刻作废
 *  （expireSettledIntents）。匹配即消费,只用一次。忙时排队到回合结束才弹的框超过 60s 就只通知——来源核对不了，宁可让 owner 按。 */
const SWITCH_INTENT_TTL_MS = 60_000;
/** 注入后到 CC 画出框之间的空当：这段时间看到的空闲屏不作数 */
const SWITCH_INTENT_GRACE_MS = 5_000;
const switchIntents = new Map<string, { model: string; ts: number }>();

/** 注入 /model 的三条路径(web slash 直通/Discord slash/claude-settings 超时后)都要调。 */
export function noteModelSwitchIntent(agentName: string, modelStr: string) {
  // 目标认不出版本(裸别名之外的自定义 id)→ 不登记,走通知;旧意图也作废,免得它去认这次的框
  if (!modelTargetKey(modelStr)) { switchIntents.delete(agentName); return; }
  switchIntents.set(agentName, { model: modelStr, ts: Date.now() });
}

/** `/effort` 同样会弹「Change effort level?」(cache 失效确认)——意图表与 /model 同理。 */
const effortIntents = new Map<string, { level: string; ts: number }>();

export function noteEffortSwitchIntent(agentName: string, level: string) {
  // 存框里会显示的档位：ultracode 在框里写作 xhigh，存原词就永远对不上
  const l = effortDialogLevel(level);
  if (l) effortIntents.set(agentName, { level: l, ts: Date.now() });
}

/** 注入方自己已把框按掉/命令已落地 → 撤掉意图,免得有效期内 CC 主动提议的同目标框被当成用户意图代按。 */
export function clearSwitchIntent(agentName: string, kind: "model" | "effort") {
  (kind === "model" ? switchIntents : effortIntents).delete(agentName);
}

/** 框的目标和登记的意图完全一致 → 消费掉意图（只用一次）返回 true；过期的顺手清掉 */
export function consumeSwitchIntent(agentName: string, p: SwitchConfirmPrompt, now = Date.now()): boolean {
  const table = p.kind === "model" ? switchIntents : effortIntents;
  const it = table.get(agentName);
  if (!it) return false;
  if (now - it.ts > SWITCH_INTENT_TTL_MS) { table.delete(agentName); return false; }
  const hit = "model" in it ? sameModelTarget(it.model, p.target) : it.level === effortDialogLevel(p.target);
  if (hit) table.delete(agentName);
  return hit;
}

/**
 * 过了宽限、会话空闲、屏上没有切换框 = 那条命令已经被 CC 处理掉（无框直接落地 / 被吞），意图作废：
 * 之后再弹同目标的框就不是这条命令引出的（CC 自己的提议），只通知。忙着（命令还在排队）不动。
 */
export function expireSettledIntents(agentName: string, pane: string, now = Date.now()): void {
  if (detectSwitchConfirmPrompt(pane) || !paneLooksIdle(pane)) return;
  for (const table of [switchIntents, effortIntents] as Map<string, { ts: number }>[]) {
    const it = table.get(agentName);
    if (it && now - it.ts >= SWITCH_INTENT_GRACE_MS) table.delete(agentName);
  }
}

/** 按过的那张框（agent → 指纹 + 时间）：按键后抓屏可能还是旧帧，同一张框在这段时间里不再按、也不报；框一消失就清掉 */
const PRESSED_BOX_QUIET_MS = 20_000;
const pressedBoxes = new Map<string, { fp: string; ts: number }>();

export function notePressedBox(agentName: string, pane: string, now = Date.now()): void {
  pressedBoxes.set(agentName, { fp: screenFingerprint(pane), ts: now });
}

/** 这一帧是不是刚按过的那张框的旧帧 */
export function isPressedBox(agentName: string, pane: string, now = Date.now()): boolean {
  const b = pressedBoxes.get(agentName);
  return !!b && now - b.ts < PRESSED_BOX_QUIET_MS && b.fp === screenFingerprint(pane);
}

export type SwitchBoxAction =
  | { act: "none" }
  /** 刚按过的那张框的旧帧：不按也不报 */
  | { act: "stale" }
  | { act: "press"; p: SwitchConfirmPrompt }
  | { act: "notify"; p: SwitchConfirmPrompt; box: string };

/**
 * 「Switch model?」/「Change effort level?」确认框（CC 2.1.280 起两种都弹）怎么处理（press 会消费意图、记下这张框）。
 * 只代按 bridge 自己注入、登记过意图、而且框里目标和意图完全一致的那张，一张框只按一次；
 * 其余（CC 主动提议降级、同家族别的版本、没登记过的）一律不按，只通知 owner 到终端或网页终端里自己按。
 */
export function switchBoxAction(agentName: string, pane: string, now = Date.now()): SwitchBoxAction {
  // 识别收敛到 detectSwitchConfirmPrompt：只认底部真框（标题独占一行 + Yes/No 两项、看不到真输入框）
  const p = detectSwitchConfirmPrompt(pane);
  if (!p) {
    pressedBoxes.delete(agentName); // 框关过了：再弹一张同指纹的是新框，不能当旧帧压掉
    expireSettledIntents(agentName, pane, now);
    return { act: "none" };
  }
  if (isPressedBox(agentName, pane, now)) return { act: "stale" };
  if (!consumeSwitchIntent(agentName, p, now)) return { act: "notify", p, box: screenFingerprint(pane) };
  notePressedBox(agentName, pane, now);
  return { act: "press", p };
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
