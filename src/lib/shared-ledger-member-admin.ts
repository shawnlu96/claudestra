/**
 * Offline center membership administration (scripts/shared-ledger-admin.ts member-remove / member-readd).
 * Removal flips membership status; every credential check already requires an active member, so removal takes effect at once.
 * Re-adding restores the authority of every unexpired, unrevoked bearer the person held, unless the caller revokes them in the same step.
 */
import type { Store } from "../shared-ledger/store.js";

export interface MemberAdminResult { ok: boolean; teamId: string; personId: string; changed: boolean; error?: string; note?: string; revoked?: number }

const liveBearers = (store: Store, teamId: string, personId: string, now: number): number =>
  store.get<{ n: number }>("SELECT COUNT(*) n FROM credentials WHERE teamId=? AND personId=? AND revokedAt IS NULL AND expiresAt > ?",
    teamId, personId, now)!.n;

export function removeMember(store: Store, teamId: string, personId: string): MemberAdminResult {
  const status = store.get<{ status: string }>("SELECT status FROM members WHERE teamId=? AND personId=?", teamId, personId)?.status;
  if (!status) return { ok: false, teamId, personId, changed: false, error: "member not found" };
  const changed = store.write(() => store.db.query("UPDATE members SET status='removed' WHERE teamId=? AND personId=? AND status='active'")
    .run(teamId, personId).changes === 1);
  return { ok: true, teamId, personId, changed, note: "成员已移除：其 bearer 与待用入组码立即失效（list 里显示 rejected）。" };
}

export function readdMember(store: Store, teamId: string, personId: string, revokeOld: boolean, now = Date.now()): MemberAdminResult {
  const status = store.get<{ status: string }>("SELECT status FROM members WHERE teamId=? AND personId=?", teamId, personId)?.status;
  if (!status) return { ok: false, teamId, personId, changed: false, error: "member not found" };
  return store.write(() => {
    const revoked = revokeOld ? store.db.query("UPDATE credentials SET revokedAt=? WHERE teamId=? AND personId=? AND revokedAt IS NULL")
      .run(now, teamId, personId).changes : 0;
    const changed = store.db.query("UPDATE members SET status='active' WHERE teamId=? AND personId=? AND status!='active'")
      .run(teamId, personId).changes === 1;
    const note = revokeOld
      ? `已重新加回，旧 bearer 已吊销 ${revoked} 条：成员需用新入组码重新入组。`
      : `已重新加回：旧 bearer 的授权会一并恢复（当前有效 ${liveBearers(store, teamId, personId, now)} 条）；不想恢复请改用 --revoke-old 同时吊销旧 bearer。`;
    return { ok: true, teamId, personId, changed, revoked, note };
  });
}
