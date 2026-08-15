#!/usr/bin/env bun
/**
 * `claudestra` — one-shot launcher (v2.4.0+)
 *
 * 打一句 `claudestra` 就把整套拉起来：
 *  1. 检查 3 个 launchd daemon（bridge / launcher / cron）有没有 load；
 *     没 load 的就 launchctl bootstrap。launchd 自己负责拉起 + KeepAlive 重启。
 *  2. 检测当前是不是 iTerm（`$TERM_PROGRAM`）：
 *     - 在 iTerm：当前窗口直接 `tmux -CC -S /tmp/claude-orchestrator/master.sock attach -t master`
 *     - 不在 iTerm：AppleScript 唤起 iTerm + 新建窗口 + 跑 attach
 *  3. 已在 tmux 里：tmux 拒绝嵌套，干净退出 + 告诉用户怎么手动 attach。
 *
 * 由 manager.ts install-cli 装的 wrapper（~/.local/bin/claudestra）调用本脚本，
 * REPO_ROOT 和 master tmux socket 通过环境变量注入。
 */

import { spawnSync } from "child_process";
import { homedir } from "os";

const REPO_ROOT = process.env.CLAUDESTRA_REPO || ".";
const TMUX_SOCK = process.env.CLAUDESTRA_SOCK || "/tmp/claude-orchestrator/master.sock";
const ATTACH_CMD = `tmux -S ${TMUX_SOCK} -CC attach -t master`;
const DAEMONS = ["com.claudestra.bridge", "com.claudestra.launcher", "com.claudestra.cron"] as const;
const PLIST_DIR = `${homedir()}/Library/LaunchAgents`;

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m",
};

function info(s: string) { process.stdout.write(`${C.dim}▶${C.reset} ${s}\n`); }
function ok(s: string)   { process.stdout.write(`${C.green}✓${C.reset} ${s}\n`); }
function fail(s: string) { process.stderr.write(`${C.red}✗${C.reset} ${s}\n`); }
function warn(s: string) { process.stdout.write(`${C.yellow}⚠${C.reset} ${s}\n`); }

function run(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

function getUid(): string {
  const r = run("/usr/bin/id", ["-u"]);
  return r.out.trim() || "501";
}

/** launchctl list <label> 返回 0 = 该 service 在 launchd 里有注册（load 了）。 */
function isLoaded(label: string): boolean {
  const r = run("launchctl", ["list", label]);
  return r.code === 0;
}

/** bootout（容错）+ bootstrap，把 plist load 到 launchd（自动起 RunAtLoad daemon）。 */
function bootstrapDaemon(label: string, uid: string): { ok: boolean; err: string } {
  const plistPath = `${PLIST_DIR}/${label}.plist`;
  run("launchctl", ["bootout", `gui/${uid}`, plistPath]);
  const r = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  return { ok: r.code === 0, err: r.err.trim() };
}

/** 确保 3 个 daemon 都在 launchd 里。已 load 的不动；没 load 的 bootstrap。 */
function ensureDaemonsRunning(): boolean {
  const uid = getUid();
  const missing = DAEMONS.filter((d) => !isLoaded(d));
  if (missing.length === 0) {
    ok(`launchd daemon 都在 (${DAEMONS.join(", ")})`);
    return true;
  }
  info(`daemon 缺 ${missing.length}/${DAEMONS.length}（${missing.join(", ")}），bootstrap…`);
  let allOk = true;
  for (const label of missing) {
    const r = bootstrapDaemon(label, uid);
    if (!r.ok) {
      fail(`bootstrap ${label} 失败: ${r.err}`);
      allOk = false;
    }
  }
  if (allOk) ok("daemon 都起来了");
  return allOk;
}

/** 接 master tmux session — iTerm 内联 / 不在 iTerm 时 AppleScript 开新窗口。 */
function attachMaster(): never {
  // 已在 tmux 里：tmux 拒绝嵌套 attach，干净退出。
  if (process.env.TMUX) {
    info(`已在 tmux 里 (${process.env.TMUX.split(",")[0]})，跳过 attach 避免嵌套。`);
    info("要进 master TUI，请在 iTerm 外层（非 tmux）shell 里再跑 claudestra；");
    info("如果你只是想从当前 tmux 接到 master，跑：");
    console.log(`  ${C.cyan}${ATTACH_CMD}${C.reset}`);
    info("（daemon 状态已在上面打印，不用再起）");
    process.exit(0);
  }
  const inITerm = process.env.TERM_PROGRAM === "iTerm.app";
  if (inITerm) {
    info("在 iTerm 里，本窗口直接 attach…");
    const r = spawnSync("/bin/sh", ["-c", ATTACH_CMD], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  info("不在 iTerm，AppleScript 唤起 iTerm 新窗口…");
  const cmdForAS = ATTACH_CMD.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow to write text "${cmdForAS}"
end tell`;
  const r = run("osascript", ["-e", script]);
  if (r.code === 0) {
    ok("已在 iTerm 打开新窗口并 attach 到 master");
    process.exit(0);
  } else {
    fail(`osascript 失败：${r.err.trim() || r.out.trim()}`);
    warn(`手动跑：${C.cyan}${ATTACH_CMD}${C.reset}`);
    process.exit(1);
  }
}

(async () => {
  console.log(`${C.bold}${C.cyan}🚀 Claudestra${C.reset}${C.dim} ↗ ${REPO_ROOT}${C.reset}`);
  if (!ensureDaemonsRunning()) {
    warn("daemon 没全起来，跳过 attach。查日志：tail -f ~/.claude-orchestrator/logs/bridge.err");
    process.exit(1);
  }
  attachMaster();
})();
