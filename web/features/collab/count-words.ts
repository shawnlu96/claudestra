/**
 * 全站四个状态词的唯一口径（team-project-UXNUM1）：数字一律从「谁在干活」的看板模型数，不再各处按阶段自己推。
 * - 在干活 = 看板「在干活」栏的行；在等 = 「在等合并」+「在等」两栏的行；没开工 = 「待做」栏（就绪 + 被挡，按 DAG 节点数）；
 * - 已完成 = 卡在 verified / done（含窗口外的 doneRest）；已取消、本机「老卡」不进这四类；进行中 = 在干活 + 在等。
 * 顶栏、大纲芯片、右栏「现在」与「各阶段」、产品卡、子 DAG 框头、谁在干活栏数都调这里（tests/web-collab-count-words.test.ts 守一致）。
 * 纯函数：看板由 use-dag-panes.tsx 读一份（本机 /work 或团队合并看板），不在这里发请求。
 */
import { COLUMNS, columnOf, type LedgerOverview, type LedgerTaskView, type LineView, type Stage } from "./collab-model";
import { restCount } from "@/lib/api/ledger-done";
import { localColumns } from "./work/team-work-merge";
import type { TeamBoardRow, TeamWorkBoard, WorkBoard } from "./work/work-types";
import type { QuotaLinesView } from "../lend/lend-quota-model";

export interface CountWords { working: number; waiting: number; notStarted: number; done: number }
export type FeatureWords = Omit<CountWords, "done">;
type Row = Pick<TeamBoardRow, "taskId" | "featureId"> & { stage?: Stage | null; step?: string | null };

/** 看板四栏（本机 /work 的三栏经 localColumns 拆出「在等合并」；团队看板本来就是四栏） */
export interface CountBoard { working: readonly Row[]; merging: readonly Row[]; waiting: readonly Row[]; todo: { ready: readonly Row[]; blocked: readonly Row[] } }

export const countBoardOf = (board: WorkBoard | TeamWorkBoard, team: boolean): CountBoard =>
  team ? (board as TeamWorkBoard) : { ...localColumns(board as WorkBoard), todo: board.todo };

const isDone = (t: Pick<LedgerTaskView, "stage">) => t.stage === "done" || t.stage === "verified";
/** 已完成：总览里的 + 窗口外的（大纲「已完成」芯片同一个数） */
export const doneCount = (ov: Pick<LedgerOverview, "tasks" | "doneRest">): number => ov.tasks.filter(isDone).length + restCount(ov, isDone);

const waitingRows = (b: CountBoard) => [...b.merging, ...b.waiting];
const todoRows = (b: CountBoard) => [...b.todo.ready, ...b.todo.blocked];

export interface CountSnap {
  words: CountWords;
  /** 进行中（在干活 + 在等）的卡号：大纲「进行中」芯片列的就是这些 */
  active: ReadonlySet<string>;
  /** 右栏「各阶段」：只数在干活 + 在等的行，各列之和 = working + waiting */
  stages: { label: string; n: number }[];
  /** 按 feature 的在干活 / 在等 / 没开工（产品卡、子 DAG 框头） */
  byFeature: ReadonlyMap<string, FeatureWords>;
}

/**
 * 各阶段按看板事实归列：本机行的有效步骤（step）优先，其次团队行的 stage，都没有才看总览里卡的阶段。
 * 进了在干活 / 在等的规格卡（本机已在复述、团队规格卡有阻塞提问）归「复述」列：右栏不再有规格列，各列之和仍 = 在干活 + 在等
 */
const STEP_STAGE: Record<string, Stage> = { restate: "restate", write: "build", review: "review", fix: "fix", merge: "merge", deploy: "live", publishing: "build" };
const SPEC_COLUMN = 0;
function rowColumn(r: Row, merging: boolean, tasks: ReadonlyMap<string, LedgerTaskView>): number {
  const t = r.taskId ? tasks.get(r.taskId) : undefined;
  const stage = (r.step ? STEP_STAGE[r.step] : undefined) ?? r.stage ?? t?.stage ?? (merging ? "merge" : "build");
  return Math.max(SPEC_COLUMN + 1, columnOf(stage, t?.stageBefore ?? null));
}

