/** X13 · whole-group execution migration and batch-receipt reconciliation (design shared-ledger-v2.md §1 :39/:44, §2 X13, §5).
 * The group is every member (本机 / peer A / peer B); each step runs on every member and is confirmed by reading the member's
 * persisted state back before the next step starts.
 * preflight: pause dispatch on every member (scheduler maintenance lease) → backup each → in-flight list across the group; any
 * unreconciled unknown refuses. mapping: one-to-one source ↔ center ids, manifest stages equal the source's, spec copies and review
 * evidence complete (required by the source's own review facts, bound to the center's review artifact), old lend orders settled or
 * imported with their lease (leaseGen + head) checked on both sides; nothing is re-sent. switch: durable write gate (mode
 * `migrating`) confirmed on every member → one center batch flips the whole group to execution → center home leases → execution
 * mode confirmed on every member. Any failure reads the batch receipt, keeps the gates closed (old authority is never restored)
 * and freezes the whole group for PM. Reverse never writes back: freeze → export → report.
 * Drill only (isolated temp root + center adapter); a formal migration needs X15 and owner authorization (out of scope).
 */
import {
  parseCommand, parseMigrationManifest, V2ContractError, v2ManifestDigest, v2ObjectDigest,
  type V2Command, type V2MigrationManifest, type V2Receipt,
} from "./shared-ledger-contract-v2.js";
import type { Stage2Transport } from "./shared-ledger-v2-transport.js";
import { execOperationId } from "./shared-ledger-exec-client.js";
import type { SharedLedgerMode } from "./shared-ledger-mode.js";
import {
  assertDrillRoot, batchDir, fileMember, MigrationRefused, sha256File, underRoot, writeRootJson,
  type LocalInventory, type MemberPort, type MigrationFinding, type MigrationMemberSpec,
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
  /** The whole group: 本机 (the manifest's source instance) and every peer, each an isolated state dir under the drill root.
   * versionVerified = S2K2 + CTATT1 checked; the drill records it, a formal migration would require it. */
  members: MigrationMemberSpec[];
  /** Unknown intents / lend orders reconciled by hand before migrating, per member; anything unknown and not listed refuses. */
  reconciled?: { instanceId: string; kind: "intent" | "lend"; id: string; outcome: string }[];
  /** Every lend order still pooled / claimed: settle it first, or import it with the lease it is checked against. */
  orders?: Record<string, { disposition: "import"; leaseGen: number; head: string }>;
  /** Review evidence per center task id: report path relative to the drill root plus its sha256. */
  reviews?: Record<string, { reportPath: string; digest: string }>;
}
export interface MigrationOptions {
  root: string; plan: MigrationPlan; center: MigrationCenter; mode: "dry-run" | "commit";
  /** Defaults to `fileMember` over `plan.members`; a drill may wrap a port to inject a member failure. */
  members?: MemberPort[]; now?: () => number; pauseWaitMs?: number;
}
type Step = "write_gate" | "switch" | "lease" | "local_mode";
type MemberAck = { label: string; instanceId: string; gate: "confirmed" | "failed" | null; execution: "confirmed" | "failed" | null };
export type MigrationOutcome =
  | { status: "refused"; findings: MigrationFinding[]; report: string }
  | { status: "dry-run"; manifestDigest: string; batch: unknown; report: string }
  | { status: "switched"; epochs: Record<string, number>; leases: string[]; members: MemberAck[]; report: string }
  | { status: "frozen"; step: Step; batch: unknown; receipts: unknown[]; members: MemberAck[]; report: string };

type Draft = MigrationOutcome extends infer O ? O extends MigrationOutcome ? Omit<O, "report"> : never : never;
type Done = (o: Draft) => MigrationOutcome;
const REVIEWED = new Set(["review", "fix", "merge", "live", "verified", "done"]);
const errCode = (e: unknown): string => e instanceof V2ContractError ? e.code : e instanceof Error ? e.message : String(e);
const LIVE_LEND = ["pooled", "claimed"];

