import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { REPO_ROOT, SRC_DIR } from "../src/lib/repo-root";
import { REPO_ROOT as CONFIG_REPO_ROOT, MANAGER_PATH } from "../src/bridge/config";

describe("repo-root", () => {
  test("REPO_ROOT 指向仓库根", () => {
    expect(resolve(REPO_ROOT)).toBe(resolve(import.meta.dir, ".."));
    expect(existsSync(`${REPO_ROOT}/package.json`)).toBe(true);
    expect(existsSync(`${REPO_ROOT}/master`)).toBe(true);
  });

  test("SRC_DIR 指向 src/", () => {
    expect(SRC_DIR).toBe(join(resolve(REPO_ROOT), "src"));
    expect(existsSync(`${SRC_DIR}/manager.ts`)).toBe(true);
    expect(existsSync(`${SRC_DIR}/ansi2html.ts`)).toBe(true);
  });

  // 零变化：manager.ts 拆分前 REPO_ROOT 是 `${import.meta.dir}/..`（import.meta.dir = src/），
  // 这串会进 master/CLAUDE.md 渲染与 update 日志，形态不能变
  test("REPO_ROOT 保持 <repo>/src/.. 原样形态", () => {
    expect(REPO_ROOT).toBe(`${SRC_DIR}/..`);
  });

  test("bridge/config 的 REPO_ROOT 指向同一目录", () => {
    expect(resolve(CONFIG_REPO_ROOT)).toBe(resolve(REPO_ROOT));
    expect(existsSync(MANAGER_PATH)).toBe(true);
  });

  // 护栏：import.meta.dir 拼路径只允许出现在不会被搬动的入口/常量文件里。
  // 会被拆出去的模块（src/manager/* 等）必须引用 repo-root，否则一挪位置就静默指错。
  test("import.meta.dir 只出现在白名单文件里", () => {
    const allow = new Set([
      "lib/repo-root.ts",
      "bridge/config.ts",
      "bridge/screenshot.ts",
      "lib/github-release.ts",
      "launcher.ts",
      "cron.ts",
      "setup.ts",
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("import.meta.dir")) {
          const rel = relative(SRC_DIR, p);
          if (!allow.has(rel)) offenders.push(rel);
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
