/** 网页「新终端」的前端纯逻辑（web/lib/api/terminal.ts）：shell 目标走 /shells、agent 照旧；路径缩写只认整段目录 */
import { expect, test } from "bun:test";
import { shellTerminalTarget, shortPath, terminalStreamPath } from "@/lib/api/terminal";

test("TerminalView 的目标：shell 走 /shells/:id，agent 名照旧走 /agents/:name", () => {
  expect(terminalStreamPath(shellTerminalTarget("a1b2c3"), 80, 24)).toBe("/shells/a1b2c3/terminal?cols=80&rows=24");
  expect(terminalStreamPath("worker", 100, "30")).toBe("/agents/worker/terminal?cols=100&rows=30");
  expect(terminalStreamPath("shellfish", 1, 1)).toBe("/agents/shellfish/terminal?cols=1&rows=1");
});

test("shortPath：家目录及其子目录缩成 ~，前缀相同的兄弟目录不动", () => {
  expect(shortPath("/Users/he", "/Users/he")).toBe("~");
  expect(shortPath("/Users/he/repos/x", "/Users/he")).toBe("~/repos/x");
  expect(shortPath("/Users/he2/x", "/Users/he")).toBe("/Users/he2/x");
  expect(shortPath("/tmp", "")).toBe("/tmp");
});
