/**
 * 维护执行器的状态机(独立进程,见 src/state-maintenance-runner.ts):领取请求 → 落屏障与恢复清单 → 停写者 → 两次停写确认
 * → 停写后重新清点并重核档位 / 根 / 身份 → STATE1 事务迁移(每个破坏性步骤前重扫写者)→ 自动比对 → 失败则持续停写下回滚当前数据
 * → 留存报告与 ledger 指针 → 校验或回滚成功才解除屏障、按原清单恢复。回滚失败保持屏障、写者不重启。
 * 每一步先落盘再进下一步;中断后 recoverRun 按 journal 续补偿。本模块不 import 台账与身份模块。tests/state-maintenance-executor.test.ts。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, inspectLayout } from "../floka-migration/state/layout.js";
import { migrateState, recoverState, rollbackState } from "../floka-migration/state/migrate.js";
import type { StateFs, StateMigrationOptions, StateReport } from "../floka-migration/state/types.js";
import { liftBarrier, raiseBarrier, readBarrier } from "./barrier.js";
import { diffIdentity, diffTree, identityInventory, treeInventory } from "./inventory.js";
import { ensureDir, maintPaths, runDir } from "./paths.js";
import { confirmStopped, writerProbe, type ProbeDeps } from "./probe.js";
import { scrub, sha256Hex, writeReport, REPORT_FORMAT, type ObserveReport } from "./report.js";
import {
  loadState, readJson, runPaths, saveState, takeExecutorLock, takeRequest, takenRequest, writeJson0600,
  type Comparison, type Manifest, type PreInventory, type RunRequest, type RunState,
} from "./run-store.js";
import { recordServices, restoreAll, stopAll, type ServiceDeps } from "./services.js";

interface RunNote { op: "state_maintenance_run"; runId: string; seq: number; result: string; reportRel: string; reportSha256: string; actor: string }

export interface ExecDeps {
  maintRoot: string;
  home: string;
  oldRoot: string;
  newRoot: string;
  fs: StateFs;
  probe: Omit<ProbeDeps, "canaryPath" | "recordedPids">;
  services: ServiceDeps;
  /** config 的 rename.state 原文 */
  readMode: () => string;
  baseline: () => Promise<string>;
  /** 写结果指针(生产:短命子进程打开即关台账);失败由它留待补记录 */
  writeNote: (n: RunNote) => Promise<{ ok: boolean; error?: string }>;
  /** 补记之前没落库的指针(幂等) */
  flushNotes: () => Promise<{ ok: boolean; error?: string }>;
  version: string;
  now: () => number;
  probeGapMs: number;
  restoreWaitMs: number;
  /** 测试注入崩溃点 */
  crashAt?: (point: string) => void;
}

export const rootsDigest = (oldRoot: string, newRoot: string): string => sha256Hex(`${oldRoot}\0${newRoot}`);
const REPORT_MAX_AGE_MS = 24 * 3600_000;
const STAGES = ["迁移前", "迁移后", "回滚前", "回滚后"] as const;

interface Run { d: ExecDeps; s: RunState; req: RunRequest; canary: string }

const save = (r: Run, phase?: RunState["phase"], note?: string): RunState => saveState(r.d.maintRoot, r.s, phase, note);
const cancelled = (r: Run): boolean => {
  try {
    readFileSync(runPaths(r.d.maintRoot, r.s.runId).cancel);
    return true;
  } catch {
    return false; // 没有取消标记
  }
};

function probeDeps(r: Run): ProbeDeps {
  const manifest = readJson<Manifest>(runPaths(r.d.maintRoot, r.s.runId).manifest);
  return { ...r.d.probe, canaryPath: r.canary, recordedPids: () => manifest?.sessions.pids ?? [] };
}

function migrationOpts(r: Run, txId: string): StateMigrationOptions {
  const journalDir = runDir(maintPaths(r.d.maintRoot).journals, r.s.runId);
  ensureDir(journalDir);
  return {
    mode: "on", oldRoot: r.d.oldRoot, newRoot: r.d.newRoot, home: r.d.home, fs: r.d.fs, journalDir, txId,
    writers: writerProbe(probeDeps(r), [r.d.oldRoot, r.d.newRoot]), crashAt: r.d.crashAt,
  };
}

