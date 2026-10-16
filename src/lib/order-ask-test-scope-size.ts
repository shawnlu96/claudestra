/**
 * ASKSCOPE3 PM 定 3：经测试类扩围（快路或 ASK4 原路，reason = superseded_assertion）自动批进来的测试文件，交付登记时按 Git blob 核改动尺寸：
 * 单文件增删合计 > 40 行，或整段删掉的 describe( / test( / it( 块多于 1 个，就记「规格外尺寸超限，审查员判」——结果随 deliver_scope 事件
 * （卡上的 note）登记，审查单「已自动核准」小节标红列出（ask-scope-auto-display.ts）。不拒交付、不改审查结论口径。
 * 核不了（没有完整 diff / Git 对象、二进制、base 里没有这个文件）一律按超限标红，交审查员自己核。tests/order-ask-test-scope-size.test.ts。
 */
import type { Database } from "bun:sqlite";
import { removedTestBlocks } from "./ask-scope-auto-diff.js";
import { hasAsksTable } from "./ledger-asks.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { ScopeDiff } from "./order-deliver-scope-git.js";

const TEST_SCOPE_MAX_LINES = 40;
const TEST_SCOPE_MAX_REMOVED_BLOCKS = 1;

interface TestScopeSize { path: string; askId: string; added: number | null; deleted: number | null; removedBlocks: number | null; over: boolean; reason: string | null }
export interface TestScopeEvidence { rule: string; files: TestScopeSize[] }

/** 本卡经测试类扩围自动批准、理由是被规格替代的旧断言的文件 → 批它的 ask（PM 自己答的不算：那是 PM 定的范围） */
function approvedFiles(db: Database, taskId: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!hasAsksTable(db)) return out;
  const rows = db.query(`SELECT id, json_extract(extra, '$.files') AS files FROM asks WHERE taskId = ? AND state = 'answered'
    AND json_extract(extra, '$.autoScope') = 1 AND json_extract(extra, '$.reason') = 'superseded_assertion' ORDER BY createdAt`).all(taskId) as { id: string; files: string | null }[];
  for (const r of rows) {
    const files = (() => { try { return JSON.parse(r.files ?? "[]") as unknown; } catch { return []; } })();
    if (Array.isArray(files)) for (const f of files) if (typeof f === "string" && !out.has(f)) out.set(f, r.id);
  }
  return out;
}

/** 单文件判定：行数来自 PR diff，删块按 base / head 两份 blob 比（null = 核不了） */
export function judgeTestScopeSize(added: number | null, deleted: number | null, removedBlocks: number | null): string | null {
  if (added === null || deleted === null) return "二进制改动，行数不适用";
  if (added + deleted > TEST_SCOPE_MAX_LINES) return `增删合计 ${added + deleted} 行，超过 ${TEST_SCOPE_MAX_LINES} 行`;
  if (removedBlocks === null) return "未能按 blob 核删块";
  if (removedBlocks > TEST_SCOPE_MAX_REMOVED_BLOCKS) return `整段删掉 ${removedBlocks} 个 describe / test / it 块，多于 ${TEST_SCOPE_MAX_REMOVED_BLOCKS} 个`;
  return null;
}

/** 交付登记时调（在事务外，可读 Git 对象）；本卡没有这类文件或交付没改它们 = {}。永不抛出：核不了的按超限标红 */
export async function checkTestScopeSize(db: Database, task: LedgerTask, head: string, diff: ScopeDiff): Promise<{ askScopeTests?: TestScopeEvidence }> {
  let approved: Map<string, string>;
  try { approved = approvedFiles(db, task.id); } catch { return {}; }
  const touched = diff.files.filter((f) => approved.has(f.path));
  if (!touched.length) return {};
  let mergeBase: string | null = null;
  try { if (diff.objects && diff.filesComplete) mergeBase = await diff.objects.mergeBase(diff.base, head); } catch { mergeBase = null; }
  const files: TestScopeSize[] = [];
  for (const f of touched) {
    let blocks: number | null = null;
    if (mergeBase && diff.objects && f.added !== null && f.deleted !== null) {
      try {
        const [base, next] = await Promise.all([diff.objects.show(mergeBase, f.path), diff.objects.show(head, f.path)]);
        blocks = removedTestBlocks(base, next);
      } catch { blocks = null; } // base 里没有（新建）或 head 里删了整个文件：核不了，按超限标红
    }
    const reason = judgeTestScopeSize(f.added, f.deleted, blocks);
    files.push({ path: f.path, askId: approved.get(f.path)!, added: f.added, deleted: f.deleted, removedBlocks: blocks, over: reason !== null, reason });
  }
  return { askScopeTests: { rule: "ask-scope-tests/v1", files } };
}
