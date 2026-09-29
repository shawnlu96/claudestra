/** web/features/chat/ctx-boundary-view.ts：上下文边界小标的文字与等级色 */
import { describe, expect, test } from "bun:test";
import { boundaryLabel, boundaryLeft, boundaryLines, hasNamedPolicy, type CtxBoundaryInfo } from "@/features/chat/ctx-boundary-view";

const b = (o: Partial<CtxBoundaryInfo>): CtxBoundaryInfo => ({ policy: "executor", window: 200_000, hardCap: 250_000, remaining: 35_000, level: "ok", ...o });

describe("ctx-boundary-view", () => {
  test("余量 / 超出按 k 显示；软线关着 → null", () => {
    expect(boundaryLeft(b({}))).toEqual({ key: "余 {n}", n: "35k" });
    expect(boundaryLeft(b({ remaining: -20_400, level: "over" }))).toEqual({ key: "超 {n}", n: "20k" });
    expect(boundaryLeft(b({ remaining: 0 }))).toEqual({ key: "余 {n}", n: "0k" });
    expect(boundaryLeft(b({ remaining: null, window: 0 }))).toBeNull();
  });
  test("悬停说明：压缩线 / 硬上限，缺的显示 —", () => {
    expect(boundaryLines(b({}))).toEqual({ window: "200k", cap: "250k" });
    expect(boundaryLines(b({ window: 0, hardCap: null }))).toEqual({ window: "—", cap: "—" });
  });
  test("内置策略给中文名，自定义显示 id；全局不算具名策略", () => {
    expect(boundaryLabel("executor")).toBe("执行类");
    expect(boundaryLabel("coordinator")).toBe("协调类");
    expect(boundaryLabel("my-proj")).toBe("my-proj");
    expect(hasNamedPolicy(b({ policy: "global" }))).toBe(false);
    expect(hasNamedPolicy(b({}))).toBe(true);
    expect(hasNamedPolicy(null)).toBe(false);
  });
});
