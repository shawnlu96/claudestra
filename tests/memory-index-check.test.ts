/**
 * src/lib/memory-index-check.ts 的纯逻辑:字节总量、切行、最长三行的排序、提示措辞。全是合成输入。
 * 走真实 hook 入口的用例在 tests/memory-index-check-hook.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { checkMemoryIndex, MEMORY_INDEX_MAX_BYTES, memoryIndexNotice } from "../src/lib/memory-index-check.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("checkMemoryIndex", () => {
  test("[验收线 1] 等于阈值不报,多 1 字节超 1", () => {
    expect(MEMORY_INDEX_MAX_BYTES).toBe(8192);
    const at = checkMemoryIndex(bytes(`${"a".repeat(5000)}\n${"b".repeat(3190)}\n`));
    expect(at).toMatchObject({ totalBytes: 8192, maxBytes: 8192, overBytes: 0 });
    expect(memoryIndexNotice(at)).toBeNull();
    const over = checkMemoryIndex(bytes(`${"a".repeat(5000)}\n${"b".repeat(3191)}\n`));
    expect(over).toEqual({ totalBytes: 8193, maxBytes: 8192, overBytes: 1, longest: [{ line: 1, bytes: 5000 }, { line: 2, bytes: 3191 }] });
    expect(memoryIndexNotice(over)).toBe(
      "⚠ 记忆索引 MEMORY.md 共 8193 字节,超过 8192 字节阈值 1 字节;最长行:第 1 行(5000 字节)、第 2 行(3191 字节)。只是提示,不会自动改动;要精简请先让用户确认。",
    );
  });

  test("[验收线 2] 中文 / CRLF / 空行 / 末行无换行:总量按原始字节,行长不含换行符,同长按行号", () => {
    const text = "# 索引\r\n\r\n- 甲乙丙丁\n- abcdefghijkl\n\n- 最长的一行在这里 xyz";
    const check = checkMemoryIndex(bytes(text), 50);
    expect(check.totalBytes).toBe(73);
    expect(check.overBytes).toBe(23);
    expect(check.longest).toEqual([{ line: 6, bytes: 30 }, { line: 3, bytes: 14 }, { line: 4, bytes: 14 }]);
    const notice = memoryIndexNotice(check)!;
    expect(notice).toContain("第 6 行(30 字节)、第 3 行(14 字节)、第 4 行(14 字节)");
    for (const body of ["索引\r", "甲乙丙丁", "abcdefghijkl", "最长的一行", "xyz"]) expect(notice).not.toContain(body);
    expect(notice).not.toContain("\n");
  });

  test("[验收线 2] 两行文件只列两行;末尾换行不多算一个空行;空文件没有行", () => {
    expect(checkMemoryIndex(bytes("ab\ncdef"), 1).longest).toEqual([{ line: 2, bytes: 4 }, { line: 1, bytes: 2 }]);
    expect(checkMemoryIndex(bytes("ab\ncdef\n"), 1).longest).toHaveLength(2);
    expect(checkMemoryIndex(bytes("\n\n"), 1).longest).toEqual([{ line: 1, bytes: 0 }, { line: 2, bytes: 0 }]);
    expect(checkMemoryIndex(new Uint8Array(0), 1)).toEqual({ totalBytes: 0, maxBytes: 1, overBytes: 0, longest: [] });
  });

  test("坏的 UTF-8 也按字节数,不抛", () => {
    const check = checkMemoryIndex(new Uint8Array([0xff, 0xfe, 0x0a, 0xe4, 0xb8]), 2);
    expect(check).toEqual({ totalBytes: 5, maxBytes: 2, overBytes: 3, longest: [{ line: 1, bytes: 2 }, { line: 2, bytes: 2 }] });
  });

  test("[验收线 3] 阈值必须是正整数", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => checkMemoryIndex(bytes("x"), bad)).toThrow(RangeError);
  });
});
