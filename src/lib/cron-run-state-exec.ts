/**
 * cron 一次执行的骨架：内存占位 → 台账认领 → history 初写 → 派发 → 收尾。src/cron.ts 只接端口。
 *
 * 顺序是约束本身：认领和 history 初写任何一步失败都还没发过外部动作（零派发）；
 * 内存占位从第一行起就在 finally 里释放——初写抛错不会让这个任务之后每次触发都被「上一次还没完」挡掉。
 * 临时 agent 的名字、create 尝试、会话身份、截止时间逐步落进台账，daemon 中途退出由 lib/cron-run-recovery.ts 接着管。
 * 反例见 tests/cron-audit-run.test.ts。
 */

import type { CronJob } from "./cron-job.js";
import { guardedStopTempAgent, type CronAgentPorts } from "./cron-run-recovery.js";
import type { CronRunRecord, CronRunStatus, CronRunStore } from "./cron-run-state.js";

export interface CronRunCtx { key: string; historyId: string }
export interface CronRunOutcome { status: "success" | "timeout"; error?: string }

export interface CronHistoryRow {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt?: string;
  status: CronRunStatus;
  error?: string;
}

export interface CronExecDeps {
  /** 进程内「这个任务正在跑」的占位 */
  running: Set<string>;
  /** 本进程正在管的台账 key：恢复扫描跳过它们 */
  liveKeys: Set<string>;
  store: CronRunStore;
  owner: string;
  maxRuntimeMs(job: CronJob): number;
  /** 截止时间在 maxRuntime 之外再留的余量（create 预算 + 冷启动） */
  deadlineSlackMs: number;
  reportChannel(job: CronJob): string | undefined;
  appendHistory(entry: CronHistoryRow): Promise<void>;
  updateHistory(id: string, patch: Partial<CronHistoryRow>): Promise<void>;
  /** 真正派发。抛 = 失败 */
  execute(job: CronJob, run: CronRunCtx): Promise<CronRunOutcome>;
  notifyFailure(job: CronJob, error: string): Promise<void>;
  touchLastRun(job: CronJob): Promise<void>;
  log(msg: string): void;
  error(msg: string): void;
}

export type CronRunResult = "ran" | "failed" | "busy" | "duplicate" | "state-unavailable";

/** 收尾步骤各自兜住：一个写不进去不该挡住后面的释放和通知；丢的只是这一条记录，日志里有 */
async function attempt(deps: Pick<CronExecDeps, "error">, what: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (e) { deps.error(`⚠️ cron ${what}失败: ${(e as Error).message}`); }
}

/** 只把还在 running 的记录定成最终状态（恢复扫描已经定过的不覆盖） */
const finishRun = (store: CronRunStore, key: string, status: CronRunStatus, error?: string) =>
  store.update(key, (r) => {
    if (r.status !== "running") return false;
    Object.assign(r, { status, error, finishedAt: new Date().toISOString() });
  });

