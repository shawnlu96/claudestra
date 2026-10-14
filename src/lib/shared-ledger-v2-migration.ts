/** X13 · whole-group execution migration and batch-receipt reconciliation (design shared-ledger-v2.md §1 :39/:44, §2 X13, §5).
 * preflight: pause dispatch (scheduler maintenance lease) → backup → in-flight list; any unreconciled unknown refuses.
 * mapping: one-to-one local ↔ center ids, spec copies and review evidence complete, old lend orders settled or imported with
 * their lease (leaseGen + head) checked; nothing is re-sent. switch: durable write gate (mode `migrating`) → one center batch
 * flips the whole group to execution → center home leases → local mode execution. Any failure reads the batch receipt, keeps
 * the gate closed (old authority is never restored) and freezes for PM. Reverse never writes back: freeze → export → report.
 * Drill only (isolated temp root + center adapter); a formal migration needs X15 and owner authorization (out of scope).
 */
import {
  parseCommand, parseMigrationManifest, V2ContractError, v2ManifestDigest, v2ObjectDigest,
  type V2Command, type V2MigrationManifest, type V2Receipt,
} from "./shared-ledger-contract-v2.js";
import type { Stage2Transport } from "./shared-ledger-v2-transport.js";
import { execOperationId } from "./shared-ledger-exec-client.js";
import { readSharedLedgerMode, writeSharedLedgerModes, type SharedLedgerMode } from "./shared-ledger-mode.js";
import {
  assertDrillRoot, backupLocal, batchDir, MigrationRefused, pauseDispatch, readLocalInventory, sha256File, underRoot, writeRootJson,
  type LocalInventory, type MigrationBackup, type MigrationFinding,
} from "./shared-ledger-v2-migration-local.js";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The center calls this module makes; `createStage2Transport` satisfies it through `migrationCenter`. */
export interface MigrationCenter {
  migrate: Stage2Transport["migrate"]; migration: Stage2Transport["migration"];
  snapshot: Stage2Transport["snapshot"]; receipt: Stage2Transport["receipt"];
  command(command: V2Command): Promise<V2Receipt>;
}
export const migrationCenter = (t: Stage2Transport): MigrationCenter => ({
  migrate: b => t.migrate(b), migration: id => t.migration(id), snapshot: id => t.snapshot(id), receipt: q => t.receipt(q),
  command: c => t.call("commands", {}, c),
});

type ManifestBody = Omit<V2MigrationManifest, "manifestDigest" | "evidence" | "featureIds" | "frozenAt" | "batchId">;
export interface MigrationPlan {
  batchId: string; centerId: string;
  /** Group features: the local id must equal the center id (X7 exec gate reads the mode file by center id). */
  featureIds: string[]; centerFeatureIds?: Record<string, string>;
  /** Boot id of the home scheduler that will hold the center leases. */
  homeBootId: string;
  /** Rows + mappings + authorization, minus the fields this module fills (evidence, digest, featureIds, frozenAt, batchId). */
  manifest: ManifestBody;
  /** Unknown intents / lend orders reconciled by hand before migrating; anything unknown and not listed refuses. */
  reconciled?: { kind: "intent" | "lend"; id: string; outcome: string }[];
  /** Every local lend order still pooled / claimed: settle it first, or import it with the lease it is checked against. */
  orders?: Record<string, { disposition: "import"; leaseGen: number; head: string }>;
  /** Review evidence per center task id: report path relative to the drill root plus its sha256. */
  reviews?: Record<string, { reportPath: string; digest: string }>;
  /** 本机 / peer A / peer B version check (S2K2 + CTATT1). Drill records it; a formal migration would require it. */
  members?: { label: string; instanceId: string; versionVerified: boolean }[];
}
export interface MigrationOptions {
  root: string; plan: MigrationPlan; center: MigrationCenter; mode: "dry-run" | "commit";
  ledgerPath?: string; now?: () => number; pauseWaitMs?: number;
}
export type MigrationOutcome =
  | { status: "refused"; findings: MigrationFinding[]; report: string }
  | { status: "dry-run"; manifestDigest: string; batch: unknown; report: string }
  | { status: "switched"; epochs: Record<string, number>; leases: string[]; report: string }
  | { status: "frozen"; step: "switch" | "lease" | "local_mode"; batch: unknown; receipts: unknown[]; report: string };

