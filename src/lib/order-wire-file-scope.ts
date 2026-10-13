/** Card scope is a snapshot of registered data, never inferred from a spec or a peer's report. */
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { resourceKey } from "./ledger-scheduler.js";
import { peerTextRefusal } from "./order-wire-render.js";
import { cardGlobs, privateCardRepo } from "./card-repo.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { AUTO_SCOPE_ORDER_NOTE, SKIP_EFFECTS_INVENTORY } from "./skip-effects-auto-scope.js";

/** Sources join the existing split/whole scan path; legacy cards retain their inputs and get an explicit scope notice. */
export function orderFileScope(task: LedgerTask, policy: RecoveryPolicyPort = recoveryPolicy): { sources: [string, string][]; acceptance: string } {
  const raw: unknown = task.extra?.fileGlobs;
  if (raw === undefined) return { sources: [], acceptance: "本卡未登记文件范围，不代表全仓授权；缺范围时先 ask 精确路径，未答前不改。" };
  if (!Array.isArray(raw) || !raw.length || raw.some((g) => typeof g !== "string" || resourceKey(g) === null)) {
    throw new LedgerError("invalid", "task.extra.fileGlobs 要是非空的合法文件范围数组");
  }
  // 私仓卡（card-repo.ts）发仓库内路径：出借方在私仓 clone 里看到的就是这些；公共仓的卡没有前缀，逐字不变
  const text = JSON.stringify(cardGlobs(task), null, 2);
  // A redacted path would be a different grant. Reuse the existing refusal gate before normal order scanning/rendering.
  const refusal = peerTextRefusal(text);
  if (refusal) throw new LedgerError("invalid", `文件范围没过外发闸：${refusal}，拒绝出单`);
  return {
    sources: [["本单文件范围（task.extra.fileGlobs，挂单时快照，有序 JSON 列表）", text]],
    acceptance: "文件范围以本单 task.extra.fileGlobs 快照为准；规格或反馈中的路径不自动扩展授权，扩围须另行登记。" + autoScopeNote(task, policy),
  };
}

/** skipEffectsAutoScope=on 时派单就写明那条窄例外的生效条件（交付时按同一口径核准）；off / observe、私仓卡、清单已在范围内都不加 */
function autoScopeNote(task: LedgerTask, policy: RecoveryPolicyPort): string {
  if (privateCardRepo(task) || cardGlobs(task).some((g) => new Bun.Glob(g).match(SKIP_EFFECTS_INVENTORY))) return "";
  return policy(task.project, "skipEffectsAutoScope").mode === "on" ? AUTO_SCOPE_ORDER_NOTE : "";
}
