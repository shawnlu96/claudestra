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

  test("fixed / reopen 按来源事件先后生效（source-order）：再上线后晚到的旧回滚不重开；来源最新的是回滚就 open", () => {
    const src = (originSeq: number) => ({ source: { origin: "ab12", originSeq }, taskId: "N1f" });
    const link = mk("link_fix", 1, { taskId: "N1f" });
    const f812 = mk("fixed", 10, src(812));
    const f950 = mk("fixed", 20, src(950));
    const r900 = mk("reopen", 30, src(900));
    expect(memoryStatus(PIT, [link, f812, f950, r900])).toMatchObject({ status: "fixed", fixTask: "N1f" });
    // 回滚 900 先被观察到、上线 812 晚到：来源最新的是回滚
    expect(memoryStatus(PIT, [link, mk("reopen", 10, src(900)), mk("fixed", 20, src(812))])).toMatchObject({ status: "open", fixTask: "N1f" });
    // {seq} 来源同理；来源不可比（没带 / 形状不同）退回按观察时间
    expect(memoryStatus(PIT, [link, mk("fixed", 10, { taskId: "N1f", source: { seq: 50 } }), mk("reopen", 20, { taskId: "N1f", source: { seq: 40 } })]).status).toBe("fixed");
    expect(memoryStatus(PIT, [link, mk("fixed", 10, src(950)), mk("reopen", 20, { taskId: "N1f", source: { seq: 1 } })]).status).toBe("open");
    expect(memoryStatus(PIT, [link, mk("fixed", 10, src(950)), mk("reopen", 20, { taskId: "N1f" })]).status).toBe("open");
  });

  test("回滚后同一卡重新 link_fix 保留来源水位（source-order 重新关联分支）：迟到的旧上线不把坑标 fixed", () => {
    const src = (originSeq: number) => ({ source: { origin: "ab12", originSeq }, taskId: "Fix" });
    const marks = [mk("link_fix", 1, { taskId: "Fix" }), mk("fixed", 2, src(800)), mk("reopen", 3, src(900)), mk("link_fix", 4, { taskId: "Fix" })];
    expect(memoryStatus(PIT, [...marks, mk("fixed", 5, src(812))])).toMatchObject({ status: "fixing", fixTask: "Fix" });
    // 比回滚新的上线照常生效；unlink 后再 link 同一卡是新关联，水位清零
    expect(memoryStatus(PIT, [...marks, mk("fixed", 5, src(950))]).status).toBe("fixed");
    expect(memoryStatus(PIT, [...marks.slice(0, 3), mk("unlink_fix", 4, { taskId: "Fix" }), mk("link_fix", 5, { taskId: "Fix" }), mk("fixed", 6, src(812))]).status).toBe("fixed");
  });

  test("回滚后的 open 坑可 unlink_fix 清掉保留的修复关联（unlink-reopened），旧卡之后的 fixed 不再生效", () => {
    const marks = [mk("link_fix", 10, { taskId: "Fix" }), mk("fixed", 20, { taskId: "Fix" }), mk("reopen", 30, { taskId: "Fix" }), mk("unlink_fix", 40, { taskId: "Fix" })];
    expect(memoryStatus(PIT, marks)).toMatchObject({ status: "open", fixTask: null });
    expect(memoryStatus(PIT, [...marks, mk("fixed", 50, { taskId: "Fix" })]).status).toBe("open");
    // 别的卡的 unlink_fix 不清；清掉后可重新 link 别的卡
    expect(memoryStatus(PIT, [...marks.slice(0, 3), mk("unlink_fix", 40, { taskId: "Other" })]).fixTask).toBe("Fix");
    expect(memoryStatus(PIT, [...marks, mk("link_fix", 50, { taskId: "N2f" }), mk("fixed", 60, { taskId: "N2f" })])).toMatchObject({ status: "fixed", fixTask: "N2f" });
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
  test("500 组随机 mark 集合（含同 ts、多 origin、别的记忆的行、各种初始状态、各种来源事件），每组 20 种随机排列结果一致", () => {
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
          source: r() < 0.6 ? (r() < 0.8 ? { origin: pick(["ab12", "cd34"]), originSeq: 1 + Math.floor(r() * 6) } : { seq: 1 + Math.floor(r() * 6) }) : null,
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