type Draft = MigrationOutcome extends infer O ? O extends MigrationOutcome ? Omit<O, "report"> : never : never;
type Done = (o: Draft) => MigrationOutcome;
const REVIEWED = new Set(["review", "fix", "merge", "live", "verified", "done"]);
const errCode = (e: unknown): string => e instanceof V2ContractError ? e.code : e instanceof Error ? e.message : String(e);

/** Pure checks over the inventory and plan; returns every finding instead of stopping at the first. */
function migrationFindings(root: string, plan: MigrationPlan, inv: LocalInventory, modes: Record<string, SharedLedgerMode>): MigrationFinding[] {
  const out: MigrationFinding[] = [], add = (code: string, item: string, detail: string) => out.push({ code, item, detail });
  const m = plan.manifest, reconciled = new Set((plan.reconciled ?? []).map(r => `${r.kind}:${r.id}`));
  for (const f of plan.featureIds) {
    const center = plan.centerFeatureIds?.[f] ?? f;
    if (center !== f) add("feature_id_mismatch", f, `本机 feature id 与中心 ${center} 不同，X7 执行闸按中心 id 读模式，拒绝切换`);
    const mode = modes[f];
    if (mode.migrating) add("already_migrating", f, `已在批次 ${mode.migrating.batchId} 中`);
    else if (mode.authorityMode !== m.authorityFrom) add("authority_mismatch", f, `本机 ${mode.authorityMode}，清单 ${m.authorityFrom}`);
  }
  for (const i of inv.inflight) {
    if (i.status === "unknown") { if (!reconciled.has(`${i.kind}:${i.id}`)) add("unknown_unreconciled", `${i.kind}:${i.id}`, `卡 ${i.taskId} 未核清`); }
    else if (i.kind === "worker") add("worker_live", i.id, `卡 ${i.taskId} 执行者 ${i.status}，先停或结清`);
    else if (i.kind === "intent") add("intent_inflight", i.id, `卡 ${i.taskId} 意图 ${i.status}，先结清`);
  }
  const mapped = (kind: string) => new Map(m.mappings.filter(x => x.kind === kind).map(x => [x.sourceId, x.id]));
  const tasks = mapped("task"), orders = mapped("order"), centerTasks = new Map(m.tasks.map(t => [t.id, t]));
  const seen = new Set<string>();
  for (const t of inv.tasks) {
    const id = tasks.get(t.id);
    if (!id || !centerTasks.has(id)) { add("mapping_missing", t.id, "本机卡没有一一对应的中心卡"); continue; }
    if (seen.has(id)) add("mapping_not_one_to_one", t.id, `中心卡 ${id} 被多张本机卡映射`);
    seen.add(id);
  }
  for (const [source] of tasks) if (!inv.tasks.some(t => t.id === source)) add("mapping_unknown_source", source, "映射的本机卡不在本组");
  for (const t of m.tasks) {
    const art = m.artifacts.find(a => a.artifactId === t.spec.artifactId);
    if (t.spec.visibility !== "approved_copy" || !art || art.kind !== "spec") add("spec_copy_missing", t.id, "缺获准规格副本");
    const review = plan.reviews?.[t.id];
    if (REVIEWED.has(t.stage) || t.review.reportArtifactId !== null || review) {
      if (!review) add("review_evidence_missing", t.id, "缺审查报告路径与哈希");
      else if (isAbsolute(review.reportPath) || !existsSync(underRoot(root, review.reportPath))) add("review_evidence_missing", t.id, "报告不在演练根目录内");
      else if (sha256File(underRoot(root, review.reportPath)) !== review.digest) add("review_evidence_digest", t.id, "报告哈希不符");
    }
  }
  for (const o of inv.orders.filter(o => ["pooled", "claimed"].includes(o.status))) {
    const want = plan.orders?.[o.orderId], central = m.lendOrders.find(c => c.orderId === orders.get(o.orderId));
    if (!want) add("lend_unsettled", o.orderId, `出借单 ${o.status}（${o.peer}）：先结清或显式导入`);
    else if (!central) add("lend_import_unmapped", o.orderId, "导入的出借单在清单里没有对应中心订单");
    else if (want.leaseGen !== o.leaseGen || want.head !== o.head || central.leaseGen !== o.leaseGen || central.head !== o.head) {
      add("lend_lease_mismatch", o.orderId, `租约核对不符：本机 gen ${o.leaseGen}/${o.head.slice(0, 8)}`);
    }
  }
  for (const c of m.lendOrders) if (["pooled", "claimed"].includes(c.status)
    && !inv.orders.some(o => orders.get(o.orderId) === c.orderId && plan.orders?.[o.orderId])) add("lend_not_declared", c.orderId, "清单里的在途订单没有显式导入声明");
  return out;
}

