/**
 * v4 的选中状态只存稳定的键（任务 id / 依赖的「前置>后置」/ 折叠组 id），每次渲染从当前总览和画布里解析：
 * 存整份 dep / fold 快照的话，刷新后属性页还显示旧的状态、条件和成员，删掉的关系也一直留着。解析不到 = 目标没了，调用方清掉选择。
 * 单测 tests/web-collab-v4-model.test.ts。
 */
import type { LedgerDepView, LedgerOverview } from "../collab-model";
import type { Canvas, CFold } from "./causal-model";

/** 选中了什么：任务、边（一根线可能合了好几条依赖，按依赖的键记）、折叠组、「待你处理」 */
export type Selection = { kind: "task"; id: string } | { kind: "edge"; keys: string[] } | { kind: "fold"; id: string } | { kind: "waits" } | null;
export type Resolved = { kind: "edge"; deps: LedgerDepView[] } | { kind: "fold"; fold: CFold } | { kind: "waits" } | null;

export const depKey = (d: Pick<LedgerDepView, "from" | "to">) => `${d.from}>${d.to}`;
export const edgeSel = (deps: readonly LedgerDepView[]): Selection => ({ kind: "edge", keys: deps.map(depKey) });

/** 任务选中走任务详情（openTask），这里只管其余几种；目标全没了 = null */
export function resolveSelection(sel: Selection, ov: Pick<LedgerOverview, "deps">, canvas: Pick<Canvas, "groups">): Resolved {
  if (!sel || sel.kind === "task") return null;
  if (sel.kind === "waits") return sel;
  if (sel.kind === "edge") {
    const deps = (ov.deps ?? []).filter((d) => sel.keys.includes(depKey(d)));
    return deps.length ? { kind: "edge", deps } : null;
  }
  const fold = canvas.groups.flatMap((g) => g.folds).find((f) => f.id === sel.id);
  return fold ? { kind: "fold", fold } : null;
}

/** 窄屏（手机）此刻整屏显示哪一页：任务详情优先，其次边 / 折叠组 / 待你处理，都没有是列表 */
export function narrowPane(openTask: string | null, r: Resolved): "detail" | "edge" | "fold" | "waits" | "list" {
  return openTask ? "detail" : r?.kind ?? "list";
}
