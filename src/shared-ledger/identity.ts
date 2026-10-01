import { SharedLedgerError } from "../lib/shared-ledger-contract.js";
import { sharedLedgerCredentialHash, type SharedLedgerCredential, type SharedLedgerPrincipal } from "../lib/shared-ledger-auth.js";
import { Store, decode, encode } from "./store.js";

/** Provisioning is an offline embedding API, never an unauthenticated HTTP administration route. */
export function registerCredential(store: Store, credential: SharedLedgerCredential, code: string): void {
  store.write(() => {
    store.run("INSERT OR IGNORE INTO teams VALUES (?,?)", credential.teamId, credential.teamId);
    for (const grant of credential.projects) {
      if (grant.projectId === "*") throw new SharedLedgerError("forbidden");
      store.run("INSERT OR IGNORE INTO projects VALUES (?,?,?)", credential.teamId, grant.projectId, grant.projectId);
    }
    store.run("INSERT OR REPLACE INTO members VALUES (?,?,?,?)", credential.teamId, credential.personId, code, credential.membershipStatus);
    store.run("INSERT OR REPLACE INTO instance_bindings VALUES (?,?,?,?)",
      credential.teamId, credential.personId, credential.instanceId, credential.publicKey);
    store.run("INSERT OR REPLACE INTO credentials VALUES (?,?,?,?,?,?,?)", credential.credentialHash,
      credential.teamId, credential.personId, credential.instanceId, credential.expiresAt, credential.revokedAt, encode(credential.projects));
  });
}
export function loadCredential(store: Store, bearer: string): SharedLedgerCredential | null {
  const row = store.get<SharedLedgerCredential & { grants: string }>(`SELECT c.hash credentialHash,c.teamId,c.personId,c.instanceId,
    c.expiresAt,c.revokedAt,c.grants,m.status membershipStatus,b.publicKey FROM credentials c
    JOIN members m ON m.teamId=c.teamId AND m.personId=c.personId
    JOIN instance_bindings b ON b.teamId=c.teamId AND b.personId=c.personId AND b.instanceId=c.instanceId WHERE c.hash=?`,
  sharedLedgerCredentialHash(bearer));
  return row ? { ...row, projects: decode(row.grants) } : null;
}
export function recheck(store: Store, bearer: string, principal: SharedLedgerPrincipal, now: number, publicKey: string): void {
  const c = loadCredential(store, bearer);
  if (!c || c.membershipStatus !== "active" || c.revokedAt !== null || c.expiresAt <= now) throw new SharedLedgerError("not_member");
  if (c.publicKey !== publicKey) throw new SharedLedgerError("forbidden");
  if (c.teamId !== principal.teamId || c.personId !== principal.personId || c.instanceId !== principal.instanceId
    || encode(c.projects) !== encode(principal.projects)) {
    // Principal grants may be filtered to a single project; check each against current persisted grants.
    if (!c || c.teamId !== principal.teamId || c.personId !== principal.personId || c.instanceId !== principal.instanceId
      || principal.projects.some((g) => !c.projects.some((p) => encode(g) === encode(p)))) throw new SharedLedgerError("forbidden");
  }
}
export function hasRead(principal: SharedLedgerPrincipal, project: string): boolean {
  return principal.projects.some((g) => g.projectId === project && g.actions.includes("read"));
}
export function actorCode(store: Store, p: SharedLedgerPrincipal): string {
  return store.get<{ code: string }>("SELECT code FROM members WHERE teamId=? AND personId=?", p.teamId, p.personId)!.code;
}
export function registeredHome(store: Store, team: string, instance: string, project: string): boolean {
  return store.all<{ bearerHash: string }>(`SELECT c.hash bearerHash FROM credentials c JOIN members m
    ON m.teamId=c.teamId AND m.personId=c.personId WHERE c.teamId=? AND c.instanceId=? AND m.status='active' AND c.revokedAt IS NULL AND c.expiresAt > ?`,
  team, instance, Date.now()).some((r) => {
    const row = store.get<{ grants: string }>("SELECT grants FROM credentials WHERE hash=?", r.bearerHash)!;
    return decode<SharedLedgerCredential["projects"]>(row.grants).some((g) => g.projectId === project);
  });
}
