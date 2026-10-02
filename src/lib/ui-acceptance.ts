/**
 * 带界面的 feature 的整页验收（i28-UIQ1）：子 DAG 里只要有 ui 节点，就由系统维护一个收尾节点 PAGEOK，依赖全部 ui 节点；
 * 它是 PM 的验收卡（没有文件范围，不会被自动开卡），没 verified 之前 feature 不能改成 done。
 * 写入点：dag-init / dag-rewrite 落库前（ledger-feature-write.ts / ledger-dag-write.ts），feature 完成判定在 setFeature。
 * ui 卡的审查单另附规格的「对照基准」一节和 UI_BASIS_RULE（order-standard-answers.ts）。tests/ui-acceptance.test.ts。
 */
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { cardNames } from "./ledger-card-names.js";
import { nodePhase, type NodePhase } from "./ledger-dag-rules.js";
import { effectiveNodes, getDagVersion, PLANNED, type DagNode, type Feature } from "./ledger-feature.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask, LedgerError } from "./ledger-store.js";
import { specSection } from "./review-pack.js";
import { isUiSpec } from "./spec-lint.js";
import { readTextSoft, specPathFor } from "./task-spec.js";

export const PAGE_CHECK_KEY = "PAGEOK";
const PAGE_CHECK_LINE = "整页验收（PM）：中继 + owner 设备 + 生产数据，和对照基准同屏截图逐栏对台账";
/** PAGEOK 卡的验收清单（固定）：feature 改 done 被拒时随说明给 PM，开这张卡时照抄进规格 */
const PAGE_CHECK_LIST = [
  "经中继（不是本机直连）打开入口",
  "用 owner 的设备视角（同尺寸 / 同主题）",
  "用生产数据，不用短标题夹具",
  "和规格里的对照基准同屏截图",
  "逐栏对照台账真实状态（标题、计数、状态、顺序）",
] as const;

/** 规格卡目录跟着台账库走（库在 <state>/ledger.sqlite，规格卡在 <state>/ledger/docs/tasks/）；内存库没有规格卡 */
function specDirOf(db: Database): string | null {
  return db.filename && db.filename !== ":memory:" ? join(dirname(db.filename), "ledger", "docs", "tasks") : null;
}

/** 绑的卡 workflow 模板是 ui，或节点规格卡卡首写了「模板：ui」 */
function isUiNode(db: Database, f: Feature, n: DagNode, readSpec?: (taskId: string) => string | null): boolean {
  if (n.taskId && getWorkflow(db, n.taskId)?.template === "ui") return true;
  const taskId = n.taskId ?? cardNames(db, f, n.key, n).taskId;
  const dir = specDirOf(db);
  return isUiSpec(readSpec ? readSpec(taskId) : dir ? readTextSoft(join(dir, `${taskId}.md`)) : null);
}

const phaseOf = (db: Database, n: DagNode): NodePhase => nodePhase(n.taskId, n.taskId ? (getTask(db, n.taskId)?.stage ?? null) : null);

/** 写入的原始节点里剔掉 PAGEOK：它由 withPageCheck 维护，不收调用方给的 */
export const dropPageCheck = (raw: unknown): unknown =>
  Array.isArray(raw) ? raw.filter((x) => !(x && typeof x === "object" && (x as { key?: unknown }).key === PAGE_CHECK_KEY)) : raw;

/**
 * 落库前把 PAGEOK 摆对：有 ui 节点 → 有且只有一个，依赖 = 全部 ui 节点（排序）；没有 ui 节点且它还没开工 → 移除。
 * PAGEOK 只认当前版本那一份（PM 传进来的由 dropPageCheck 先剔掉，免得它的旧依赖指向刚删的节点）；已完成的原样带入（重写规矩要求）。
 * cur = 当前版本节点（dag-init 为 null）。
 */
export function withPageCheck(db: Database, f: Feature, next: DagNode[], cur: readonly DagNode[] | null,
  readSpec?: (taskId: string) => string | null): DagNode[] {
  const page = cur?.find((n) => n.key === PAGE_CHECK_KEY);
  const rest = next.filter((n) => n.key !== PAGE_CHECK_KEY);
  const phase = page ? phaseOf(db, page) : "idle";
  if (page && phase === "done") return [...rest, page];
  const ui = rest.filter((n) => isUiNode(db, f, n, readSpec)).map((n) => n.key).sort();
  if (!ui.length && phase === "idle") return rest;
  const base: DagNode = { key: PAGE_CHECK_KEY, taskId: null, oneLine: PAGE_CHECK_LINE, deps: [], status: PLANNED, estimate: "", inheritedFrom: null };
  return [...rest, { ...base, ...page, deps: ui, inheritedFrom: null }];
}

/** feature 改成 done 之前：当前版本有 PAGEOK 就要它绑的卡已 verified / done，否则拒（说明缺哪个节点） */
export function requirePageCheck(db: Database, f: Feature): void {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const page = v ? effectiveNodes(db, v).find((n) => n.key === PAGE_CHECK_KEY) : null;
  if (!page) return;
  const stage = page.taskId ? getTask(db, page.taskId)?.stage : null;
  if (stage === "verified" || stage === "done") return;
  const where = page.taskId ? `卡 ${page.taskId} 在 ${stage ?? "找不到"}` : "没绑卡";
  throw new LedgerError("conflict", `feature ${f.id} 的整页验收节点 ${PAGE_CHECK_KEY} 还没 verified（${where}），不能改成 done。验收清单：${PAGE_CHECK_LIST.join("；")}`);
}

/**
 * ui 卡审查单上的「对照基准」一节（并进标准答复那一项）；不是 ui 卡为 undefined，审查单逐字不变。
 * specText 不给就按卡上的规格路径读；规格没写对照基准时明说，审查员按 UI_BASIS_RULE 报 P1。
 */
export function uiReviewBasis(db: Database | undefined, task: LedgerTask, specText?: string | null): string | undefined {
  const text = specText !== undefined ? specText : readTextSoft(specPathFor(task, db ? getMeta(db, task.project).docsDir : null));
  if (!(db && getWorkflow(db, task.id)?.template === "ui") && !isUiSpec(text)) return undefined;
  const basis = text ? specSection(text, "对照基准") : [];
  return ["对照基准（规格原文，逐项对照截图审）：", ...(basis.length ? basis : ["（规格没写「## 对照基准」）"])].join("\n");
}
