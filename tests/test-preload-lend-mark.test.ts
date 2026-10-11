/** tests/preload.ts 清掉出借 worker 标记：出借机上本地跑子进程台账用例和 CI 一致；子进程显式带标记照样被拒 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEND_WORKER_MARK } from "../src/lib/runtimes/clean-env.js";

let dir: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cstra-preload-lend-"));
  state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "demo", name: "demo", dirs: ["/tmp"], createdAt: "2026-10-11" }] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 照 manager-ledger.test.ts：子进程跑真实 manager.ts，状态目录指到临时目录，没有频道号 = 终端（owner） */
async function manager(extra: Record<string, string>, ...args: string[]): Promise<Record<string, any>> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(dir, "run"), ...extra };
  delete env.DISCORD_CHANNEL_ID;
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/manager.ts"), "ledger", ...args], { env, stdout: "pipe", stderr: "pipe" });
  return JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "");
}

describe("预加载清出借 worker 标记", () => {
  test("bun test 进程里没有标记，子进程按 owner 写临时台账成功", async () => {
    expect(LEND_WORKER_MARK).toBe("CLAUDESTRA_LEND_WORKER");
    expect(process.env.CLAUDESTRA_LEND_WORKER).toBeUndefined();
    expect(await manager({}, "item-new", "i01", "--project", "demo", "--title", "预加载")).toMatchObject({ ok: true, item: { project: "demo", id: "i01" } });
  }, 30_000);
  test("反例：子进程显式带标记，同一条写入仍被拒（生产拒绝逻辑没被绕开）", async () => {
    expect(await manager({ [LEND_WORKER_MARK]: "1" }, "item-new", "i01", "--project", "demo", "--title", "预加载")).toMatchObject({
      ok: false,
      code: "forbidden",
      error: "出借 worker 不能以本机身份写台账或改声明",
    });
  }, 30_000);
});
