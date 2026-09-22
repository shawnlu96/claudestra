/**
 * Claudestra 自己的磁盘落点，一处定义（2026-09 审查 D7-9 / D6-11）。
 *
 * 之前 `~/.claude-orchestrator` 在三十多处各自拼接，写法三种混用（`${HOME}/…`、
 * `homedir()`、`HOME || "~"`），registry.json 的路径定义了四份，`master.sock` 四份。
 * 结果是没有任何办法让一个沙箱实例不去读写生产的 registry / principals / master.sock。
 *
 * 两个 override（不设 = 与原来逐字节相同的路径）：
 *   - `CLAUDESTRA_STATE_DIR`   状态目录，默认 `~/.claude-orchestrator`
 *   - `CLAUDESTRA_RUNTIME_DIR` 运行目录（tmux socket、截图临时文件），默认 `/tmp/claude-orchestrator`
 *
 * ⚠ override 只作用于读到它的进程。Pi 扩展（src/pi/claudestra-extension.ts）为了只依赖
 * node: 模块而内联了同一条规则，改这里的默认值要同步改那边。
 *
 * 路径都在模块加载时求值（与之前各处的常量语义一致）；需要「换一个 home 算路径」的
 * 纯函数（测试用）走 `stateDirIn(home)`。
 */

import { homedir } from "os";
import { join } from "path";

/** 某个 home 下的默认状态目录（不看 override）。给带 `home` 参数的纯函数用。 */
export function stateDirIn(home: string): string {
  return join(home, ".claude-orchestrator");
}

function envDir(name: string): string | undefined {
  const v = (process.env[name] || "").trim();
  return v || undefined;
}

/** ~/.claude-orchestrator（或 CLAUDESTRA_STATE_DIR） */
export const STATE_DIR = envDir("CLAUDESTRA_STATE_DIR") ?? stateDirIn(homedir());

/** /tmp/claude-orchestrator（或 CLAUDESTRA_RUNTIME_DIR） */
export const RUNTIME_DIR = envDir("CLAUDESTRA_RUNTIME_DIR") ?? "/tmp/claude-orchestrator";

/** 状态目录下的文件 */
export function statePath(...parts: string[]): string {
  return join(STATE_DIR, ...parts);
}

/** 运行目录下的文件 */
export function runtimePath(...parts: string[]): string {
  return join(RUNTIME_DIR, ...parts);
}

/** master tmux session 的私有 socket */
export const TMUX_SOCK = runtimePath("master.sock");

// ── 状态文件（多处共用的才列在这里；只有一个模块用的由该模块自己 statePath()）──
export const REGISTRY_PATH = statePath("registry.json");
export const CONFIG_PATH = statePath("config.json");
export const LOG_DIR = statePath("logs");
export const ARCHIVE_ROOT = statePath("archive");
export const INBOX_DIR = statePath("inbox");
export const UPDATE_LOCK = statePath("update.lock");
export const CRON_HISTORY_PATH = statePath("cron-history.json");

/**
 * 被拉起的进程（agent 里的 claude / pi、它们的 hook、channel-server）不继承 manager 的 env，
 * 而是继承 tmux server 的全局 env。所以 override 必须显式写进启动前缀，否则沙箱 agent 的
 * hook 仍会写生产目录。没设 override 时返回空对象 → 启动命令与原来逐字节相同。
 */
export function pathOverrideEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR"]) {
    const v = (env[k] || "").trim();
    if (v) out[k] = v;
  }
  return out;
}
