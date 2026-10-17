/**
 * 中心副本自动开卡的调度侧（merge-arch-CREPAUTO1）。on：openCard 的预检先经 centerPreflight（start_node 同一条「中心认领 → 预检」路径：
 * 没认领的新认领，已有 committed 认领的只核对后补建卡，不再认领）；中心拒绝就记 note / 冷却，不写台账 claim、不烧 arm。
 * observe：每轮把「放行后本会开」的节点各记一条 recovery_observe，不碰中心、不建卡。台账写一律走调度身份 CLI（center-replica-autostart-ledger.ts）。
 * runStart 失败后的孤儿标记由 openCard 调 centerStartFailed（与 start_node 一致）。tests/center-replica-autostart.test.ts。
 */
import type { Preflight, StartEnv } from "./dag-tools-start.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { centerClaimAction, centerReplicaMember, centerReplicaMode, coolCenterNode, isCenterReplica } from "./center-replica-autostart.js";
import { activeFeatures, currentViews, featureGateRest, isStop, nodeCandidate, type Candidate } from "./scheduler-autostart.js";
import type { StartTickEnv } from "./scheduler-autostart-run.js";
import { localAuthorRuntime } from "./scheduler-local-runtime.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { schedulerV2SkipFeature } from "./scheduler-v2-skip.js";
import { CENTER_START_TEXT, centerPreflight } from "./shared-ledger-center-start.js";
import { pickRepo } from "./shared-ledger-gate-repo.js";

type Failed = { taskId: string; error: string }[];
type Env = Pick<StartTickEnv, "db" | "ledger" | "now">;

/** 一时的拒绝（中心不可达、本机认领锁忙、认领文件读写失败）：冷却后再试；其余（冲突、已被别人绑、版本变了、无权…）记 note，同版本同规格不再试 */
const TRANSIENT: readonly string[] = [CENTER_START_TEXT.unreachable, CENTER_START_TEXT.busy, CENTER_START_TEXT.claims, CENTER_START_TEXT.local];

async function centerRefused(env: Env, cand: Candidate, code: string, error: string, failed: Failed): Promise<void> {
  if (TRANSIENT.includes(error)) return coolCenterNode(cand.f.id, cand.key, env.now());
  const r = await env.ledger("ledger", "scheduler-autostart", "center-replica", cand.f.id, cand.key, "--mode", "skip", "--text", error,
    "--extra", JSON.stringify({ code, arm: cand.arm, taskId: cand.taskId }));
  if (r.ok !== true) {
    coolCenterNode(cand.f.id, cand.key, env.now()); // note not written: at least keep the node from taking every tick's single start
    failed.push({ taskId: `${cand.f.id}/${cand.key}`, error: `中心拒绝认领的 note 没写进去：${String(r.error ?? r.code ?? "")}` });
  }
}

/**
 * openCard 的预检：非中心副本原样 run()。副本先在中心认领（或核对已有认领），过了才跑原预检；centerPreflight 自己处理「认领后卡号被占 → 孤儿」。
 * 返回 null = 中心这一步拒了（已记 note 或冷却），本轮不写台账 claim。
 */
export async function centerReplicaPreflight(env: Env, cand: Candidate, run: () => Promise<Preflight>, failed: Failed): Promise<Preflight | null> {
  if (!isCenterReplica(cand.f.id)) return run();
  let ran = false;
  const pre = await centerPreflight(env.db, cand.f, cand.key, { featureId: cand.f.id, key: cand.key, taskId: cand.taskId }, () => { ran = true; return run(); });
  if (ran || pre.ok) return pre;
  await centerRefused(env, cand, pre.code, pre.error, failed);
  return null;
}

/** 本会放哪：生产放置函数只读地算一遍（与开卡同一个；私仓 / 预留的观察都只在真开卡或进程日志里留痕） */
async function wouldPlace(env: StartTickEnv, cand: Candidate): Promise<string> {
  const se = env.startEnv();
  if (!se.placement) return "本机（这台没接槽池放置）";
  try {
    const repo = await pickRepo({ ...se, db: env.db, caller: "" } as StartEnv, cand.f.project, undefined);
    if (!repo) return "开不了：项目没有 git 目录";
    const p = await se.placement(env.db, { project: cand.f.project, repoDir: repo, fileGlobs: cand.fileGlobs, want: "auto", card: cand.taskId });
    return p.where === "peer" ? `peer:${p.peer}` : p.where === "local" ? `本机（${localAuthorRuntime(cand.f.project)}）` : `等：${p.reason}`;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `算放置出错：${(e as Error).message}`;
  }
}

/** 本进程写成过的 observe 样本（台账另按 dedup 只留一条）：不用每轮为同一节点重算放置 */
const observed = new Set<string>();

/** observe：开关 observe 的项目里，副本 feature 按放行后的门逐节点算，本会开的各记一条样本 */
export async function centerReplicaObserveTick(env: StartTickEnv, failed: Failed): Promise<void> {
  for (const project of [...env.svc.projects].sort()) {
    if (centerReplicaMode(project) !== "observe") continue;
    for (const f of activeFeatures(env.db, project)) {
      if (schedulerV2SkipFeature(env.db, f.id)) continue; // S2D2: no local card work for a migrating / execution feature
      if (!isCenterReplica(f.id) || !centerReplicaMember(f.id) || featureGateRest(env.db, f, env.svc)) continue;
      const views = currentViews(env.db, f), lanes = featureLanes(env.db, f);
      for (const key of lanes?.startNow ?? []) {
        const r = nodeCandidate(env.db, f, key, lanes, views, (id) => env.readSpec(id), env.now());
        const mark = JSON.stringify([env.db.filename, f.id, key, isStop(r) ? "" : r.arm]);
        if (isStop(r) || observed.has(mark)) continue;
        const action = centerClaimAction(f.id, key), where = await wouldPlace(env, r);
        const text = `${action === "repair" ? "按已有中心认领补建卡" : "在中心认领并开卡"} ${r.taskId}（节点 ${f.id}/${key}），放 ${where}`;
        const w = await env.ledger("ledger", "scheduler-autostart", "center-replica", f.id, key, "--mode", "observe", "--dedup", `${key}:${r.arm}`, "--text", text,
          "--extra", JSON.stringify({ action, taskId: r.taskId, placement: where, version: f.currentVersion, arm: r.arm }));
        if (w.ok === true) observed.add(mark);
        else failed.push({ taskId: `${f.id}/${key}`, error: `中心副本 observe 样本没写进去：${String(w.error ?? w.code ?? "")}` });
      }
    }
  }
}
