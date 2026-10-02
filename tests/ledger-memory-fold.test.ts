/** 记忆状态折叠（pmem-M1 验收线 3）：转移表逐条 + 「结果与 marks 排列顺序无关」性质测试（固定种子随机生成，可复现） */
import { describe, expect, test } from "bun:test";
import { initialStatus, memoryStatus, type FoldMark, type FoldMemory } from "../src/lib/ledger-memory-fold.js";
import { MEMORY_MARKS, type MemoryMarkKind } from "../src/lib/ledger-memory-schema.js";

const PIT: FoldMemory = { id: "ab12-m3", kind: "pitfall", fixable: true, via: "tool", authorRole: "reviewer" };
let seq = 0;
const mk = (mark: MemoryMarkKind, ts: number, extra: Partial<FoldMark> = {}): FoldMark => ({
  memoryId: PIT.id, origin: "ab12", originSeq: ++seq, ts, mark, taskId: null, by: null, dedupKey: null, ...extra,
});

describe("初始状态", () => {
  test("执行者写的、自动沉淀的 = candidate；PM / 审查员 / owner / 系统 = open", () => {
    expect(initialStatus({ via: "tool", authorRole: "executor" })).toBe("candidate");
    expect(initialStatus({ via: "p1_family", authorRole: "system" })).toBe("candidate");
    for (const r of ["reviewer", "pm", "owner"] as const) expect(initialStatus({ via: "tool", authorRole: r })).toBe("open");
    expect(initialStatus({ via: "verify_summary", authorRole: "system" })).toBe("open");
  });
});

describe("转移", () => {
  test("§4.4：link_fix → fixing → fixed；上线 → 回滚 → 再上线（lifecycle-reopen）：fixed → open（保留修复关联）→ fixed", () => {
    const link = mk("link_fix", 1, { taskId: "N1f" });
    const fixed = mk("fixed", 2, { taskId: "N1f", dedupKey: "auto:fixed:ab12-m3:N1f:ab12/812" });
    expect(memoryStatus(PIT, [link])).toMatchObject({ status: "fixing", fixTask: "N1f" });
    expect(memoryStatus(PIT, [link, fixed]).status).toBe("fixed");
    const reopen = mk("reopen", 3, { taskId: "N1f" });
    expect(memoryStatus(PIT, [link, fixed, reopen])).toMatchObject({ status: "open", fixTask: "N1f" });
    const refixed = mk("fixed", 4, { taskId: "N1f" });
    expect(memoryStatus(PIT, [link, fixed, reopen, refixed]).status).toBe("fixed");
  });

  test("fixed 只认关联过的修复卡；unlink_fix 清关联回 open，之后的 fixed 不生效", () => {
    const link = mk("link_fix", 1, { taskId: "N1f" });
    expect(memoryStatus(PIT, [link, mk("fixed", 2, { taskId: "OTHER" })]).status).toBe("fixing");
    expect(memoryStatus(PIT, [mk("fixed", 2, { taskId: "N1f" })]).status).toBe("open");
    const un = mk("unlink_fix", 2, { taskId: "N1f" });
    expect(memoryStatus(PIT, [link, un])).toMatchObject({ status: "open", fixTask: null });
    expect(memoryStatus(PIT, [link, un, mk("fixed", 3, { taskId: "N1f" })]).status).toBe("open");
  });

  test("修复类 mark 只对 fixable 坑生效", () => {
    const rule = { ...PIT, fixable: false };
    expect(memoryStatus(rule, [mk("link_fix", 1, { taskId: "N1f" }), mk("fixed", 2, { taskId: "N1f" })]).status).toBe("open");
    const sum: FoldMemory = { ...PIT, kind: "summary", fixable: null };
    expect(memoryStatus(sum, [mk("link_fix", 1, { taskId: "N1f" })]).status).toBe("open");
  });

  test("candidate --confirm--> open；candidate 上 link_fix 不生效", () => {
    const cand = { ...PIT, authorRole: "executor" as const };
    expect(memoryStatus(cand, [mk("link_fix", 1, { taskId: "N1f" })]).status).toBe("candidate");
    expect(memoryStatus(cand, [mk("confirm", 1)]).status).toBe("open");
  });

  test("dispute 加标不改状态；人工 confirm 清标，自动 confirm（auto:）只加来源不清标", () => {
    const d = mk("dispute", 1);
    expect(memoryStatus(PIT, [d])).toMatchObject({ status: "open", disputed: true });
    expect(memoryStatus(PIT, [d, mk("confirm", 2, { dedupKey: "auto:confirm:ab12-m3::ab12/9" })]).disputed).toBe(true);
    expect(memoryStatus(PIT, [d, mk("confirm", 2)]).disputed).toBe(false);
  });

  test("retract / supersede 是终态，之后的 mark 只记录不生效", () => {
    expect(memoryStatus(PIT, [mk("retract", 1), mk("confirm", 2), mk("link_fix", 3, { taskId: "N1f" })]).status).toBe("retracted");
    expect(memoryStatus(PIT, [mk("supersede", 1, { by: "ab12-m9" }), mk("retract", 2)])).toMatchObject({ status: "superseded", supersededBy: "ab12-m9" });
  });

  test("别的记忆的 mark 忽略", () => {
    expect(memoryStatus(PIT, [mk("retract", 1, { memoryId: "ab12-m4" })]).status).toBe("open");
  });

  test("同一毫秒按 origin、再按 originSeq 定先后", () => {
    const a = mk("retract", 5, { origin: "aaaa", originSeq: 9 });
    const b = mk("supersede", 5, { origin: "bbbb", originSeq: 1, by: "x" });
    expect(memoryStatus(PIT, [b, a]).status).toBe("retracted");
  });
});

