/**
 * 「Switch model?」弹窗代决按钮（permission-watcher 检测到 CC 主动提议换模型时发出；Enter = 接受切换，Escape = 保持现状）。
 * owner 点过才发键：经 manager tmux-send-keys --authorized，按钮 id 进审计（logs/send-keys-audit.jsonl）；画面闸照查——按钮点得晚、
 * 框已经换成额度菜单 / 权限框时不发（owner 授权的是切模型那个框）。runManager 注入，单测 tests/send-key-guard.test.ts。
 */
import { authorizedSendKeysArgs } from "../lib/send-key-guard.js";

export const isSwmodelButton = (id: string): boolean => id.startsWith("swmodel_yes:") || id.startsWith("swmodel_no:");

export async function handleSwmodelButton(id: string, runManager: (...args: string[]) => Promise<any>): Promise<{ text: string }> {
  const yes = id.startsWith("swmodel_yes:");
  const agent = id.slice(id.indexOf(":") + 1);
  const r = await runManager(...authorizedSendKeysArgs(agent, `button:${id}`, [yes ? "Enter" : "Escape"]));
  if (r.error) return { text: `❌ 发键失败: ${r.error}` };
  return { text: yes ? `🔁 已替 **${agent}** 确认切换模型` : `🛡 已替 **${agent}** 关闭弹窗、保持当前模型` };
}
