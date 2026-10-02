/**
 * 记忆的当前状态 = 按固定全序折叠 marks（设计稿 docs/design/project-memory.md §1.2）。纯函数、无 bun 依赖：
 * 先按 (ts, origin, originSeq) 排好再依次应用，所以任何两端拿到同一个 mark 集合都算出同一个状态，与到达 / 传入顺序无关
 * （tests/ledger-memory-fold.test.ts 的性质测试）。权限（谁能打哪种 mark）在写入层与工具层，这里只认「打了什么」。
 *
 *   candidate --confirm--> open
 *   open --link_fix--> fixing --fixed--> fixed --reopen--> open（保留修复关联：同一张卡再上线再 fixed）
 *   fixing --unlink_fix--> open（清修复关联）
 *   任意 --dispute--> 同状态 + disputed（人工 confirm 清掉；自动 confirm 只加来源、不清）
 *   任意 --retract / supersede--> 终态（之后的 marks 只记录不生效）
 *
 * link_fix / unlink_fix / fixed / reopen 只对 fixable = 1 的坑生效；对不上当前状态或修复卡的 mark 记录但不生效。
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

function apply(m: FoldMemory, st: MemoryState, mk: FoldMark): MemoryState {
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
      return fixablePitfall && st.status === "open" && mk.taskId ? { ...st, status: "fixing", fixTask: mk.taskId } : st;
    case "unlink_fix":
      return fixablePitfall && st.status === "fixing" && (mk.taskId === null || mk.taskId === st.fixTask) ? { ...st, status: "open", fixTask: null } : st;
    case "fixed":
      return fixablePitfall && (st.status === "fixing" || st.status === "open") && st.fixTask !== null && mk.taskId === st.fixTask ? { ...st, status: "fixed" } : st;
    case "reopen":
      return fixablePitfall && st.status === "fixed" && mk.taskId === st.fixTask ? { ...st, status: "open" } : st;
  }
}

/** 当前状态；marks 里别的记忆的行忽略，传入顺序无关 */
export function memoryStatus(memory: FoldMemory, marks: readonly FoldMark[]): MemoryState {
  const mine = marks.filter((k) => k.memoryId === memory.id).sort(compareMarks);
  let st: MemoryState = { status: initialStatus(memory), disputed: false, fixTask: null, supersededBy: null };
  for (const mk of mine) st = apply(memory, st, mk);
  return st;
}
