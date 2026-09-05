/**
 * v2.4.0+：把 Claudestra 的 3 个 daemon 从 pm2 解耦，让 macOS launchd 直接管。
 *
 * 为啥换掉 pm2 启动链：
 *   - pm2 是 Node 写的，依赖一个能跑的 Node 实例。Node 又依赖一堆 dylib（icu4c
 *     之类）。brew 升级 icu4c / OpenSSL / libuv 都可能把 homebrew node 弄废，
 *     pm2 跟着挂；env-node 在 LaunchAgent PATH 里抓到 brew node 反而比 nvm 优先。
 *   - 用户的 node 装哪儿（nvm / fnm / asdf / volta / 系统 brew）千差万别，不能假设。
 *   - launchd 是 macOS 内置，永远在；Bun 是项目硬依赖（bridge / launcher / cron
 *     都跑在 bun 上），路径已经知道。组合起来就一条干净启动链：
 *         /Users/<user>/.bun/bin/bun  /repo/src/X.ts
 *     完全不依赖 node / pm2 / brew。
 *
 * 这个模块装/迁移以下东西（idempotent，每次 install-cli / update 都跑一次也无害）：
 *   1) `claudestra` CLI wrapper → ~/.local/bin/claudestra（XDG 标准，多数 PATH
 *      默认带它）+ ~/.bun/bin/claudestra symlink（兜底覆盖另一种常见 PATH）
 *   2) 三个 user-level LaunchAgent：
 *        com.claudestra.bridge.plist    → bun src/bridge.ts
 *        com.claudestra.launcher.plist  → bun src/launcher.ts
 *        com.claudestra.cron.plist      → bun src/cron.ts
 *      每个都 RunAtLoad=true（开机自启）+ KeepAlive=true（crash 自动重启，替代
 *      pm2 restart_delay）+ ThrottleInterval=10s（防 crash loop）。
 *   3) 迁移：把旧 com.claudestra.autostart.plist（v2.3.x，跑 pm2）+ 旧
 *      pm2.<user>.plist（pm2 startup 装的）unload 并 .bak 备份；把还在跑的 pm2
 *      daemon（discord-bridge / master-launcher / cron-scheduler）stop 掉，
 *      免得跟新 launchd 守护互相打架。
 *   4) 启动新 plist（launchctl bootout 容错 + bootstrap）。
 *
 * pm2 本身没卸：用户想 `pm2 logs` 看历史还能用。`ecosystem.config.cjs` 留着供
 * 临时手动启动 / 老熟人怀旧。但**启动链不再走 pm2**，所有面向用户的文档
 * （README / SETUP / CLAUDE.md / install.sh / master 模板）也已在 v2.13.1 全部
 * 改口径到 launchd —— 之前文档教 pm2、代码装 launchd，照着装会同时跑起两套：
 * 一个 token 两条 Discord 网关、3847 端口 EADDRINUSE 崩溃循环、两个 launcher
 * 抢同一个 tmux session。
 */

