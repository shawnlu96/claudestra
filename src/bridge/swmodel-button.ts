/**
 * 「Switch model?」/「Change effort level?」弹窗代决按钮（permission-watcher 发出；Enter = 接受切换，Escape = 保持现状）。
 * 授权绑定到那一张框：按钮 id 带框的指纹（lib/send-key-guard.ts screenFingerprint）和代次（发通知的时刻）。点击时两道核对——
 * bridge 这边：代次还是这个 agent 眼下那张框的（框关了、换了一张，watcher 就作废旧代次）；manager 那边：--expect switch_confirm --box <指纹>，
 * 拿到窗口锁后重新抓屏，指纹对不上不发。按钮 id 进审计（logs/send-keys-audit.jsonl）。runManager 注入，单测 tests/send-key-guard.test.ts。
 */
import { authorizedSendKeysArgs } from "../lib/send-key-guard.js";

export const isSwmodelButton = (id: string): boolean => id.startsWith("swmodel_yes:") || id.startsWith("swmodel_no:");

/** agent → 眼下那张框的「指纹.代次」；bridge 重启就清空（旧按钮随之失效，watcher 会重新发通知） */
const live = new Map<string, string>();

/** watcher 发通知时调：登记这张框、返回带授权码的按钮组（Discord / 网页同一组 id） */
export function switchPromptButtons(agent: string, fingerprint: string, now = Date.now()) {
  const token = `${fingerprint}.${now.toString(36)}`;
  live.set(agent, token);
  return {
    type: "buttons" as const,
    buttons: [
      { id: `swmodel_no:#${token}:${agent}`, label: "不切,保持现状", emoji: "🛡", style: "primary" as const },
      { id: `swmodel_yes:#${token}:${agent}`, label: "切换", emoji: "🔁", style: "secondary" as const },
    ],
  };
}

/** watcher 看到这个 agent 上已经没有切换框了：旧按钮作废。返回 false，好让 watcher 一行 return */
export function forgetSwitchPrompt(agent: string): false {
  live.delete(agent);
  return false;
}

const ID_RE = /^swmodel_(yes|no):#([0-9a-f]{12})\.([0-9a-z]+):(.+)$/;

export async function handleSwmodelButton(id: string, runManager: (...args: string[]) => Promise<any>): Promise<{ text: string }> {
  const m = ID_RE.exec(id);
  if (!m) return { text: "⌛ 这个按钮是旧版本发的，认不出对应哪一张框，没发键；请到终端或网页终端里自己按" };
  const [, verb, fingerprint, gen, agent] = m as unknown as [string, "yes" | "no", string, string, string];
  if (live.get(agent) !== `${fingerprint}.${gen}`) return { text: "⌛ 这条通知对应的框已经关了或换了一张，没发键；如果还有框，会另发新通知" };
  const r = await runManager(...authorizedSendKeysArgs(agent, `button:${id}`, "switch_confirm", fingerprint, [verb === "yes" ? "Enter" : "Escape"]));
  if (r.error) return { text: `❌ 发键失败: ${r.error}` };
  return { text: verb === "yes" ? `🔁 已替 **${agent}** 确认切换` : `🛡 已替 **${agent}** 关闭弹窗、保持现状` };
}
