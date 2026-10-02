import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import { codexQuotaWait } from "./scheduler-local-runtime-quota.js";
import type { SlotWait } from "./scheduler-local-runtime-slots.js";
import type { StartTickEnv } from "./scheduler-autostart-run.js";
import { quotaOver } from "./scheduler-autostart.js";

/** Recheck the canonical quota reason: ordinary slot contention must never alert the PM. */
export async function notifyAutostartQuotaWait(env: StartTickEnv, project: string, wait: void | SlotWait): Promise<void> {
  if (!wait) return;
  let snapshot: InventoryQuota | undefined;
  const now = Date.now();
  const quota = await codexQuotaWait(async () => {
    snapshot = (await readInventoryQuota()).codex;
    return snapshot;
  }, now);
  if (!quota || quota.reason !== wait.reason || !snapshot) return;
  const over = quotaOver({ ...snapshot, windows: snapshot.windows.filter((w) => !w.resetPassed
    && (w.resetsAtMs === null || w.resetsAtMs > now) && Number.isFinite(w.usedPct)) }, 85);
  if (!over) return;
  const key = `quota:codex:${over.id}:${over.resetsAtMs ?? "?"}`;
  if (env.memo.has(key)) return;
  env.memo.add(key);
  const reset = over.resetsAtMs ? new Date(over.resetsAtMs).toISOString() : "未知";
  await env.notifyPm(project, `[自动开卡] Codex 周额度 ${over.id} 已用 ${over.usedPct}%，到了 85% 的线，暂停自动开卡（窗口 ${reset} 重置）。`);
}