/** 请求本身:未过期、根 / 基线 / 报告都和批准时一致、报告无冲突且不太旧、档位仍是 on */
async function requestProblem(d: ExecDeps, req: RunRequest): Promise<string | null> {
  if (d.now() > req.expiresAt) return "执行请求已过期,请重新批准";
  if (req.rootsDigest !== rootsDigest(d.oldRoot, d.newRoot)) return "状态根和批准时不一致,拒绝";
  if ((await d.baseline()) !== req.baseline) return "代码基线和批准时不一致,拒绝";
  if (d.readMode() !== "on") return "rename.state 不是 on,拒绝执行";
  let text: string;
  try {
    text = readFileSync(join(d.maintRoot, req.reportRel), "utf8");
  } catch {
    return "批准的报告读不到,拒绝"; // 报告没了就无从核对身份
  }
  if (sha256Hex(text) !== req.reportSha256) return "批准的报告已变,拒绝";
  const rep = JSON.parse(text) as ObserveReport;
  if (rep.conflicts.length) return "批准的报告有冲突,拒绝";
  if (d.now() - Date.parse(rep.createdAt) > REPORT_MAX_AGE_MS) return "批准的报告超过 24 小时,请重新预演";
  return null;
}

async function inventoryOf(d: ExecDeps): Promise<{ layout: string; data: string | null; inv: PreInventory | null }> {
  const layout = await inspectLayout(d.fs, d.oldRoot, d.newRoot);
  const data = dataRoot(layout, d.oldRoot, d.newRoot);
  if (!data) return { layout: layout.kind, data, inv: null };
  return { layout: layout.kind, data, inv: { identity: await identityInventory(d.fs, data), tree: await treeInventory(d.fs, data, true), layout: layout.kind } };
}

function compare(stage: string, base: PreInventory, cur: { layout: string; inv: PreInventory | null }, wantLayout: string): Comparison {
  if (!cur.inv) return { stage, executed: true, layout: cur.layout, note: "找不到数据根" };
  const identityDiff = diffIdentity(base.identity, cur.inv.identity);
  const treeDiff = diffTree(base.tree, cur.inv.tree);
  const note = cur.layout !== wantLayout ? `根形态是 ${cur.layout},应为 ${wantLayout}` : undefined;
  return { stage, executed: true, layout: cur.layout, identityDiff, treeDiff, ...(note ? { note } : {}) };
}

const passed = (c: Comparison): boolean => !c.note && !c.identityDiff?.length && !c.treeDiff?.length;

/** 停写后重新清点:档位、根形态、冲突、身份与批准报告一致;问题即拒绝 */
async function preInventory(r: Run): Promise<string | null> {
  const { d } = r;
  if (d.readMode() !== "on") return "停写后复核:rename.state 已不是 on";
  const cur = await inventoryOf(d);
  if (cur.layout !== "legacy" || !cur.inv) return `停写后复核:根形态是 ${cur.layout},不是待迁移的旧根`;
  if (cur.inv.identity.conflicts.length) return cur.inv.identity.conflicts.join(";");
  const rep = JSON.parse(readFileSync(join(d.maintRoot, r.req.reportRel), "utf8")) as ObserveReport;
  const want = (rep.identity?.items ?? []).filter((i) => i.required).map((i) => `${i.name}:${i.sha256}`).join(",");
  const got = cur.inv.identity.items.filter((i) => i.required).map((i) => `${i.name}:${i.sha256}`).join(",");
  if (want !== got) return "停写后的身份与批准的报告不一致,拒绝";
  writeJson0600(runPaths(d.maintRoot, r.s.runId).pre, cur.inv);
  r.s.comparisons = [{ stage: "迁移前", executed: true, layout: cur.layout, note: `身份 ${cur.inv.identity.items.length} 项、数据 ${cur.inv.tree.entries.length} 项` }];
  return null;
}

/** 还没动根就停下:恢复停过的写者、解除屏障 */
async function refuse(r: Run, error: string, outcome: "refused" | "cancelled" = "refused"): Promise<RunState> {
  r.s.error = scrub(error, r.d, r.d.maintRoot);
  r.s.outcome = outcome;
  return finish(r, outcome === "cancelled" ? "cancelled" : "refused");
}

/**
 * 留存 + 指针 + (成功 / 拒绝时)解除屏障并恢复;failed 保持屏障与停写。
 * 终态先记进 s.final 再进 recording;解除屏障之前先落 restoring——任一处崩溃,恢复按钮都能按落盘的阶段续做。
 * resume = 续做崩溃中断的同一次留存:沿用已固定的报告。否则是新结果(如 failed-holding 后恢复成功):
 * 旧报告与指针原样保留进 priorReports,新结果另写 run-<seq>.json 并记 seq 不同的指针。
 */
