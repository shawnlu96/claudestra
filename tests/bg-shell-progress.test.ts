import { describe, expect, test } from "bun:test";
import { exitCodeOf, feedShellChunk, newShellProgress, settleShellTail } from "../src/lib/bg-shell-progress";

const enc = (s: string) => new TextEncoder().encode(s);

describe("bg-shell-progress：只认 CC 追加的独立末行 [exited with code N]", () => {
  test("整行精确匹配；相似字符串 / 半截标记 / 前后带字都不算", () => {
    expect(exitCodeOf("[exited with code 0]")).toBe(0);
    expect(exitCodeOf("[exited with code 137]\r")).toBe(137);
    expect(exitCodeOf("[exited with code -1]")).toBe(-1);
    const near = ["[exited with code ]", "[exited with code 0", "exited with code 0", " [exited with code 0]"];
    near.push("[exited with code 0] ok", "log: [exited with code 0]", "[Exited with code 0]", "[exited with code 0x1]");
    for (const s of near) {
      expect(exitCodeOf(s)).toBeNull();
    }
  });

  test("普通输出逐行渲染，CRLF 去 \\r，空行跳过，超长截 300", () => {
    const st = newShellProgress();
    const r = feedShellChunk(st, enc(`a\r\n\r\nb\n${"x".repeat(400)}\n`));
    expect(r.lines).toEqual(["a", "b", "x".repeat(300)]);
    expect(r.exitCode).toBeNull();
  });

  test("跨多次读的半行 + 分块退出行 + CRLF：拼回后才认，且只认一次", () => {
    const st = newShellProgress();
    expect(feedShellChunk(st, enc("running 12 tests\nhalf of a li"))).toEqual({ lines: ["running 12 tests"], exitCode: null });
    expect(feedShellChunk(st, enc("ne\n[exited with co"))).toEqual({ lines: ["half of a line"], exitCode: null });
    expect(feedShellChunk(st, enc("de 1]\r\n"))).toEqual({ lines: ["[exited with code 1]"], exitCode: 1 });
    // 重复 poll（没有新字节）不会再认一次
    expect(feedShellChunk(st, enc(""))).toEqual({ lines: [], exitCode: null });
    expect(settleShellTail(st)).toBeNull();
  });

  test("UTF-8 多字节被读边界切开也能拼回", () => {
    const st = newShellProgress();
    const bytes = enc("测试通过\n");
    expect(feedShellChunk(st, bytes.subarray(0, 4)).lines).toEqual([]);
    expect(feedShellChunk(st, bytes.subarray(4)).lines).toEqual(["测试通过"]);
  });

  test("退出行后面还有输出 / 残尾 → 只是普通日志行，不结束", () => {
    const st = newShellProgress();
    expect(feedShellChunk(st, enc("[exited with code 0]\nstill going\n")).exitCode).toBeNull();
    expect(feedShellChunk(st, enc("[exited with code 0]\nmore")).exitCode).toBeNull();
    expect(settleShellTail(st)).toBeNull(); // 残尾 "more" 不是退出行
    expect(feedShellChunk(st, enc("\necho '[exited with code 0]'\n")).exitCode).toBeNull();
  });

  test("没补换行的退出行：本轮不认，下一轮文件不再增长才认（防止是更长一行的前半截）", () => {
    const st = newShellProgress();
    expect(feedShellChunk(st, enc("ok\n[exited with code 0]")).exitCode).toBeNull();
    expect(settleShellTail(st)).toEqual({ line: "[exited with code 0]", exitCode: 0 });
    expect(settleShellTail(st)).toBeNull(); // 只收一次

    const longer = newShellProgress();
    feedShellChunk(longer, enc("[exited with code 0]"));
    // 下一轮又长出了字 → 它只是普通行的前半截
    expect(feedShellChunk(longer, enc(" (not really)\n")).exitCode).toBeNull();
  });

  test("晚到的退出行：长时间无输出之后照样能收", () => {
    const st = newShellProgress();
    feedShellChunk(st, enc("bun test > log 2>&1\n"));
    for (let i = 0; i < 5; i++) expect(settleShellTail(st)).toBeNull(); // 12 分钟静默的若干次 poll
    expect(feedShellChunk(st, enc("[exited with code 0]\n")).exitCode).toBe(0);
  });
});
