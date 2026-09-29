/**
 * 协作详情的「步骤」段（T47 步骤化台账，src/lib/ledger-steps.ts）：每一步谁在做、交付的 head 区间、结论，
 * 本机真校验过的（作者 ≠ 审查人）和对方自报的（模型）分开标。只画派过步骤的卡；老卡（全是推出来的）不出这一段。
 * 形状照 GET /api/v1/ledger/:project/tasks/:id 的 steps，未知字段丢掉。单测 tests/web-collab-steps.test.ts。
 */

export interface StepRow {
  step: string;
  label: string;
  round: number;
  executor: string;
  peer: boolean;
  state: string;
  heads: string | null;
  verdict: "pass" | "changes" | "block" | null;
  /** 本机核过的一句（zh 原文）；没有 = null */
  checked: string | null;
  /** 对方自报的模型（凭声明） */
  claimedModel: string | null;
}

const LABEL: Record<string, string> = {
  restate: "复述", write: "写", review: "初审", fix: "修", final_review: "终审", ui_check: "看界面", merge: "合并部署", verify: "核对",
};
const ORDER = Object.keys(LABEL);
export const STEP_STATE: Record<string, string> = { assigned: "已派", delivered: "已交付", done: "已完成" };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const short = (h: unknown): string | null => (typeof h === "string" && h ? h.slice(0, 8) : null);

function checkedOf(v: Record<string, unknown>): string | null {
  if (v.reviewerNotAuthor === true) return "本机核过：审的人不是写的人";
  if (v.reviewerNotAuthor === null && typeof v.why === "string") return v.why === "作者未知" ? "作者未知" : "同一实例，凭对方声明";
  return null;
}

/** API 的 steps → 显示行；全是推出来的（老卡）返回 [] */
export function stepRows(steps: unknown): StepRow[] {
  const list = Array.isArray(steps) ? steps.map(obj) : [];
  if (!list.some((s) => s.derived !== true)) return [];
  return list
    .filter((s) => typeof s.step === "string" && Object.hasOwn(LABEL, s.step) && typeof s.executor === "string")
    .sort((a, b) => ORDER.indexOf(String(a.step)) - ORDER.indexOf(String(b.step)) || Number(a.round) - Number(b.round))
    .map((s) => {
      const from = short(s.headFrom), to = short(s.headTo);
      const v = s.verdict;
      const model = obj(s.claims).model;
      return {
        step: String(s.step),
        label: LABEL[String(s.step)]!,
        round: Number(s.round) || 0,
        executor: String(s.executor).replace(/^agent-/, ""),
        peer: s.executorKind === "peer",
        state: String(s.state ?? ""),
        heads: to ? (from ? `${from}..${to}` : to) : null,
        verdict: v === "pass" || v === "changes" || v === "block" ? v : null,
        checked: checkedOf(obj(s.verified)),
        claimedModel: typeof model === "string" && model ? model : null,
      };
    });
}