interface MemberState { port: MemberPort; inv: LocalInventory; modes: Record<string, SharedLedgerMode> }
/** Pure checks over every member's inventory and the plan; returns every finding instead of stopping at the first. */
function migrationFindings(root: string, plan: MigrationPlan, group: MemberState[]): MigrationFinding[] {
  const out: MigrationFinding[] = [], add = (code: string, item: string, detail: string) => out.push({ code, item, detail });
  const m = plan.manifest, reconciled = new Set((plan.reconciled ?? []).map(r => `${r.instanceId}:${r.kind}:${r.id}`));
  const ids = new Set(group.map(g => g.port.instanceId)), source = group.find(g => g.port.instanceId === m.sourceInstanceId);
  if (!source) add("member_missing", m.sourceInstanceId, "清单的源实例不在本组成员里");
  for (const t of m.tasks) if (!ids.has(t.homeInstanceId)) add("member_missing", `${t.homeInstanceId}:${t.id}`, "卡的主场实例不在本组成员里");
  const mapped = (kind: string) => new Map(m.mappings.filter(x => x.kind === kind).map(x => [x.sourceId, x.id]));
  const tasks = mapped("task"), orders = mapped("order"), centerTasks = new Map(m.tasks.map(t => [t.id, t]));
  for (const f of plan.featureIds) {
    const center = plan.centerFeatureIds?.[f] ?? f;
    if (center !== f) add("feature_id_mismatch", f, `本机 feature id 与中心 ${center} 不同，X7 执行闸按中心 id 读模式，拒绝切换`);
  }
  const sourceOrders = new Map((source?.inv.orders ?? []).map(o => [o.orderId, o]));
  for (const { port, inv, modes } of group) {
    const who = port.instanceId;
    for (const f of plan.featureIds) {
      const mode = modes[f];
      if (mode.migrating) add("already_migrating", `${who}/${f}`, `${port.label} 已在批次 ${mode.migrating.batchId} 中`);
      else if (mode.authorityMode !== m.authorityFrom) add("authority_mismatch", `${who}/${f}`, `${port.label} ${mode.authorityMode}，清单 ${m.authorityFrom}`);
    }
    for (const i of inv.inflight) {
      const item = `${who}:${i.kind}:${i.id}`;
      if (i.status === "unknown") { if (!reconciled.has(item)) add("unknown_unreconciled", item, `${port.label} 卡 ${i.taskId} 未核清`); }
      else if (i.kind === "worker") add("worker_live", item, `${port.label} 卡 ${i.taskId} 执行者 ${i.status}，先停或结清`);
      else if (i.kind === "intent") add("intent_inflight", item, `${port.label} 卡 ${i.taskId} 意图 ${i.status}，先结清`);
    }
    if (port === source?.port) continue;
    // A peer owns no card of the group except the center's own (projections); its live lend rows are the same imported orders.
    for (const t of inv.tasks) if (!centerTasks.has(t.id)) add("member_task_unmapped", `${who}:${t.id}`, `${port.label} 的本组卡不在源实例映射里`);
    for (const o of inv.orders.filter(o => LIVE_LEND.includes(o.status))) {
      const want = plan.orders?.[o.orderId], home = sourceOrders.get(o.orderId);
      if (!want || !home) add("lend_unsettled", `${who}:${o.orderId}`, `${port.label} 出借单 ${o.status}：先结清或随源实例显式导入`);
      else if (o.leaseGen !== want.leaseGen || o.head !== want.head) add("lend_lease_mismatch", `${who}:${o.orderId}`, `${port.label} 侧租约 gen ${o.leaseGen} 与导入声明不符`);
    }
  }
  if (!source) return out;
  const local = new Map(source.inv.tasks.map(t => [t.id, t])), seen = new Set<string>(), sourceOf = new Map<string, string>();
  for (const t of source.inv.tasks) {
    const id = tasks.get(t.id), center = id ? centerTasks.get(id) : undefined;
    if (!id || !center) { add("mapping_missing", t.id, "本机卡没有一一对应的中心卡"); continue; }
    if (seen.has(id)) add("mapping_not_one_to_one", t.id, `中心卡 ${id} 被多张本机卡映射`);
    seen.add(id); sourceOf.set(id, t.id);
    if (center.stage !== t.stage) add("stage_mismatch", t.id, `清单 stage ${center.stage} 与源卡 ${t.stage} 不符`);
  }
  for (const [s] of tasks) if (!local.has(s)) add("mapping_unknown_source", s, "映射的本机卡不在本组");
  for (const t of m.tasks) {
    const art = m.artifacts.find(a => a.artifactId === t.spec.artifactId);
    if (t.spec.visibility !== "approved_copy" || !art || art.kind !== "spec") add("spec_copy_missing", t.id, "缺获准规格副本");
    // Whether review evidence is due follows the source card's own facts, not only the stage the manifest claims.
    const src = local.get(sourceOf.get(t.id) ?? ""), review = plan.reviews?.[t.id];
    if (!(src?.reviewed || REVIEWED.has(src?.stage ?? "") || REVIEWED.has(t.stage) || t.review.reportArtifactId !== null || review)) continue;
    if (!review) { add("review_evidence_missing", t.id, "缺审查报告路径与哈希"); continue; }
    if (isAbsolute(review.reportPath) || !existsSync(underRoot(root, review.reportPath))) { add("review_evidence_missing", t.id, "报告不在演练根目录内"); continue; }
    if (sha256File(underRoot(root, review.reportPath)) !== review.digest) { add("review_evidence_digest", t.id, "报告哈希不符"); continue; }
    const bound = m.artifacts.find(a => a.artifactId === t.review.reportArtifactId);
    if (!bound || bound.taskId !== t.id || !["review", "report"].includes(bound.kind) || bound.originalDigest !== review.digest) {
      add("review_evidence_unbound", t.id, "审查报告没绑到中心卡的审查证据（reportArtifactId / originalDigest）");
    }
  }
  for (const o of source.inv.orders.filter(o => LIVE_LEND.includes(o.status))) {
    const want = plan.orders?.[o.orderId], central = m.lendOrders.find(c => c.orderId === orders.get(o.orderId));
    if (!ids.has(o.peer)) add("member_missing", `${o.peer}:${o.orderId}`, "在途出借单的借方不在本组成员里");
    if (!want) add("lend_unsettled", o.orderId, `出借单 ${o.status}（${o.peer}）：先结清或显式导入`);
    else if (!central) add("lend_import_unmapped", o.orderId, "导入的出借单在清单里没有对应中心订单");
    else if (want.leaseGen !== o.leaseGen || want.head !== o.head || central.leaseGen !== o.leaseGen || central.head !== o.head) {
      add("lend_lease_mismatch", o.orderId, `租约核对不符：本机 gen ${o.leaseGen}/${o.head.slice(0, 8)}`);
    }
  }
  for (const c of m.lendOrders) if (LIVE_LEND.includes(c.status)
    && !source.inv.orders.some(o => orders.get(o.orderId) === c.orderId && plan.orders?.[o.orderId])) add("lend_not_declared", c.orderId, "清单里的在途订单没有显式导入声明");
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

function memberPorts(root: string, specs: MigrationMemberSpec[] | undefined): MemberPort[] | MigrationFinding {
  const list = specs ?? [];
  if (!list.length || new Set(list.map(m => m.instanceId)).size !== list.length || new Set(list.map(m => m.dir)).size !== list.length) {
    return { code: "members_invalid", item: "members", detail: "本组成员为空或 instanceId / 目录重复" };
  }
  return list.map(m => fileMember(root, m));
}
/** Pauses every member's dispatch; one refusal releases the members already paused and refuses the whole group. */
async function pauseGroup(ports: MemberPort[], waitMs?: number): Promise<{ release(): void }> {
  const held: { release(): void }[] = [];
  const release = () => { for (const h of held.splice(0).reverse()) h.release(); };
  for (const p of ports) {
    try { held.push(await p.pause(waitMs)); } catch (e) {
      release();
      if (e instanceof MigrationRefused) throw new MigrationRefused(e.findings.map(f => ({ ...f, item: `${p.instanceId}:${f.item}`, detail: `${p.label} ${f.detail}` })));
      throw e;
    }
  }
  return { release };
}

export async function runExecutionMigration(opts: MigrationOptions): Promise<MigrationOutcome> {
  const root = assertDrillRoot(opts.root), plan = opts.plan, now = opts.now ?? Date.now;
  const dir = batchDir(root, plan.batchId), reportPath = join(dir, `${opts.mode}-report.json`);
  const report: Record<string, unknown> = { batchId: plan.batchId, mode: opts.mode, featureIds: plan.featureIds, startedAt: now(),
    notMigrated: ["scheduler_sessions", "process locks"],
    versions: (plan.members ?? []).length === 3 && plan.members.every(m => m.versionVerified) ? "verified" : "unverified (drill only)" };
  const done: Done = o => {
    writeRootJson(root, reportPath, { ...report, outcome: o, finishedAt: now() });
    return { ...o, report: reportPath };
  };
  try { return await migrateGroup(root, opts, report, done); }
  catch (e) { if (e instanceof MigrationRefused) return done({ status: "refused", findings: e.findings }); throw e; }
}

/** Every refusal below (a member's paused lock, an existing backup, a path escaping the drill root) reaches the caller as an
 * itemized `refused`; nothing has been sent to the center or gated locally before the findings come back empty. */
async function migrateGroup(root: string, opts: MigrationOptions, report: Record<string, unknown>, done: Done): Promise<MigrationOutcome> {
  const plan = opts.plan, now = opts.now ?? Date.now;
  const ports = opts.members ?? memberPorts(root, plan.members);
  if (!Array.isArray(ports)) return done({ status: "refused", findings: [ports] });
  const pause = await pauseGroup(ports, opts.pauseWaitMs);
  try {
    // Each run backs up into its own directory (a re-run never overwrites an earlier backup).
    let n = 1;
    while (existsSync(join(batchDir(root, plan.batchId), `${opts.mode}-backup${n > 1 ? `-${n}` : ""}`))) n++;
    const backupDir = join("shared-ledger-v2-migration", plan.batchId, `${opts.mode}-backup${n > 1 ? `-${n}` : ""}`);
    const members = ports.map(p => ({ label: p.label, instanceId: p.instanceId, versionVerified: p.versionVerified, dispatchPaused: true,
      backup: p.backup(join(backupDir, p.instanceId)), inflight: [] as unknown[] }));
    report.members = members;
    const homeTasks = ports.find(p => p.instanceId === plan.manifest.sourceInstanceId)?.inventory(plan.featureIds).tasks.map(t => t.id) ?? [];
    const group = ports.map(port => ({ port, inv: port.inventory(plan.featureIds, homeTasks), modes: port.modes(plan.featureIds) }));
    group.forEach((g, i) => { members[i]!.inflight = g.inv.inflight; });
    Object.assign(report, { dispatchPaused: true, reconciled: plan.reconciled ?? [] });
    const findings = migrationFindings(root, plan, group);
    if (findings.length) return done({ status: "refused", findings });
    let manifest: V2MigrationManifest;
    try { manifest = buildManifest(plan, Object.keys(plan.orders ?? {}).length > 0, now()); }
    catch (e) { return done({ status: "refused", findings: [{ code: "manifest_invalid", item: plan.batchId, detail: errCode(e) }] }); }
    report.manifestDigest = manifest.manifestDigest;
    if (opts.mode === "dry-run") return await dryRun(opts.center, manifest, done);
    return await commit(root, plan, manifest, opts.center, group, report, done);
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

/** Writes `next(mode)` on every member, then reads each member back; the step is confirmed only when every member shows it. */
async function confirmEach(group: MemberState[], acks: MemberAck[], key: "gate" | "execution", featureIds: string[],
  next: (m: SharedLedgerMode, f: string) => SharedLedgerMode, holds: (m: SharedLedgerMode, f: string) => boolean): Promise<string | null> {
  for (const [i, { port }] of group.entries()) {
    try {
      const cur = port.modes(featureIds);
      await port.writeModes(Object.fromEntries(featureIds.map(f => [f, next(cur[f]!, f)])));
      const back = port.modes(featureIds);
      if (!featureIds.every(f => holds(back[f]!, f))) throw new Error(`${port.label} 回读未确认`);
      acks[i]![key] = "confirmed";
    } catch (e) { acks[i]![key] = "failed"; return `${port.instanceId}: ${errCode(e)}`; }
  }
  return null;
}

async function commit(root: string, plan: MigrationPlan, manifest: V2MigrationManifest, center: MigrationCenter, group: MemberState[],
  report: Record<string, unknown>, done: Done): Promise<MigrationOutcome> {
  const acks: MemberAck[] = group.map(g => ({ label: g.port.label, instanceId: g.port.instanceId, gate: null, execution: null }));
  report.acks = acks;
  const freeze = (step: Step, batch: unknown, receipts: unknown[], reason: string) => {
    writeRootJson(root, join(batchDir(root, plan.batchId), "frozen.json"), {
      batchId: plan.batchId, state: "frozen_pending_pm", step, reason, batch, receipts, members: acks,
      note: "全组写门保持关闭，不恢复旧权威；PM 按 batch / 回执与成员确认核对后另行处理",
    });
    return done({ status: "frozen", step, batch, receipts, members: acks });
  };
  // 1. Durable write gate on every member: from here on local writes to the group's cards are refused (X7), and nothing reopens
  // them. The center batch is sent only after every member confirmed its gate.
  const gate = { batchId: plan.batchId, kind: "execute" as const };
  const gateFail = await confirmEach(group, acks, "gate", plan.featureIds, m => ({ ...m, migrating: gate }),
    m => m.migrating?.batchId === gate.batchId && m.migrating.kind === gate.kind);
  if (gateFail) return freeze("write_gate", await lookupBatch(center, plan.batchId), [], gateFail);
  report.writeGate = "confirmed on every member";
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
  // 4. Every member's mode follows the center: execution bound to the center feature and the epoch the leases were taken under.
  // Success is reported only when every member confirmed it; a member left behind keeps its closed gate and the group freezes.
  const exec = (f: string): SharedLedgerMode => ({ authorityMode: "execution", sharedPlanning: true,
    centerExecution: { centerId: plan.centerId, teamId: manifest.teamId, projectId: manifest.projectId, centerFeatureId: f, epoch: epochs[f]! } });
  const execFail = await confirmEach(group, acks, "execution", plan.featureIds, (_m, f) => exec(f),
    (m, f) => m.authorityMode === "execution" && !m.migrating && m.centerExecution?.epoch === epochs[f] && m.centerExecution.centerFeatureId === f);
  if (execFail) return freeze("local_mode", result, leases, execFail);
  return done({ status: "switched", epochs, leases, members: acks });
}

export interface ReverseOptions {
  root: string; batchId: string; featureIds: string[]; center: MigrationCenter;
  members: MigrationMemberSpec[] | MemberPort[]; now?: () => number;
}
export interface ReverseOutcome { status: "exported"; directWriteBack: "refused"; centerAdvanced: boolean; export: string; report: string }
/** Reverse is never automatic: freeze every member (mode `migrating` revert), export the center views, write a reconciliation
 * report. No member's old ledger is ever written; when the center has commits past the batch it says so and stays refused. */
export async function exportForReverse(opts: ReverseOptions): Promise<ReverseOutcome> {
  const root = assertDrillRoot(opts.root), now = opts.now ?? Date.now, dir = batchDir(root, opts.batchId);
  const ports = opts.members.map(m => "pause" in m ? m : fileMember(root, m));
  if (!ports.length) throw new Error("reverse needs the group's members");
  const pause = await pauseGroup(ports);
  try {
    for (const p of ports) {
      const modes = p.modes(opts.featureIds);
      await p.writeModes(Object.fromEntries(opts.featureIds.map(f => [f, { ...modes[f]!, migrating: { batchId: opts.batchId, kind: "revert" as const } }])));
    }
    const batch = await opts.center.migration(opts.batchId);
    const baseline = batch.status === "committed" ? batch.result!.serverSeq : null;
    const views = await Promise.all(opts.featureIds.map(f => opts.center.snapshot(f)));
    const centerAdvanced = baseline === null || views.some(v => v.serverSeq > baseline);
    const taskMaps = (batch.result?.mappings ?? []).filter(m => m.kind === "task");
    const home = ports.find(p => p.instanceId === taskMaps[0]?.sourceInstanceId) ?? ports[0]!;
    const inv = home.inventory(opts.featureIds), sources = new Map(taskMaps.map(m => [m.id, m.sourceId]));
    const exportPath = writeRootJson(root, join(dir, "reverse-export.json"), { batchId: opts.batchId, exportedAt: now(), batch, views });
    const report = writeRootJson(root, join(dir, "reverse-report.json"), {
      batchId: opts.batchId, state: "frozen_pending_pm", directWriteBack: "refused", centerAdvanced, baselineServerSeq: baseline,
      members: ports.map(p => ({ label: p.label, instanceId: p.instanceId, frozen: opts.featureIds.every(f => p.modes([f])[f]!.migrating?.kind === "revert") })),
      centerServerSeq: views.map(v => ({ featureId: v.feature.id, serverSeq: v.serverSeq, epoch: v.feature.epoch })),
      tasks: views.flatMap(v => v.tasks.map(t => ({ centerTaskId: t.id, centerStage: t.stage, centerRev: t.rev,
        localTaskId: sources.get(t.id) ?? null, localStage: inv.tasks.find(l => l.id === sources.get(t.id))?.stage ?? null }))),
      note: centerAdvanced ? "中心已有迁移后的新提交：不能直接回写旧本机库，须 PM 核对后单独迁回" : "仅导出与核对；不提供自动回迁",
    });
    return { status: "exported", directWriteBack: "refused", centerAdvanced, export: exportPath, report };
  } finally { pause.release(); }
}
