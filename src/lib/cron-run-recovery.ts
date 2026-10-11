/**
 * cron 运行台账的恢复：daemon 重启（或上一轮清理没成）后，把没结束的记录接着管完。
 *
 * 只做三件事，都不重发 prompt、不重建 agent：
 *   - 没建临时 agent 的记录：标「结果未知 / 没派发」，通知一次；
 *   - 临时 agent 身份已确认的：接着等它空闲或到截止时间，然后只收**原会话**；
 *   - 身份没确认 / 同名换了会话的：一个都不停，标待核、通知一次。
 * 停 agent 只走调用方给的 manager 端口（list + kill），停之前现查一次同名 agent 的会话 id。
 * list 与 kill 之间仍有窗口；manager 有了带预期会话的原子停止后，把 guardedStopTempAgent 里的两步换成那一条。
 */

import { isUnfinishedCronRun, type CronRunRecord, type CronRunStatus, type CronRunStore, type CronTempSupervision } from "./cron-run-state.js";

export interface CronAgentRow { name: string; sessionId?: string }

/** manager 的端口：cron.ts 接 runManager，测试接 fake */
export interface CronAgentPorts {
  /** manager list 的 agents；失败要抛，不能返回空（空 = 都不在，会把还在跑的判成已收） */
  listAgents(): Promise<CronAgentRow[]>;
  /** 按短名停；返回失败原因，null = 停了或本就不在 */
  killAgent(agentName: string): Promise<string | null>;
  isIdle(agentName: string): Promise<boolean>;
}

export type CronStopOutcome =
  | { kind: "stopped" }
  | { kind: "gone" }
  | { kind: "no-identity" }
  | { kind: "session-changed"; seen: string }
  | { kind: "failed"; error: string };

const windowName = (agentName: string) => `agent-${agentName}`;

/** 只在同名 agent 还是 expectedSession 这个会话时停它；没有身份、查不到、会话变了都不发 kill */
export async function guardedStopTempAgent(ports: CronAgentPorts, agentName: string, expectedSession: string | undefined): Promise<CronStopOutcome> {
  if (!expectedSession) return { kind: "no-identity" };
  let rows: CronAgentRow[];
  try { rows = await ports.listAgents(); } catch (e) { return { kind: "failed", error: `查不到 agent 列表: ${(e as Error).message}` }; }
  const row = rows.find((a) => a.name === windowName(agentName));
  if (!row) return { kind: "gone" };
  if (row.sessionId !== expectedSession) return { kind: "session-changed", seen: row.sessionId || "(无)" };
  try {
    const err = await ports.killAgent(agentName);
    return err ? { kind: "failed", error: err } : { kind: "stopped" };
  } catch (e) {
    return { kind: "failed", error: (e as Error).message };
  }
}

export interface CronRecoveryDeps {
  store: CronRunStore;
  agents: CronAgentPorts;
  /** 本 daemon 实例；它名下且还在 liveKeys 里的记录由执行路径自己管 */
  owner: string;
  liveKeys: ReadonlySet<string>;
  now(): number;
  /** 别的实例还活着（它的记录在截止时间 + ownerGraceMs 之前不接手） */
  ownerAlive(owner: string): boolean;
  finishHistory(historyId: string, patch: { status: CronRunStatus; error?: string; finishedAt: string }): Promise<void>;
  notify(record: CronRunRecord, text: string): Promise<void>;
  log(msg: string): void;
  /** 连续空闲次数，跨轮保留（两轮都空闲才算跑完，同执行路径） */
  idleStreaks: Map<string, number>;
  /** create 最长要这么久才有定论：之前不判「agent 不在」 */
  createSettleMs: number;
  ownerGraceMs: number;
}

interface Stage { status: CronRunStatus; supervision?: CronTempSupervision }
interface Settle {
  status?: CronRunStatus;
  error?: string;
  supervision?: CronTempSupervision;
  cleanupError?: string;
  notice?: string;
}

const stageOf = (r: CronRunRecord): Stage => ({ status: r.status, supervision: r.temp?.supervision });

/**
 * 记录还停在读到时的阶段才改（两个实例同时恢复只有一个改得动，通知也就只发一次）。
 * 先落盘、再回写 history 和通知：落盘失败抛给上层，记录原样留着下一轮重试。
 */