/** Fills evidence / digest and lets the X0 parser re-check every relation (mappings, spec copies, no leases, no unknowns). */
function buildManifest(plan: MigrationPlan, imported: boolean, frozenAt: number): V2MigrationManifest {
  const body = { ...structuredClone(plan.manifest), batchId: plan.batchId, featureIds: [...plan.featureIds], frozenAt,
    evidence: { dispatchPaused: true, workersSettled: true, unknownReconciled: true, specsComplete: true, reviewsComplete: true,
      oldOrders: imported ? "imported_reconciled" : "settled", localWriteGateInstalled: true, leasesMustBeAcquired: true },
    manifestDigest: "" } as V2MigrationManifest;
  body.manifestDigest = v2ManifestDigest(body);
  return parseMigrationManifest(body);
}

const modeOf = (plan: MigrationPlan, root: string) => Object.fromEntries(plan.featureIds.map(f => [f, readSharedLedgerMode(f, root)]));

export async function runExecutionMigration(opts: MigrationOptions): Promise<MigrationOutcome> {
  const root = assertDrillRoot(opts.root), plan = opts.plan, now = opts.now ?? Date.now;
  const ledgerPath = opts.ledgerPath ?? join(root, "ledger.sqlite");
  underRoot(root, ledgerPath);
  const dir = batchDir(root, plan.batchId), reportPath = join(dir, `${opts.mode}-report.json`);
  const report: Record<string, unknown> = { batchId: plan.batchId, mode: opts.mode, featureIds: plan.featureIds, startedAt: now(),
    notMigrated: ["scheduler_sessions", "process locks"], members: plan.members ?? [],
    versions: (plan.members ?? []).length === 3 && plan.members!.every(m => m.versionVerified) ? "verified" : "unverified (drill only)" };
  const done: Done = o => {
    writeRootJson(root, reportPath, { ...report, outcome: o, finishedAt: now() });
    return { ...o, report: reportPath };
  };
  let pause: { release(): void };
  try { pause = await pauseDispatch(root, ledgerPath, opts.pauseWaitMs); }
  catch (e) { if (e instanceof MigrationRefused) return done({ status: "refused", findings: e.findings }); throw e; }
  try {
    let backup: MigrationBackup;
    try { backup = backupLocal(root, `${plan.batchId}-${opts.mode}`, ledgerPath); }
    catch (e) { if (e instanceof MigrationRefused) return done({ status: "refused", findings: e.findings }); throw e; }
    const inv = readLocalInventory(ledgerPath, plan.featureIds);
    Object.assign(report, { dispatchPaused: true, backup, inflight: inv.inflight, reconciled: plan.reconciled ?? [] });
    const findings = migrationFindings(root, plan, inv, modeOf(plan, root));
    if (findings.length) return done({ status: "refused", findings });
    let manifest: V2MigrationManifest;
    try { manifest = buildManifest(plan, Object.keys(plan.orders ?? {}).length > 0, now()); }
    catch (e) { return done({ status: "refused", findings: [{ code: "manifest_invalid", item: plan.batchId, detail: errCode(e) }] }); }
    report.manifestDigest = manifest.manifestDigest;
    if (opts.mode === "dry-run") return await dryRun(opts.center, manifest, done);
    return await commit(root, ledgerPath, plan, manifest, opts.center, report, done);
  } finally { pause.release(); }
}

