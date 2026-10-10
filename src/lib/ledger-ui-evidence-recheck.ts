/**
 * UIHASH1: right before PM's `ui-approve` is written, the screenshots the card's digest stands on are re-checked when a formal
 * delivery registered them (ledger-deliver-ui.ts: a deliver event whose uiEvidence carries this digest, bytesVerified). The
 * registered manifest — never extra.screenshots — names the files: each is re-read under this machine's artifact root on the same
 * trusted path (layer anchors, O_NOFOLLOW fd, realpath pin, provenance for imports), its actual bytes hashed against the registered
 * sha256, its path against the registered path, and the manifest against the card's current head / specRev / round with no later
 * delivery. Last, every file is re-stat'ed against the inode the read saw (TOCTOU: a swap or write meanwhile refuses). Anything
 * off throws before the approval: zero writes. A card whose digest has no formal registration (manual screenshots, legacy
 * approvals) gets nothing new here and keeps the original gates; this never approves anything by itself.
 * tests/ledger-ui-evidence-recheck.test.ts.
 */
import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { uiDeliverPort } from "./ledger-deliver-ui-port.js";
import { fileId, sameFile, uiProblem, verifyUiShots, type UiDeliverPeer, type UiDeliverPort } from "./ledger-deliver-ui.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { isUiEvidenceError, parseUiEvidence } from "./order-deliver-ui.js";

type Stored = Record<string, unknown> & { shots?: unknown; peer?: unknown };

const refuse = (task: LedgerTask, code: string, why: string): never => {
  throw new LedgerError("conflict", `${task.id} 截图证据批准前重核不过（${code}）：${why}；没记批准`, { ui: code });
};

/** The registered peer of an imported set, exactly as deliver stored it; anything else is not a registration to stand on. */
function storedPeer(v: unknown): UiDeliverPeer | null {
  const p = v as Partial<UiDeliverPeer> | null;
  return p && typeof p.peer === "string" && typeof p.worker === "string" && typeof p.orderId === "string" ? { peer: p.peer, worker: p.worker, orderId: p.orderId } : null;
}

/**
 * Throws a LedgerError (conflict) unless the formally registered screenshots behind the card's digest are still exactly what was
 * delivered. `carried`: a merge-stage approval whose head moved by review carries (ui-approve-carry-anchor.ts already proved the
 * chain), so the manifest's head is the delivered one rather than the card's. Returns whether a formal registration was checked.
 */
export function recheckUiEvidence(task: LedgerTask, events: readonly LedgerEvent[], o: { carried?: boolean; roots?: UiDeliverPort["roots"] } = {}): boolean {
  const digest = task.extra.screenshotsDigest;
  const deliveries = events.filter((e) => e.kind === "deliver");
  const reg = deliveries.findLast((e) => (e.data.uiEvidence as Stored | undefined)?.digest === digest);
  if (!reg || typeof digest !== "string") return false; // no formal registration of this digest: the original gates alone
  const stored = reg.data.uiEvidence as Stored;
  const shots = Array.isArray(stored.shots) ? (stored.shots as Record<string, unknown>[]) : [];
  let e;
  try {
    e = parseUiEvidence({ v: stored.v, taskId: stored.taskId, head: stored.head, specRev: stored.specRev, round: stored.round, source: stored.source,
      summary: stored.summary, digest: stored.digest, shots: shots.map((s) => ({ view: s?.view, size: s?.size, phase: s?.phase, ref: s?.ref, sha256: s?.sha256 })) });
  } catch (err) {
    if (!isUiEvidenceError(err)) throw err;
    return refuse(task, "registration_invalid", `登记的截图清单读不出来（#${reg.seq}）`);
  }
  const peer = stored.peer === undefined ? undefined : storedPeer(stored.peer);
  if (stored.bytesVerified !== true || peer === null || (e.source === "imported") !== !!peer) refuse(task, "registration_invalid", `登记的截图清单不完整（#${reg.seq}）`);
  if (deliveries.at(-1) !== reg) refuse(task, "evidence_drift", `登记截图之后又有交付（#${deliveries.at(-1)!.seq}），摘要没跟着换`);
  if (e.taskId !== task.id || reg.data.headSHA !== e.head) refuse(task, "evidence_drift", "登记的截图清单与那次交付的卡 / head 对不上");
  if (!o.carried && e.head !== task.headSHA) refuse(task, "head_drift", `卡上 head 已是 ${task.headSHA ?? "（空）"}，截图是 ${e.head} 的`);
  if (e.specRev !== task.specRev || e.round !== task.round) refuse(task, "evidence_drift", `截图是规格第 ${e.specRev} 版第 ${e.round} 轮的，卡上是第 ${task.specRev} 版第 ${task.round} 轮`);
  const paths = shots.map((s) => s?.path);
  const extra = task.extra.screenshots;
  if (!Array.isArray(extra) || extra.length !== paths.length || extra.some((p, i) => p !== paths[i])) refuse(task, "evidence_drift", "卡上的截图路径不是登记时的那组");
  try {
    const files = verifyUiShots(task.id, e, o.roots ?? uiDeliverPort().roots, peer ?? undefined);
    for (const f of files) if (f.path !== shots.find((s) => s?.ref === f.ref)?.path) refuse(task, "path_moved", `${f.ref} 不在登记时的路径`);
    // TOCTOU: the path still names the very inode that was hashed, unchanged since; a swap / write in between refuses
    for (const f of files) {
      let now;
      try { now = fileId(lstatSync(f.path)); } catch { return refuse(task, "path_untrusted", `${f.ref} 重核后读不到了`); }
      if (!sameFile(f.id, now)) refuse(task, "changed_during_check", `${f.ref} 在重核过程中被改动或替换`);
    }
  } catch (err) {
    const p = uiProblem(err);
    if (!p) throw err;
    return refuse(task, p.code, p.why);
  }
  return true;
}
