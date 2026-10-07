import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { bindHash } from "../../lib/ask-bind.js";
import { getAsk, patchAsk, ownerAnswered, type Ask } from "../../lib/ledger-asks.js";
import { STATE_DIR } from "../../lib/paths.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import { askDb, askReadDb } from "../asks.js";
import type { ProjectPerson, SharedProjectsPorts } from "./shared-projects-ports.js";

const CREATOR = "system:shared-projects";
const KEY = "sharedProjectCompletion";
const HEX = /^[a-f0-9]{64}$/;

/** Trusted completion facts only: identifiers and digests, never invitation, credential or center bodies. */
export interface SharedProjectCompletionReceipt {
  v: 2; state: "completed"; askId: string; operationId: string; paramsHash: string; paramsDigest: string;
  centerId: string; teamId: string; personId: string; instanceId: string; projectId: string; localProjectId: string; completedAt: number;
  /** Binding-store generation the verified readback/gate ran against; any later binding rewrite (remove, replace, re-add) is stale. */
  bindingGeneration: string;
}
/** One consistent read of the binding store: its generation digest and the bindings it holds. */
export interface SharedProjectBindingSnapshot { generation: string; bindings: SharedLedgerBinding[] }
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
const sameBindings = (a: SharedLedgerBinding[], b: SharedLedgerBinding[]) => JSON.stringify(a) === JSON.stringify(b);
/** Exactly one local binding for the center/team/project, and it is the completed local project. */
function onlyBinding(bindings: SharedLedgerBinding[], at: Pick<Who, "centerId" | "teamId">, p: { projectId: string; localProjectId: string }): boolean {
  const bound = bindings.filter(b => b.centerId === at.centerId && b.teamId === at.teamId && b.projectId === p.projectId);
  return bound.length === 1 && (bound[0]!.localProjectId ?? bound[0]!.projectId) === p.localProjectId;
}

/**
 * Binding-store generation without changing the binding schema: device/inode/size/ns timestamps plus a content digest of
 * shared-ledger-bindings.json. Its sole writer publishes by atomic rename, so removing and re-adding an identical row yields a
 * new generation. Deliberately coarse: any binding rewrite after a receipt reads as stale, never as success.
 */
export function sharedProjectBindingGeneration(dir = STATE_DIR): () => SharedProjectBindingSnapshot | null {
  const path = join(dir, "shared-ledger-bindings.json");
  const id = (s: BigIntStats | undefined) => s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : "missing";
  return () => {
    try {
      const before = statSync(path, { bigint: true, throwIfNoEntry: false });
      const bindings = readSharedLedgerBindings(dir);
      const bytes = before ? readFileSync(path) : Buffer.alloc(0);
      if (id(before) !== id(statSync(path, { bigint: true, throwIfNoEntry: false }))) return null; // Replaced mid-read.
      return { generation: createHash("sha256").update(id(before)).update("\0").update(bytes).digest("hex"), bindings };
    } catch { return null; }
  };
}

function receiptOf(a: Ask): SharedProjectCompletionReceipt | null {
  const r = a.extra[KEY] as Partial<SharedProjectCompletionReceipt> | undefined;
  const p = params(a);
  if (!r || r.v !== 2 || r.state !== "completed" || r.askId !== a.id || r.operationId !== p?.operationId || r.paramsHash !== a.bind?.paramsHash
    || !sameWho(p?.who, r as Who) || typeof r.projectId !== "string" || typeof r.localProjectId !== "string" || !r.projectId || !r.localProjectId
    || typeof r.paramsDigest !== "string" || !HEX.test(r.paramsDigest) || !Number.isSafeInteger(r.completedAt)
    || typeof r.bindingGeneration !== "string" || !HEX.test(r.bindingGeneration)
    || a.extra.sharedProjectExecuted !== true || !ownerAnswered(a.answer)) return null;
  return r as SharedProjectCompletionReceipt;
}

