import { closeAsk, getAsk, listAsks, MASTER_PROJECT, patchAsk } from "../lib/ledger-asks.js";
import type { ProjectAuditMutationPorts } from "../lib/shared-ledger-project-audit.js";
import { askDb, askReadDb, createAsk, onAsk, publishAsk } from "./asks.js";
import { SharedLedgerProjectAuditor } from "./shared-ledger-project-audit.js";

/**
 * Composition port for N2/N3/N4. The caller supplies real readers, N2 replacement and N2 project creation.
 * Deliberately no legacy setter fallback: startup registration must wait for those dependencies and removal of the old rebind sweep.
 */
export async function initSharedLedgerProjectAudit(ports: ProjectAuditMutationPorts & { inform: (text: string) => Promise<void> }) {
  const auditor = new SharedLedgerProjectAuditor({
    ...ports, now: Date.now,
    asks: () => {
      const db = askReadDb();
      return db ? listAsks(db, { project: MASTER_PROJECT, source: "system" }) : [];
    },
    openAsk: input => createAsk(input),
    closeAsk: (id, state) => {
      const a = closeAsk(askDb(), id, state, "shared project audit snapshot changed or expired");
      if (a) publishAsk(a);
    },
    claim: id => {
      const db = askDb();
      return db.transaction(() => {
        const a = getAsk(db, id);
        if (!a || a.state !== "answered" || a.extra.projectAuditSettled) return false;
        patchAsk(db, id, { extra: { projectAuditSettled: true } });
        return true;
      }).immediate();
    },
  });
  const stop = onAsk(a => {
    if (a.state === "answered") void auditor.onAnswered(a).catch(() => {
      console.error("共享项目核对作答处理失败；下次启动会重新核对。"); // Fixed text excludes credentials and file paths.
    });
  });
  try { await auditor.run(); }
  catch (error) { stop(); throw error; }
  return { afterJoin: () => auditor.run(), stop };
}
