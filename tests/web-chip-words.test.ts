/** web/features/chat/chip-words.ts：侧栏会话行四种芯片（上下文余量、台账阶段、工作中、压缩中）的一句话解释，中英两份、不带术语 */
import { describe, expect, test } from "bun:test";
import { ctxChipWords, rowStateWords, stageChipWords, stageWords } from "@/features/chat/chip-words";
import type { CtxBoundaryInfo } from "@/features/chat/ctx-boundary-view";
import { STAGES } from "../src/lib/ledger-stages";

const b = (o: Partial<CtxBoundaryInfo>): CtxBoundaryInfo => ({ policy: "coordinator", window: 200_000, hardCap: 250_000, remaining: 77_000, level: "ok", ...o });
const TERMS = /压缩线|硬上限|上下文边界|hard cap|compaction line/i;

describe("chip-words", () => {
  test("上下文芯片：余量 / 超出 / 只有上限 / 没设上限，带类别，不说术语", () => {
    expect(ctxChipWords(b({}), "zh")).toBe("协调类会话：上下文还能用约 77k，快到时会提醒压缩");
    expect(ctxChipWords(b({ policy: "executor", remaining: -12_400, level: "over" }), "zh")).toBe("执行类会话：上下文已多用了约 12k，该压缩了");
    expect(ctxChipWords(b({ remaining: null }), "zh")).toBe("协调类会话：上下文最多用到约 250k");
    expect(ctxChipWords(b({ remaining: null, hardCap: null }), "zh")).toBe("协调类会话：上下文没有设上限");
    expect(ctxChipWords(b({ policy: "my-policy" }), "en")).toBe("my-policy session: about 77k of context left; it will be reminded to compact near the end");
    expect(ctxChipWords(b({ warnings: ["ccWindow 越界"] }), "zh")).toEndWith("（配置有问题：ccWindow 越界）");
    for (const lang of ["zh", "en"] as const)
      for (const o of [{}, { remaining: -1 }, { remaining: null }, { remaining: null, hardCap: null }]) expect(ctxChipWords(b(o), lang)).not.toMatch(TERMS);
  });

  test("阶段芯片：每个台账阶段都有一句话，审查 / 返工带轮次，认不出的阶段不白屏", () => {
    for (const s of STAGES) for (const lang of ["zh", "en"] as const) expect(stageWords(s, lang)).not.toMatch(/阶段|stage "/);
    expect(stageChipWords({ id: "T5", stage: "live", round: 0 }, "zh")).toBe("T5：它的卡已上线，等 PM 验证");
    expect(stageChipWords({ id: "T5", stage: "fix", round: 2 }, "zh")).toBe("T5：审查提了意见，它在返工（第 2 轮）");
    expect(stageChipWords({ id: "T5", stage: "review", round: 1 }, "en")).toBe("T5: its card is in review, waiting for the verdict (round 1)");
    expect(stageChipWords({ id: "T5", stage: "build", round: 3 }, "zh")).toBe("T5：它在开发这张卡"); // 只有审查 / 返工的轮次有意义
    expect(stageWords("constructor", "zh")).toBe("它的卡在「constructor」阶段");
  });

  test("工作中 / 压缩中", () => {
    expect(rowStateWords("busy", "zh")).toBe("它正在跑一轮");
    expect(rowStateWords("compacting", "zh")).toBe("正在压缩上下文，稍后恢复");
    expect(rowStateWords("busy", "en")).toBe("it is running a turn");
  });
});
