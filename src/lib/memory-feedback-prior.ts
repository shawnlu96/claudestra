/**
 * PMEMTUNE2 · 跨卡无关降权（恢复键 memoryFeedbackPrior）：别的卡交付时在 memoryRefs 里标的 applied / irrelevant，按记忆汇总成一个
 * 排序先验乘子，memory-retrieve.ts 在现有先验（总结衰减、文件消失）上再乘它。纯函数：汇总的那一次查库在 memory-retrieve.ts。
 * - 平滑 (applied + 1) / (applied + irrelevant + 2)，以「没有信息」的 0.5 为基准折成乘子（×2、封顶 1）：applied 不少于 irrelevant 的不降，
 *   标记衰减到几乎没权重时回到 1（不折算的话，标过 3 次的记忆即使全是 applied 也 ≤0.8、衰减后一律停在 0.5）；标记少于 3 次不降权（= 1）；
 * - 每条标记按 30 天半衰期加权（30 天前的算半条）；
 * - 下限 0.2：再无关也不会永远出不来（memory-retrieve.ts 的绝对下限 SCORE_FLOOR 按乘它之前的分判，它只影响名次和相对阈值）；
 * - wrong 仍走 memory-tools-refs.ts 的 dispute 排除，不并进这里。
 * docs/architecture/project-memory-relevance.md；tests/memory-feedback-prior.test.ts。
 */

const DAY_MS = 86_400_000;
const FEEDBACK_HALF_LIFE_DAYS = 30;
const FEEDBACK_MIN_SAMPLES = 3;
export const FEEDBACK_FLOOR = 0.2;
export const UNRELATED_WEIGHT = 0.25;

/** 一次标记：哪种用法、什么时候标的 */
export interface FeedbackMark { use: "applied" | "irrelevant"; ts: number; weight?: number }

/** 先验乘子，∈ [0.2, 1] */
export function feedbackPrior(marks: readonly FeedbackMark[], now: number, floor = FEEDBACK_FLOOR): number {
  if (marks.length < FEEDBACK_MIN_SAMPLES) return 1;
  let applied = 0, irrelevant = 0;
  for (const m of marks) {
    const w = (m.weight ?? 1) * 0.5 ** (Math.max(0, now - m.ts) / DAY_MS / FEEDBACK_HALF_LIFE_DAYS);
    if (m.use === "applied") applied += w;
    else irrelevant += w;
  }
  return Math.max(floor, Math.min(1, (2 * (applied + 1)) / (applied + irrelevant + 2)));
}

/** refs 事件的一行（events.kind = 'memory'，data.op = 'refs'，见 memory-tools-refs.ts） */
export interface RefsRow { target: string; ts: number; data: string | null }

/**
 * 按 memoryId 汇总 refs 事件里的 applied / irrelevant；wrong 和坏行跳过。excludeTask = 本卡自己的标记不算（只认别的卡）。
 */
export function marksByMemory(rows: readonly RefsRow[], excludeTask?: string, weightOf?: (target: string) => number): Map<string, FeedbackMark[]> {
  const out = new Map<string, FeedbackMark[]>();
  for (const r of rows) {
    if (excludeTask !== undefined && r.target === excludeTask) continue;
    let refs: unknown;
    try { refs = r.data ? (JSON.parse(r.data) as { refs?: unknown }).refs : undefined; } catch { continue; }
    if (!Array.isArray(refs)) continue;
    for (const ref of refs as { id?: unknown; use?: unknown }[]) {
      if (typeof ref?.id !== "string" || (ref.use !== "applied" && ref.use !== "irrelevant")) continue;
      const list = out.get(ref.id) ?? [];
      list.push({ use: ref.use, ts: r.ts, ...(weightOf ? { weight: weightOf(r.target) } : {}) });
      out.set(ref.id, list);
    }
  }
  return out;
}
