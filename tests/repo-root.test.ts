import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { REPO_ROOT, SRC_DIR } from "../src/lib/repo-root";
import { REPO_ROOT as CONFIG_REPO_ROOT, MANAGER_PATH } from "../src/bridge/config";

describe("repo-root", () => {
  test("REPO_ROOT 指向仓库根", () => {
    expect(REPO_ROOT).toBe(resolve(import.meta.dir, ".."));
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "master"))).toBe(true);
  });

  test("SRC_DIR 指向 src/", () => {
    expect(SRC_DIR).toBe(join(REPO_ROOT, "src"));
    expect(existsSync(join(SRC_DIR, "manager.ts"))).toBe(true);
    expect(existsSync(join(SRC_DIR, "ansi2html.ts"))).toBe(true);
  });

  test("路径是干净的（不含 ..）——带 .. 的原样字符串做目录比较会失配", () => {
    expect(REPO_ROOT.includes("..")).toBe(false);
    expect(SRC_DIR.includes("..")).toBe(false);
  });

  test("bridge/config 复用同一个值", () => {
    expect(CONFIG_REPO_ROOT).toBe(REPO_ROOT);
    expect(existsSync(MANAGER_PATH)).toBe(true);
  });

  // 护栏：import.meta.dir 拼仓库路径的写法只允许留在 repo-root.ts。文件一挪位置
  // 那种写法就静默指错（install-cli 会把错路径写进 plist），所以新代码必须引用 repo-root。
  test("src/ 里没有别处再用 import.meta.dir 拼路径", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && p !== join(SRC_DIR, "lib", "repo-root.ts")) {
          if (readFileSync(p, "utf8").includes("import.meta.dir")) offenders.push(p.slice(REPO_ROOT.length + 1));
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
