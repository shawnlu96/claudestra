/** 改动文件 → 要重启的 daemon（src/lib/ledger-daemon-map.ts）：import 解析、闭包、入口读不到退回保守规则，以及真实仓库上的冒烟 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { conservativeDaemonsOf, daemonsOfFromRepo, importClosure, relativeSpecs, resolveSpec } from "../src/lib/ledger-daemon-map.js";

const FILES: Record<string, string> = {
  "src/bridge.ts": `import { a } from "./lib/a.js";\nimport type { T } from "./lib/types.js";\nimport "./bridge/side.js";\nimport x from "zod";`,
  "src/cron.ts": `export { b } from "./lib/b.js";\nconst m = await import("./lib/dyn.js");`,
  "src/scheduler.ts": `import { a } from "./lib/a.js";`,
  "src/launcher.ts": `import { a } from "./lib/a.js";`,
  "src/lib/a.ts": `import { c } from "./sub/index.js";`,
  "src/lib/sub/index.ts": ``,
  "src/lib/b.ts": ``,
  "src/lib/types.ts": ``,
  "src/lib/dyn.ts": ``,
  "src/lib/orphan.ts": ``,
  "src/bridge/side.tsx": ``,
};
const read = (rel: string) => FILES[rel] ?? null;

describe("import 解析", () => {
  test("只取相对路径：from / export from / import() / 裸 import；包名不算", () => {
    expect(relativeSpecs(FILES["src/bridge.ts"])).toEqual(["./lib/a.js", "./lib/types.js", "./bridge/side.js"]);
    expect(relativeSpecs(FILES["src/cron.ts"])).toEqual(["./lib/b.js", "./lib/dyn.js"]);
  });
  test(".js 后缀解析到 .ts / .tsx / index.ts；找不到为 null", () => {
    const exists = (r: string) => r in FILES;
    expect(resolveSpec("src/bridge.ts", "./bridge/side.js", exists)).toBe("src/bridge/side.tsx");
    expect(resolveSpec("src/lib/a.ts", "./sub", exists)).toBe("src/lib/sub/index.ts");
    expect(resolveSpec("src/lib/a.ts", "./nope.js", exists)).toBeNull();
  });
});

describe("闭包与映射", () => {
  test("传递闭包含入口自己；type-only 也算", () => {
    expect([...importClosure("src/bridge.ts", read)].sort()).toEqual(["src/bridge.ts", "src/bridge/side.tsx", "src/lib/a.ts", "src/lib/sub/index.ts", "src/lib/types.ts"]);
  });
  test("文件归属：共用的 lib 归多个 daemon；没人 import 的 lib 不要求重启", () => {
    const of = daemonsOfFromRepo(read);
    expect(of("src/lib/sub/index.ts")).toEqual(["bridge", "scheduler", "launcher"]);
    expect(of("src/lib/dyn.ts")).toEqual(["cron"]);
    expect(of("src/lib/orphan.ts")).toEqual([]);
  });
  test("入口读不到（仓库结构变了）→ 退回保守规则：src/lib 四个都要重启", () => {
    const of = daemonsOfFromRepo((rel) => (rel === "src/cron.ts" ? null : read(rel)));
    expect(of).toBe(conservativeDaemonsOf);
    expect(of("src/lib/orphan.ts")).toEqual(["bridge", "cron", "scheduler", "launcher"]);
  });
  test("真实仓库：四个入口都能解析；tmux-helper 四个都用，bridge 的子模块只归 bridge", () => {
    const root = join(import.meta.dir, "..");
    const of = daemonsOfFromRepo((rel) => {
      try {
        return readFileSync(join(root, rel), "utf8");
      } catch {
        return null; // 候选后缀不存在
      }
    });
    expect(of).not.toBe(conservativeDaemonsOf);
    expect(of("src/lib/tmux-helper.ts")).toEqual(["bridge", "cron", "scheduler", "launcher"]);
    expect(of("src/bridge/router.ts")).toEqual(["bridge"]);
  });
});