async function dryRun(center: MigrationCenter, manifest: V2MigrationManifest, done: Done) {
  try {
    const result = await center.migrate({ mode: "dry-run", manifest });
    // A dry-run must leave no batch record behind: the lookup still answers unknown for this batchId.
    const batch = await center.migration(manifest.batchId);
    if (batch.status !== "unknown") return done({ status: "refused", findings: [{ code: "dry_run_committed", item: manifest.batchId, detail: "演练批次已有提交记录" }] });
    return done({ status: "dry-run", manifestDigest: result.manifestDigest, batch: { dryRun: result, lookup: batch } });
  } catch (e) {
    return done({ status: "refused", findings: [{ code: "center_refused", item: manifest.batchId, detail: errCode(e) }] });
  }
}

async function lookupBatch(center: MigrationCenter, batchId: string): Promise<unknown> {
  try { return await center.migration(batchId); } catch (e) { return { status: "unreachable", error: errCode(e) }; }
}

async function commit(root: string, ledgerPath: string, plan: MigrationPlan, manifest: V2MigrationManifest, center: MigrationCenter,
  report: Record<string, unknown>, done: Done): Promise<MigrationOutcome> {
  const before = modeOf(plan, root);
  // 1. Durable write gate: from here on local writes to the group's cards are refused (X7), and nothing reopens them.
  try {
    await writeSharedLedgerModes(Object.fromEntries(plan.featureIds.map(f => [f,
      { ...before[f], migrating: { batchId: plan.batchId, kind: "execute" as const } }])), root, ledgerPath);
  } catch (e) {
    return done({ status: "refused", findings: [{ code: "write_gate_failed", item: plan.batchId, detail: errCode(e) }] });
  }
  report.writeGate = "installed";
  const freeze = (step: "switch" | "lease" | "local_mode", batch: unknown, receipts: unknown[], reason: string) => {
    writeRootJson(root, join(batchDir(root, plan.batchId), "frozen.json"), {
      batchId: plan.batchId, state: "frozen_pending_pm", step, reason, batch, receipts,
      note: "本机写门保持关闭，不恢复旧权威；PM 按 batch / 回执核对后另行处理",
    });
    return done({ status: "frozen", step, batch, receipts });
  };
  // 2. Whole-group switch: one batch, all-or-nothing at the center. A failed or lost answer is resolved only by the batch lookup.
  let result;
  try { result = await center.migrate({ mode: "commit", manifest }); }
  catch (e) { return freeze("switch", await lookupBatch(center, plan.batchId), [], errCode(e)); }
  report.batch = result;
  // 3. Center home leases under the new epoch; every attempted acquire is classified by its own receipt on failure.
  const epochs: Record<string, number> = {}, leases: string[] = [], sent: V2Command[] = [];
  try {
    for (const f of plan.featureIds) epochs[f] = (await center.snapshot(f)).feature.epoch;
    const workflows = new Map(manifest.workflows.map(w => [w.taskId, w.rev]));
    for (const t of manifest.tasks) {
      const command = parseCommand({ teamId: manifest.teamId, projectId: manifest.projectId, requestId: `${plan.batchId}.lease.${t.id}`,
        serviceGeneration: result.serviceGeneration, epoch: epochs[t.featureId], bootId: plan.homeBootId, type: "lease.acquire",
        payload: { taskId: t.id, expectedRev: t.rev, expectedSpecRev: t.specRev, expectedWorkflowRev: workflows.get(t.id) ?? 0,
          homeInstanceId: t.homeInstanceId } });
      sent.push(command);
      await center.command(command);
      leases.push(t.id);
    }
  } catch (e) {
    const receipts = await Promise.all(sent.map(async c => {
      try { return { requestId: c.requestId, lookup: await center.receipt({ requestId: c.requestId, operationId: execOperationId(c), commandDigest: v2ObjectDigest(c) }) }; }
      catch (err) { return { requestId: c.requestId, lookup: { status: "unreachable", error: errCode(err) } }; }
    }));
    return freeze("lease", await lookupBatch(center, plan.batchId), receipts, errCode(e));
  }
  // 4. Local mode follows the center: execution bound to the center feature and the epoch the leases were taken under.
  try {
    await writeSharedLedgerModes(Object.fromEntries(plan.featureIds.map(f => [f, { authorityMode: "execution" as const, sharedPlanning: true,
      centerExecution: { centerId: plan.centerId, teamId: manifest.teamId, projectId: manifest.projectId, centerFeatureId: f, epoch: epochs[f] } }])),
    root, ledgerPath);
  } catch (e) { return freeze("local_mode", result, leases, errCode(e)); }
  return done({ status: "switched", epochs, leases });
}

