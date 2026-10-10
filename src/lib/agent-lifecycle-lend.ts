/**
 * LIFE1 B 终态退休端口的事实层（纯函数，tests/agent-lifecycle-lend.test.ts）：出借 worker 平时是 foreign（agent-lifecycle.ts 的 planner /
 * doctor / 定时收不动它）；只有 lend 服务在本单正规结单链里显式调用、所有事实都从 B journal / registry / 收据 / ACP 活动记录现读时，
 * 才给出一个 rule = lend_terminal 的 archive-only Action，交给 agent-lifecycle-run.ts runLendTerminal（LIFE1 唯一 collect）。
 * worker 自报的 terminal / verified / backedUp 一律不信；窗口消失、kill 回 ok 都不算退出证明。
 * 退出证明：现有 acp-activity 记录精确同 agent / session、hostPid 有效，可信来源给出的该 pid 宿主进程启动时刻（hostStart）
 * 落在本单建单之后、该记录写盘之前（防 PID 复用 / 别的宿主的记录），且对该 pid 探测严格 ESRCH；活着 / EPERM / 其他错误 / 记录缺失一律拒绝。
 * ActivityRecord 本身不带宿主启动身份，订单 startedAt 是 worker.create 返回后才记的、和心跳建立不了 process-start 关系：
 * 没有 hostStart 来源就是 blocked-capability（生产现无这个 reader，见 lend-worker-archive-cmds.ts productionArchiveDeps）。
 * Claude 家族同样没有持久宿主记录，明确 blocked-capability，不当已退出。
 */
import type { ActivityRecord } from "./agent-supervisor-activity.js";
import type { Action } from "./agent-lifecycle.js";
import type { CardWorker } from "./agent-lifecycle-store.js";
import type { LendRow } from "./lend-journal.js";
import { workerArchiveProblem, type WorkerArchiveIdentity, type WorkerArchiveRecord } from "./lend-worker-registry-archive.js";
import type { WorkerLiveness } from "./worker-liveness.js";

/** off：结单不碰；observe：只跑 dry-run 记日志（生产缺省）；on：真退休，失败留 settle（只在测试注入 / 另经 owner 规则启用） */
export type LendTerminalMode = "off" | "observe" | "on";
export const LEND_TERMINAL_DEFAULT: LendTerminalMode = "observe";

/** 对 hostPid 的一次 kill(pid, 0) 探测结果 */
export type PidProbe = "esrch" | "alive" | "eperm" | "unknown";

export function probePid(pid: number, kill: (pid: number, sig: number) => void = process.kill): PidProbe {
  try { kill(pid, 0); return "alive"; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "esrch" : code === "EPERM" ? "eperm" : "unknown";
  }
}

/** 宿主进程的启动身份：只能来自可信的、在宿主活着时记下的来源，不能由 worker 自报或事后推算 */
export interface HostStart { pid: number; startedAt: number }

export interface LendTerminalFacts {
  id: WorkerArchiveIdentity;
  /** B canonical journal 现读的订单行 */
  row: LendRow | null;
  /** registry 现读的条目 */
  record: WorkerArchiveRecord | undefined;
  /** cardWorkerIndex 里同名的本机卡关联：有就不是出借 worker，不借 A 卡冒终态 */
  card: CardWorker | undefined;
  window: WorkerLiveness;
  activity: ActivityRecord | null;
  /** activity.hostPid 的宿主启动身份；null = 没有可信来源（blocked-capability） */
  hostStart: HostStart | null;
  /** activity.hostPid 的探测；没有记录时不探 */
  probe: PidProbe | null;
  /** 会话归档已在（kill / 宿主收尾拷过），collect 不二次归档 */
  historyKept: boolean;
}

export type LendTerminalVerdict = { action: Action } | { refuse: string; blocked?: true };

/** 退出证明；null = 已肯定退出。blocked = 缺的是能力（宿主启动身份来源），不是事实不符 */
export function exitProblem(f: Pick<LendTerminalFacts, "id" | "row" | "window" | "activity" | "hostStart" | "probe">): { problem: string; blocked?: true } | null {
  if (f.window !== "no_window") return { problem: `窗口 / 宿主状态 ${f.window}，不当已退出` };
  const a = f.activity;
  if (!a) return { problem: "没有 ACP 活动记录，退出无法证明" };
  if (a.agent !== f.id.agent || a.sessionId !== f.id.sessionId) return { problem: "ACP 活动记录不是本单的 agent / 会话" };
  if (!Number.isInteger(a.hostPid) || a.hostPid <= 1) return { problem: "ACP 活动记录没有有效宿主 pid" };
  if (f.row?.startedAt == null || a.writtenAt < f.row.startedAt) return { problem: "ACP 活动记录早于本单开跑或开跑时刻不明，pid 来源不可信" };
  const h = f.hostStart;
  if (!h) return { problem: `宿主 pid ${a.hostPid} 没有可信的启动身份来源，process-start 关系不明（blocked-capability）`, blocked: true };
  if (h.pid !== a.hostPid || !Number.isFinite(h.startedAt) || h.startedAt < f.row.createdAt || h.startedAt > a.writtenAt) {
    return { problem: `宿主 pid ${a.hostPid} 的启动身份与本单 / 活动记录对不上（可能 PID 复用），不当已退出` };
  }
  if (f.probe !== "esrch") return { problem: `宿主 pid ${a.hostPid} 探测为 ${f.probe ?? "未探"}，不是严格 ESRCH` };
  return null;
}

export function lendTerminalAction(f: LendTerminalFacts): LendTerminalVerdict {
  const problem = workerArchiveProblem(f.id, f.row, f.record ?? {});
  if (problem) return { refuse: problem };
  if (f.card) return { refuse: `${f.id.agent} 关联本机卡 ${f.card.taskId ?? "?"}（${f.card.source}），不是出借 worker 的终态事实` };
  if (f.row!.family !== "codex") return { refuse: `${f.row!.family} 家族没有持久宿主退出证明端口（blocked-capability）`, blocked: true };
  const exit = exitProblem(f);
  if (exit) return { refuse: exit.problem, ...(exit.blocked ? { blocked: true as const } : {}) };
  return { action: {
    agent: f.id.agent, taskId: null, role: "other", rule: "lend_terminal", idleMs: null, sessionId: f.id.sessionId,
    ...(f.record?.cwd ? { cwd: f.record.cwd } : {}),
    reason: `出借单 ${f.id.orderId} 已 ${f.row!.state}（gen ${f.id.leaseGen}），worker 已退出`,
    archiveOnly: { orderId: f.id.orderId, leaseGen: f.id.leaseGen, historyKept: f.historyKept },
  } };
}