export function countSnap(board: CountBoard, ov: Pick<LedgerOverview, "tasks" | "doneRest">): CountSnap {
  const tasks = new Map(ov.tasks.map((t) => [t.id, t]));
  const waiting = waitingRows(board), todo = todoRows(board);
  const n = COLUMNS.map(() => 0);
  for (const r of board.working) n[rowColumn(r, false, tasks)]!++;
  for (const r of board.merging) n[rowColumn(r, true, tasks)]!++;
  for (const r of board.waiting) n[rowColumn(r, false, tasks)]!++;
  const byFeature = new Map<string, FeatureWords>();
  const bump = (rows: readonly Row[], k: keyof FeatureWords) => {
    for (const r of rows) {
      // 团队卡没绑节点时 featureId 为空：按总览里卡所属的 feature（itemId）归
      const f = r.featureId ?? (r.taskId ? tasks.get(r.taskId)?.itemId : null);
      if (!f) continue;
      const cur = byFeature.get(f) ?? { working: 0, waiting: 0, notStarted: 0 };
      byFeature.set(f, { ...cur, [k]: cur[k] + 1 });
    }
  };
  bump(board.working, "working");
  bump(waiting, "waiting");
  bump(todo, "notStarted");
  return {
    words: { working: board.working.length, waiting: waiting.length, notStarted: todo.length, done: doneCount(ov) },
    active: new Set([...board.working, ...waiting].flatMap((r) => (r.taskId ? [r.taskId] : []))),
    stages: COLUMNS.map((label, i) => ({ label, n: n[i]! })).filter((c) => c.n > 0),
    byFeature,
  };
}

const NONE: FeatureWords = { working: 0, waiting: 0, notStarted: 0 };
export const featureWords = (snap: CountSnap, featureId: string): FeatureWords => snap.byFeature.get(featureId) ?? NONE;

/** 右栏「其中 N 条出问题 / 卡住」：沿用 homeView 的 attention，只数进行中的卡（标注，不另成一类） */
export function attentionOf(snap: CountSnap, lines: readonly Pick<LineView, "id" | "attention">[]): { problem: number; stuck: number } {
  const on = lines.filter((l) => snap.active.has(l.id));
  return { problem: on.filter((l) => l.attention === "problem").length, stuck: on.filter((l) => l.attention === "stuck").length };
}

/**
 * 计数源的状态：loading = 还没载完（显示骨架，不出任何数字）；ready = 出数，missing = 20 秒后仍没读到详情的 feature 数（> 0 时出提示）。
 * none = 这个源读不到看板（老 bridge 没有 /work、读失败且手上没有上一份，或已超时）：状态词不出数字也不出骨架，已知指标照常出
 */
export type CountState = { status: "loading" } | { status: "none" } | { status: "ready"; snap: CountSnap; missing: number };
export const snapOf = (c: CountState | null | undefined): CountSnap | null => (c?.status === "ready" ? c.snap : null);

interface TeamLast { list: { features: readonly { id: string }[] }; details: ReadonlyMap<string, unknown> }
/** 团队源列表里还没拉到详情的 feature 数；不是团队源（没有 last，team-source-shared.ts SharedSource 才有）= 0，列表还没读到 = null */
export function missingFeatures(source: object): number | null {
  if (!("last" in source) || typeof source.last !== "function") return 0;
  const got = (source.last as () => TeamLast | null)();
  return got ? got.list.features.filter((f) => !got.details.has(f.id)).length : null;
}

export interface QuotaFamilyPct { family: string; pct: number }
const FAMILY_NAME: Record<string, string> = { claude: "Claude", codex: "Codex" };
/** 每族的本周已用百分比；某族为空就略去；一族都没有 = null（整格不出） */
export function quotaPcts(view: QuotaLinesView | null): QuotaFamilyPct[] | null {
  const out = (view?.families ?? []).flatMap((f) => (f.weekUsedPct === null ? [] : [{ family: FAMILY_NAME[f.family] ?? f.family, pct: Math.round(f.weekUsedPct) }]));
  return out.length ? out : null;
}
