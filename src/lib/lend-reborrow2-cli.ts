/**
 * `ledger lend-offer <task> --reborrow2 --ended-order <id> [--apply]`: dry-run by default. Source I/O and materials are read
 * outside the transaction, twice, with the pinned peer key and borrow entry re-read before the single canonical write.
 * The manager passes ports only; it never restores a lease or edits rows itself. tests/lend-reborrow2-apply.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getLendOrder, type OfferInput } from "./ledger-lend.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { LEND_FAMILIES, type BorrowEntry, type LendFamily } from "./lend-config.js";
import { applyReborrow2 } from "./lend-reborrow2-apply.js";
import { prepareReborrow2Context } from "./lend-reborrow2-context.js";
import { reborrow2Key, replayReborrow2 } from "./lend-reborrow2-event.js";
import { assertReborrow2Authority, captureReborrow2Facts, type Reborrow2Facts } from "./lend-reborrow2-facts.js";
import { prepareReborrow2Source, type Reborrow2Source, type Reborrow2SourceProbe } from "./lend-reborrow2-source.js";

export interface Reborrow2Request { taskId: string; peer: string; repo: string; family: LendFamily; endedOrder: string; apply: boolean }

export interface Reborrow2CliPort {
  db: Database; actor: string; now(): number; ctx(): WriteCtx;
  /** Fresh lend.json/contacts read for this peer and project on every call. */
  borrow(): Promise<BorrowEntry | null>;
  peerFp(peer: string): Promise<string | null>;
  probe: Reborrow2SourceProbe;
  /** The ordinary offer input and write materials, built with the original (proven) family; REBOR2 overrides family and PR. */
  materials(originalFamily: LendFamily): Promise<{ input: OfferInput; materialsDiag?: string }>;
  refresh(input: OfferInput): Promise<OfferInput>;
}

/** Required explicitly: a REBOR2 request never inherits the CLI's Codex default. */
export function reborrow2Family(s: string): LendFamily {
  if (!(LEND_FAMILIES as readonly string[]).includes(s)) throw new LedgerError("invalid", `--family 只能是 ${LEND_FAMILIES.join(" / ")}`);
  return s as LendFamily;
}

function replay(port: Reborrow2CliPort, req: Reborrow2Request, pinned: string | null, borrow: BorrowEntry | null) {
  const old = getLendOrder(port.db, req.endedOrder);
  if (!old || old.taskId !== req.taskId) throw new LedgerError("not_found", `没有本卡的原写单 ${req.endedOrder}`);
  const event = getEventByDedup(port.db, reborrow2Key(req.taskId, old.orderId, old.leaseGen));
  const saved = event?.data.lend as { facts: Reborrow2Facts; source: Reborrow2Source } | undefined;
  if (!saved) return null;
  const f = saved.facts;
  if (f.target.peer !== req.peer || f.target.repo !== req.repo || f.family !== req.family) throw new LedgerError("conflict", "原终态已用于不同 peer / 仓库 / 家族的接续");
  assertReborrow2Authority(port.db, f, port.actor, borrow, pinned, port.now(), true);
  const existing = replayReborrow2(port.db, f, saved.source, (id) => getLendOrder(port.db, id));
  const committed = existing ? getLendOrder(port.db, existing.orderId) : null;
  if (!committed?.reborrow2Basis) throw new LedgerError("conflict", "原终态接续审计 basis 无效");
  return { ok: true, duplicate: true, orderId: committed.orderId, status: committed.status, head: committed.head };
}

export async function runReborrow2(port: Reborrow2CliPort, req: Reborrow2Request): Promise<Record<string, unknown>> {
  const pinned = await port.peerFp(req.peer), borrow = await port.borrow();
  const replayed = replay(port, req, pinned, borrow);
  if (replayed) return replayed;
  if (!pinned) throw new LedgerError("forbidden", `${req.peer} 没有钉住的实例公钥`);
  const facts = captureReborrow2Facts(port.db, req.taskId, { peer: req.peer, fp: pinned, repo: req.repo, family: req.family });
  if (facts.previous.orderId !== req.endedOrder) throw new LedgerError("conflict", `已结束租约对应的原写单是 ${facts.previous.orderId}，不是 ${req.endedOrder}`);
  assertReborrow2Authority(port.db, facts, port.actor, borrow, pinned, port.now());
  const recovery = await prepareReborrow2Context(facts, port.probe);
  const { input: base, materialsDiag } = await port.materials(facts.originalFamily);
  if (!base.write || base.write.fp !== pinned || base.peer !== req.peer || base.repo !== req.repo) throw new LedgerError("invalid", "终态接续缺写单材料或材料身份不符");
  const input: OfferInput = { ...base, family: facts.family, pr: recovery.source.pr?.number ?? null, write: { ...base.write, base: "main", reborrow2: recovery } };
  const checked = await prepareReborrow2Source(facts, port.probe);
  if (JSON.stringify(checked) !== JSON.stringify(recovery.source)) throw new LedgerError("conflict", "材料准备期间远端来源漂移");
  const fresh = await port.refresh(input);
  const fp = await port.peerFp(req.peer);
  assertReborrow2Authority(port.db, facts, port.actor, fresh.borrow, fp, port.now());
  const s = recovery.source;
  const report = { previousOrderId: facts.previous.orderId, gen: facts.previous.leaseGen, end: facts.end, leaseReason: facts.lease.reason,
    leaseEndedAt: facts.lease.updatedAt, samePeer: facts.samePeer, family: facts.family, originalFamily: facts.originalFamily,
    reviewedHead: facts.task.headSHA, startHead: s.startHead, oldBranch: s.old.branch, oldHead: s.old.head, oldPr: s.old.pr?.number ?? null,
    branch: facts.target.branch, providerVerification: "required_at_claim", materialsDiag };
  if (!req.apply) return { ok: true, dryRun: true, ...report };
  const o = applyReborrow2(port.db, port.ctx(), recovery, { ...fresh, write: { ...fresh.write!, reborrow2: recovery } }, fp);
  return { ...report, ok: true, orderId: o.orderId, head: o.head, peer: o.peer, family: o.family, supersedes: o.supersedes };
}
