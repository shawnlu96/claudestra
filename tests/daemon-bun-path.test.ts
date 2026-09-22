import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// launchd 给 daemon 的 PATH 是固定几条，裸 "bun" 可能 ENOENT；process.execPath 在 Homebrew 下是
// 带版本号的 Cellar 路径，brew upgrade bun 后旧目录被清掉同样 ENOENT（launcher 一跑几天）。
// 拉 bun 子进程一律走 resolveBunPath()（稳定符号链接优先）。
test("launcher / manager 不 spawn 裸 bun 或 process.execPath", () => {
  for (const f of ["src/launcher.ts", "src/manager.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", f), "utf-8");
    expect({ f, bare: /\[\s*"bun"\s*,/.test(src) }).toEqual({ f, bare: false });
    expect({ f, execPath: /\[\s*process\.execPath\s*,|exec "\$\{process\.execPath\}"/.test(src) }).toEqual({ f, execPath: false });
  }
});
