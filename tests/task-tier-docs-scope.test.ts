/**
 * docs 文件范围（src/lib/task-tier-docs-scope.ts）：fileGlobs 只许 docs/**、任意目录 *.md、逐项写明的发版说明；
 * 交付时实际 diff（新增 / 修改 / 删除 / 重命名两头）与规格版本绑定都要证明合规，证据缺失一律拒。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { docsDeliveryCheck, docsDispatchCheck, docsGlobProblem, docsPathProblem, type DocsCheckCtx, type DocsDeliveryProof } from "../src/lib/task-tier-docs-scope.js";
import { registerTierTemplate } from "../src/lib/task-tier-spec.js";

// 钩子只在 docs 已注册时被调用（task-tier-docs-template.ts 同步挂）；这里直接调，先让启动核对认 docs
let undo = () => {};
beforeAll(() => { undo = registerTierTemplate("docs"); });
afterAll(() => undo());

const SPEC = "# 改文档\n模板：docs\n\n## 背景\n";
const proof = (files: string[], over: Partial<DocsDeliveryProof> = {}): DocsDeliveryProof =>
  ({ files, stored: { template: "docs", specRev: 1 }, specRev: 1, specText: SPEC, ...over });
const ctx = (fileGlobs: string[], docs?: DocsDeliveryProof): DocsCheckCtx => ({ project: "p1", taskId: "D1", tier: "docs", fileGlobs, ...(docs ? { docs } : {}) });

describe("[验收线 2] fileGlobs 声明", () => {
  test.each(["docs/**", "docs/guide/*.md", "docs/a.txt", "**/*.md", "README.md", "src/lib/notes.md", "web/*.md",
    "RELEASE_NOTES.txt", "CHANGES", "release-notes/v1.2.txt", "packages/x/CHANGELOG"])("%s 放行", (g) => {
    expect(docsGlobProblem(g)).toBeNull();
  });

  test.each([
    ["src/**", "超出 docs 范围"], ["**", "超出 docs 范围"], ["*", "超出 docs 范围"], ["docs", "超出 docs 范围"], ["src/a.ts", "超出 docs 范围"],
    ["release-notes/*", "逐项写具体文件路径"], ["CHANGELOG*", "逐项写具体文件路径"], ["releases/**", "逐项写具体文件路径"],
    ["docs/../src/a.ts", "相对路径"], ["/abs/docs/a.md", "相对路径"], ["repo:o/r/docs/a.md", "相对路径"], ["", "相对路径"],
    ["docs/{a,b}", "{} 或 !"], ["!docs/x", "{} 或 !"], ["**/*.{md,ts}", "{} 或 !"], ["src/.md", "超出 docs 范围"],
  ])("%s 拒（%s）", (g, why) => {
    expect(docsGlobProblem(g)).toContain(why);
  });

  test("派单钩子：每条都要过、空 = 证明不了；非 docs 类型不管", () => {
    expect(docsDispatchCheck(ctx(["docs/**", "README.md", "RELEASE_NOTES.txt"]))).toBeNull();
    expect(docsDispatchCheck(ctx(["docs/**", "src/**"]))).toContain("src/**");
    expect(docsDispatchCheck(ctx([]))).toContain("证明不了");
    expect(docsDispatchCheck({ ...ctx(["src/**"]), tier: "code" })).toBeNull();
  });
});

describe("[验收线 2] 实际路径", () => {
  test("docs 下任意文件、任意目录 .md、逐项写明的发版说明通过；不在 fileGlobs 或不是文档的拒", () => {
    const globs = ["docs/**", "**/*.md", "RELEASE_NOTES.txt"];
    for (const p of ["docs/a.ts", "docs/x/y.png", "README.md", "src/lib/a.md", "RELEASE_NOTES.txt"]) expect(docsPathProblem(p, globs)).toBeNull();
    expect(docsPathProblem("src/a.ts", globs)).toContain("不在本卡 fileGlobs");
    expect(docsPathProblem("CHANGELOG", globs)).toContain("不在本卡 fileGlobs");
    expect(docsPathProblem("../x.md", globs)).toContain("不合法");
    expect(docsPathProblem("src/a.md", ["docs/**"])).toContain("不在本卡 fileGlobs");
  });
});

describe("[验收线 2] 交付钩子", () => {
  const globs = ["docs/**", "README.md"];
  test("范围内的增删改通过", () => {
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md", "docs/old.md", "README.md"])))).toBeNull();
  });

  test("越界：新增 / 删除 / 重命名（两头都列）任一头出界就拒，诊断写明路径", () => {
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md", "src/a.ts"])))).toContain("src/a.ts 不在本卡 fileGlobs");
    // docs/a.md → src/a.md 重命名：--no-renames 两头都在
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md", "src/a.md"])))).toContain("实际 diff 越界 1 处");
  });

  test("宽泛授权在交付时同样拒（即使 diff 本身只动了文档）", () => {
    expect(docsDeliveryCheck(ctx(["**"], proof(["docs/a.md"])))).toContain("文件范围不合规");
  });

  test("证据缺失 / 读不到 diff / 规格改版 / 卡首声明换类型 / 卡上流程不是 docs：一律拒，不放行不转 code", () => {
    expect(docsDeliveryCheck(ctx(globs))).toContain("证明不了合规");
    expect(docsDeliveryCheck(ctx(globs, proof([], { files: undefined, filesError: "git diff 失败" })))).toContain("git diff 失败");
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md"], { specRev: 2 })))).toContain("第 1 版改到第 2 版");
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md"], { specText: "# 改文档\n模板：code\n" })))).toContain("冲突");
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md"], { specText: "# 改文档\n模板：docs\n模板：docs\n" })))).toContain("只能有一行");
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md"], { stored: { template: "code", specRev: 1 } })))).toContain("不是 docs");
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md"], { stored: null })))).toContain("核对不了规格版本");
  });

  test("缺声明的规格（= code）不算冲突，按已存 docs 流程核对；非 docs 类型不管", () => {
    expect(docsDeliveryCheck(ctx(globs, proof(["docs/a.md"], { specText: "# 改文档\n" })))).toBeNull();
    expect(docsDeliveryCheck({ ...ctx(globs), tier: "code" })).toBeNull();
  });
});
