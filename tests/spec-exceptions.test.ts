import { expect, test } from "bun:test";
import { allExcepted, parseSpecExceptions } from "../src/lib/spec-exceptions.js";

const INLINE = [
  "# X", "模板：code", "", "## 范围（DAG globs）", "", "- src/lib/order-ask.ts", "",
  ["精准例外（不进 fileGlobs，交付说明逐条列）：src/lib/recovery-keys.ts 按字母序插 `askDefaultAll` 一行；",
    "`SweepDeps.notify` 的生产接线处（bridge 侧注入 sendLedgerNotice 的那一处）只加 level 透传（不超过 3 行；别的不改）；",
    "src/lib/scheduler-v2-skip-effects.ts 只登记本卡新增副作用模块。"].join(""),
  "", "## 不做", "", "- 精准例外：src/lib/not-here.ts 不算（不在范围节）",
].join("\n");

test("legacy paragraph inside ## 范围: split on top-level semicolons, identifiers are not paths", () => {
  const ex = parseSpecExceptions(INLINE);
  expect(ex.entries.map((e) => e.file)).toEqual(["src/lib/recovery-keys.ts", "src/lib/scheduler-v2-skip-effects.ts"]);
  expect(ex.entries[0].limit).toBe("src/lib/recovery-keys.ts 按字母序插 `askDefaultAll` 一行");
  expect(ex.errors).toHaveLength(1);
  expect(ex.errors[0]).toMatchObject({ why: "没有仓库相对文件路径", text: expect.stringContaining("SweepDeps.notify") });
});

test("dedicated ## 精准例外 section: one file + limit per line; globs, absolute and dot paths are refused", () => {
  const ex = parseSpecExceptions([
    "# X", "## 精准例外", "",
    "- `src/lib/a.ts` 只加一行", "- 改src/lib/b.ts一行，参考 https://x.com/y", "- `package.json` 加一条脚本",
    "- src/lib/*.ts 全部", "- `/etc/passwd` 读", "- ../x/y.ts 外面", "- ./src/c.ts 带点", "- 没有路径的一行",
    "```", "- src/in/fence.ts", "```",
    "### 子标题也属于本节", "- tests/a.test.ts 新增", "", "## 下一节", "- src/lib/z.ts",
  ].join("\n"));
  expect(ex.entries.map((e) => e.file)).toEqual(["src/lib/a.ts", "src/lib/b.ts", "package.json", "tests/a.test.ts"]);
  expect(ex.errors.map((e) => e.why)).toEqual(["不认通配：src/lib/*.ts", "没有仓库相对文件路径", "没有仓库相对文件路径", "没有仓库相对文件路径", "没有仓库相对文件路径"]);
});

test("allExcepted: every file must be listed; empty never matches", () => {
  const ex = parseSpecExceptions("## 精准例外\n- src/lib/a.ts 一行\n");
  expect(allExcepted(ex, ["src/lib/a.ts"])).toBe(true);
  expect(allExcepted(ex, ["src/lib/a.ts", "src/lib/b.ts"])).toBe(false);
  expect(allExcepted(ex, [])).toBe(false);
  expect(allExcepted(parseSpecExceptions("## 精准例外\n- src/lib/*.ts\n"), ["src/lib/a.ts"])).toBe(false);
});
