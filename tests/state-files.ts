/**
 * 同一次 bun test 的所有测试文件共用一个临时状态目录（tests/preload.ts），registry.json 这类共享状态文件谁都可能留下一份。
 * 所以用例要在每条用例前写自己的那份、跑完还原成原样（原来没有就删掉），不能按「不存在才自建」——那样会读到别的测试
 * 留下的内容（preempt-stop 曾被另一个测试留下的 registry 读错 agent，在 CI 上稳定挂掉）。
 */
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
 * 本测试文件独占共享状态目录下的 dir（如 agent-settings/）：开跑前清空（别的测试或上一次跑留下的文件不影响「没文件」的断言），
 * 跑完再清空（不留给后面的文件）。文件内用例之间的先后照旧。
 */
export function ownStateDirForFile(dir: string): void {
  const clear = () => rmSync(dir, { recursive: true, force: true });
  beforeAll(clear);
  afterAll(clear);
}
