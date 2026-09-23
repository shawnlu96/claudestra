import { describe, expect, test } from "bun:test";
import { formatBench, percentile, summarizeFrames } from "../web/features/devtools/bench-stats";

describe("bench-stats", () => {
  test("percentile:空数组 0;p50 / p95 取上取整位置", () => {
    expect(percentile([], 50)).toBe(0);
    const s = [10, 12, 14, 16, 18, 20, 22, 24, 26, 100];
    expect(percentile(s, 50)).toBe(18);
    expect(percentile(s, 95)).toBe(100);
    expect(percentile(s, 100)).toBe(100);
  });
  test("summarizeFrames:计数、四舍五入到 0.1、超阈值帧数", () => {
    const st = summarizeFrames([16.66, 16.7, 17, 55.55, 120]);
    expect(st.frames).toBe(5);
    expect(st.p50).toBe(17);
    expect(st.max).toBe(120);
    expect(st.over50).toBe(2);
    expect(st.over100).toBe(1);
  });
  test("formatBench:一行、带前缀、附加字段按 k=v", () => {
    const line = formatBench("scroll 1200px/s 到底", summarizeFrames([16, 17]), { msgs: 300, dom: 12000 });
    expect(line.startsWith("[bench] scroll 1200px/s 到底 frames=2 ")).toBe(true);
    expect(line.endsWith("msgs=300 dom=12000")).toBe(true);
  });
});
