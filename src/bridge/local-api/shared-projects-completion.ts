import type { Database } from "bun:sqlite";
import { bindHash } from "../../lib/ask-bind.js";
import { getAsk, patchAsk, ownerAnswered, type Ask } from "../../lib/ledger-asks.js";
import { askDb, askReadDb } from "../asks.js";
import type { ProjectPerson, SharedProjectsPorts } from "./shared-projects-ports.js";

const CREATOR = "system:shared-projects";
const KEY = "sharedProjectCompletion";
const HEX = /^[a-f0-9]{64}$/;

/** Trusted completion facts only: identifiers and digests, never invitation, credential or center bodies. */
export interface SharedProjectCompletionReceipt {
  v: 1; state: "completed"; askId: string; operationId: string; paramsHash: string; paramsDigest: string;
  centerId: string; teamId: string; personId: string; instanceId: string; projectId: string; localProjectId: string; completedAt: number;
}
export type SharedProjectCompletionView =
  | { ok: true; operationId: string; state: "completed"; askId: string; projectId: string; localProjectId: string; paramsDigest: string; completedAt: number }
  | { ok: true; operationId: string; state: "pending"; openAskId?: string }
  | { ok: true; operationId: string; state: "stale" | "unknown" };
/** Called by N4 completion only after credentialSaved and gateRead both succeed; false means the receipt was not stored. */
export type SharedProjectCompletionHook = (facts: { projectId: string; localProjectId: string; paramsDigest: string }) => boolean;

type Who = Pick<ProjectPerson, "centerId" | "teamId" | "personId" | "instanceId">;
const params = (a: Ask) => a.bind?.params as { operationId?: unknown; who?: Partial<Who> } | undefined;
const sameWho = (a: Partial<Who> | undefined, b: Who, instance = true) => !!a && a.centerId === b.centerId && a.teamId === b.teamId
  && a.personId === b.personId && (!instance || a.instanceId === b.instanceId);
/** A stored card is trusted only when its own binding still hashes to the approved parameters. */
const intact = (a: Ask, operationId: string) => a.createdBy === CREATOR && a.extra.sharedProjectAction === true && !!a.bind
  && bindHash(a.bind, CREATOR) === a.bind.paramsHash && params(a)?.operationId === operationId;

function receiptOf(a: Ask): SharedProjectCompletionReceipt | null {
  const r = a.extra[KEY] as Partial<SharedProjectCompletionReceipt> | undefined;
  const p = params(a);
  if (!r || r.v !== 1 || r.state !== "completed" || r.askId !== a.id || r.operationId !== p?.operationId || r.paramsHash !== a.bind?.paramsHash
    || !sameWho(p?.who, r as Who) || typeof r.projectId !== "string" || typeof r.localProjectId !== "string" || !r.projectId || !r.localProjectId
    || typeof r.paramsDigest !== "string" || !HEX.test(r.paramsDigest) || !Number.isSafeInteger(r.completedAt)
    || a.extra.sharedProjectExecuted !== true || !ownerAnswered(a.answer)) return null;
  return r as SharedProjectCompletionReceipt;
}

/** Bound to the claimed card: the hook writes once, through askDb's single atomic port, and never resurrects a different claim. */
export function sharedProjectCompletionHook(a: Ask, who: Who, operationId: string, d: Pick<SharedProjectsPorts, "now" | "recordCompletion">): SharedProjectCompletionHook | undefined {
  const record = d.recordCompletion;
  if (!record || !a.bind) return undefined;
  return facts => {
    try {
      return record(a, { v: 1, state: "completed", askId: a.id, operationId, paramsHash: a.bind!.paramsHash, paramsDigest: facts.paramsDigest,
        centerId: who.centerId, teamId: who.teamId, personId: who.personId, instanceId: who.instanceId,
        projectId: facts.projectId, localProjectId: facts.localProjectId, completedAt: d.now() });
    } catch { return false; } // A storage error is an unstored receipt, reported as pending by the caller.
  };
}

export function sharedProjectCompletionStore(database?: Database) {
  return {
    /** CAS on the original claim generation: same stored answer and binding, claimed, approved person, and no earlier receipt. */
    recordCompletion: (claimed: Ask, receipt: SharedProjectCompletionReceipt): boolean => {
      const db = database ?? askDb();
      return db.transaction(() => {
        const current = getAsk(db, claimed.id);
        if (!current || !intact(current, receipt.operationId) || current.state !== "answered" || current.extra.sharedProjectExecuted !== true
          || current.extra[KEY] !== undefined || !claimed.bind || current.bind!.paramsHash !== claimed.bind.paramsHash
          || JSON.stringify(current.answer) !== JSON.stringify(claimed.answer) || !ownerAnswered(current.answer)
          || receipt.askId !== current.id || receipt.paramsHash !== current.bind!.paramsHash || !sameWho(params(current)?.who, receipt)) return false;
        patchAsk(db, current.id, { extra: { [KEY]: receipt } });
        return receiptOf(getAsk(db, current.id)!) !== null;
      }).immediate();
    },
    /** Read-only lookup of N4 cards for one operation; never opens the write connection. */
    completionAsks: (operationId: string): Ask[] => {
      const db = database ?? askReadDb();
      if (!db) return [];
      const rows = db.prepare("SELECT id FROM asks WHERE createdBy = ? AND json_extract(bind, '$.params.operationId') = ? ORDER BY createdAt DESC LIMIT 64")
        .all(CREATOR, operationId) as { id: string }[];
      return rows.map(r => getAsk(db, r.id)).filter((a): a is Ask => !!a);
    },
  };
}

/**
 * N5 read path. Only the current authenticated person's cards count; success additionally requires the same instance and the
 * receipt's exact local binding to still be the only binding of that center/team/project. Reading never calls center/N2/N3 ports.
 */
export function readSharedProjectCompletion(who: Who, operationId: string, d: Pick<SharedProjectsPorts, "bindings" | "completionAsks">): SharedProjectCompletionView {
  const mine = (d.completionAsks?.(operationId) ?? []).filter(a => intact(a, operationId) && sameWho(params(a)?.who, who, false));
  const receipts = mine.map(receiptOf).filter((r): r is SharedProjectCompletionReceipt => !!r).sort((a, b) => b.completedAt - a.completedAt);
  const r = receipts[0];
  if (r) {
    const bound = d.bindings().filter(b => b.centerId === r.centerId && b.teamId === r.teamId && b.projectId === r.projectId);
    if (r.instanceId !== who.instanceId || bound.length !== 1 || (bound[0]!.localProjectId ?? bound[0]!.projectId) !== r.localProjectId) {
      return { ok: true, operationId, state: "stale" };
    }
    return { ok: true, operationId, state: "completed", askId: r.askId, projectId: r.projectId, localProjectId: r.localProjectId,
      paramsDigest: r.paramsDigest, completedAt: r.completedAt };
  }
  const own = mine.filter(a => sameWho(params(a)?.who, who));
  if (!own.some(a => a.extra.sharedProjectExecuted === true)) return { ok: true, operationId, state: "unknown" };
  const open = own.find(a => a.state === "open");
  return { ok: true, operationId, state: "pending", ...(open ? { openAskId: open.id } : {}) };
}
