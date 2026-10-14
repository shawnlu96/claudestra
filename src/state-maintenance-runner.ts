/**
 * 状态根维护的独立执行器入口(由 manager state-maintenance 以 detached 方式拉起,不在 launchd 里,不随 bridge / 请求超时退出)。
 *   serve <runId> [--recover]  维护页 + 看护:页面就绪、状态 ready 之后才拉起 exec(恢复时拉起 recover)
 *   exec <runId> / recover <runId>  执行 / 中断恢复(lib/state-maintenance/executor.ts)
 *   note <maintRoot> / note-flush <maintRoot>  短命子进程:打开即关台账,写结果指针 / 补记待补指针
 * 不 import manager 主入口,也不静态 import 会读或生成身份的模块(台账写入只在 note 子命令里动态加载)。
 * tests/state-maintenance-runner.test.ts。
 */

import { existsSync, readFileSync } from "node:fs";
import { productionContext } from "./lib/state-maintenance/context.js";
import { executeRun, recoverRun } from "./lib/state-maintenance/executor.js";
import { startPage } from "./lib/state-maintenance/page.js";
import { maintPaths } from "./lib/state-maintenance/paths.js";
import { parseRunnerArgs } from "./lib/state-maintenance/runner-args.js";
import { pidAlive, realExecDeps, spawnRunner } from "./lib/state-maintenance/real-deps.js";
import { loadState, newState, runPaths, saveState, writeJson0600, type RunState } from "./lib/state-maintenance/run-store.js";

/** 结束态:页面再留一会儿给人看结果;停在需要恢复的状态则一直留着 */
const SETTLED = new Set<RunState["phase"]>(["done", "refused", "cancelled"]);
const LINGER_MS = 30 * 60_000;

/** manager 拉起本入口时用的参数形状(manager/state-maintenance.ts 按它类型检查 spawn) */
export type RunnerSpawnArgs = ["serve", string] | ["serve", string, "--recover"];

function executorAlive(maintRoot: string): boolean {
  try {
    return pidAlive(Number(readFileSync(`${maintPaths(maintRoot).control}/executor.lock`, "utf8").trim()));
  } catch {
    return false; // 没有锁文件 = 没有执行器在跑
  }
}

async function serve(runId: string, recover: boolean): Promise<void> {
  const ctx = productionContext();
  process.chdir(ctx.maintRoot); // 执行器与页面的 cwd 都在根外,停写探针里不留状态根句柄
  const existing = loadState(ctx.maintRoot, runId);
  if (!recover && existing) throw new Error("这次运行已经有状态,拒绝重复启动");
  const page = startPage({
    maintRoot: ctx.maintRoot, runId, now: () => Date.now(),
    executorAlive: () => executorAlive(ctx.maintRoot), spawnRecover: () => spawnRunner(ctx.maintRoot, ["recover", runId]),
  });
  writeJson0600(runPaths(ctx.maintRoot, runId).servePid, process.pid);
  writeJson0600(runPaths(ctx.maintRoot, runId).access, { port: page.port, code: page.code });
  if (recover) spawnRunner(ctx.maintRoot, ["recover", runId]);
  else {
    saveState(ctx.maintRoot, newState(runId), "ready", "维护页就绪");
    spawnRunner(ctx.maintRoot, ["exec", runId]);
  }
  let settledAt = 0;
  for (;;) {
    await Bun.sleep(5_000);
    const s = loadState(ctx.maintRoot, runId);
    const settled = !!s && SETTLED.has(s.phase) && !(s.note && !s.note.ok) && !executorAlive(ctx.maintRoot);
    settledAt = settled ? settledAt || Date.now() : 0;
    if (settledAt && Date.now() - settledAt > LINGER_MS) break;
  }
  page.stop();
}

async function note(cmd: "note" | "note-flush", maintRoot: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(maintRoot)) return { ok: false, error: "维护根不存在" };
  const ledger = await import("./lib/state-maintenance/ledger-access.js"); // 台账依赖图带身份模块:只在这个短命子进程里加载
  const flushed = ledger.flushPendingNotes(maintRoot);
  if (cmd === "note-flush") return flushed.failed.length ? { ok: false, error: flushed.failed.join(";") } : { ok: true };
  const r = ledger.recordPointer(maintRoot, JSON.parse(await Bun.stdin.text()));
  return r.ok ? { ok: true } : { ok: false, error: `留存未完成:${r.error}` };
}

async function runnerMain(argv: string[]): Promise<number> {
  const a = parseRunnerArgs(argv);
  if ("error" in a) return console.error(a.error), 2;
  if ("maintRoot" in a) return console.log(JSON.stringify(await note(a.cmd, a.maintRoot))), 0;
  if (a.cmd === "serve") return await serve(a.runId, a.recover), 0;
  const ctx = productionContext();
  process.chdir(ctx.maintRoot);
  const s = await (a.cmd === "exec" ? executeRun : recoverRun)(realExecDeps(ctx), a.runId);
  console.log(JSON.stringify({ runId: s.runId, phase: s.phase, outcome: s.outcome }));
  return 0;
}

if (import.meta.main) process.exit(await runnerMain(process.argv.slice(2)));