/** Bound to the claimed card: the hook writes once, through askDb's single atomic port, and never resurrects a different claim. */
export function sharedProjectCompletionHook(a: Ask, who: Who, operationId: string,
  d: Pick<SharedProjectsPorts, "now" | "recordCompletion" | "bindings" | "bindingGeneration">): SharedProjectCompletionHook | undefined {
  const record = d.recordCompletion;
  if (!record || !a.bind) return undefined;
  return facts => {
    try {
      // Pin the generation the readback/gate just verified; without one consistent snapshot of the adapter's own store, no receipt.
      const snap = d.bindingGeneration?.();
      if (!snap || !sameBindings(snap.bindings, d.bindings()) || !onlyBinding(snap.bindings, who, facts)) return false;
      return record(a, { v: 2, state: "completed", askId: a.id, operationId, paramsHash: a.bind!.paramsHash, paramsDigest: facts.paramsDigest,
        centerId: who.centerId, teamId: who.teamId, personId: who.personId, instanceId: who.instanceId,
        projectId: facts.projectId, localProjectId: facts.localProjectId, completedAt: d.now(), bindingGeneration: snap.generation });
    } catch { return false; } // A storage error is an unstored receipt, reported as pending by the caller.
  };
}

/** The binding generation defaults to the canonical state dir; an adapter on another dir must supply its own, or receipts fail closed. */
export function sharedProjectCompletionStore(database?: Database, stateDir = STATE_DIR) {
  return {
    bindingGeneration: sharedProjectBindingGeneration(stateDir),
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
 * N5 read path. Only the current authenticated person's cards count. Success additionally requires the same instance; the
 * binding store still at the receipt's generation (a removed, replaced or re-added binding never revives an old receipt) and
 * being the store the adapter reads; exactly the receipt's local binding; and a strong-identity local readback of the target
 * project's own credential. Reading writes nothing and never calls center, enrollment, gate or continue.
 */
export async function readSharedProjectCompletion(who: ProjectPerson, operationId: string,
  d: Pick<SharedProjectsPorts, "bindings" | "completionAsks" | "bindingGeneration" | "credentialSaved">): Promise<SharedProjectCompletionView> {
  const mine = (d.completionAsks?.(operationId) ?? []).filter(a => intact(a, operationId) && sameWho(params(a)?.who, who, false));
  const receipts = mine.map(receiptOf).filter((r): r is SharedProjectCompletionReceipt => !!r).sort((a, b) => b.completedAt - a.completedAt);
  const r = receipts[0];
  if (r) {
    if (r.instanceId !== who.instanceId) return { ok: true, operationId, state: "stale" };
    const snap = d.bindingGeneration?.();
    if (!snap || !sameBindings(snap.bindings, d.bindings())) return { ok: true, operationId, state: "unknown" };
    if (snap.generation !== r.bindingGeneration || !onlyBinding(snap.bindings, r, r)) return { ok: true, operationId, state: "stale" };
    let saved = false;
    try {
      // The adapter's readback keys on the target ids and checks person/instance against the local credential file only.
      saved = await d.credentialSaved(who, { centerId: r.centerId, teamId: r.teamId, projectId: r.projectId } as Parameters<SharedProjectsPorts["credentialSaved"]>[1]);
    } catch { /* Identity drift or an unreadable credential store is not success. */ }
    if (!saved) return { ok: true, operationId, state: "stale" };
    return { ok: true, operationId, state: "completed", askId: r.askId, projectId: r.projectId, localProjectId: r.localProjectId,
      paramsDigest: r.paramsDigest, completedAt: r.completedAt };
  }
  const own = mine.filter(a => sameWho(params(a)?.who, who));
  if (!own.some(a => a.extra.sharedProjectExecuted === true)) return { ok: true, operationId, state: "unknown" };
  const open = own.find(a => a.state === "open");
  return { ok: true, operationId, state: "pending", ...(open ? { openAskId: open.id } : {}) };
}