import { LOG_DIR, ensureLogDir } from "./log-paths.js";
import { mkdir, writeFile, chmod, stat, rename, unlink, symlink, readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { resolveBunPath } from "./bun-path.js";
import { ensureRecallHook, recallAvailable } from "./session-recall.js";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";
import { readActiveAgents } from "./registry.js";

const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";

/** 3 个 daemon 的 launchd 定义。改这里 = 改启动链。 */
export const DAEMONS = [
  // ⚠ 顺序即 reload 顺序,launcher 必须最后:update 子进程常由 launcher 派生,
  // bootout launcher 会让 launchd 连坐回收它(macOS 责任链不随 detach 断,
  // peer 取证 2026-08-09)——launcher 放最后保证 bridge/cron 先完成 reload,
  // 自杀只损失收尾输出。
  { label: "com.claudestra.bridge",   script: "src/bridge.ts",   stem: "bridge" },
  { label: "com.claudestra.cron",     script: "src/cron.ts",     stem: "cron" },
  { label: "com.claudestra.launcher", script: "src/launcher.ts", stem: "launcher" },
] as const;

/** 老 pm2 启动名（用于 stop 老的、避免跟新 launchd 抢） */
const LEGACY_PM2_NAMES = ["discord-bridge", "master-launcher", "cron-scheduler"];

export interface DaemonInstall {
  label: string;
  plistPath: string;
  loaded: boolean;
  warning?: string;
}

export interface InstallCliResult {
  cliWrapper: string;
  daemons: DaemonInstall[];
  /** 老 com.claudestra.autostart.plist（v2.3.x 一体式 autostart），已 unload+.bak */
  oldAutostartPlist?: { path: string; backed: string };
  /** 老 pm2.<user>.plist（pm2 startup 装的），已 unload+.bak */
  oldPm2StartupPlist?: { path: string; backed: string };
  /** 被 stop 掉的老 pm2 daemon 名字列表（防跟新 launchd 抢） */
  pm2Stopped: string[];
  /** 老 claudestra-autostart wrapper 是否被清掉了 */
  removedOldAutostartWrapper: boolean;
  /** Claude Code 的 ~/.claude/settings.json 里 typing-hook command 是否被迁移成 bun 绝对路径 */
  migratedHookCommand: boolean;
  /** v2.21.5+ SessionStart 记忆召回 hook:installed=本次写入 / present=早就有 / skipped=本机没有 ~/mem0-mcp/recall.py */
  recallHook?: "installed" | "present" | "skipped";
  /** iTerm 的 TmuxDashboardLimit 是否被调高（默认 10 → 200），从 oldValue → 200。null = iTerm 没装跳过；undefined = 已经 ≥ 200 无需改 */
  bumpedTmuxDashboardLimit?: { from: number; to: number; needsITermRestart?: boolean } | null;
  /** ~/.claude/settings.json permissions.allow 加进去的 mcp__<server>__* wildcard 规则（已存在的不重加） */
  allowedMcpTools?: { added: string[]; servers: string[] } | null;
  /** v2.5.4+ repo skills/ 里随包分发的 skill，symlink 到 ~/.claude/skills/ 的结果 */
  bundledSkills?: { linked: string[]; skipped: string[] };
  errors: string[];
  warnings: string[];
}

function which(cmd: string): string | null {
  const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && r.status === 0 ? p : null;
}

function getUid(): string {
  const r = spawnSync("/usr/bin/id", ["-u"], { encoding: "utf8" });
  return (r.stdout || "").trim() || "501";
}

/**
 * LaunchAgent 进程的 PATH。daemon 自己用绝对路径，PATH 主要供它 shell 出去时用
 * （launcher 调 tmux、cron 偶尔 spawn 别的命令）。简洁就行 —— 不再为 nvm / pm2
 * 各种位置打补丁。
 */
function buildEnvPath(): string {
  const home = homedir();
  return [
    `${home}/.bun/bin`,
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

/**
 * 把 `claudestra` 命令装到 ~/.local/bin（XDG 主路径）+ symlink 到 ~/.bun/bin。
 *
 * v2.4.1+：纯 bash wrapper，**自己**做 daemon 健康检查 + tmux attach。
 * 之前 v2.4.0 是 bun cli/claudestra.ts 跑 spawnSync 调 tmux —— iTerm 的 tmux -CC
 * 集成需要 tmux 是 iTerm 直接子进程才会切到 native tabs 模式，绕一层 bun
 * spawnSync 之后 iTerm 不识别 control 协议 → 看到普通 tmux attach。
 * 改成 bash `exec tmux -CC ...` 替换当前进程，tmux 字节流直送 iTerm PTY。
 */
async function writeCliWrapper(repoRoot: string, _bunPath: string): Promise<string> {
  const home = homedir();
  const primary = `${home}/.local/bin/claudestra`;
  const fallback = `${home}/.bun/bin/claudestra`;
  await mkdir(`${home}/.local/bin`, { recursive: true });
  await mkdir(`${home}/.bun/bin`, { recursive: true });
  const daemonLabels = DAEMONS.map((d) => `"${d.label}"`).join(" ");
  const content = `#!/usr/bin/env bash
# claudestra — one-shot launcher (Claudestra-installed, v2.4.1+)
# 流程：
#   1) launchctl 检查 3 个 daemon，没 load 的 bootstrap
#   2) 已在 tmux 嵌套，提示 + 退出
#   3) 在 iTerm：exec tmux -CC（iTerm 集成需要 tmux 是 iTerm 直接子进程）
#   4) 不在 iTerm：osascript 唤起 iTerm 新窗口跑 attach
set -u

REPO=${JSON.stringify(repoRoot)}
SOCK=${JSON.stringify(TMUX_SOCK)}
DAEMONS=(${daemonLabels})
PLIST_DIR="$HOME/Library/LaunchAgents"
ATTACH=(tmux -S "$SOCK" -CC attach -t master)

UID_NUM=$(/usr/bin/id -u)

CI=$'\\033[2m▶\\033[0m'
CO=$'\\033[32m✓\\033[0m'
CW=$'\\033[33m⚠\\033[0m'
CF=$'\\033[31m✗\\033[0m'
CB=$'\\033[1;36m'
CR=$'\\033[0m'

echo "\${CB}🚀 Claudestra\${CR} \\033[2m↗ $REPO\\033[0m"

missing=()
for d in "\${DAEMONS[@]}"; do
  /bin/launchctl list "$d" >/dev/null 2>&1 || missing+=("$d")
done

if [ \${#missing[@]} -eq 0 ]; then
  echo "$CO launchd daemon 都在 (\${DAEMONS[*]})"
else
  echo "$CI daemon 缺 \${#missing[@]}/\${#DAEMONS[@]}（\${missing[*]}），bootstrap…"
  fail=0
  for d in "\${missing[@]}"; do
    plist="$PLIST_DIR/$d.plist"
    /bin/launchctl bootout "gui/$UID_NUM" "$plist" >/dev/null 2>&1 || true
    if ! /bin/launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null; then
      echo "$CF bootstrap $d 失败 — 查 plist: $plist"
      fail=1
    fi
  done
  [ "$fail" -eq 1 ] && exit 1
  echo "$CO daemon 都起来了"
fi

# 已在 tmux 里：不嵌套 attach
if [ -n "\${TMUX:-}" ]; then
  echo "$CI 已在 tmux 里 (\${TMUX%%,*})，跳过 attach 避免嵌套"
  echo "    要进 master TUI：在 iTerm 外层（非 tmux）shell 里再跑 claudestra；"
  echo "    或者手动：\${ATTACH[*]}"
  exit 0
fi

# 在 iTerm：exec 替换当前进程，让 tmux 直接成为 iTerm 子进程（-CC 协议字节直送 PTY）
if [ "\${TERM_PROGRAM:-}" = "iTerm.app" ]; then
  echo "$CI 在 iTerm，exec tmux -CC（iTerm 集成会切到 native tabs）"
  exec "\${ATTACH[@]}"
fi

# 不在 iTerm：osascript 唤起 iTerm 新窗口跑 attach
echo "$CI 不在 iTerm，AppleScript 唤起 iTerm 新窗口…"
ATTACH_STR="\${ATTACH[*]}"
/usr/bin/osascript <<APPLESCRIPT
tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow to write text "$ATTACH_STR"
end tell
APPLESCRIPT
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "$CO 已在 iTerm 打开新窗口并 attach 到 master"
else
  echo "$CF osascript 失败，手动跑：\${ATTACH[*]}"
fi
exit "$rc"
`;
  // 老版本可能在 primary 写过 symlink（甚至 ~/.local/bin <-> ~/.bun/bin 循环），
  // writeFile 会 ELOOP；先 unlink 容错再写真实文件。
  await unlink(primary).catch(() => {});
  await writeFile(primary, content);
  await chmod(primary, 0o755);
  // ~/.bun/bin/claudestra symlink → primary（两个 PATH 选项都覆盖）
  try {
    await unlink(fallback).catch(() => {});
    await symlink(primary, fallback);
  } catch { /* 非关键 */ }
  return primary;
}

function buildDaemonPlist(
  repoRoot: string,
  bunPath: string,
  daemon: typeof DAEMONS[number],
): string {
  const home = homedir();
  const envPath = buildEnvPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemon.label}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>${home}</string>
    <!--
      LANG/LC_ALL 必须注入 UTF-8 locale，否则 daemon 派生的子进程（tmux 尤其）
      跑在 C locale 下会把 CJK 字符渲染成 '_' placeholder。导致 launcher 调
      manager.ts list 时拿到的 tmux window name 跟 registry 里的真实 CJK name
      不 match，永远判定 dead → 死循环 restart → zombie window 累积。
      pm2 时代不出问题是因为 pm2 从 user shell 启动，继承了 LANG。
    -->
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>LC_ALL</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${repoRoot}/${daemon.script}</string>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/${daemon.stem}.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/${daemon.stem}.err</string>
</dict>
</plist>
`;
}

async function writeDaemonPlists(
  repoRoot: string,
  bunPath: string,
): Promise<{ label: string; plistPath: string }[]> {
  const dir = `${homedir()}/Library/LaunchAgents`;
  await mkdir(dir, { recursive: true });
  const out: { label: string; plistPath: string }[] = [];
  for (const d of DAEMONS) {
    const plistPath = `${dir}/${d.label}.plist`;
    await writeFile(plistPath, buildDaemonPlist(repoRoot, bunPath, d));
    out.push({ label: d.label, plistPath });
  }
  return out;
}

/** bootout（容错）+ bootstrap。bootstrap 失败返回错误信息。 */
function reloadDaemon(plistPath: string, uid: string): { ok: boolean; err: string } {
  spawnSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { encoding: "utf8" });
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || "").trim() };
}

/**
 * v2.3.x 装的 com.claudestra.autostart.plist + 老的 pm2.<user>.plist 都 unload
 * + 重命名 .bak。免得 boot 时跟新的三个 plist 一起跑、抢着启动 pm2。
 */
async function migrateOldPlists(): Promise<{
  oldAutostartPlist?: { path: string; backed: string };
  oldPm2StartupPlist?: { path: string; backed: string };
}> {
  const dir = `${homedir()}/Library/LaunchAgents`;
  if (!existsSync(dir)) return {};
  const out: any = {};
  // v2.3.x 一体式 autostart
  const autostart = `${dir}/com.claudestra.autostart.plist`;
  if (existsSync(autostart)) {
    spawnSync("launchctl", ["unload", autostart], { encoding: "utf8" });
    const backed = autostart + ".bak";
    try { await rename(autostart, backed); out.oldAutostartPlist = { path: autostart, backed }; }
    catch { /* 不能 rename 就算了 */ }
  }
  // 更老的 pm2 startup 装的
  const user = process.env.USER || "";
  for (const name of [`pm2.${user}.plist`, "pm2.plist"]) {
    const p = join(dir, name);
    if (existsSync(p)) {
      spawnSync("launchctl", ["unload", p], { encoding: "utf8" });
      const backed = p + ".bak";
      try { await rename(p, backed); out.oldPm2StartupPlist = { path: p, backed }; break; }
      catch { /* */ }
    }
  }
  return out;
}

/**
 * 老 pm2 daemon（discord-bridge / master-launcher / cron-scheduler）如果在跑，
 * stop 掉 —— 新 launchd 守护会立刻拉同样的 daemon 起来，pm2 不放手就会有两份。
 * pm2 不在 PATH 就直接跳过，没事。
 */
async function stopLegacyPm2Daemons(): Promise<string[]> {
  const pm2Path = which("pm2");
  if (!pm2Path) return [];
  const stopped: string[] = [];
  // 先看哪些真在跑（避免对没起的 daemon 调 delete 报错刷屏）
  const list = spawnSync(pm2Path, ["jlist"], { encoding: "utf8" });
  if (list.status !== 0) return [];
  let online: string[] = [];
  try {
    const procs = JSON.parse(list.stdout || "[]") as Array<{ name: string; pm2_env?: { status?: string } }>;
    online = procs
      .filter((p) => LEGACY_PM2_NAMES.includes(p.name) && p.pm2_env?.status === "online")
      .map((p) => p.name);
  } catch { /* parse fail */ }
  for (const name of online) {
    const r = spawnSync(pm2Path, ["delete", name], { encoding: "utf8" });
    if (r.status === 0) stopped.push(name);
  }
  if (stopped.length > 0) {
    // 更新 pm2 dump 文件，万一用户还在用 pm2 resurrect 也不会重新拉起这仨
    spawnSync(pm2Path, ["save"], { encoding: "utf8" });
  }
  return stopped;
}

/**
 * Claude Code 的 typing-hook 在 ~/.claude/settings.json 里 v2.3.x 之前是
 *     command: "bun /path/to/src/hooks/typing-hook.ts"
 * 用相对命令 `bun`。v2.4.0 切到 launchd 后，worker 进程的 PATH 链不再继承用户终端
 * PATH（launchd plist envPath 是给 daemon 用的，worker 是 master tmux pane 派生的，
 * shell 启动可能没 ~/.bun/bin），Claude Code 用 `/bin/sh -c "bun ..."` 跑 hook 就
 * "/bin/sh: bun: command not found"。
 *
 * 修法：每次 install-cli 都把 settings.json 里所有指向 typing-hook.ts 的 command
 * 替换为 bun **绝对路径**，幂等（已经是绝对路径就 no-op）。
 */
/**
 * v2.21.5+ SessionStart 记忆召回 hook(lib/session-recall.ts):本机装了 ~/mem0-mcp/recall.py
 * 才注册,幂等——已有就只校正命令/matcher/timeout。setup / install-cli / update /
 * `manager install-hooks` 四处共用。
 */
export async function ensureRecallHookInstalled(bunPath: string, repoRoot: string): Promise<{ status: "installed" | "present" | "skipped"; command: string }> {
  const command = `${bunPath} ${resolve(repoRoot)}/src/hooks/recall-hook.ts`;
  if (!recallAvailable()) return { status: "skipped", command };
  const settingsPath = `${homedir()}/.claude/settings.json`;
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(await readFile(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  const changed = ensureRecallHook(settings, command);
  if (changed) await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { status: changed ? "installed" : "present", command };
}

async function migrateHookCommand(bunPath: string): Promise<boolean> {
  const settingsPath = `${homedir()}/.claude/settings.json`;
  if (!existsSync(settingsPath)) return false;
  let raw: string;
  try { raw = await readFile(settingsPath, "utf-8"); } catch { return false; }
  let settings: any;
  try { settings = JSON.parse(raw); } catch { return false; }
  if (!settings.hooks || typeof settings.hooks !== "object") return false;

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        // 匹配 "bun /path/.../typing-hook.ts" — 把开头的 "bun " 换成绝对路径
        const m = h.command.match(/^bun\s+(.+typing-hook\.ts)\s*$/);
        if (m) {
          h.command = `${bunPath} ${m[1]}`;
          changed = true;
        }
      }
    }
  }

  if (!changed) return false;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

/**
 * 用户主动装的 MCP server 工具在 Claude Code auto permission mode 下经常被
 * classifier 拦截：
 *   - mcp__claudestra__reply 被误判成"擅自向外部发布"
 *   - mcp__alipan__* / mcp__resource-search__* / mcp__moviepilot__* 等被
 *     classifier 看不懂语境直接 deny
 *   - 或者更糟：classifier 模型（Opus 4.7）overload 时 fallback deny
 *     "claude-opus-4-7 is temporarily unavailable, so auto mode cannot
 *      determine the safety of mcp__resource-search__search_alipan_resource"
 *
 * 这些 MCP server 都是用户主动 `claude mcp add` 装的，agent 用它们是合理任务。
 * classifier 不该审 —— 用户已经表达"装了就是要用"的意图。
 *
 * 修：扫所有已装 MCP server（user-level + project-level），全部加 wildcard
 * `mcp__<server>__*` 到 ~/.claude/settings.json permissions.allow。
 * idempotent —— 已存在的 entry 不重复加；用户自己加的 specific tool allow 不动；
 * 把 v2.4.9 那 6 条 mcp__claudestra__* specific allow 合并成一条
 * mcp__claudestra__* wildcard。
 */
async function ensureMcpToolsAllowed(repoRoot: string): Promise<{ added: string[]; servers: string[] } | null> {
  const settingsPath = `${homedir()}/.claude/settings.json`;
  if (!existsSync(settingsPath)) return null;
  let raw: string;
  try { raw = await readFile(settingsPath, "utf-8"); } catch { return null; }
  let settings: any;
  try { settings = JSON.parse(raw); } catch { return null; }
  if (!settings.permissions || typeof settings.permissions !== "object") {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  const serverNames = new Set<string>();
  // 1) user-level: ~/.claude.json mcpServers
  try {
    const claudeJson = JSON.parse(await readFile(`${homedir()}/.claude.json`, "utf-8"));
    Object.keys(claudeJson?.mcpServers || {}).forEach((s) => serverNames.add(s));
    // 2) project-level: ~/.claude.json projects[].mcpServers
    for (const p of Object.values(claudeJson?.projects || {}) as any[]) {
      Object.keys(p?.mcpServers || {}).forEach((s) => serverNames.add(s));
    }
  } catch { /* ignore */ }

  // 3) project-level：扫所有 Claudestra registry 里 active agent 的 cwd
  //    下的 .mcp.json —— project-level MCP server 都列在那里
  for (const info of await readActiveAgents()) {
    if (!info.cwd) continue;
    const mcpPath = `${info.cwd}/.mcp.json`;
    if (!existsSync(mcpPath)) continue;
    try {
      const projMcp = JSON.parse(await readFile(mcpPath, "utf-8"));
      Object.keys(projMcp?.mcpServers || {}).forEach((s) => serverNames.add(s));
    } catch { /* skip bad json */ }
  }

  // 4) 最起码确保 claudestra 本身在（即使上面都没找到，比如全新装机）
  let mcpName = process.env.MCP_NAME || "";
  if (!mcpName) {
    try {
      const envText = await readFile(`${repoRoot}/.env`, "utf-8").catch(() => "");
      const m = envText.match(/^MCP_NAME\s*=\s*(.+)$/m);
      if (m) mcpName = m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* */ }
  }
  if (!mcpName) mcpName = "claudestra";
  serverNames.add(mcpName);

  // 每个 server 加一条 wildcard allow（MCP tool prefix 用 underscore，跟 server
  // 名同样 sanitize：hyphen → underscore，跟 channel-server 注册 tool 名一致）
  const existing = new Set<string>(settings.permissions.allow);
  const added: string[] = [];
  const servers = Array.from(serverNames).sort();
  for (const s of servers) {
    const rule = `mcp__${s.replace(/-/g, "_")}__*`;
    if (!existing.has(rule)) {
      settings.permissions.allow.push(rule);
      added.push(rule);
    }
  }
  if (added.length === 0) return { added: [], servers };
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { added, servers };
}

/**
 * iTerm 默认 `TmuxDashboardLimit = 10`：tmux session windows 数 > 10 时 iTerm
 * 把所有 windows 标 buried（不自动 open native tabs），让用户从 dashboard 手动
 * 选 reveal。Claudestra 用户 worker 一旦超 10 个，attach 就看不到 native tabs，
 * 还得逐个 reveal 极痛苦。
 *
 * v2.3.2 引入"reboot autostart 并发 restart 全部 worker"后这个 bug 才显现 ——
 * pm2 时代用户慢慢一个个 create 不一定超 10；现在 reboot 一次性瞬间 11 个就
 * 触发了 iTerm 的 throttle。
 *
 * 调到 200（基本无限制）。idempotent —— 已经 ≥ 200 就不改，让用户自己设的值
 * 不被覆盖。iTerm 没装就跳过。
 */
async function bumpITermTmuxDashboardLimit(): Promise<
  { from: number; to: number; needsITermRestart?: boolean } | null | undefined
> {
  // 检查 iTerm 是否装了
  if (!existsSync("/Applications/iTerm.app")) return null;
  const TARGET = 200;
  // defaults read 拿当前值（没设过 → 用 iTerm 默认 10）
  const r = spawnSync("defaults", ["read", "com.googlecode.iterm2", "TmuxDashboardLimit"], { encoding: "utf8" });
  const current = r.status === 0 ? parseInt((r.stdout || "").trim(), 10) : 10;
  if (Number.isFinite(current) && current >= TARGET) return undefined;
  const from = Number.isFinite(current) ? current : 10;
  const w = spawnSync("defaults", ["write", "com.googlecode.iterm2", "TmuxDashboardLimit", "-int", String(TARGET)], { encoding: "utf8" });
  if (w.status !== 0) return null;
  // v2.18.1（owner 2026-08-10 实报「日本那台 iTerm 有窗口不显示」）：这台机器
  // iTerm 装着、本函数也跑过，值却从没落地——运行中的 iTerm 把偏好缓存在内存
  // 里，退出时会用旧值覆盖回磁盘，我们写的 200 就这么没了（macOS defaults 的
  // 经典行为）。写完立刻回读，并把「iTerm 正在运行 → 需要重启才生效、且现在
  // 不重启可能被覆盖」这件事显式冒泡，不再静默失效。
  const back = spawnSync("defaults", ["read", "com.googlecode.iterm2", "TmuxDashboardLimit"], { encoding: "utf8" });
  const verified = back.status === 0 ? parseInt((back.stdout || "").trim(), 10) : NaN;
  if (verified !== TARGET) return null; // 写了但没落地，按失败报
  const running = spawnSync("pgrep", ["-x", "iTerm2"], { encoding: "utf8" }).status === 0;
  return { from, to: TARGET, needsITermRestart: running || undefined };
}

/** v2.3.x 写过的 ~/.bun/bin/claudestra-autostart 现在没用了，清掉。 */
async function removeOldAutostartWrapper(): Promise<boolean> {
  const target = `${homedir()}/.bun/bin/claudestra-autostart`;
  if (!existsSync(target)) return false;
  try { await unlink(target); return true; } catch { return false; }
}

/**
 * 主入口：装 CLI + 写 3 个 daemon plist + 迁移老配置 + 启动新 plist。
 *
 * 顺序很重要：
 *   1) 写 CLI wrapper（独立于 daemon，先把它落地）
 *   2) 写 3 个新 plist（落地不 load）
 *   3) unload + .bak 老的 autostart plist（不让它再跟新的争）
 *   4) stop 老 pm2 daemon（不让 pm2 进程跟新 launchd 进程同时跑同一个 daemon）
 *   5) 清老 claudestra-autostart 包装脚本
 *   6) bootstrap 3 个新 plist（launchd 接管）
 *
 * Idempotent —— 跑多次只是重写同一份文件 + 重新 load，无害。每次 update 走一次。
 */
/**
 * v2.5.4+ 把 repo skills/ 下随包分发的 skill symlink 到 ~/.claude/skills/。
 * 用 symlink 而不是拷贝：update 后 skill 内容自动跟着 repo 走，无需重装。
 * 幂等规则：目标不存在或已是 symlink → (重)建指向本 repo；目标是用户自己的真实
 * 目录 → 不动（尊重用户自定义），记进 skipped。
 */
async function installBundledSkills(repoRoot: string): Promise<{ linked: string[]; skipped: string[] }> {
  const srcRoot = join(repoRoot, "skills");
  const dstRoot = join(homedir(), ".claude", "skills");
  const linked: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(srcRoot)) return { linked, skipped };
  const { readdir, lstat, rm } = await import("fs/promises");
  await mkdir(dstRoot, { recursive: true });
  for (const name of await readdir(srcRoot)) {
    const src = join(srcRoot, name);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    const dst = join(dstRoot, name);
    try {
      const st = await lstat(dst).catch(() => null);
      if (st && !st.isSymbolicLink()) {
        skipped.push(name); // 用户自己的同名 skill，不覆盖
        continue;
      }
      if (st) await rm(dst); // 旧 symlink（可能指向老路径）→ 重建
      await symlink(src, dst);
      linked.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { linked, skipped };
}

/**
 * 非 macOS 平台的替代方案提示：一个可直接抄用的 systemd user unit 模板。
 * 三个 daemon 只有入口脚本不同，故只给一份带占位的模板。
 */
function systemdUnitHint(repoRoot: string, bunPath: string): string {
  return [
    `  # ~/.config/systemd/user/claudestra-bridge.service`,
    `  # （launcher / cron 同理，把 ExecStart 换成 src/launcher.ts、src/cron.ts，`,
    `  #   服务名相应改成 claudestra-launcher / claudestra-cron）`,
    `  [Unit]`,
    `  Description=Claudestra bridge`,
    `  [Service]`,
    `  ExecStart=${bunPath} ${repoRoot}/src/bridge.ts`,
    `  WorkingDirectory=${repoRoot}`,
    `  EnvironmentFile=${repoRoot}/.env`,
    `  Restart=always`,
    `  RestartSec=10`,
    `  [Install]`,
    `  WantedBy=default.target`,
  ].join("\n");
}

export async function installClaudestraCli(repoRoot: string): Promise<InstallCliResult> {
  repoRoot = resolve(repoRoot);
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: InstallCliResult = {
    cliWrapper: "",
    daemons: [],
    pm2Stopped: [],
    removedOldAutostartWrapper: false,
    migratedHookCommand: false,
    errors,
    warnings,
  };

  // 平台守卫。这个函数整体是 launchd 专有的：写 ~/Library/LaunchAgents/*.plist、
  // 调 launchctl bootout/bootstrap。以前没有这道判断，Linux 上会照样往
  // ~/Library/LaunchAgents 里 mkdir -p 出一个假目录、launchctl 报 command not found，
  // 而调用方（setup.ts）只 warn 不 fail —— 用户看到"✨ 安装完成"，实际没有任何
  // 进程守护、开机不自启，且文档里的排查命令（launchctl list）全都用不了。
  // 与其假装成功，不如明确失败并给出可操作的替代方案。
  if (process.platform !== "darwin") {
    errors.push(
      `进程守护当前只实现了 macOS launchd，检测到 ${process.platform}。\n` +
        `Claudestra 本身能在 Linux 上跑（bridge / launcher / cron 都是普通 Bun 进程），\n` +
        `只是需要你自己接管开机自启。用 systemd 的话，为这三个服务各建一个 user unit：\n\n` +
        systemdUnitHint(repoRoot, resolveBunPath()) +
        `\n然后 systemctl --user daemon-reload && systemctl --user enable --now claudestra-bridge`
    );
    return result;
  }

  // 找 bun（绝对路径，写进所有 plist + CLI wrapper）
  const bunPath = resolveBunPath();
  try { await stat(bunPath); }
  catch { errors.push(`bun 不在 ${bunPath}（先 curl -fsSL https://bun.sh/install | bash）`); return result; }

  // 1) CLI wrapper
  try { result.cliWrapper = await writeCliWrapper(repoRoot, bunPath); }
  catch (e) { errors.push(`CLI wrapper: ${(e as Error).message}`); return result; }

  // 2) 写 3 个 plist
  let plists: { label: string; plistPath: string }[];
  try { plists = await writeDaemonPlists(repoRoot, bunPath); }
  catch (e) { errors.push(`写 daemon plist: ${(e as Error).message}`); return result; }

  // 3) 迁移老 plist
  try {
    const m = await migrateOldPlists();
    if (m.oldAutostartPlist) result.oldAutostartPlist = m.oldAutostartPlist;
    if (m.oldPm2StartupPlist) result.oldPm2StartupPlist = m.oldPm2StartupPlist;
  } catch (e) { warnings.push(`迁移老 plist: ${(e as Error).message}`); }

  // 4) stop 老 pm2 daemon
  try { result.pm2Stopped = await stopLegacyPm2Daemons(); }
  catch (e) { warnings.push(`stop 老 pm2 daemon: ${(e as Error).message}`); }

  // 5) 清老 autostart wrapper
  result.removedOldAutostartWrapper = await removeOldAutostartWrapper();

  // 5b) 迁移 ~/.claude/settings.json hook command → bun 绝对路径（v2.4.0 后必须，
  //     不然 worker 跑 hook 时 /bin/sh PATH 没 ~/.bun/bin，bun 找不到）
  try { result.recallHook = (await ensureRecallHookInstalled(bunPath, repoRoot)).status; }
  catch (e) { warnings.push(`召回 hook: ${(e as Error).message}`); }
  try { result.migratedHookCommand = await migrateHookCommand(bunPath); }
  catch (e) { warnings.push(`迁移 hook command: ${(e as Error).message}`); }

  // 5c) 调高 iTerm TmuxDashboardLimit（默认 10 让 > 10 windows 全 bury，参考
  //     bumpITermTmuxDashboardLimit 注释里完整背景）
  try {
    result.bumpedTmuxDashboardLimit = await bumpITermTmuxDashboardLimit();
    if (result.bumpedTmuxDashboardLimit?.needsITermRestart) {
      warnings.push(
        "iTerm 窗口上限已调到 200，但 iTerm 正在运行——**需要重启 iTerm 才生效**；" +
        "且运行中的 iTerm 退出时可能用旧值覆盖回去，建议尽快重启一次（不重启的话超过 10 个 agent 窗口不会显示为标签页）"
      );
    }
  } catch (e) { warnings.push(`调 iTerm TmuxDashboardLimit: ${(e as Error).message}`); }

  // 5d) 扫所有已装 MCP server（user-level + project-level）加 wildcard allow
  //     到 settings.json，避免 auto classifier 拦截用户主动装的 MCP 工具
  //     （参考 ensureMcpToolsAllowed 注释里的多个 bug 案例）
  try { result.allowedMcpTools = await ensureMcpToolsAllowed(repoRoot); }
  catch (e) { warnings.push(`allow mcp__*__* 工具: ${(e as Error).message}`); }

  // 5e) repo skills/ 里的随包 skill → symlink 到 ~/.claude/skills/（save-compact 等）
  try { result.bundledSkills = await installBundledSkills(repoRoot); }
  catch (e) { warnings.push(`装 bundled skills: ${(e as Error).message}`); }

  // 6) bootstrap 3 个新 plist
  const uid = getUid();
  for (const p of plists) {
    const r = reloadDaemon(p.plistPath, uid);
    const item: DaemonInstall = { label: p.label, plistPath: p.plistPath, loaded: r.ok };
    if (!r.ok) {
      item.warning = r.err || "launchctl bootstrap failed";
      warnings.push(`${p.label}: ${item.warning}`);
    }
    result.daemons.push(item);
  }

  return result;
}
