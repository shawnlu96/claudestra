/**
 * `mark-turn <agent>`：记下 agent 第一次跑完回合的时间（registry firstTurnAt）。bridge 的 Stop hook 在条目还没这个
 * 标记时调一次；registry 只由 manager 写，所以走这条命令，不让 bridge 直接改文件。
 * restart 靠它分辨「从没对话过」（create 写 null）和「对话过、但会话文件丢了」（lib/restart-result.ts restartLaunchPlan）。
 */
import { normalizeName, output, patchRegistryAgent } from "./core.js";

export async function cmdMarkTurn(name: string | undefined) {
  if (!name) return output({ ok: false, error: "usage: mark-turn <name>" });
  const tmuxName = normalizeName(name);
  let at: string | undefined;
  const found = await patchRegistryAgent(tmuxName, (a) => {
    at = a.firstTurnAt || new Date().toISOString(); // 已经记过就不改：只要第一次的时间
    a.firstTurnAt = at;
  });
  output(found ? { ok: true, name: tmuxName, firstTurnAt: at } : { ok: false, error: `${tmuxName} 不在 registry` });
}
