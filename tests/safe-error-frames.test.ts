/** PROPLOG1：catch 日志里的安全错误行——错误名 + 阶段 + 仓库内相对路径帧，不带 message / 绝对路径 */
import { describe, expect, test } from "bun:test";
import { MAX_SAFE_FRAMES, safeErrorLine, safeErrorName, safeFrames } from "../src/lib/safe-error-frames.js";
import { when } from "../src/lib/center-proposal-inbox.js";

const SECRET = "sk-SECRETSECRETSECRETSECRET123";
const fake = (stack: string, name = "RangeError") => Object.assign(new Error(SECRET), { name, stack });

describe("safeErrorLine", () => {
  test("真抛出的错误：本文件相对路径带行列，不含 message 和绝对路径", () => {
    let caught: unknown;
    try { new Date(NaN).toISOString(); } catch (e) { caught = e; }
    const line = safeErrorLine(caught, "开卡");
    expect(line).toMatch(/^RangeError（阶段 开卡；帧 tests\/safe-error-frames\.test\.ts:\d+:\d+/);
    expect(line).not.toContain(process.cwd());
    expect(line).not.toContain("Invalid");
  });

  test("仓库外、node_modules、bun 内部帧只计数；message 多行也不进日志", () => {
    const root = "/repo";
    const e = fake([`RangeError: ${SECRET}`, "  more message https://x.example/?t=1",
      "    at inboxCard (/repo/src/lib/center-proposal-inbox.ts:70:5)",
      "    at map (native:1:1)", "    at <anonymous>", "    at foo (/repo/node_modules/zod/index.js:3:4)",
      "    at bar (/Users/someone/other/x.ts:9:9)", "    at file:///repo/src/bridge/center-proposal-inbox.ts:118:22",
      "    at processTicksAndRejections (native)"].join("\n"));
    expect(safeFrames(e, { root })).toEqual({ frames: ["src/lib/center-proposal-inbox.ts:70:5", "src/bridge/center-proposal-inbox.ts:118:22"], external: 5 });
    const line = safeErrorLine(e, "补记", { root });
    expect(line).toBe("RangeError（阶段 补记；帧 src/lib/center-proposal-inbox.ts:70:5 ← src/bridge/center-proposal-inbox.ts:118:22；其他帧 5）");
    for (const bad of [SECRET, "/repo", "/Users", "example", "inboxCard"]) expect(line).not.toContain(bad);
  });

  test("最多 8 帧，多出来的算进计数", () => {
    const e = fake(["Error: x", ...Array.from({ length: 11 }, (_, i) => `    at f (/repo/src/a.ts:${i + 1}:1)`)].join("\n"), "Error");
    const r = safeFrames(e, { root: "/repo" });
    expect(r.frames.length).toBe(MAX_SAFE_FRAMES);
    expect(r.external).toBe(3);
  });

  test("错误名只放行标识符形状；非 Error / 无栈不抛", () => {
    expect(safeErrorName(fake("", `Bad ${SECRET} name`))).toBe("Error");
    expect(safeErrorName("boom")).toBe("non_error");
    expect(safeErrorLine({ stack: "at /repo/a.ts:1:1" }, "分类", { root: "/repo" })).toBe("non_error（阶段 分类；帧 无）");
    expect(safeErrorLine(Object.assign(new TypeError("m"), { stack: undefined }), "撤卡")).toBe("TypeError（阶段 撤卡；帧 无）");
  });
});

describe("when（PROPLOG1 验收线 3）", () => {
  test("NaN / 超出 Date 范围 / 非整数 → 未知，不抛错", () => {
    for (const v of [NaN, 9e15, -9e15, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) expect(when(v)).toBe("未知");
  });
  test("正常毫秒值输出不变", () => {
    expect(when(1_790_000_000_000)).toBe(new Date(1_790_000_000_000).toISOString().slice(0, 16).replace("T", " ") + " UTC");
    expect(when(0)).toBe("1970-01-01 00:00 UTC");
  });
});