/** mulberry32：固定种子，失败可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("性质：折叠结果与 marks 的排列顺序无关", () => {
  test("500 组随机 mark 集合（含同 ts、多 origin、别的记忆的行、各种初始状态），每组 20 种随机排列结果一致", () => {
    const r = rng(20261003);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const memories: FoldMemory[] = [PIT, { ...PIT, authorRole: "executor" }, { ...PIT, fixable: false }, { ...PIT, kind: "summary", fixable: null, via: "verify_summary", authorRole: "system" }];
    let nonTrivial = 0;
    for (let g = 0; g < 500; g++) {
      const memory = pick(memories);
      const n = 1 + Math.floor(r() * 12);
      const seqs = new Map<string, number>();
      const marks: FoldMark[] = Array.from({ length: n }, () => {
        const origin = pick(["ab12", "cd34", "ef56"]);
        const originSeq = (seqs.get(origin) ?? 0) + 1;
        seqs.set(origin, originSeq);
        const mark = pick(MEMORY_MARKS);
        return {
          memoryId: r() < 0.9 ? memory.id : "ab12-m99", origin, originSeq, ts: Math.floor(r() * 5), mark,
          taskId: mark === "unlink_fix" && r() < 0.3 ? null : pick(["N1f", "N2f"]), by: mark === "supersede" ? pick(["ab12-m7", "ab12-m8"]) : null,
          dedupKey: mark === "confirm" && r() < 0.5 ? `auto:confirm:${memory.id}::${origin}/${originSeq}` : null,
        };
      });
      const expected = memoryStatus(memory, marks);
      if (expected.status !== initialStatus(memory) || expected.disputed) nonTrivial++;
      for (let p = 0; p < 20; p++) expect(memoryStatus(memory, shuffle(marks, r))).toEqual(expected);
    }
    // 生成器要真的走到各种状态，不然性质测试是空转
    expect(nonTrivial).toBeGreaterThan(200);
  });

  test("折叠不改传入数组", () => {
    const marks = [mk("retract", 2), mk("dispute", 1)];
    const copy = [...marks];
    memoryStatus(PIT, marks);
    expect(marks).toEqual(copy);
  });
});
