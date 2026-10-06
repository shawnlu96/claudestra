/**
 * 必须走默认路径的用例（路由 / pushWork 内部读默认出借 journal 与 peers / principals）整文件改在独立状态目录的
 * `bun test` 子进程里跑（i28-TJ1）：preload 的状态目录是整次 bun test 各文件共用的，放行 test-guard 的闸只是绕过、不是隔离。
 * 用法：`const { describe, test, beforeAll, afterAll } = isolatedStateSuite(import.meta.path)` 代替从 bun:test 导入这几个；
 * 父进程里它们是空操作，只登记一条「起子进程跑本文件、退出码 0」的用例；子进程（新建的 CLAUDESTRA_STATE_DIR）里就是 bun:test 本身。
 */
import * as bun from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { DEFAULT_LEND_JOURNAL_OK } from "../src/lib/test-guard.ts";

/** 子进程的标记：设了就是独立状态目录里的那一份，照常登记用例 */
const ISOLATED_STATE_CHILD = "CLAUDESTRA_TEST_ISOLATED_STATE";

type Suite = Pick<typeof bun, "describe" | "test" | "beforeAll" | "afterAll">;

export function isolatedStateSuite(file: string, timeoutMs = 300_000): Suite {
  if (process.env[ISOLATED_STATE_CHILD] === "1") return bun;
  bun.test(`${basename(file)}（独立状态目录的子进程）`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cstra-test-iso-state-"));
    try {
      const child = Bun.spawn([process.execPath, "test", file], {
        cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CLAUDESTRA_STATE_DIR: stateDir, [ISOLATED_STATE_CHILD]: "1", [DEFAULT_LEND_JOURNAL_OK]: "1" },
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`子进程 bun test ${basename(file)} 退出码 ${code}\n${(out + err).slice(-8000)}`);
      bun.expect(err).toMatch(/\b0 fail\b/);
      bun.expect(err).toMatch(/\b[1-9]\d* pass\b/); // 路径没匹配上时 bun test 也可能不跑任何用例
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, timeoutMs);
  const noop = (() => {}) as never;
  return { describe: noop, test: noop, beforeAll: noop, afterAll: noop };
}
