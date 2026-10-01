/**
 * 自动开卡（i28-A1 §3）调度侧：每轮在 auto tick 之后最多开一张卡，复用 start_node 的 preflightStart / runStart，不改它们。
 * 顺序：先对账断掉留下的 claim（已绑 → done；否则 unknown 并通知 PM 一次，不重开；本进程正在开的跳过）→ 选候选（scheduler-autostart.ts）→
 * 额度门 → 重读规格卡 → 台账 claim（事务里重核全部台账门，同一 arm 只一条）→ preflight → 再读规格卡 → runStart → settle。runStart 发出的台账写一律改写成
 * `ledger scheduler-autostart step <claim> …` 以调度身份执行；create / kill 走带租约、不带调度身份的 manager，且只许本 claim 的 agent；
 * 别的 manager 调用适配器直接抛错，这一步失败、进入回滚。失败只通知 PM 一条，同一 arm 不再重试；开卡成功不通知。
 * tests/scheduler-autostart-run.test.ts。
 */
import type { Database } from "bun:sqlite";
import { preflightStart, type StartEnv, type StartPlan } from "./dag-tools-start.js";
import { runStart, type StepIO } from "./dag-tools-steps.js";
import type { InventoryQuota } from "./ai-quota.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { openClaims, type AutostartClaim } from "./ledger-autostart-grant.js";
import { getFeature } from "./ledger-feature.js";
import { getTask } from "./ledger-store.js";
import {
  activeFeatures, projectPm, armOf, currentViews, featureGate, isStop, nodeCandidate, quotaOver, readSwitch, specGate, templateLabel, weeklyLine,
  type Candidate, type ServiceFacts, type SpecFile,
} from "./scheduler-autostart.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { TickPace } from "./scheduler-yield.js";

type Ledger = (...args: string[]) => Promise<Record<string, unknown>>;
type Failed = { taskId: string; error: string }[];

export interface StartTickEnv {
  db: Database;
  svc: ServiceFacts;
  /** 调度身份的 ledger CLI（已套租约守卫） */
  ledger: Ledger;
  /** 不带调度身份、带租约的 manager：只用来 create / kill 本 claim 的 agent */
  plain(args: string[], timeoutMs?: number): Promise<any>;
  startEnv(): Omit<StartEnv, "db" | "caller">;
  stepIO(): Omit<StepIO, "db" | "manager" | "attempt">;
  readSpec(taskId: string): SpecFile | null;
  /** Claude 的额度快照（只读、不联网）；读不到抛错或给 unknown 都不拦 */
  quota(): Promise<InventoryQuota>;
  notifyPm(project: string, text: string): Promise<void>;
  /** 进程内去重（额度到线按窗口只通知一次） */
  memo: Set<string>;
  now(): number;
  attempt(): string;
}

const short = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").slice(0, 300);

async function notify(env: StartTickEnv, project: string, text: string, failed: Failed, taskId: string): Promise<void> {
  try {
    await env.notifyPm(project, text);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId, error: `通知 PM 失败：${(e as Error).message}` });
  }
}

async function settle(env: StartTickEnv, c: AutostartClaim, outcome: "done" | "failed" | "unknown", more: string[] = []): Promise<boolean> {
  const r = await env.ledger("ledger", "scheduler-autostart", "settle", String(c.seq), "--outcome", outcome, ...more);
  return r.ok === true;
}

const worktreeOf = (env: StartTickEnv, c: AutostartClaim) => `${env.startEnv().worktreeRoot}/${c.taskId.toLowerCase()}`;

/**
 * 本进程里正在开的节点（台账文件 + feature + 节点 → 计数）：从 claim 之前到结清之后，对账一律跳过它们的 claim，不然同进程并发的另一轮
 * 会把还在跑的 claim 结成 unknown，收回它的写权。跨进程不用登记：拿到调度租约的才跑得了，前一个持有者的台账写和 create 都会报 lease-lost。
 */
const INFLIGHT = new Map<string, number>();
const flightKey = (db: Database, featureId: string, key: string) => `${db.filename}\0${featureId}\0${key}`;

