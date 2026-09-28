/**
 * lib/memory-hygiene.ts hygienePrompt：报告先落文件（reports/mem0-hygiene-<日期>.md）再用 reply 发；删除授权仍只有 ①② 两处。
 */
import { expect, test } from "bun:test";
import { hygienePrompt } from "../src/lib/memory-hygiene";
import { statePath } from "../src/lib/paths";

test("报告落文件 + reply 两个去处；删除授权仍限 ①②", () => {
  const p = hygienePrompt();
  expect(p).toContain(`${statePath("reports")}/mem0-hygiene-<今天 YYYY-MM-DD>.md`);
  expect(p).toContain("用 reply 工具把同一份报告发出来");
  expect(p).toContain("①②是仅有的两处授权执行 memory_delete 的步骤");
});
