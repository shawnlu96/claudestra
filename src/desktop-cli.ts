/**
 * 菜单栏小程序（desktop/）调用的命令入口，每个子命令往 stdout 打一行 JSON。
 * app 的 Rust 外壳不做判断，只转发这里的结果——逻辑留在 TS，和 doctor / install-cli 共用一套口径。
 *
 *   bun src/desktop-cli.ts status    三个 daemon 的状态 + 本机网页地址 + 日志目录（毫秒级，菜单栏轮询用）
 *   bun src/desktop-cli.ts deps      运行时依赖（bun / claude 版本与登录 / tmux），即 doctor 的「运行时」分区
 *   bun src/desktop-cli.ts doctor    完整体检（只读，十几秒）
 *   bun src/desktop-cli.ts restart   launchctl kickstart -k 三个 daemon（顺序同 DAEMONS，launcher 最后）
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { resolveBridgePort } from "./lib/bridge-url.js";
import { daemonState, desktopLabels, overallStatus } from "./lib/desktop-status.js";
import { checkRuntime, runDoctor } from "./lib/doctor.js";
import { readDotenvFileSync } from "./lib/env-file.js";
import { LOG_DIR } from "./lib/log-paths.js";
import { REPO_ROOT } from "./lib/repo-root.js";
import { refuseInSandbox } from "./lib/sandbox.js";

const HOME = process.env.HOME || "";

function emit(obj: unknown): void {
  console.log(JSON.stringify(obj));
}

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err: err.trim() };
}

async function status() {
  const list = await run(["launchctl", "list"]);
  const daemons = desktopLabels().map((label) =>
    daemonState(list.out, label, existsSync(`${HOME}/Library/LaunchAgents/${label}.plist`)));
  // 端口按 daemon 实际读到的 .env 算（和 doctor 同口径），不看调用方终端 export 的变量
  const port = resolveBridgePort(readDotenvFileSync(`${REPO_ROOT}/.env`) ?? {});
  return {
    ok: list.code === 0,
    overall: overallStatus(daemons),
    daemons,
    webUrl: `http://127.0.0.1:${port}`,
    logDir: LOG_DIR,
    repoRoot: resolve(REPO_ROOT),
    configured: existsSync(`${REPO_ROOT}/.env`),
  };
}

async function restart() {
  refuseInSandbox("重启 launchd 服务");
  const uid = process.getuid?.() ?? 0;
  const results = [];
  for (const label of desktopLabels()) {
    const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
    results.push({ label, ok: r.code === 0, error: r.code === 0 ? undefined : r.err || `exit ${r.code}` });
  }
  return { ok: results.every((r) => r.ok), results };
}

async function main(sub: string | undefined) {
  switch (sub) {
    case "status": return status();
    case "deps": return { ok: true, checks: await checkRuntime() };
    case "doctor": {
      const checks = await runDoctor(REPO_ROOT);
      return { ok: checks.every((c) => c.status !== "fail"), checks };
    }
    case "restart": return restart();
    default: return { ok: false, error: `未知子命令：${sub ?? "(空)"}（status / deps / doctor / restart）` };
  }
}

if (import.meta.main) {
  main(process.argv[2])
    .then((r) => { emit(r); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { emit({ ok: false, error: (e as Error).message }); process.exit(1); });
}
