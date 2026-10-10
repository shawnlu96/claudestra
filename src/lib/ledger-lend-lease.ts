import { reborrowMarker, type ReborrowBinding } from "./lend-reborrow-marker.js";
/**
 * 出借写代码单的 A 侧规矩（i28-R6）：写租约与开工 / 修复单的内容。
 * 写租约：一张卡第一次把开工单借给某个出借方时记下（held），之后直到合并（卡走到 merge 及以后）或 PM 收回，这张卡的开工 / 修复单
 * 只能挂给它；修复单只派给持有写租约的出借方（开工单没借出去的卡，分支不是出借分支，对方推不了）。
 * 派不回去（授权过期、名额满、离线）由 ledger-lend.ts 结束租约并通知 PM 退回本机。
 * 单子内容：规格原文、上一轮审查报告原文和逐项结论都放在 inputs / findings 里，由 T87 的外发闸按外来数据逐行引用，不进任何命令行。
 * tests/ledger-lend-write.test.ts。
 */
import type { Database } from "bun:sqlite";
import { LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { lendBranch, type LendStep } from "./lend-git.js";
import { orderWireOf, WIRE_LIMITS, type OrderWire } from "./order-wire.js";
import { chunkInputs, type InputSplit } from "./order-wire-chunks.js";
import { standardAnswers } from "./order-standard-answers.js";
import type { ReviewFinding } from "./scheduler-review.js";
import type { bounceWork } from "./scheduler-merge-conflict.js";
import { lendFixEnv } from "./lend-fix-env.js";
import { relayTarget } from "./lend-fix-reassign-event.js";
import { orderFileScope } from "./order-wire-file-scope.js";
import { assertReborrowContext, type ReborrowContext } from "./lend-reborrow-context.js";
/** i28-GATE2：出借单外发前把本卡历史 head 截短、敏感问题编号换别名（逻辑在 order-gate-heads.ts） */
export { forPeer } from "./order-gate-heads.js";

export interface WriteLease {
  taskId: string; project: string; peer: string; fp: string; branch: string; repo: string;
  prevAssignee: string | null; prevAssigneeKind: string | null; state: "held" | "ended"; reason: string | null; createdAt: number; updatedAt: number;
}

/** CLI 在事务外备好的写单材料：对方指纹（按钉住的公钥算）、基线、上一轮审查 */
export interface WriteOffer {
  /** Verified recovery keeps the ledger's reviewed head separate from the remote starting point. */
  reborrow?: ReborrowContext;
  fp: string;
  /** 基线分支名（开工单从它切）与它此刻在远端的 head（开工单的 head）；修复单两者都不用 */
  base: string;
  baseSha: string | null;
  /** 修复单：普通修复用上一轮报告原文；merge bounce 用本机核定的环境说明 */
  report: string | null;
}

/** 合并之后（merge / live / verified / done）或卡作废，写租约自然结束 */
const LEASE_STAGES = ["spec", "restate", "build", "review", "fix", "blocked"];

const hasLeases = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_write_leases'").get();

export function getWriteLease(db: Database, taskId: string): WriteLease | null {
  if (!hasLeases(db)) return null;
  return db.query("SELECT * FROM lend_write_leases WHERE taskId = ?").get(taskId) as WriteLease | null;
}

/** 此刻还算数的写租约：held，且卡还没走到合并之后 */
export function heldLease(db: Database, task: Pick<LedgerTask, "id" | "stage">): WriteLease | null {
  const l = getWriteLease(db, task.id);
  return l && l.state === "held" && LEASE_STAGES.includes(task.stage) ? l : null;
}

/** 写租约记在这个出借方名下；已经 held 在它名下就不动（借出去之前的负责人只在第一次记） */
export function holdWriteLease(db: Database, task: LedgerTask, l: Pick<WriteLease, "peer" | "fp" | "branch" | "repo">, now: number): void {
  const cur = heldLease(db, task);
  if (cur && cur.peer === l.peer && cur.branch === l.branch) return;
  db.prepare(`INSERT INTO lend_write_leases (taskId, project, peer, fp, branch, repo, prevAssignee, prevAssigneeKind, state, reason, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', NULL, ?, ?) ON CONFLICT (taskId) DO UPDATE SET project = excluded.project, peer = excluded.peer, fp = excluded.fp,
    branch = excluded.branch, repo = excluded.repo, prevAssignee = excluded.prevAssignee, prevAssigneeKind = excluded.prevAssigneeKind, state = 'held',
    reason = NULL, updatedAt = excluded.updatedAt`).run(task.id, task.project, l.peer, l.fp, l.branch, l.repo, task.assignee ?? null, task.assigneeKind ?? null, now, now);
}

export function endWriteLease(db: Database, taskId: string, reason: string, now: number): WriteLease | null {
  const l = getWriteLease(db, taskId);
  if (!l || l.state !== "held") return null;
  db.prepare("UPDATE lend_write_leases SET state = 'ended', reason = ?, updatedAt = ? WHERE taskId = ? AND state = 'held'").run(reason, now, taskId);
  return l;
}

/** 这张卡此刻能不能把写单挂给这个 peer；能 = 返回这一单的分支名 */
export function writeOfferBranch(db: Database, task: LedgerTask, step: LendStep, peer: string, w: WriteOffer): string {
  const branch = lendBranch(task.id, w.fp);
  if (!branch) throw new LedgerError("invalid", `任务 id ${task.id} 或出借方指纹不合格，拼不出出借分支名`);
  const lease = heldLease(db, task);
  if (w.reborrow) {
    assertReborrowContext(task, peer, w.reborrow);
    if (w.reborrow.facts.lease.fp !== w.fp || w.reborrow.facts.lease.branch !== branch || w.base !== "main") {
      throw new LedgerError("conflict", "恢复上下文的指纹、分支或 main base 不符");
    }
    return branch;
  }
  const relay = step === "fix" && !lease && relayTarget(db, task) === peer; // i28-RA1：自动改派的接力单，起点是 PR 当前 head、分支是新出借方自己的
  if (lease && lease.peer !== peer) throw new LedgerError("conflict", `这张卡的写租约在 ${lease.peer}：修复单优先派回它；要换人先 ledger lend-reclaim ${task.id}`);
  if (lease && lease.branch !== branch) throw new LedgerError("conflict", `${peer} 的实例指纹变了（租约记的分支是 ${lease.branch}），先 lend-reclaim 收回`);
  if (step === "fix") {
    if (!lease && !relay) throw new LedgerError("invalid", "修复单只派给持有写租约的出借方（这张卡的开工单没借出去，对方推不了它的分支）");
    if (!relay && task.branch !== branch) throw new LedgerError("invalid", `卡上的分支是 ${task.branch ?? "（空）"}，不是出借分支 ${branch}`);
    if (!task.headSHA || !/^[0-9a-f]{40}$/.test(task.headSHA)) throw new LedgerError("invalid", "卡上没有完整的 40 位 head，修复单没有起点");
  } else if (!w.baseSha || !/^[0-9a-f]{40}$/.test(w.baseSha)) {
    throw new LedgerError("invalid", `查不到基线 ${w.base} 在远端的完整 head，开工单没有起点`);
  }
  return branch;
}

const FINDING_KEYS: readonly (keyof ReviewFinding)[] = ["findingId", "family", "severity", "probe"];

/** 卡上最近一条带逐项结论的审查：修复单要修的就是它（坏行丢掉，整单还要过 parseOrderWire） */
export function lastReviewOf(db: Database, task: LedgerTask): { path: string | null; findings: ReviewFinding[] } {
  const e = listEvents(db, { project: task.project, target: task.id }).findLast((x) => x.kind === "review");
  const rows = (Array.isArray(e?.data.findings) ? e!.data.findings : []) as Record<string, unknown>[];
  const findings = rows.filter((f) => f && typeof f === "object" && FINDING_KEYS.every((k) => typeof f[k] === "string")).slice(0, WIRE_LIMITS.findings)
    .map((f) => ({ findingId: f.findingId as string, family: f.family as string, severity: f.severity as ReviewFinding["severity"], probe: f.probe as string }));
  return { path: typeof e?.data.path === "string" ? e.data.path : null, findings };
}

export interface WriteOrderInput { orderId: string; step: LendStep; head: string; branch: string; base: string; spec: string; report: string | null;
  resume?: boolean; reborrow?: ReborrowBinding;
  findings: ReviewFinding[]; repo: string; pr: number | null; bounce?: ReturnType<typeof bounceWork> | null;
  /** 开工单：复述已交、PM 还没答时的复述原文（i28-RS1）——随单带上，答复之后由 ledger-lend-relay.ts 推送 */
  restate?: string | null }

/** 复述交了、PM 还没答就派出的开工单要写明的那一句（i28-RS1） */
export const RESTATE_PENDING_LINE = "复述答复会随后推送，收到前遇到复述里列的待定点按复述里的默认做";

/** 写单验收里指代订单分支的固定说法：分支本身由结构化字段给出（GB1） */
export const LEND_BRANCH_TEXT = "本出借单已登记的分支";

/** 开工 / 修复单：外来原文只进 inputs / findings（外发闸逐行引用），标题、验收、回写说明是本机写的 */
export function writeOrderWire(task: LedgerTask, o: WriteOrderInput, split: InputSplit = chunkInputs): OrderWire {
  const bounce = o.step === "fix" ? o.bounce : null;
  const restate = o.step === "write" && o.restate ? o.restate : null;
  const scope = orderFileScope(task);
  const inputs = split([[`规格原文（specRev ${task.specRev}）`, o.spec], ...scope.sources, ...(restate ? [["本机复述原文（PM 还没答复）", restate] as const] : []),
    ...(o.step === "fix" && !bounce && o.report ? [["上一轮审查报告原文", o.report] as const] : [])]);
  // head 只放在 head 字段里：外发闸扫全部自由文本，别处再写一遍 40 位十六进制会被当成疑似密钥整单拒掉
  // 分支同理（GB1）：完整分支名只在 write-order / claim / journal 的结构化字段里（lendBranch / 租约 / 推送 / 交付门逐字核对），
  // 验收自由文本只说「本出借单已登记的分支」——长卡号拼出的分支名会被外发闸当随机串整单拒掉
  const start = o.step === "write" && !o.resume ? `从基线 ${o.base} 切出${LEND_BRANCH_TEXT}（起点是标题里的 head）` : `在${LEND_BRANCH_TEXT}上接着改（起点是标题里的 head）`;
  return lendFixEnv(orderWireOf({
    taskId: task.id, specRev: task.specRev, head: o.head, round: task.round, node: o.step, step: o.step, dedupKey: o.orderId,
    inputs: [...inputs, ...(bounce?.inputs ?? []), standardAnswers("author")],
    outputs: ["分支上的提交（出借服务推送、开 / 更新 PR）", "一行摘要 + 自查（逐条对验收线）"],
    acceptance: [`${start}；工作副本里已检出好，只在这个分支上提交；${scope.acceptance}`, `只动这一个分支：推送由出借服务做，只推${LEND_BRANCH_TEXT}，不推 ${o.base}、不改别的分支`,
      ...(bounce?.acceptance ?? [o.step === "fix" ? "逐条修上一轮审查的问题，自查里写明每条怎么修的" : "按规格与验收线实现，自查逐条对验收线"]),
      ...(restate ? [RESTATE_PENDING_LINE] : []), ...(o.reborrow ? [reborrowMarker(o.reborrow)] : [])],
    writeBack: "提交后用 deliver（M2 前是 lend submit）交一行摘要和自查，单号见标题",
    findings: o.step === "fix" && !bounce ? o.findings : [],
  }, { repo: o.repo, pr: o.pr }), bounce, o.report);
}
