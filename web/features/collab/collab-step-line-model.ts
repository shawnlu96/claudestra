/**
 * 协作视图的步骤线（T51）：一张卡从复述到核对的整条线，每一步谁在做（本机 agent / 人 / agent@实例）、模型、状态、
 * 交付的 head 区间、结论；本机真校验过的（verified）和对方自报的（claims）分开。当前这一步和三种等待（卡住 / 等对方 owner /
 * 等审查）也在这里判。数据是 bridge 给的 stepLine（src/lib/ledger-step-line.ts：steps + active + awaitingPeerOwner），
 * 形状不可信：未知字段丢掉，老 bridge 没有 stepLine = null。纯函数，单测 tests/web-collab-step-line.test.ts。
 */

/** 线上的 7 格：初审、终审合成「审查」一格（显示轮次大的那一次，同一轮终审优先，与 bridge currentReview 同口径） */
export const SLOT_KEYS = ["restate", "write", "review", "fix", "ui_check", "merge", "verify"] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
export const SLOT_LABEL: Record<SlotKey, string> = {
  restate: "复述", write: "写", review: "审查", fix: "修", ui_check: "看界面", merge: "合并部署", verify: "核对",
};
export type SlotState = "assigned" | "delivered" | "done";
export type WaitKind = "blocked" | "owner" | "review";

export interface StepSlot {
  key: SlotKey;
  label: string;
  /** 这一步有没有人（没派 = 空位） */
  filled: boolean;
  /** 去掉 agent- 前缀、去掉 @实例 的名字 */
  executor: string | null;
  /** 别的实例的名字（executor 是 agent@实例）；本机 = null */
  instance: string | null;
  kind: "agent" | "human" | "peer" | null;
  state: SlotState | null;
  round: number;
  heads: string | null;
  verdict: "pass" | "changes" | "block" | null;
  /** 老卡按负责人推出来的，库里没有这一行 */
  derived: boolean;
  /** 审查格里显示的是终审 */
  final: boolean;
  /** 本机核过的一句（zh 原文），比如「审的人不是写的人」 */
  verified: string | null;
  /** 模型：本机 agent 从会话列表查（真的），别的实例的是对方自报（凭声明） */
  model: { name: string; claimed: boolean } | null;
  current: boolean;
}

export interface StepLineView {
  slots: StepSlot[];
  current: StepSlot | null;
  wait: WaitKind | null;
  /** 在等但没有哪一格是当前（进了 review 还没派审查员、卡住的那一步没派人）：详情里单独挂在线上方，不然只有列表看得到 */
  looseWait: WaitKind | null;
  /** 全是推出来的（老卡）：整条线标「推断」 */
  derivedOnly: boolean;
}

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const short = (h: unknown): string | null => (typeof h === "string" && h ? h.slice(0, 8) : null);
const STATES: readonly string[] = ["assigned", "delivered", "done"];

function verifiedOf(v: Row): string | null {
  if (v.reviewerNotAuthor === true) return "本机核过：审的人不是写的人";
  if (v.reviewerNotAuthor === null && typeof v.why === "string") return v.why === "作者未知" ? "作者未知" : "同一实例，凭对方声明";
  return null;
}

/** 同一步取轮次最大的；审查格在 review / final_review 里取轮次大的，同一轮终审优先 */
function pick(rows: readonly Row[], key: SlotKey): Row | null {
  const names = key === "review" ? ["final_review", "review"] : [key];
  let best: Row | null = null;
  for (const r of rows) {
    if (!names.includes(String(r.step))) continue;
    const better = !best || Number(r.round) > Number(best.round) || (Number(r.round) === Number(best.round) && r.step === "final_review");
    if (better) best = r;
  }
  return best;
}

function slotOf(key: SlotKey, r: Row | null, active: Row, modelOf: (agent: string) => string | null): StepSlot {
  const empty: StepSlot = {
    key, label: SLOT_LABEL[key], filled: false, executor: null, instance: null, kind: null, state: null, round: 0, heads: null,
    verdict: null, derived: false, final: false, verified: null, model: null, current: false,
  };
  if (!r || typeof r.executor !== "string" || !r.executor) return empty;
  const kind = r.executorKind === "peer" || r.executorKind === "human" ? r.executorKind : "agent";
  const at = kind === "peer" ? r.executor.lastIndexOf("@") : -1;
  const name = (at > 0 ? r.executor.slice(0, at) : r.executor).replace(/^agent-/, "");
  const claimed = obj(r.claims).model;
  const local = kind === "agent" ? modelOf(r.executor) : null;
  const from = short(r.headFrom), to = short(r.headTo);
  const v = r.verdict;
  return {
    ...empty,
    filled: true,
    executor: name,
    instance: at > 0 ? r.executor.slice(at + 1) : null,
    kind,
    state: STATES.includes(String(r.state)) ? (r.state as SlotState) : null,
    round: Number(r.round) || 0,
    heads: to ? (from && from !== to ? `${from}..${to}` : to) : null,
    verdict: v === "pass" || v === "changes" || v === "block" ? v : null,
    derived: r.derived === true,
    final: r.step === "final_review",
    verified: verifiedOf(obj(r.verified)),
    model: typeof claimed === "string" && claimed ? { name: claimed, claimed: true } : local ? { name: local, claimed: false } : null,
    current: active.step === r.step && Number(active.round) === Number(r.round),
  };
}

/** bridge 的 stepLine + 卡的阶段 → 一条线；modelOf 按本机 agent 名查它现在的模型（查不到 null） */
export function stepLineView(info: unknown, stage: string, modelOf: (agent: string) => string | null = () => null): StepLineView | null {
  const i = obj(info);
  if (!Array.isArray(i.steps)) return null;
  const rows = i.steps.map(obj).filter((r) => typeof r.step === "string");
  const active = obj(i.active);
  const slots = SLOT_KEYS.map((k) => slotOf(k, pick(rows, k), active, modelOf));
  const wait: WaitKind | null = stage === "blocked" ? "blocked" : i.awaitingPeerOwner === true ? "owner" : stage === "review" ? "review" : null;
  const filled = slots.filter((s) => s.filled);
  const current = slots.find((s) => s.current) ?? null;
  return { slots, current, wait, looseWait: current ? null : wait, derivedOnly: filled.length > 0 && filled.every((s) => s.derived) };
}

/** 等待的一句（zh 原文）：列表里跟在当前步骤后面、详情里标在当前格上 */
export const WAIT_LABEL: Record<WaitKind, string> = { blocked: "卡住了", owner: "等对方 owner 同意", review: "等审查" };