export async function runCronJobGuarded(deps: CronExecDeps, job: CronJob, now: Date): Promise<CronRunResult> {
  if (deps.running.has(job.id)) {
    deps.log(`⏭ 跳过 "${job.name}" — 上一次执行尚未完成`);
    return "busy";
  }
  deps.running.add(job.id);
  let run: CronRunCtx | undefined;
  try {
    const historyId = `run_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    const claim = await deps.store.claim({
      jobId: job.id, jobName: job.name, epochMinute: Math.floor(now.getTime() / 60_000), historyId, owner: deps.owner, startedAt,
      deadlineAt: new Date(Date.now() + deps.maxRuntimeMs(job) + deps.deadlineSlackMs).toISOString(),
      reportChannel: deps.reportChannel(job), dir: job.dir,
    });
    if (!claim.claimed) {
      if (claim.reason === "duplicate") {
        deps.log(`⏭ 跳过 "${job.name}" — 这一分钟已被认领（${claim.existing.status}，${claim.existing.owner}）`);
        return "duplicate";
      }
      deps.error(`❌ cron "${job.name}" 没有派发：${claim.error}`);
      return "state-unavailable";
    }
    run = { key: claim.record.key, historyId };
    deps.liveKeys.add(run.key);
    await deps.appendHistory({ id: historyId, jobId: job.id, jobName: job.name, startedAt, status: "running" });
    const outcome = await deps.execute(job, run);
    const finishedAt = new Date().toISOString();
    await attempt(deps, "回写 history ", () => deps.updateHistory(historyId, { finishedAt, status: outcome.status, error: outcome.error }));
    await attempt(deps, "回写运行台账", () => finishRun(deps.store, run!.key, outcome.status, outcome.error));
    return "ran";
  } catch (err) {
    const msg = (err as Error).message;
    deps.error(`❌ cron 任务执行失败: "${job.name}" — ${msg}`);
    if (run) {
      const { key, historyId } = run;
      await attempt(deps, "回写 history ", () => deps.updateHistory(historyId, { finishedAt: new Date().toISOString(), status: "error", error: msg }));
      await attempt(deps, "回写运行台账", () => finishRun(deps.store, key, "error", msg));
    }
    await attempt(deps, "失败通知", () => deps.notifyFailure(job, msg));
    return "failed";
  } finally {
    deps.running.delete(job.id);
    if (run) {
      deps.liveKeys.delete(run.key);
      await attempt(deps, "回写 lastRun ", () => deps.touchLastRun(job));
    }
  }
}

export interface CronTempDeps {
  store: CronRunStore;
  agents: CronAgentPorts;
  /** manager create；ok=false 带 error */
  create(agentName: string, job: CronJob): Promise<{ ok?: boolean; error?: unknown; sessionId?: unknown }>;
  sendPrompt(agentName: string, prompt: string): Promise<void>;
  /** 完成后的摘要（抓不到返回 ""） */
  summary(job: CronJob, sessionId: string): Promise<string>;
  /** 发到这次任务的通知频道；没有频道 / 发不出去都不抛 */
  notify(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
  error(msg: string): void;
  timing: { readyMs: number; coldStartMs: number; pollMs: number; cleanupDelayMs: number };
}

/** 这次启动独有的名字：时间 + 随机，同一毫秒两个实例也不撞 */
const cronTempAgentName = (jobName: string, nowMs: number): string =>
  `cron-${jobName.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${nowMs.toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** 台账里补一笔身份 / 进度；写不进去只记日志——身份还在内存里，本进程照样只收原会话，进程没了由恢复扫描按「没确认」处理。发 prompt 前那一笔不走这里（必须落盘） */
async function noteTemp(deps: CronTempDeps, key: string, what: string, mutate: (r: CronRunRecord) => void): Promise<void> {
  try { await deps.store.update(key, (r) => { if (r.temp) mutate(r); else return false; }); } catch (e) {
    deps.error(`⚠️ cron 运行台账没记上「${what}」: ${(e as Error).message}`);
  }
}

/** 连续两次（间隔 pollMs）都空闲才算跑完：单次判定会撞上工具结果回来到下一次请求之间的瞬态，把还在跑的收掉 */
async function waitTempIdle(deps: CronTempDeps, agentName: string, maxRuntimeMs: number): Promise<boolean> {
  await deps.sleep(deps.timing.coldStartMs);
  const startTime = deps.now();
  let idleStreak = 0;
  while (deps.now() - startTime < maxRuntimeMs) {
    await deps.sleep(deps.timing.pollMs);
    try {
      idleStreak = (await deps.agents.isIdle(agentName)) ? idleStreak + 1 : 0;
    } catch { return false; /* 窗口查不了：按没跑完收，外层记超时 */ }
    if (idleStreak >= 2) return true;
  }
  return false;
}

/** 成功、超时、异常都跑一次：只收确认过的那个会话；没确认过身份的不按名字停，留给恢复扫描核 */
async function cleanupTempAgent(deps: CronTempDeps, job: CronJob, run: CronRunCtx, agentName: string, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  await deps.sleep(deps.timing.cleanupDelayMs);
  const out = await guardedStopTempAgent(deps.agents, agentName, sessionId);
  if (out.kind === "stopped" || out.kind === "gone") {
    await noteTemp(deps, run.key, "临时 agent 已收", (r) => { r.temp!.supervision = "cleaned"; });
    return;
  }
  const changed = out.kind === "session-changed";
  const why = out.kind === "failed" ? out.error : changed ? `同名 agent 的会话已变（现在是 ${out.seen}），没有停它` : "没有确认过会话身份";
  deps.error(`❌ cron 临时 agent 清理失败: ${agentName} — ${why}`);
  await noteTemp(deps, run.key, "临时 agent 没收掉", (r) => {
    r.temp!.supervision = changed ? "needs-review" : "cleanup-pending";
    r.temp!.cleanupError = why;
  });
  const hint = changed ? `核对后手动清理：bun src/manager.ts kill ${agentName}` : "下一轮自动重试";
  await deps.notify(`⚠️ **定时任务临时 agent 清理失败**: ${job.name}（${agentName}）\n-# ${why.slice(0, 200)}\n-# ${hint}`);
}

/**
 * spawn 临时 agent 跑一次，跑完销毁（零上下文的批处理）。
 * 名字和 create 尝试先落台账、落不进去就不 create；create 返回的会话 id 是之后唯一认的身份。
 */
export async function runCronTempAgent(deps: CronTempDeps, job: CronJob, run: CronRunCtx, maxRuntimeMs: number): Promise<CronRunOutcome> {
  const agentName = cronTempAgentName(job.name, deps.now());
  const saved = await deps.store.update(run.key, (r) => {
    r.temp = { agentName, createAttemptedAt: new Date(deps.now()).toISOString(), supervision: "create-attempted" };
  });
  if (!saved) throw new Error("运行台账里没有这次认领，没有创建 agent");
  deps.log(`🚀 执行 cron 任务（临时 agent）: "${job.name}" → agent ${agentName}`);
  await deps.notify(`⏰ **定时任务开始**: ${job.name}\n-# 📁 ${job.dir}\n-# 💬 ${job.prompt.slice(0, 100)}`);

  let sessionId: string | undefined;
  try {
    const created = await deps.create(agentName, job);
    if (!created.ok) throw new Error(`创建 agent 失败: ${created.error}`);
    sessionId = typeof created.sessionId === "string" && created.sessionId ? created.sessionId : undefined;
    const { readyMs, coldStartMs } = deps.timing;
    await noteTemp(deps, run.key, "会话身份", (r) => {
      Object.assign(r.temp!, { sessionId, confirmedAt: new Date(deps.now()).toISOString(), supervision: sessionId ? "supervising" : "needs-review" });
      r.deadlineAt = new Date(deps.now() + readyMs + coldStartMs + maxRuntimeMs).toISOString();
    });
    if (!sessionId) {
      const fix = `核对后手动清理：bun src/manager.ts kill ${agentName}`;
      await deps.notify(`⚠️ **定时任务临时 agent 待核**: ${job.name}（${agentName}）\n-# create 没有返回会话 id，跑完不会自动停它\n-# ${fix}`);
    }
    await deps.sleep(readyMs); // 等 agent 就绪
    // 「要发了」必须先落盘才发（抛 = 没发，finally 照样只收原会话）：恢复扫描靠它分辨「没派发」和「可能在跑」，
    // 记不上还发出去，daemon 一退，在跑的 worker 就会被当成没派发。会话身份顺带再落一次，上面那笔没记上的这里补齐。
    const confirmedAt = new Date(deps.now()).toISOString();
    const marked = await deps.store.update(run.key, (r) => {
      if (!r.temp) return false;
      if (sessionId && !r.temp.sessionId) Object.assign(r.temp, { sessionId, confirmedAt, supervision: "supervising" });
      r.temp.promptAttemptedAt = new Date(deps.now()).toISOString();
    });
    if (!marked) throw new Error("运行台账里没有这次认领，prompt 没有发");
    await deps.sendPrompt(agentName, job.prompt);

    const completed = await waitTempIdle(deps, agentName, maxRuntimeMs);
    const outcome: CronRunOutcome = completed ? { status: "success" } : { status: "timeout", error: `超时 (${Math.round(maxRuntimeMs / 60_000)} 分钟)` };
    // 结果先落盘再收 agent：这之后 daemon 退出，恢复扫描只需要收原会话，不会重新判一次结果
    await noteTemp(deps, run.key, "结果", (r) => {
      Object.assign(r, { status: outcome.status, error: outcome.error, finishedAt: new Date(deps.now()).toISOString() });
      if (sessionId) r.temp!.supervision = "cleanup-pending";
    });
    let body = `${completed ? "✅" : "⏰"} **定时任务${completed ? "完成" : "超时"}**: ${job.name}`;
    if (completed && sessionId) {
      const summary = await deps.summary(job, sessionId);
      if (summary) body += `\n\n${summary}`;
    }
    await deps.notify(body);
    return outcome;
  } finally {
    try { await cleanupTempAgent(deps, job, run, agentName, sessionId); } catch (e) {
      deps.error(`❌ cron 临时 agent 清理异常: ${agentName} — ${(e as Error).message}`);
    }
  }
}
