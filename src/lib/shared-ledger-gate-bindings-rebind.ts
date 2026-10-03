import { STATE_DIR } from "./paths.js";
import { setSharedLedgerBinding, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { sharedLedgerJoinPinsMatch } from "./shared-ledger-gate-proxy-join-pins.js";
import { resolveSharedLedgerCredential } from "./shared-ledger-mode.js";

const sameSharedLedgerBinding = (a: SharedLedgerBinding, b: SharedLedgerBinding): boolean =>
  a.centerId === b.centerId && a.teamId === b.teamId && a.projectId === b.projectId
  && (a.localProjectId ?? a.projectId) === (b.localProjectId ?? b.projectId);

/** Check both the approved source mapping and pins while holding the binding writer lock; credentials are read only. */
export async function rebindSharedLedgerBinding(previous: SharedLedgerBinding, localProjectId: string, dir = STATE_DIR): Promise<void> {
  await setSharedLedgerBinding({ ...previous, localProjectId }, dir, current => {
    if (!current.some(b => sameSharedLedgerBinding(b, previous))) throw new Error("绑定已变化，请重新检查");
    const credential = resolveSharedLedgerCredential("owner:self", "person", previous.centerId, previous.teamId, previous.projectId, "read", dir);
    if (!credential) throw new Error("本机 owner 缺少该共享项目的读取凭据");
    if (!sharedLedgerJoinPinsMatch(credential, localProjectId, previous.projectId, dir)) throw new Error("所选项目或中心与已有 pins 不符");
  });
}