async function finish(r: Run, phase: RunState["phase"], resume = false): Promise<RunState> {
  const { d, s } = r;
  if (s.report && !resume) {
    s.priorReports = [...(s.priorReports ?? []), { ...s.report, note: s.note }];
    s.report = undefined;
    s.note = undefined;
    s.comparisons = s.comparisons.filter((c) => c.executed); // 上一版的「未执行」占位不带进新结果
  }
  s.final = phase;
  save(r, "recording"); // 归档旧版与进入 recording 同一次落盘:之后崩溃,续做的只会是新这一版
  if (!s.report) {
    // 报告只写一次:落盘的 rel + 哈希先记进状态再写指针;此前崩溃还没写过指针,重写无妨
    const seq = (s.priorReports?.length ?? 0) + 1;
    const supersedes = s.priorReports?.at(-1);
    const seen = new Set(s.comparisons.map((c) => c.stage));
    for (const stage of STAGES) if (!seen.has(stage)) s.comparisons.push({ stage, executed: false, note: "未执行" });
    s.report = {
      seq,
      ...writeReport(d.maintRoot, s.runId, seq === 1 ? "run" : `run-${seq}`, {
        format: REPORT_FORMAT, kind: "run", version: d.version, baseline: r.req.baseline, runId: s.runId, reportRunId: r.req.reportRunId, seq,
        ...(supersedes ? { supersedes: { rel: supersedes.rel, sha256: supersedes.sha256 } } : {}),
        outcome: s.outcome, error: s.error ?? null, comparisons: s.comparisons, phases: s.history,
      }),
    };
    save(r);
  }
  const rep = s.report;
  if (!reportIntact(d, rep)) s.note = { ok: false, error: "留存未完成:结果报告和首次落盘的哈希对不上,不重写、不补指针,需人工核查" };
  else if (!s.note) {
    // 指针可能已在崩溃前落库:同一 dedupKey(runId + op + seq)、同一报告哈希,重写即幂等复核
    s.note = await d.writeNote({ op: "state_maintenance_run", runId: s.runId, seq: rep.seq ?? 1, result: s.outcome ?? "unknown", reportRel: rep.rel, reportSha256: rep.sha256, actor: r.req.actor });
    save(r);
    d.crashAt?.("recording:after-note");
  } else if (!s.note.ok) s.note = await d.flushNotes(); // 崩溃前已写过(或留了待补):补记,不再写第二条
  if (s.outcome === "failed") return save(r, "failed-holding", "屏障保持、写者保持停止,等恢复按钮");
  save(r, "restoring");
  d.crashAt?.("restore:before-lift");
  liftBarrier(d.maintRoot, s.runId);
  return restoreWriters(r);
}

const reportIntact = (d: ExecDeps, rep: { rel: string; sha256: string }): boolean => {
  try {
    return sha256Hex(readFileSync(join(d.maintRoot, rep.rel), "utf8")) === rep.sha256;
  } catch {
    return false; // 读不到就当对不上
  }
};

/** 屏障已解除(或正要解除)后按原清单恢复写者;幂等(services.restoreAll 对照实际状态),异常记为恢复失败而不是卡住 */
async function restoreWriters(r: Run): Promise<RunState> {
  const { d, s } = r;
  const manifest = readJson<Manifest>(runPaths(d.maintRoot, s.runId).manifest);
  if (manifest && s.stopped.length) {
    try {
      s.restore = await restoreAll(d.services, manifest.services, manifest.sessions, s.stopped, d.restoreWaitMs);
    } catch (e) {
      s.restore = { ok: false, problems: [`恢复写者中断:${scrub((e as Error).message, d, d.maintRoot)}`] };
    }
  }
  return save(r, s.restore && !s.restore.ok ? "restore-failed" : (s.final ?? "done"));
}

/** 迁移后的核对;不通过就在持续停写下回滚当前数据 */
async function verifyOrRollback(r: Run): Promise<RunState> {
  const { d, s } = r;
  const pre = readJson<PreInventory>(runPaths(d.maintRoot, s.runId).pre);
  if (!pre) return fail(r, "迁移前清单丢失,无法核对,保持屏障");
  save(r, "verifying");
  const after = compare("迁移后", pre, await inventoryOf(d), "migrated");
  s.comparisons.push(after);
  if (passed(after)) return (s.outcome = "migrated"), finish(r, "done");
  return rollback(r, `迁移后核对没通过:${[after.note, ...(after.identityDiff ?? []), ...(after.treeDiff ?? [])].filter(Boolean).join(";")}`);
}

