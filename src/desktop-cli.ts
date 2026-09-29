/**
 * 菜单栏小程序（desktop/）调用的命令入口，每个子命令往 stdout 打一行 JSON。
 * app 的 Rust 外壳不做判断，只转发这里的结果——逻辑留在 TS，和 doctor / install-cli 共用一套口径。
 * 约定：命令本身失败 → `{ok:false, error}`（外壳转成报错）；doctor 的 ok:false 只表示有失败项，不带 error。
 * 这里自己产出的文案（error、服务行 detail）用英文：菜单栏按系统语言切中英，TS 侧只给一种，英文两边都看得懂。
 *
 *   bun src/desktop-cli.ts status    三个 daemon 的状态 + 本机网页地址 + 日志目录（毫秒级，菜单栏轮询用）
 *   bun src/desktop-cli.ts deps      运行时依赖（bun / claude 版本与登录 / tmux），即 doctor 的「运行时」分区
 *   bun src/desktop-cli.ts doctor    完整体检（只读，十几秒）
 *   bun src/desktop-cli.ts restart   launchctl kickstart -k 三个 daemon（顺序同 DAEMONS，launcher 最后）
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { dotenvBridgePort } from "./lib/bridge-url.js";
import { desktopLabels, LABELS_ENV, labelsOverrideFiles, overallStatus, updateHolder } from "./lib/desktop-status.js";
import { checkRuntime, runDoctor } from "./lib/doctor.js";
import { readDotenvFileSync } from "./lib/env-file.js";
import { daemonDetail, daemonState } from "./lib/launchd-status.js";
import { LOG_DIR } from "./lib/log-paths.js";
import { UPDATE_LOCK } from "./lib/paths.js";
import { REPO_ROOT } from "./lib/repo-root.js";
import { refuseInSandbox } from "./lib/sandbox.js";

const HOME = process.env.HOME || "";

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err: err.trim() };
}

/** Bun 会自动加载仓库里的 env 文件：label 覆盖写进去就会长期生效、悄悄改掉线上行为，所以只认进程环境 */
function labels(): string[] {
  const files = labelsOverrideFiles((f) => readDotenvFileSync(`${REPO_ROOT}/${f}`));
  if (files.length) throw new Error(`${LABELS_ENV} must not be set in ${files.join(" / ")} (export it for a dev run only)`);
  return desktopLabels();
}

async function status() {
  const dotenv = readDotenvFileSync(`${REPO_ROOT}/.env`);
  const list = await run(["launchctl", "list"]);
  if (list.code !== 0) return { ok: false, error: `launchctl list failed: ${list.err}` };
  const daemons = labels().map((label) => {
    const d = daemonState(list.out, label, existsSync(`${HOME}/Library/LaunchAgents/${label}.plist`));
    return { ...d, detail: daemonDetail(d.reason, "en") };
  });
  return {
    ok: true,
    overall: overallStatus(daemons),
    daemons,
    // 端口按 daemon 实际读到的 .env 算（和 doctor 同口径），不看调用方终端 export 的变量
    webUrl: `http://127.0.0.1:${dotenvBridgePort(REPO_ROOT, dotenv)}`,
    logDir: LOG_DIR,
    repoRoot: resolve(REPO_ROOT),
    configured: dotenv !== null,
  };
}

function readUpdateLock(): { text: string; mtimeMs: number } | null {
  try {
    return { text: readFileSync(UPDATE_LOCK, "utf8"), mtimeMs: statSync(UPDATE_LOCK).mtimeMs };
  } catch {
    return null; // 没有锁文件 = 没在更新
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 只探活不发信号
    return true;
  } catch {
    return false;
  }
}

async function restart() {
  refuseInSandbox("重启 launchd 服务");
  const targets = labels();
  const holder = updateHolder(readUpdateLock(), Date.now(), pidAlive);
  if (holder) return { ok: false, error: `an auto-update is running (pid ${holder}); restart after it finishes, or it would be cut off halfway` };
  const uid = process.getuid?.() ?? 0;
  const results = [];
  for (const label of targets) {
    const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
    results.push({ label, ok: r.code === 0, error: r.code === 0 ? undefined : r.err || `exit ${r.code}` });
  }
  const failed = results.filter((r) => !r.ok);
  return failed.length
    ? { ok: false, results, error: failed.map((r) => `${r.label}: ${r.error}`).join("\n") }
    : { ok: true, results };
}

type Result = { ok: boolean; error?: string; [k: string]: unknown };

async function main(sub: string | undefined): Promise<Result> {
  switch (sub) {
    case "status": return status();
    case "deps": return { ok: true, checks: await checkRuntime() };
    case "doctor": {
      const checks = await runDoctor(REPO_ROOT);
      return { ok: checks.every((c) => c.status !== "fail"), checks };
    }
    case "restart": return restart();
    default: return { ok: false, error: `unknown subcommand: ${sub ?? "(none)"} (status / deps / doctor / restart)` };
  }
}

if (import.meta.main) {
  main(process.argv[2])
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.log(JSON.stringify({ ok: false, error: (e as Error).message })); process.exit(1); });
}