async function settle(deps: CronRecoveryDeps, r: CronRunRecord, s: Settle): Promise<CronRunRecord | null> {
  const from = stageOf(r);
  const finishedAt = new Date(deps.now()).toISOString();
  const next = await deps.store.update(r.key, (cur) => {
    if (cur.status !== from.status || cur.temp?.supervision !== from.supervision) return false;
    if (s.status) Object.assign(cur, { status: s.status, error: s.error, finishedAt });
    if (cur.temp && s.supervision) cur.temp.supervision = s.supervision;
    if (cur.temp && s.cleanupError !== undefined) cur.temp.cleanupError = s.cleanupError;
  });
  if (!next) return null;
  if (s.status) {
    try { await deps.finishHistory(r.historyId, { status: s.status, error: s.error, finishedAt }); } catch (e) {
      deps.log(`⚠️ cron 恢复：回写 history ${r.historyId} 失败（台账已是 ${s.status}）: ${(e as Error).message}`);
    }
  }
  if (s.notice) {
    try { await deps.notify(next, s.notice); } catch (e) { deps.log(`⚠️ cron 恢复通知没发出去（${r.jobName}）: ${(e as Error).message}`); }
  }
  return next;
}

/** 结果已定之后收原会话。停不掉的留 cleanup-pending 下一轮再试；失败只在第一次通知 */
async function cleanupTemp(deps: CronRecoveryDeps, r: CronRunRecord): Promise<void> {
  const temp = r.temp!;
  const out = await guardedStopTempAgent(deps.agents, temp.agentName, temp.sessionId);
  if (out.kind === "stopped" || out.kind === "gone") {
    await settle(deps, r, { supervision: "cleaned", cleanupError: "" });
    return;
  }
  if (out.kind === "failed") {
    const first = !temp.cleanupError;
    await settle(deps, r, {
      supervision: "cleanup-pending",
      cleanupError: out.error,
      notice: first ? `⚠️ **定时任务临时 agent 清理失败**: ${r.jobName}（${temp.agentName}）\n-# ${out.error.slice(0, 200)}\n-# 下一轮自动重试` : undefined,
    });
    return;
  }
  const why = out.kind === "no-identity" ? "没有确认过会话身份" : `同名 agent 的会话已变（现在是 ${out.seen}）`;
  await settle(deps, r, {
    supervision: "needs-review",
    cleanupError: why,
    notice: `⚠️ **定时任务临时 agent 待核**: ${r.jobName}（${temp.agentName}）\n-# ${why}，没有停它\n-# 核对后手动清理：bun src/manager.ts kill ${temp.agentName}`,
  });
}

/** create 发出过、会话身份没落盘：只核同名 agent 在不在，不重建、不停 */
async function recoverUnconfirmed(deps: CronRecoveryDeps, r: CronRunRecord, rows: () => Promise<CronAgentRow[]>): Promise<void> {
  const temp = r.temp!;
  if (deps.now() < Date.parse(temp.createAttemptedAt) + deps.createSettleMs) return; // create 可能还在跑
  const row = (await rows()).find((a) => a.name === windowName(temp.agentName));
  const running = r.status === "running";
  if (!row) {
    const aborted: Settle = {
      status: "error",
      error: "daemon 中断：create 没有确认，同名 agent 不在，这次没有执行",
      notice: `❌ **定时任务中断**: ${r.jobName}\n-# 重启后核对：临时 agent 没建成，这次没有执行，不补跑`,
    };
    await settle(deps, r, { supervision: "cleaned", ...(running ? aborted : {}) });
    return;
  }
  await settle(deps, r, {
    supervision: "needs-review",
    cleanupError: "create 之后没有确认会话身份",
    ...(running ? { status: "unknown" as const, error: "daemon 中断：create 结果未确认，临时 agent 待核" } : {}),
    notice: `⚠️ **定时任务临时 agent 待核**: ${r.jobName}（${temp.agentName}）\n` +
      `-# create 之后没有确认会话身份（现在的会话 ${row.sessionId || "(无)"}），没有停它、没有重建\n-# 核对后手动清理：bun src/manager.ts kill ${temp.agentName}`,
  });
}

