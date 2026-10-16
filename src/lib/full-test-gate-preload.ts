/**
 * 直接敲 `bun test`（不经 scripts/test.ts）的准入，tests/preload.ts 调用（docs/architecture/full-test-gate.md）。
 * 全量调用不在这里自己当名额持有者：preload 跑在 bun test 进程里，等它退出时没人能确认整棵进程树已退出。
 * 所以交给 scripts/test.ts 监管——它拿名额、起一个带许可标记的 bun test，本进程只等它并原样返回退出码。
 * 带许可标记（经 scripts/test.ts 起的、或它们的子进程）、CI、带文件的调用直接放行，不双占。tests/full-test-gate-preload.test.ts。
 */
import { classifyBunArgv, FULL_TEST_PERMIT_ENV, isCiEnv, readOwnArgv } from "./full-test-gate-args.js";

export async function gateDirectBunTest(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (isCiEnv(env) || env[FULL_TEST_PERMIT_ENV]) return;
  const argv = await readOwnArgv();
  // 读不出命令行就按全量处理：宁可让带文件的调用多排一次队，也不漏闸
  const run = argv ? classifyBunArgv(argv) : { kind: "full" as const, args: [] };
  if (!argv) console.error("[full-test-gate] 读不出 bun test 的命令行，按全量处理");
  // preload 也被脚本 / bun -e 复用；只有 bun test 才参与准入。
  if (run.kind === "other" || run.kind === "focused" || run.kind === "worker") return;
  if (run.kind === "error") {
    console.error(`[full-test-gate] ${run.message}；测试未启动`);
    process.exit(2);
  }
  const { REPO_ROOT } = await import("./repo-root.js");
  const child = Bun.spawn([process.execPath, `${REPO_ROOT}/scripts/test.ts`, ...run.args], { stdio: ["inherit", "inherit", "inherit"], env });
  // 终端的 Ctrl-C 同组直达 scripts/test.ts，这里只吞掉免得先退出；kill 给本进程的 TERM / HUP 转过去
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  process.exit(await child.exited);
}