export interface ReverseOptions { root: string; batchId: string; featureIds: string[]; center: MigrationCenter; ledgerPath?: string; now?: () => number }
export interface ReverseOutcome { status: "exported"; directWriteBack: "refused"; centerAdvanced: boolean; export: string; report: string }
/** Reverse is never automatic: freeze the group locally (mode `migrating` revert), export the center views, write a reconciliation
 * report. The old local ledger is never written; when the center has commits past the batch it says so and stays refused. */
export async function exportForReverse(opts: ReverseOptions): Promise<ReverseOutcome> {
  const root = assertDrillRoot(opts.root), now = opts.now ?? Date.now, ledgerPath = opts.ledgerPath ?? join(root, "ledger.sqlite");
  const dir = batchDir(root, opts.batchId), pause = await pauseDispatch(root, ledgerPath);
  try {
    const modes = Object.fromEntries(opts.featureIds.map(f => [f, readSharedLedgerMode(f, root)]));
    await writeSharedLedgerModes(Object.fromEntries(opts.featureIds.map(f => [f,
      { ...modes[f], migrating: { batchId: opts.batchId, kind: "revert" as const } }])), root, ledgerPath);
    const batch = await opts.center.migration(opts.batchId);
    const baseline = batch.status === "committed" ? batch.result!.serverSeq : null;
    const views = await Promise.all(opts.featureIds.map(f => opts.center.snapshot(f)));
    const centerAdvanced = baseline === null || views.some(v => v.serverSeq > baseline);
    const inv = readLocalInventory(ledgerPath, opts.featureIds);
    const sources = new Map((batch.result?.mappings ?? []).filter(m => m.kind === "task").map(m => [m.id, m.sourceId]));
    const exportPath = writeRootJson(root, join(dir, "reverse-export.json"), { batchId: opts.batchId, exportedAt: now(), batch, views });
    const report = writeRootJson(root, join(dir, "reverse-report.json"), {
      batchId: opts.batchId, state: "frozen_pending_pm", directWriteBack: "refused", centerAdvanced, baselineServerSeq: baseline,
      centerServerSeq: views.map(v => ({ featureId: v.feature.id, serverSeq: v.serverSeq, epoch: v.feature.epoch })),
      tasks: views.flatMap(v => v.tasks.map(t => ({ centerTaskId: t.id, centerStage: t.stage, centerRev: t.rev,
        localTaskId: sources.get(t.id) ?? null, localStage: inv.tasks.find(l => l.id === sources.get(t.id))?.stage ?? null }))),
      note: centerAdvanced ? "中心已有迁移后的新提交：不能直接回写旧本机库，须 PM 核对后单独迁回" : "仅导出与核对；不提供自动回迁",
    });
    return { status: "exported", directWriteBack: "refused", centerAdvanced, export: exportPath, report };
  } finally { pause.release(); }
}