/** 身份已确认、还没出结果：接着监督。到期 / 连续两轮空闲才定结果，然后只收原会话 */
async function recoverSupervised(deps: CronRecoveryDeps, r: CronRunRecord, rows: () => Promise<CronAgentRow[]>): Promise<void> {
  const temp = r.temp!;
  const row = (await rows()).find((a) => a.name === windowName(temp.agentName));
  if (!row) {
    await settle(deps, r, {
      status: "unknown", error: "重启后临时 agent 已不在，结果未知", supervision: "cleaned",
      notice: `⚠️ **定时任务结果未知**: ${r.jobName}\n-# 重启后临时 agent ${temp.agentName} 已不在，不补跑`,
    });
    return;
  }
  if (row.sessionId !== temp.sessionId) {
    await settle(deps, r, {
      status: "unknown", error: "重启后同名 agent 的会话已变，结果未知", supervision: "needs-review",
      cleanupError: `同名 agent 的会话已变（现在是 ${row.sessionId || "(无)"}）`,
      notice: `⚠️ **定时任务结果未知**: ${r.jobName}（${temp.agentName}）\n-# 同名 agent 已不是原会话，没有停它`,
    });
    return;
  }
  let verdict: Settle | undefined;
  if (deps.now() >= Date.parse(r.deadlineAt)) {
    verdict = { status: "timeout", error: "超时（重启后恢复监督）", notice: `⏰ **定时任务超时**: ${r.jobName}\n-# 重启后恢复监督，到期收回临时 agent` };
  } else if (!temp.promptAttemptedAt) {
    verdict = {
      status: "unknown", error: "daemon 中断：prompt 没有发出记录，不补发",
      notice: `⚠️ **定时任务结果未知**: ${r.jobName}\n-# 重启前没有发出 prompt 的记录，不补发，收回临时 agent`,
    };
  } else {
    const streak = (await deps.agents.isIdle(temp.agentName)) ? (deps.idleStreaks.get(r.key) ?? 0) + 1 : 0;
    deps.idleStreaks.set(r.key, streak);
    if (streak >= 2) verdict = { status: "success", notice: `✅ **定时任务完成**: ${r.jobName}\n-# 重启后恢复监督` };
  }
  if (!verdict) return; // 还在跑：下一轮再看
  deps.idleStreaks.delete(r.key);
  const next = await settle(deps, r, { ...verdict, supervision: "cleanup-pending" });
  if (next) await cleanupTemp(deps, next);
}

async function recoverOne(deps: CronRecoveryDeps, r: CronRunRecord, rows: () => Promise<CronAgentRow[]>): Promise<void> {
  if (deps.liveKeys.has(r.key)) return;
  if (r.owner !== deps.owner && deps.ownerAlive(r.owner) && deps.now() < Date.parse(r.deadlineAt) + deps.ownerGraceMs) return;
  const temp = r.temp;
  if (!temp) {
    // 定向现存 agent，或认领后还没建临时 agent：没有可收的东西，只定结果，不重发
    const sent = !!r.dispatchAttemptedAt;
    const head = `**: ${r.jobName}\n-# daemon 在`;
    await settle(deps, r, sent
      ? { status: "unknown", error: "daemon 中断：prompt 可能已发出，结果未知，不重发", notice: `⚠️ **定时任务结果未知${head}执行中退出，prompt 可能已发出，不重发` }
      : { status: "error", error: "daemon 中断：没有派发，不补跑", notice: `❌ **定时任务中断${head}派发前退出，这次没有执行，不补跑` });
    return;
  }
  if (!temp.sessionId) return recoverUnconfirmed(deps, r, rows);
  if (r.status === "running") return recoverSupervised(deps, r, rows);
  await cleanupTemp(deps, r);
}

/**
 * 扫一遍没结束的记录，各推进一步。不阻塞等待：还在跑的留给下一轮（调用方每个 tick 调一次）。
 * 台账读不出 = 什么都不做；单条失败（list / 落盘）不影响别的，记录原样留着重试。
 */
export async function recoverCronRuns(deps: CronRecoveryDeps): Promise<{ scanned: number; failed: number; readError?: string }> {
  let runs: CronRunRecord[];
  try { runs = await deps.store.list(); } catch (e) { return { scanned: 0, failed: 0, readError: (e as Error).message }; }
  const open = runs.filter(isUnfinishedCronRun);
  let listed: Promise<CronAgentRow[]> | undefined;
  const rows = () => (listed ??= deps.agents.listAgents()); // 一轮只查一次，没有要查的记录就不查
  let failed = 0;
  for (const r of open) {
    try { await recoverOne(deps, r, rows); } catch (e) {
      failed++;
      deps.log(`⚠️ cron 恢复 ${r.jobName}（${r.key}）这一轮没成，保留记录下轮重试: ${(e as Error).message}`);
    }
  }
  return { scanned: open.length, failed };
}

export interface LegacyHistoryRow { id: string; jobName?: string; startedAt?: string; status: string; finishedAt?: string; error?: string }

/**
 * 旧版留下的 running 历史（台账里没有对应记录 = 没有 agent 名和会话身份）：原地改成 unknown 待核，返回改了的那些。
 * 不按 cron 名字去猜 agent、不停任何会话；改完就不再是 running，所以通知只会发一次。
 */
export function markLegacyRunningHistory<T extends LegacyHistoryRow>(history: T[], runs: CronRunRecord[], nowIso: string): T[] {
  const known = new Set(runs.map((r) => r.historyId));
  const marked: T[] = [];
  for (const h of history) {
    if (!h || h.status !== "running" || known.has(h.id)) continue;
    Object.assign(h, { status: "unknown", finishedAt: nowIso, error: "待核：旧记录没有运行身份（agent 名 / 会话），重启后无法恢复监督" });
    marked.push(h);
  }
  return marked;
}