async function rollback(r: Run, why: string): Promise<RunState> {
  const { d, s } = r;
  s.error = scrub(why, d, d.maintRoot);
  s.rollbackAttempt += 1;
  save(r, "rolling-back");
  const before = await inventoryOf(d);
  if (!before.inv) return fail(r, "回滚前找不到数据根,保持屏障");
  s.comparisons.push({ stage: "回滚前", executed: true, layout: before.layout, note: `数据 ${before.inv.tree.entries.length} 项(回滚搬回的是这份当前数据)` });
  save(r);
  d.crashAt?.("rollback:start");
  const rep = await rollbackState(migrationOpts(r, `${s.runId}-rb${s.rollbackAttempt}`));
  return afterRollback(r, rep, before.inv);
}

async function afterRollback(r: Run, rep: StateReport, base: PreInventory): Promise<RunState> {
  const { d, s } = r;
  if (rep.status !== "committed") return fail(r, `回滚没完成:${scrub(rep.error ?? rep.status, d, d.maintRoot)}`);
  const c = compare("回滚后", base, await inventoryOf(d), "legacy");
  s.comparisons.push(c);
  if (!passed(c)) return fail(r, "回滚后核对没通过,保持屏障");
  s.outcome = "rolled-back";
  return finish(r, "done");
}

async function fail(r: Run, error: string): Promise<RunState> {
  r.s.error = [r.s.error, scrub(error, r.d, r.d.maintRoot)].filter(Boolean).join(";");
  r.s.outcome = "failed";
  return finish(r, "failed-holding");
}

/** STATE1 事务的结果分流:提交 → 核对;执行器已补偿回旧根 → 记回滚;补偿失败 / 中途拒绝且根被动过 → 保持屏障 */
async function afterMigrate(r: Run, rep: StateReport): Promise<RunState> {
  if (rep.status === "committed") return verifyOrRollback(r);
  const why = scrub([rep.error ?? rep.status, ...new Set(rep.steps.flatMap((x) => x.conflicts ?? []))].join(";"), r.d, r.d.maintRoot);
  const layout = (await inspectLayout(r.d.fs, r.d.oldRoot, r.d.newRoot)).kind;
  if (rep.status === "refused" && journalStatus(r.d, r.s.runId, rep.txId) === null && layout === "legacy") return refuse(r, `迁移被拒(没动根):${why}`);
  if (rep.status !== "rolled_back") return fail(r, `迁移中断或补偿失败:${why}`);
  const pre = readJson<PreInventory>(runPaths(r.d.maintRoot, r.s.runId).pre)!;
  r.s.comparisons.push({ stage: "迁移后", executed: true, layout, note: `迁移没完成,事务已补偿:${why}` });
  r.s.error = why;
  return afterRollback(r, { ...rep, status: "committed" }, pre);
}

async function stopAndProbe(r: Run): Promise<string | null> {
  const { d, s } = r;
  const services = await recordServices(d.services);
  if ("error" in services) return services.error;
  const sessions = await d.services.sessions.snapshot();
  if ("error" in sessions) return `会话快照失败:${sessions.error}`;
  writeJson0600(runPaths(d.maintRoot, s.runId).manifest, { services, sessions, recordedAt: d.now() } satisfies Manifest);
  raiseBarrier(d.maintRoot, { runId: s.runId, since: d.now(), reason: "状态根迁移维护" });
  d.crashAt?.("barrier");
  save(r, "stopping");
  const stopErr = await stopAll(d.services, services, sessions, s.stopped, () => void save(r));
  save(r);
  if (stopErr) return stopErr;
  if (cancelled(r)) return "cancel";
  save(r, "probing");
  const problems = await confirmStopped(probeDeps(r), [d.oldRoot, d.newRoot], d.probeGapMs);
  return problems.length ? `停写确认没通过:${problems.join(";")}` : null;
}

/** 新执行:维护页就绪(状态 ready)之后才会被拉起,才允许停服务 */
export async function executeRun(d: ExecDeps, runId: string): Promise<RunState> {
  const lock = takeExecutorLock(d.maintRoot);
  if ("error" in lock) throw new Error(lock.error);
  try {
    const s = loadState(d.maintRoot, runId);
    if (!s || s.phase !== "ready") throw new Error("维护页未就绪或这次运行已开始,拒绝重复执行");
    const req = takeRequest(d.maintRoot, runId);
    const r: Run = { d, s, req: req!, canary: lock.path };
    if (!req) return save({ ...r, s: { ...s, outcome: "refused", error: "请求不存在或已被领取" } }, "refused");
    const bad = await requestProblem(d, req);
    if (bad) return (s.outcome = "refused"), (s.error = bad), save(r, "refused");
    const stopErr = await stopAndProbe(r);
    if (stopErr) return refuse(r, stopErr === "cancel" ? "已取消(还没动状态根)" : stopErr, stopErr === "cancel" ? "cancelled" : "refused");
    save(r, "pre-inventory");
    const preErr = await preInventory(r);
    if (preErr) return refuse(r, preErr);
    if (cancelled(r)) return refuse(r, "已取消(还没动状态根)", "cancelled");
    save(r, "migrating");
    d.crashAt?.("migrate:start");
    return afterMigrate(r, await migrateState(migrationOpts(r, runId)));
  } finally {
    lock.release();
  }
}

