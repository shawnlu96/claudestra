/**
 * 记忆的当前状态 = 按固定全序折叠 marks（设计稿 docs/design/project-memory.md §1.2）。纯函数、无 bun 依赖：
 * 先按 (ts, origin, originSeq) 排好再依次应用，所以任何两端拿到同一个 mark 集合都算出同一个状态，与到达 / 传入顺序无关
 * （tests/ledger-memory-fold.test.ts 的性质测试）。权限（谁能打哪种 mark）在写入层与工具层，这里只认「打了什么」。
 *
 *   candidate --confirm--> open
 *   open --link_fix--> fixing --fixed--> fixed --reopen--> open（保留修复关联：同一张卡再上线再 fixed）
 *   fixing / open（回滚后仍带修复关联）--unlink_fix--> open（清修复关联）
 *   任意 --dispute--> 同状态 + disputed（人工 confirm 清掉；自动 confirm 只加来源、不清）
 *   任意 --retract / supersede--> 终态（之后的 marks 只记录不生效）
 *
 * link_fix / unlink_fix / fixed / reopen 只对 fixable = 1 的坑生效；对不上当前状态或修复卡的 mark 记录但不生效。
 * fixed / reopen 是修复卡上线 / 回滚的观察，生效看来源事件的先后而不是观察时间：同一修复卡上，来源不比已生效的那条新的
 * fixed / reopen 不生效（晚到的旧回滚不会把再上线的坑重开）。两条来源可比 = 同为 {origin, originSeq} 且 origin 相同，或同为 {seq}；
 * 不可比（没带来源、来源形状不同）时退回按观察时间。来源最新的是回滚就是 open，哪怕它更早的那次上线晚到、还没折进来。
 * 回滚后对同一张卡重新 link_fix 不清来源水位（只有 unlink_fix 或换卡才清）。
 */
import type { MemoryAuthorRole, MemoryKind, MemoryMarkKind, MemoryVia } from "./ledger-memory-schema.js";

const MEMORY_STATUSES = ["candidate", "open", "fixing", "fixed", "retracted", "superseded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 折叠要用到的记忆字段 */
export interface FoldMemory {
  id: string;
  kind: MemoryKind;
  fixable: boolean | null;
  via: MemoryVia;
  authorRole: MemoryAuthorRole;
}

/** 来源事件引用：有 origin 的用 {origin, originSeq}；老事件没有 origin 的用 {seq}，只在本机有效 */
export type MemorySourceRef = { origin: string; originSeq: number } | { seq: number };

/** 折叠要用到的 mark 字段 */
export interface FoldMark {
  memoryId: string;
  origin: string;
  originSeq: number;
  ts: number;
  mark: MemoryMarkKind;
  taskId: string | null;
  by: string | null;
  dedupKey: string | null;
  /** 触发它的事件；fixed / reopen 按它定先后 */
  source?: MemorySourceRef | null;
}

export interface MemoryState {
  status: MemoryStatus;
  disputed: boolean;
  /** 关联的修复卡：link_fix 设上、unlink_fix 清掉；reopen 后仍保留（同一张卡再上线还能 fixed） */
  fixTask: string | null;
  supersededBy: string | null;
}

/** 自动 mark 的 dedupKey 前缀（设计稿 §1.2：`auto:<mark>:<memoryId>:<taskId>:<来源事件>`） */
const AUTO_MARK_PREFIX = "auto:";

/** 执行者写的、自动沉淀的（p1_family）从 candidate 起步；PM / 审查员 / owner / 系统确认的写入直接 open */
export function initialStatus(m: Pick<FoldMemory, "via" | "authorRole">): MemoryStatus {
  return m.authorRole === "executor" || m.via === "p1_family" ? "candidate" : "open";
}

/** 全序比较：ts，再 origin，再 originSeq（(origin, originSeq) 是主键，不会平局） */
function compareMarks(a: FoldMark, b: FoldMark): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  return a.originSeq - b.originSeq;
}

const isTerminal = (s: MemoryStatus) => s === "retracted" || s === "superseded";

/** a 的来源是否不比 b 新；不可比返回 false */
function notNewer(a: MemorySourceRef | null | undefined, b: MemorySourceRef | null): boolean {
  if (!a || !b) return false;
  if ("seq" in a && "seq" in b) return a.seq <= b.seq;
  if ("origin" in a && "origin" in b && a.origin === b.origin) return a.originSeq <= b.originSeq;
  return false;
}

/** 折叠过程的状态：fixSource = 当前修复卡上已生效的最新 fixed / reopen 来源 */
type FoldState = MemoryState & { fixSource: MemorySourceRef | null };

function apply(m: FoldMemory, st: FoldState, mk: FoldMark): FoldState {
  if (isTerminal(st.status)) return st;
  const fixablePitfall = m.kind === "pitfall" && m.fixable === true;
  switch (mk.mark) {
    case "confirm": {
      const auto = mk.dedupKey?.startsWith(AUTO_MARK_PREFIX) ?? false;
      return { ...st, status: st.status === "candidate" ? "open" : st.status, disputed: auto ? st.disputed : false };
    }
    case "dispute":
      return { ...st, disputed: true };
    case "retract":
      return { ...st, status: "retracted" };
    case "supersede":
      return { ...st, status: "superseded", supersededBy: mk.by };
    case "link_fix":
      // 回滚后重新关联同一张卡：保留来源水位，迟到的旧上线仍拦得住；换卡才清零
      return fixablePitfall && st.status === "open" && mk.taskId
        ? { ...st, status: "fixing", fixTask: mk.taskId, fixSource: mk.taskId === st.fixTask ? st.fixSource : null }
        : st;
    case "unlink_fix":
      return fixablePitfall && (st.status === "fixing" || st.status === "open") && st.fixTask !== null && (mk.taskId === null || mk.taskId === st.fixTask)
        ? { ...st, status: "open", fixTask: null, fixSource: null }
        : st;
    case "fixed":
    case "reopen": {
      if (!fixablePitfall || st.fixTask === null || mk.taskId !== st.fixTask || notNewer(mk.source, st.fixSource)) return st;
      const fixSource = mk.source ?? st.fixSource;
      if (mk.mark === "fixed") return { ...st, status: "fixed", fixSource };
      return { ...st, status: "open", fixSource };
    }
  }
}

/** 当前状态；marks 里别的记忆的行忽略，传入顺序无关 */
export function memoryStatus(memory: FoldMemory, marks: readonly FoldMark[]): MemoryState {
  const mine = marks.filter((k) => k.memoryId === memory.id).sort(compareMarks);
  let st: FoldState = { status: initialStatus(memory), disputed: false, fixTask: null, supersededBy: null, fixSource: null };
  for (const mk of mine) st = apply(memory, st, mk);
  const { fixSource: _, ...state } = st;
  return state;
}
