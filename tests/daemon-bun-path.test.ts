import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// launchd 给 daemon 的 PATH 是固定几条；mise / asdf 装的 bun 不在其中，裸 "bun" 会 ENOENT
// （dead-agent 自愈、重启波、自动更新全部静默失败）。daemon 里一律用 process.execPath。
test("launcher / manager 不 spawn 裸 bun", () => {
  for (const f of ["src/launcher.ts", "src/manager.ts"]) {
    const src = readFileSync(join(import.meta.dir, "..", f), "utf-8");
    expect({ f, hit: /\[\s*"bun"\s*,/.test(src) }).toEqual({ f, hit: false });
  }
});