function journalStatus(d: ExecDeps, runId: string, txId: string): string | null {
  const j = readJson<{ status?: string }>(join(runDir(maintPaths(d.maintRoot).journals, runId), `${txId}.journal.json`));
  return j ? String(j.status) : null;
}

/** 中断恢复的分流:先撤未完成的回滚,再按迁移事务的日志补偿或核对 */
async function recoverMigration(r: Run): Promise<RunState> {
  const { d, s } = r;
  const problems = await confirmStopped(probeDeps(r), [d.oldRoot, d.newRoot], d.probeGapMs);
  if (problems.length) return fail(r, `恢复前停写确认没通过:${problems.join(";")}`);
  const rb = s.rollbackAttempt ? `${s.runId}-rb${s.rollbackAttempt}` : null;
  const rbStatus = rb ? journalStatus(d, s.runId, rb) : null;
  if (rb && rbStatus === "committed") {
    const base = readJson<PreInventory>(runPaths(d.maintRoot, s.runId).pre)!;
    return afterRollback(r, { txId: rb, mode: "on", status: "committed", steps: [], layout: "unchecked" }, base);
  }
  if (rb && rbStatus) {
    const undo = await recoverState(migrationOpts(r, rb), "rollback");
    if (undo.status !== "rolled_back") return fail(r, `撤销未完成的回滚失败:${scrub(undo.error ?? undo.status, d, d.maintRoot)}`);
  }
  const mig = journalStatus(d, s.runId, s.runId);
  if (mig === null) return refuse(r, "执行器中断时还没开始迁移,已恢复写者");
  if (mig !== "committed") {
    save(r, "rolling-back");
    const undo = await recoverState(migrationOpts(r, s.runId), "migrate");
    return afterMigrate(r, undo.status === "rolled_back" ? undo : { ...undo, status: "rollback_failed" });
  }
  return verifyOrRollback(r);
}

/** 恢复按钮:续补偿 / 续核对 / 补指针 / 重试恢复写者。原请求与事务都要对得上 */
export async function recoverRun(d: ExecDeps, runId: string): Promise<RunState> {
  const lock = takeExecutorLock(d.maintRoot);
  if ("error" in lock) throw new Error(lock.error);
  try {
    const s = loadState(d.maintRoot, runId);
    const req = takenRequest(d.maintRoot, runId);
    if (!s || !req) throw new Error("没有这次运行的已领取请求,无从恢复");
    const r: Run = { d, s, req, canary: lock.path };
    const barrier = readBarrier(d.maintRoot);
    if (barrier && (barrier === "corrupt" || barrier.runId !== runId)) throw new Error("屏障不属于这次运行,拒绝");
    save(r, s.phase, "recover");
    if (s.phase === "restore-failed" || s.phase === "restoring") {
      // 只有核对 / 回滚已成功或没动根时才会进 restoring:屏障解除前后崩溃都按原清单续恢复
      liftBarrier(d.maintRoot, runId);
      s.restore = undefined;
      return restoreWriters(r);
    }
    if (s.phase === "recording") {
      if (!barrier) throw new Error("留存阶段屏障却已不在,需人工核查");
      return finish(r, s.final ?? (s.outcome === "failed" ? "failed-holding" : "done"), true);
    }
    if (s.phase === "done" || s.phase === "refused" || s.phase === "cancelled") {
      if (s.note && !s.note.ok) s.note = await d.flushNotes();
      return save(r);
    }
    if (!barrier && (s.phase === "starting" || s.phase === "ready") && !s.stopped.length) {
      return refuse(r, "执行器在落屏障前中断,没停任何写者、没动根"); // 恢复清单已记、屏障还没落时崩溃
    }
    if (!barrier) throw new Error("屏障已解除却停在中间状态,需人工核查");
    if (["starting", "ready", "stopping", "probing", "pre-inventory"].includes(s.phase) && !journalStatus(d, runId, runId)) {
      return refuse(r, "执行器中断时还没开始迁移,已恢复写者");
    }
    return recoverMigration(r);
  } finally {
    lock.release();
  }
}
