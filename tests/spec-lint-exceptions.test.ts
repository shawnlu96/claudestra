import { expect, test } from "bun:test";
import { lintSpecExceptions } from "../src/lib/spec-lint.js";

test("exception files that are also in fileGlobs and unparsed lines are reported, nothing else", () => {
  const text = "# X\n## 精准例外\n- src/lib/a.ts 一行\n- src/other/b.ts 一行\n- 只说了个意思\n";
  const out = lintSpecExceptions(text, ["src/lib/*.ts", "tests/x.test.ts"]);
  expect(out).toHaveLength(2);
  expect(out[0]).toContain("精准例外 src/lib/a.ts 已在本卡 fileGlobs（src/lib/*.ts）里");
  expect(out[1]).toContain("精准例外第 5 行没解析出来（没有仓库相对文件路径）");
  expect(lintSpecExceptions("# X\n## 范围\n- src/a.ts\n", ["src/a.ts"])).toEqual([]);
});
