/**
 * `ledger merge-queue`（i28-MQ2）：只读列出项目合并队列，顺序就是自动 tick 挑卡的顺序（同一个 mergeFirst）；队列本身在 lib/ledger-merge-queue-view.ts。
 * 人工合并请求（MQ1）另列一段：轮转序、状态、等待原因都出自 manual-merge-queue.ts 的同一个 manualTurn，不显示 session 等认证相关材料。
 */
import { mergeQueue } from "../lib/ledger-merge-queue-view.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import { manualQueueView, trainSignal } from "../lib/manual-merge-queue.js";
import { defaultTrainStore } from "../lib/scheduler-merge-train-hold-slot.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "../lib/recovery-policy.js";

const STATE_WORD: Record<string, string> = { queued: "排队", waiting: "等前置", void: "已失效", revoked: "已撤销", running: "合并中", merged: "已合并",
  ended: "已结束", unknown: "结果不明" };

/** The manual requests part; a policy read that throws is shown as off, never swallowed into "observe". */
function manualPart(c: Parameters<CommandSpec["run"]>[0], project: string, now: number, policy: RecoveryPolicyPort) {
  let mode: string, diag: string | null = null;
  try { const p = policy(project, "manualMergeQueue"); mode = p.mode; diag = p.diagnostic ?? null; }
  catch (e) { mode = "off"; diag = `读恢复策略失败：${(e as Error).message}`; }
  const { rows, turn } = manualQueueView(c.db, project, trainSignal(defaultTrainStore(), project, now), now);
  const lines = rows.map((r) => `人工#${r.request} ${r.task}｜${STATE_WORD[r.state] ?? r.state}${r.phase ? `/${r.phase}` : ""}` +
    `${r.turn ? `｜轮转第 ${r.turn}` : ""}｜${r.requestedBy} 请求 @${r.head}｜审查 #${r.review.seq} ${r.review.reviewer}(${r.review.family})${r.why ? `｜${r.why}` : ""}`);
  return { mode, diag, turn: turn.kind, rows, lines: [`人工合并排队策略：${mode}${diag ? `（${diag}）` : ""}`, ...lines] };
}

export function mergeQueueCmds(policy: RecoveryPolicyPort = recoveryPolicy): Record<string, CommandSpec> {
  return {
    "merge-queue": {
      valued: ["project"], bools: [],
      usage: "merge-queue [--project <id>]（只读：当前合并队列，按自动 tick 挑卡的先后；每张卡进 merge 的时间、已等分钟、合并意图阶段、被挡原因；另列人工合并请求）",
      run(c) {
        const project = c.project(), now = c.deps.now();
        const rows = mergeQueue(c.db, project, now);
        const lines = rows.map((r, i) => `${i + 1}. ${r.task}｜进 merge ${r.enteredAt === null ? "?" : new Date(r.enteredAt).toISOString()}` +
          `｜已等 ${r.waitedMin ?? "?"} 分钟｜${r.phase}${r.blocked ? `｜挡：${r.blocked}` : ""}`);
        const manual = manualPart(c, project, now, policy);
        return { ok: true, project, rows, manual: { mode: manual.mode, diag: manual.diag, turn: manual.turn, rows: manual.rows }, lines: [...lines, ...manual.lines] };
      },
    },
  };
}

export const MERGE_QUEUE_CMDS = mergeQueueCmds();
