/**
 * 同一次 bun test 的所有测试文件共用一个临时状态目录（tests/preload.ts），registry.json 这类共享状态文件谁都可能留下一份。
 * 所以用例要在每条用例前写自己的那份、跑完还原成原样（原来没有就删掉），不能按「不存在才自建」——那样会读到别的测试
 * 留下的内容（preempt-stop 曾被另一个测试留下的 registry 读错 agent，在 CI 上稳定挂掉）。
 */
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isUnderTempDir } from "../src/lib/test-guard.js";

/** 每条用例前记下 paths 的原样并调用 seed 写入本用例的内容，用例结束后还原 */
export function ownStateFilesPerTest(paths: string[], seed: () => void): void {
  let saved: Array<[string, string | null]> = [];
  beforeEach(() => {
    saved = paths.map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]);
    seed();
  });
  afterEach(() => {
    for (const [p, v] of saved) {
      if (v === null) rmSync(p, { force: true });
      else writeFileSync(p, v);
    }
  });
}

/**
 * 清空状态目录下的 dir——只在它（解析软链后）位于系统临时目录下时（preload 建的状态目录就在这里）。显式设的
 * CLAUDESTRA_STATE_DIR 可能指向真实的 ~/.claude-orchestrator 或另一套实例，那里的东西不是测试的，删了就没了 → 抛错不删。
 */
export function clearTestStateDir(dir: string, isTemp: (p: string) => boolean = isUnderTempDir): void {
  if (!isTemp(dir)) {
    throw new Error(`拒绝清空 ${dir}：不在系统临时目录下（CLAUDESTRA_STATE_DIR 显式指向了真实状态目录？去掉它，让 tests/preload.ts 建临时目录）`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 本测试文件独占共享状态目录下的 dir（如 agent-settings/）：开跑前清空（别的测试或上一次跑留下的文件不影响「没文件」的断言），
 * 跑完再清空（不留给后面的文件）。文件内用例之间的先后照旧。不在临时目录下就抛错不删（clearTestStateDir）。
 */
export function ownStateDirForFile(dir: string): void {
  beforeAll(() => clearTestStateDir(dir));
  afterAll(() => clearTestStateDir(dir));
}
