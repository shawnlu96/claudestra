import type { SlotWait } from "./scheduler-local-runtime-slots.js";
import type { StartTickEnv } from "./scheduler-autostart-run.js";
import { codexWeeklyLine } from "./quota-codex-line.js";

/** Carry the blocking window to the notice so later quota observations cannot suppress it. */
export async function notifyAutostartQuotaWait(env: StartTickEnv, project: string, wait: void | SlotWait): Promise<void> {
  const over = wait?.quota;
  if (!over) return;
  const key = `quota:codex:${over.id}:${over.resetsAtMs ?? "?"}`;
  if (env.memo.has(key)) return;
  const reset = over.resetsAtMs ? new Date(over.resetsAtMs).toISOString() : "未知";
  await env.notifyPm(project, `[自动开卡] Codex 周额度 ${over.id} 已用 ${over.usedPct}%，到了 ${codexWeeklyLine(env.db, project)}% 的线，暂停自动开卡（窗口 ${reset} 重置）。`);
  env.memo.add(key);
}