async function inFlight<T>(db: Database, featureId: string, key: string, run: () => Promise<T>): Promise<T> {
  const k = flightKey(db, featureId, key);
  INFLIGHT.set(k, (INFLIGHT.get(k) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const n = (INFLIGHT.get(k) ?? 1) - 1;
    if (n > 0) INFLIGHT.set(k, n);
    else INFLIGHT.delete(k);
  }
}

/** 断掉留下的 claim：节点已绑到卡就是开成了；否则结为 unknown，留给 PM 核对，不重开 */
async function reconcile(env: StartTickEnv, failed: Failed): Promise<void> {
  for (const c of openClaims(env.db)) {
    if (!env.svc.projects.includes(c.project) || INFLIGHT.has(flightKey(env.db, c.featureId, c.key))) continue;
    const f = getFeature(env.db, c.featureId);
    const bound = f ? currentViews(env.db, f).find((n) => n.key === c.key)?.taskId : null;
    if (!(await settle(env, c, bound ? "done" : "unknown", bound ? [] : ["--text", "开卡中途断了（上一轮没结清）"]))) {
      failed.push({ taskId: c.taskId, error: `结清断掉的 claim ${c.seq} 失败` });
      continue;
    }
    if (!bound) {
      await notify(env, c.project, `[自动开卡 ${c.taskId}] 开卡中途断了，看看 ${c.taskId} / ${c.agent} / ${worktreeOf(env, c)} 还在不在；` +
        `节点 ${c.featureId}/${c.key} 不会再自动开，核对后用 start_node 手动开或清掉残留。`, failed, c.taskId);
    }
  }
}

interface Pick { cand: Candidate; maxWorkers: number }

/** 按项目、feature、车道顺序挑第一个过了全部门的节点 */
function pickCandidate(env: StartTickEnv): Pick | null {
  for (const project of [...env.svc.projects].sort()) {
    for (const f of activeFeatures(env.db, project)) {
      if (featureGate(env.db, f, env.svc)) continue;
      const lanes = featureLanes(env.db, f);
      const views = currentViews(env.db, f);
      for (const key of lanes?.startNow ?? []) {
        const r = nodeCandidate(env.db, f, key, lanes, views, (id) => env.readSpec(id), env.now());
        if (!isStop(r)) return { cand: r, maxWorkers: env.svc.maxWorkers(project) };
      }
    }
  }
  return null;
}

/** Claude 周窗口到线就不开；同一窗口（resetsAt）只通知 PM 一次。读不到额度不拦（下游撞额度另有报警） */
async function quotaBlocked(env: StartTickEnv, project: string, failed: Failed): Promise<boolean> {
  let q: InventoryQuota;
  try {
    q = await env.quota();
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return false; // 额度快照读不到：按规格不拦，撞额度时执行者那边另有报警
  }
  const line = weeklyLine(readSwitch(env.db, project));
  const over = quotaOver(q, line);
  if (!over) return false;
  const key = `quota:claude:${over.id}:${over.resetsAtMs ?? "?"}`;
  if (!env.memo.has(key)) {
    env.memo.add(key);
    const reset = over.resetsAtMs ? new Date(over.resetsAtMs).toISOString() : "未知";
    await notify(env, project, `[自动开卡] Claude 周额度 ${over.id} 已用 ${over.usedPct}%，到了 ${line}% 的线，暂停自动开卡（窗口 ${reset} 重置）。` +
      "要调线用 autostart-set --line。", failed, project);
  }
  return true;
}

/** 挑完候选之后规格卡或节点范围变了（额度、claim、preflight 都要等）：返回原因，没变为 null。变了就按新内容下一轮重判 */
function specMoved(env: StartTickEnv, cand: Candidate): string | null {
  const spec = env.readSpec(cand.taskId);
  const g = specGate(spec, env.now());
  if ("why" in g) return g.why;
  const f = getFeature(env.db, cand.f.id);
  const globs = (f ? currentViews(env.db, f) : []).find((n) => n.key === cand.key)?.fileGlobs ?? [];
  return armOf((spec as SpecFile).text, globs, templateLabel(g.head.template)) === cand.arm ? null : "规格卡或节点范围在开卡途中改了";
}

/** runStart 的 manager 调用改写：台账写走 claim 的 step，create / kill 只许本 claim 的 agent，其余一律拒 */
function adapter(env: StartTickEnv, c: AutostartClaim, p: StartPlan): StepIO["manager"] {
  return async (args, timeoutMs) => {
    const [cmd, name] = args;
    if (cmd === "ledger") return env.ledger("ledger", "scheduler-autostart", "step", String(c.seq), ...args.slice(1));
    if (cmd === "create" && `agent-${name}` === c.agent && args[2] === p.worktree) return env.plain(args, timeoutMs);
    if (cmd === "kill" && name === c.agent) return env.plain(args, timeoutMs);
    throw new Error(`自动开卡不代跑 manager ${args.slice(0, 2).join(" ")}`);
  };
}

/** 卡号被别人（PM 的 start_node / 手工）正在用的那张活卡占着：是并发开同一个节点，输的一方安静收手 */
function takenByOther(env: StartTickEnv, c: AutostartClaim): boolean {
  const t = getTask(env.db, c.taskId);
  if (!t || t.stage === "cancelled") return false;
  const born = env.db.query("SELECT actor FROM events WHERE target = ? AND kind = 'task' ORDER BY seq LIMIT 1").get(c.taskId) as { actor: string } | null;
  return born?.actor !== "scheduler";
}

interface Failure { code: string; error: string; failedStep: string; rolledBack: string[]; leftovers: string[] }

async function fail(env: StartTickEnv, c: AutostartClaim, x: Failure, failed: Failed): Promise<void> {
  const ok = await settle(env, c, "failed", ["--code", x.code, "--failed-step", x.failedStep, "--rolled-back", JSON.stringify(x.rolledBack),
    "--leftovers", JSON.stringify(x.leftovers), "--text", `自动开卡失败（${x.failedStep}）：${short(x.error)}`]);
  if (!ok) {
    failed.push({ taskId: c.taskId, error: `结清失败的 claim ${c.seq} 没写进去：下一轮按断掉对账` });
    return;
  }
  if (takenByOther(env, c)) return;
  const t = getTask(env.db, c.taskId);
  const tail = t?.stage === "cancelled" ? `卡号 ${c.taskId} 已被回滚的那张卡占了，用 start_node 带 taskId 手动开。`
    : "同一份规格不再自动重试：改了规格卡或节点范围会重新武装，或用 start_node 手动开。";
  await notify(env, c.project, `[自动开卡 ${c.taskId}] 节点 ${c.featureId}/${c.key} 在「${x.failedStep}」这一步失败：${short(x.error)}。` +
    `已回滚：${x.rolledBack.join("、") || "无"}；留下：${x.leftovers.join("；") || "无"}。${tail}`, failed, c.taskId);
}

async function openCard(env: StartTickEnv, pick: Pick, failed: Failed): Promise<void> {
  const { cand } = pick;
  if (specMoved(env, cand)) return; // 还没写台账：安静放弃，下一轮按新规格重判
  const pre = await preflightStart({ ...env.startEnv(), db: env.db, caller: projectPm(env.db, cand.f.project) ?? "" },
    { featureId: cand.f.id, key: cand.key, template: cand.head.template.ok ? cand.head.template.template : undefined });
  if (!pre.ok && pre.code === "placement") return; // Destination has no room: leave the arm unclaimed for the next tick.
  const selected = pre.ok && "plan" in pre ? pre.plan.peer : null;
  const r = await env.ledger("ledger", "scheduler-autostart", "claim", cand.f.id, cand.key, "--arm", cand.arm, "--template", templateLabel(cand.head.template),
    "--max-workers", String(pick.maxWorkers), ...(selected ? ["--peer", JSON.stringify(selected)] : []), ...(cand.head.ownerVisual ? ["--owner-visual"] : []));
  // 选完到 claim 之间门变了（conflict），或并发的另一方先 claim（duplicate）：下一轮重算，不出声；别的拒绝进服务的失败日志
  if (r.ok !== true && r.code !== "conflict") failed.push({ taskId: `${cand.f.id}/${cand.key}`, error: `claim 被拒：${short(r.error ?? r.code)}` });
  if (r.ok !== true || r.duplicate === true) return;
  const c = r.claim as AutostartClaim;
  const t = cand.head.template;
  if (!t.ok) return fail(env, c, { code: "bad_template", error: t.error, failedStep: "template", rolledBack: [], leftovers: [] }, failed);
  if (pre.ok && "already" in pre) {
    if (!(await settle(env, c, "done"))) failed.push({ taskId: c.taskId, error: `结清 claim ${c.seq} 失败` });
    return;
  }
  if (!pre.ok) return fail(env, c, { code: pre.code, error: pre.error, failedStep: "preflight", rolledBack: [], leftovers: [] }, failed);
  const moved = specMoved(env, cand);
  if (moved) return fail(env, c, { code: "spec_changed", error: moved, failedStep: "spec", rolledBack: [], leftovers: [] }, failed);
  const p = pre.plan;
  if (p.taskId !== c.taskId || p.agent !== c.agent || p.branch !== c.branch || p.pm !== c.pm) {
    return fail(env, c, { code: "mismatch", error: `开工计划（${p.taskId} / ${p.agent}）和 claim 对不上`, failedStep: "preflight", rolledBack: [], leftovers: [] }, failed);
  }
  const out = await runStart({ ...env.stepIO(), db: () => env.db, manager: adapter(env, c, p), attempt: env.attempt() }, p);
  if (!out.ok) return fail(env, c, { code: out.code, error: out.error, failedStep: out.failedStep, rolledBack: out.rolledBack, leftovers: out.leftovers }, failed);
  if (!(await settle(env, c, "done"))) failed.push({ taskId: c.taskId, error: `开卡成功但结清 claim ${c.seq} 失败：下一轮对账` });
}

/** 一轮：对账 → 让出检查 → 挑候选 → 额度 → 开一张 */
export async function autostartTick(env: StartTickEnv, pace?: TickPace): Promise<Failed> {
  const failed: Failed = [];
  if (!env.svc.autoDispatch) return failed;
  try {
    await reconcile(env, failed);
    if (pace?.yieldNow()) return failed;
    const pick = pickCandidate(env);
    if (!pick || (await quotaBlocked(env, pick.cand.f.project, failed))) return failed;
    await inFlight(env.db, pick.cand.f.id, pick.cand.key, () => openCard(env, pick, failed));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "autostart", error: (e as Error).message });
  }
  return failed;
}
