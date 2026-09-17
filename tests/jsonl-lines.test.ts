import { describe, expect, test } from "bun:test";
import { splitChunkLines } from "../src/lib/jsonl-lines";

describe("splitChunkLines — watcher 追加块的行号坐标", () => {
  test("整行块:每行按下标编号,尾换行不产生多余行", () => {
    const r = splitChunkLines('{"a":1}\n{"b":2}\n', 100);
    expect(r.lines).toEqual([
      { seq: 100, line: '{"a":1}' },
      { seq: 101, line: '{"b":2}' },
    ]);
    expect(r.next).toBe(102);
  });

  test("空行占号但不输出——与 parseHistoryLines 的 lineOffset+i 一致", () => {
    const r = splitChunkLines('a\n\nb\n', 0);
    expect(r.lines).toEqual([
      { seq: 0, line: "a" },
      { seq: 2, line: "b" },
    ]);
    expect(r.next).toBe(3);
  });

  test("半行:前半段不推进 base,后半段落在同一行号", () => {
    const first = splitChunkLines('{"partial', 7);
    expect(first.lines).toEqual([{ seq: 7, line: '{"partial' }]);
    expect(first.next).toBe(7);
    const second = splitChunkLines('":1}\n{"c":3}\n', first.next);
    expect(second.lines).toEqual([
      { seq: 7, line: '":1}' },
      { seq: 8, line: '{"c":3}' },
    ]);
    expect(second.next).toBe(9);
  });

  test("空块:无行,base 不动", () => {
    expect(splitChunkLines("", 5)).toEqual({ lines: [], next: 5 });
  });
});
