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
import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { resolveBunPath } from "./bun-path.js";
import { ensureRecallHook, readClaudeSettings, recallAvailable, writeClaudeSettings } from "./session-recall.js";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";
import { readActiveAgents } from "./registry.js";
import { rebuildWebIfStale, restartWebService, type WebBuildResult } from "./web-build.js";

const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";

export interface DaemonSpec {
  label: string;
  stem: string;
  /** bun 跑的仓库内脚本（与 exec 二选一） */
  script?: string;
  /** 自带 argv + 工作目录（web 前端走这条：next start，不经 bun） */
  exec?: { cwd: string; argv: string[] };
  /** 已存在同名 plist 就不覆盖（给 web：用户可能手写过自己的） */
  keepExisting?: boolean;
}

/** 常驻 daemon 的 launchd 定义。改这里 = 改启动链。 */
export const DAEMONS: DaemonSpec[] = [
  // ⚠ 顺序即 reload 顺序,launcher 必须最后:update 子进程常由 launcher 派生,
  // bootout launcher 会让 launchd 连坐回收它(macOS 责任链不随 detach 断,
  // peer 取证 2026-08-09)——launcher 放最后保证 bridge/cron 先完成 reload,
  // 自杀只损失收尾输出。
  { label: "com.claudestra.bridge",   script: "src/bridge.ts",   stem: "bridge" },
  { label: "com.claudestra.cron",     script: "src/cron.ts",     stem: "cron" },
  { label: "com.claudestra.launcher", script: "src/launcher.ts", stem: "launcher" },
];

/**
 * 生成标记。写进我们自己生成的每一份 plist。
 *
 * ⚠ 为什么必须有：`keepExisting` 原本是「文件已存在就不覆盖」，用来保护用户手写的
 * plist（改过端口 / 日志落点 / 挂在反代后面）。但它同时也保护了**我们上一版生成的
 * 那一份**——试装用户 2026-09-22 就栽在这：他先用带 shebang bug 的版本跑过一次
 * install-cli，生成了一份起不来的 web plist（launchctl 报 exit 127 = 命令找不到）；
 * 之后拉了修复版再跑，`keepExisting` 原样保留那份坏文件，**修复根本没机会生效**。
 * 「不覆盖用户的」和「永远不更新自己的」是两件事，靠这个标记分开。
 */
const GENERATED_MARKER = "ClaudestraGenerated";

/**
 * 我们**历史上生成过**的 web plist 长什么样（用来认出「标记出现之前生成的那些」）。
 *
 * ⚠ 光有标记不够 —— 标记是 2026-09-22 才加的，在那之前生成的 plist 一个标记都没有，
 * 于是被永远当成「用户手写的」保护起来、再也更新不了。试装现场就卡死在这：
 * install-cli 回 `keptExisting: true`，而那份文件正是上一版生成的坏文件
 * （`env: node: No such file or directory`）。
 *
 * 判据只认**独立的绝对路径**元素，不做子串匹配：用户手写的那种
 * `/bin/sh -c 'exec ./node_modules/.bin/next start -p 3333'` 里虽然也出现
 * `./node_modules/.bin/next`，但它是一整条命令字符串、不是绝对路径元素，
 * 所以不会被误判成我们的（实测 owner 本机那份仍被判为用户手写）。
 */
const LEGACY_GENERATED_ARGV = [
  /<string>\/[^<]*\/node_modules\/\.bin\/next<\/string>/,
  /<string>\/[^<]*\/node_modules\/next\/dist\/bin\/next<\/string>/,
];

/** 这份 plist 是我们自己生成的吗（不是 ⇒ 用户手写，永不覆盖） */
export function isGeneratedPlist(content: string): boolean {
  if (content.includes(`<key>${GENERATED_MARKER}</key>`)) return true;
  return LEGACY_GENERATED_ARGV.some((re) => re.test(content));
}

/** web 前端的默认端口（web/package.json 的 `start` 脚本没写明时用它） */
export const WEB_PORT_FALLBACK = 3333;

/**
 * 从 `web/package.json` 的 `start` 脚本里抠出端口（纯函数，单测覆盖）。
 *
 * 端口的**唯一真源**是那个脚本（`next start -p 3333`）：plist 里再写一遍就会有两份
 * 会漂的配置——改了 package.json 却忘了重装 plist，网页就 502 在一个没人监听的端口上。
 */
export function webPortFromStartScript(startScript: string | undefined): number {
  const m = /(?:-p|--port)[\s=]+(\d{2,5})/.exec(startScript ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : WEB_PORT_FALLBACK;
}

/**
 * web 前端够不够格装成 daemon（纯函数，单测覆盖）。
 *
 * 四个条件缺一不可，因为 `next start` 对三种缺失的报错都很难懂：
 *  - 没有 `web/package.json` = 上游精简版，压根没有前端；
 *  - 没装依赖（`node_modules/.bin/next`）= 启动即 command not found；
 *  - 没 build（`.next/BUILD_ID`）= next start 直接退出让你先 build；
 *  - 没有 `web/.env.local` = 没签 API token，页面起来了也连不上 bridge。
 */
export function webDaemonReadiness(has: {
  pkg: boolean; nextBin: boolean; build: boolean; envLocal: boolean;
}): { ready: boolean; reason?: string } {
  if (!has.pkg) return { ready: false, reason: "本 checkout 没有 web/ 前端" };
  if (!has.envLocal) return { ready: false, reason: "web/.env.local 还没生成（跑 bun run setup 选上 Web）" };
  if (!has.nextBin) return { ready: false, reason: "web 依赖没装（cd web && npm install）" };
  if (!has.build) return { ready: false, reason: "web 还没构建（cd web && npm run build）" };
  return { ready: true };
}

/**
 * web daemon 的 spec。**只在文件不存在时写**（keepExisting）：这台机器上可能已经有一份
 * 手写的 plist（改过端口、日志落点、或挂在反代后面），install-cli 每次 update 都会跑，
 * 无条件覆盖等于每次升级都把用户的定制悄悄抹掉。
 */
export function webDaemonSpec(repoRoot: string, port: number, nodePath?: string | null): DaemonSpec {
  const webDir = `${repoRoot}/web`;
  // ⚠ 不要直接 exec `node_modules/.bin/next`：它是 `#!/usr/bin/env node` 的 shim，
  //   解析 node 靠的是 **plist 里那份固定 PATH**。用 nvm / fnm / volta 装 node 的机器
  //   （相当常见）node 在 ~/.nvm/versions/node/vX/bin 之类的地方，不在那份列表里 ⇒
  //   launchd 起不来这个 daemon，端口永远不监听，用户看到的就是「装完网页打不开」，
  //   而且 KeepAlive 会让它安静地重试到天荒地老。拿到 node 绝对路径就直接 exec 它。
  const argv = nodePath
    ? [nodePath, `${webDir}/node_modules/next/dist/bin/next`, "start", "-p", String(port)]
    : [`${webDir}/node_modules/.bin/next`, "start", "-p", String(port)];
  return { label: "com.claudestra.web", stem: "web", keepExisting: true, exec: { cwd: webDir, argv } };
}

/** 老 pm2 启动名（用于 stop 老的、避免跟新 launchd 抢） */
const LEGACY_PM2_NAMES = ["discord-bridge", "master-launcher", "cron-scheduler"];

/** 装完探活 + 自愈的结果 */
export interface DaemonHealth {
  label: string;
  /** 给人看的探测目标，如 `bridge HTTP :13847` */
  name: string;
  healthy: boolean;
  /** 探失败后自动 kickstart 过一次 */
  repaired: boolean;
  /** 仍不健康时附上 .err 的末尾几行（已去重） */
  log?: string[];
}

export interface DaemonInstall {
  label: string;
  plistPath: string;
  loaded: boolean;
  warning?: string;
  /** 已有同名 plist，原样保留、也没重新 load（见 webDaemonSpec 的 keepExisting） */
  keptExisting?: boolean;
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
  /** v2.24+ web 前端 daemon：装上了就给 url，没装给不够格的原因 */
  webDaemon?:
    | { installed: true; port: number; url: string; serving: boolean; error?: string; log?: string[] }
    | { installed: false; reason?: string };
  /** v2.24+ 装完逐个探活；不健康的自动 kickstart 一次再探 */
  daemonHealth?: DaemonHealth[];
  /** web 构建过期（按 hash 判）就在 reload 之前重建；失败只进 warnings */
  webBuild?: WebBuildResult;
  errors: string[];
  warnings: string[];
}

function which(cmd: string): string | null {
  const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && r.status === 0 ? p : null;
}

/**
 * 写进 plist 的可执行文件路径。
 *
 * ⚠ 这里有两个**方向相反**的坑，所以既不能「一律用 which 的结果」也不能「一律 realpath」：
 *
 *  1. **临时软链**：fnm 默认把 node 挂在
 *     `~/Library/Caches/fnm_multishells/<pid>_<ts>/bin/node` —— 那个目录随装机
 *     那个 shell 退出就没了。which 当场找得到、写进 plist，launchd 再去执行时路径
 *     已经不存在 ⇒ `launchctl list` 报 exit **127（命令找不到）**，而 KeepAlive 会
 *     安静地一直重试。这种必须 realpath 到真实安装位置。
 *
 *  2. **跟随升级的稳定软链**：brew 的 `/opt/homebrew/bin/node` 正是我们想要的形态
 *     ——它始终指向当前版本。realpath 反而得到
 *     `/opt/homebrew/Cellar/node/26.4.0/bin/node`，**下次 brew 升级 node 这个路径
 *     就消失了**，等于把一个好路径换成会过期的。
 *
 * 所以只对「看起来是临时的」才 realpath：多壳缓存目录、/tmp、/var/folders。
 * 其余保持原样。两种情况最后都验一次文件真的在。
 * （同一条教训在 lib/claude-binary.ts 上踩过一次，那次是 claude。）
 */
const EPHEMERAL_BIN_RE = /(fnm_multishells|^\/tmp\/|^\/var\/folders\/|\/Caches\/)/;

export function preferStablePath(p: string, resolve: (x: string) => string, exists: (x: string) => boolean): string | null {
  let chosen = p;
  if (EPHEMERAL_BIN_RE.test(p)) {
    try { chosen = resolve(p); } catch { chosen = p; }
  }
  if (exists(chosen)) return chosen;
  return exists(p) ? p : null;
}

/** 常见的 node 安装位置（版本管理器的 shim 不在这里，靠上面两路兜） */
const WELL_KNOWN_NODE = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

/**
 * 找一个**launchd 也能执行到**的 node。
 *
 * 三路依次试，因为 2026-09-22 的试装现场证明单靠 `/usr/bin/which` 会落空：
 * 那台机器的 `web.err` 刷满 `env: node: No such file or directory`，而 plist 里
 * argv0 是 `.bin/next` 那个 shim —— 说明 install-cli 当时 `which node` 返回了 null，
 * 于是退回 shebang 形式，launchd 的固定 PATH 里又没有 node。
 *   1. `/usr/bin/which`：继承当前进程的 PATH，最快；
 *   2. **登录 shell**：`sh -lc 'command -v node'` —— nvm / fnm / volta 的初始化写在
 *      ~/.zshrc / ~/.zprofile 里，只有过一遍登录 shell 才看得到（与
 *      lib/claude-binary.ts 解析 claude 同一口径）；
 *   3. 几个常见绝对路径兜底。
 * 三路都没有就返回 null —— 调用方据此**不装**这个 daemon，而不是装一个必然 127 的。
 */
function stableBinPath(cmd: string): string | null {
  const candidates: string[] = [];
  const direct = which(cmd);
  if (direct) candidates.push(direct);
  try {
    const r = spawnSync("/bin/sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8", timeout: 10_000 });
    const viaLogin = (r.stdout || "").trim().split("\n").pop()?.trim();
    if (viaLogin && viaLogin.startsWith("/")) candidates.push(viaLogin);
  } catch { /* 登录 shell 起不来就跳过这一路 */ }
  if (cmd === "node") candidates.push(...WELL_KNOWN_NODE);

  for (const c of candidates) {
    const picked = preferStablePath(c, realpathSync, existsSync);
    if (picked) return picked;
  }
  return null;
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
  // node 的实际所在目录排在最前：nvm / fnm / volta 的路径不在下面这份固定列表里，
  // 而 web daemon 与它派生的子进程都要用到 node（见 webDaemonSpec 的注释）。
  const nodeDir = (() => {
    const p = stableBinPath("node");
    return p ? dirname(p) : null;
  })();
  // bun 所在目录同理（mise / asdf 装的 bun 不在 ~/.bun/bin）：daemon 派生的子进程与 hook 要找得到它
  const bunDir = dirname(resolveBunPath());
  return [
    ...(nodeDir ? [nodeDir] : []),
    ...(bunDir && bunDir !== `${home}/.bun/bin` ? [bunDir] : []),
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
  const content = cliWrapperScript(repoRoot);
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

/** `claudestra` 包装脚本的内容（纯函数，单测做 bash -n 语法检查） */
export function cliWrapperScript(repoRoot: string): string {
  const daemonLabels = DAEMONS.map((d) => `"${d.label}"`).join(" ");
  return `#!/usr/bin/env bash
# claudestra — one-shot launcher (Claudestra-installed, v2.4.1+)
# 用法：
#   claudestra                 检查 daemon 后 attach（iTerm 用 -CC 原生标签，没装 iTerm 用普通 tmux）
#   claudestra attach --plain  强制普通 tmux attach（任何终端都能用）
#   claudestra ls              列出 master session 里的窗口（agent）
# 流程：
#   1) launchctl 检查 3 个 daemon，没 load 的 bootstrap
#   2) 已在 tmux 嵌套，提示 + 退出
#   3) --plain 或没装 iTerm：普通 tmux attach（-CC 在普通终端里只会吐控制协议文本）
#   4) 在 iTerm：exec tmux -CC（iTerm 集成需要 tmux 是 iTerm 直接子进程）
#   5) 不在 iTerm 但装了 iTerm：osascript 唤起 iTerm 新窗口跑 attach
set -u

REPO=${JSON.stringify(repoRoot)}
SOCK=${JSON.stringify(TMUX_SOCK)}
DAEMONS=(${daemonLabels})
PLIST_DIR="$HOME/Library/LaunchAgents"
ATTACH=(tmux -S "$SOCK" -CC attach -t master)
PLAIN_ATTACH=(tmux -S "$SOCK" attach -t master)

PLAIN=0
case "\${1:-}" in
  ls|list)
    echo "会话在私有 socket（$SOCK）里，普通 tmux ls 看不到是正常的。"
    exec tmux -S "$SOCK" list-windows -t master -F '#{window_index}  #{window_name}'
    ;;
  attach)
    [ "\${2:-}" = "--plain" ] && PLAIN=1
    ;;
  --plain)
    PLAIN=1
    ;;
  "") ;;
  *)
    echo "用法: claudestra [attach [--plain] | ls]"
    exit 2
    ;;
esac

UID_NUM=$(/usr/bin/id -u)

CI=$'\\033[2m▶\\033[0m'
CO=$'\\033[32m✓\\033[0m'
CW=$'\\033[33m⚠\\033[0m'
CF=$'\\033[31m✗\\033[0m'
CB=$'\\033[1;36m'
CR=$'\\033[0m'

echo "\${CB}🚀 Claudestra\${CR} \\033[2m↗ $REPO\\033[0m"
echo "$CI 会话在私有 socket 里，普通 tmux ls 看不到是正常的；看窗口用 claudestra ls，非 iTerm 终端用 claudestra attach --plain"

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

# --plain 或根本没装 iTerm：普通 tmux attach，任何终端都能用
if [ "$PLAIN" -eq 1 ] || { [ "\${TERM_PROGRAM:-}" != "iTerm.app" ] && [ ! -d /Applications/iTerm.app ]; }; then
  echo "$CI 普通 tmux attach（切窗口 Ctrl-B n/p，离开 Ctrl-B d）"
  exec "\${PLAIN_ATTACH[@]}"
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
  echo "$CF osascript 失败。在 iTerm 里手动跑：\${ATTACH[*]}；其它终端：claudestra attach --plain"
fi
exit "$rc"
`;
}

function buildDaemonPlist(
  repoRoot: string,
  bunPath: string,
  daemon: DaemonSpec,
): string {
  const home = homedir();
  const envPath = buildEnvPath();
  const cwd = daemon.exec?.cwd ?? repoRoot;
  const argv = daemon.exec?.argv ?? [bunPath, `${repoRoot}/${daemon.script}`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${daemon.label}</string>
  <!-- 这一条是 Claudestra 生成的。keepExisting 的 daemon 靠它区分「用户手写的」
       和「我们上一版生成的」：手写的永远不覆盖，自己生成的必须能被新版替换。 -->
  <key>${GENERATED_MARKER}</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
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
${argv.map((a) => `    <string>${a}</string>`).join("\n")}
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
  extra: DaemonSpec[] = [],
): Promise<{ label: string; plistPath: string; kept?: boolean }[]> {
  const dir = `${homedir()}/Library/LaunchAgents`;
  await mkdir(dir, { recursive: true });
  const out: { label: string; plistPath: string; kept?: boolean }[] = [];
  for (const d of [...DAEMONS, ...extra]) {
    const plistPath = `${dir}/${d.label}.plist`;
    // keepExisting：只保留**用户手写的**。我们自己生成的必须能被新版替换，
    // 否则一旦生成过一份坏的，后续所有修复都进不来（见 GENERATED_MARKER）。
    if (d.keepExisting && existsSync(plistPath)) {
      let mine = false;
      try { mine = isGeneratedPlist(readFileSync(plistPath, "utf-8")); } catch { /* 读不了就当是用户的 */ }
      if (!mine) {
        out.push({ label: d.label, plistPath, kept: true });
        continue;
      }
    }
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
  // 解析失败会抛——宁可不挂 hook,也不能把 owner 的 settings.json 覆写成只剩我们一条
  const settings = await readClaudeSettings(settingsPath);
  const changed = ensureRecallHook(settings, command);
  if (changed) await writeClaudeSettings(settingsPath, settings);
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

  const webDir = `${repoRoot}/web`;

  // 1b) web 构建过期就重建。必须排在第 6 步 reload 之前：update 子进程由 launcher 派生，
  //     bootout launcher 会把它连坐回收，构建若在后面会被中途杀掉、留下被清空的 .next。
  //     也要在 readiness 之前：新的 BUILD_ID 参与判断能不能装 web daemon。
  //     没有 .env.local = 没选 web，不花这个钱。
  if (existsSync(`${webDir}/.env.local`)) {
    try {
      result.webBuild = await rebuildWebIfStale(repoRoot);
      if (result.webBuild.error) {
        warnings.push(`web 构建: ${result.webBuild.error}${result.webBuild.log?.length ? `。输出末尾：${result.webBuild.log.slice(-2).join(" | ")}` : ""}`);
      }
    } catch (e) { warnings.push(`web 构建: ${(e as Error).message}`); }
  }

  // 2) 写 daemon plist（3 个常驻 + web 前端，后者够格才装）
  let webPkgStart: string | undefined;
  try {
    webPkgStart = JSON.parse(readFileSync(`${webDir}/package.json`, "utf-8"))?.scripts?.start;
  } catch { /* 没有 web/ 或读不了：下面 readiness 会说明 */ }
  const webReady = webDaemonReadiness({
    pkg: existsSync(`${webDir}/package.json`),
    nextBin: existsSync(`${webDir}/node_modules/.bin/next`),
    build: existsSync(`${webDir}/.next/BUILD_ID`),
    envLocal: existsSync(`${webDir}/.env.local`),
  });
  const webPort = webPortFromStartScript(webPkgStart);
  const nodePath = stableBinPath("node");
  // ⚠ 找不到 node 就**不装**。退回 next 的 shebang 形式等于装一个必然失败的服务：
  //   launchd 的 PATH 是固定那几条，`env node` 找不到就 exit 127，而 KeepAlive 会
  //   安静地一直重试 —— 用户看到的是「命令一路 ok，网页打不开」，日志里只有
  //   `env: node: No such file or directory`（2026-09-22 试装现场就是这一幕）。
  //   宁可不装并把原因说清楚。
  const webInstallable = webReady.ready && !!nodePath;
  const extraDaemons = webInstallable ? [webDaemonSpec(repoRoot, webPort, nodePath)] : [];
  if (webReady.ready && !nodePath) {
    warnings.push("找不到可执行的 node（which / 登录 shell / 常见路径都试过）—— web 服务没装。装好 node 后重跑 install-cli");
  }
  result.webDaemon = webInstallable
    ? { installed: true, port: webPort, url: `http://localhost:${webPort}`, serving: false }
    : { installed: false, reason: webReady.ready
        ? "找不到可执行的 node（which / 登录 shell / 常见路径都试过）"
        : webReady.reason };

  let plists: { label: string; plistPath: string; kept?: boolean }[];
  try { plists = await writeDaemonPlists(repoRoot, bunPath, extraDaemons); }
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

  // 6) bootstrap 新 plist
  const uid = getUid();
  for (const p of plists) {
    // keepExisting 且本来就在：那是用户自己的 plist，连 reload 都不碰——它可能被
    // 刻意 unload 着（挂在别的反代后面 / 临时停用），我们没资格替他重新拉起。
    if (p.kept) {
      // 但刚重建过 web 的话，正在跑的服务手里是旧构建（文件还被删过一轮）：它若是 load 着的就
      // 重启一下（restartWebService 只 kickstart 已 load 的服务，不替人拉起）
      if (p.label === "com.claudestra.web" && result.webBuild?.attempted) {
        result.webBuild.restarted = restartWebService();
      }
      result.daemons.push({ label: p.label, plistPath: p.plistPath, loaded: true, keptExisting: true });
      continue;
    }
    const r = reloadDaemon(p.plistPath, uid);
    const item: DaemonInstall = { label: p.label, plistPath: p.plistPath, loaded: r.ok };
    if (!r.ok) {
      item.warning = r.err || "launchctl bootstrap failed";
      warnings.push(`${p.label}: ${item.warning}`);
    }
    result.daemons.push(item);
  }

  // ⚠ 装完必须**自己验一次**。这一段的由来：2026-09-22 的试装来回了六轮，每一轮
  //   install-cli 都打印 ok、daemons 全 loaded:true，而端口从头到尾没人监听——
  //   launchd 的 bootstrap 成功只代表「plist 被接受了」，不代表进程活着。
  //   服务起不来的真话只在 web.err 里，而没人会主动去看它。
  // 装完逐个探活，不健康的自动 kickstart 一次再探（见 healDaemons）
  result.daemonHealth = await healDaemons(repoRoot, uid, result.webDaemon?.installed ? result.webDaemon.port : null);
  for (const h of result.daemonHealth) {
    if (h.label === "com.claudestra.web" && result.webDaemon?.installed) {
      result.webDaemon.serving = h.healthy;
      if (!h.healthy) {
        result.webDaemon.error = `装好了但 ${result.webDaemon.port} 端口没人监听——服务起来就退出了`;
        if (h.log?.length) result.webDaemon.log = h.log;
      }
    }
    if (!h.healthy) {
      warnings.push(
        `${h.name} 不健康${h.repaired ? "（已自动重启一次仍无效）" : ""}。日志末尾：` +
          (h.log?.slice(-2).join(" | ") || "(.err 是空的)"),
      );
    } else if (h.repaired) {
      warnings.push(`${h.name} 起初没响应，已自动重启修好`);
    }
  }

  return result;
}

/**
 * 装完的**自愈**：daemon 不只要被 launchd 接受，还得真的在干活。
 *
 * 由来（2026-09-22 试装全程）：`launchctl bootstrap` 成功只代表 plist 被接受；
 * 进程起来就崩、或者端口开着却不响应，`launchctl list` 和 install-cli 都照样报 ok。
 * 这一轮连着踩了两次：web 服务 exit 127 刷了十几次没人知道；bridge 端口在 LISTEN
 * 但 HTTP 超时（`Bun.serve` 一起来端口就开了，"在听"不等于"活着"）。
 *
 * 所以每个能探活的 daemon 都探一次，不健康就**自动 kickstart 一次**再探。
 * 只修一次：修不好说明是代码或配置的问题，再重启十次也一样，那时该把日志摆给人看。
 */
async function healDaemons(
  repoRoot: string,
  uid: string,
  webPort: number | null,
): Promise<DaemonHealth[]> {
  const bridgePort = readBridgePort(repoRoot);
  const probes: Array<{ label: string; name: string; probe: () => Promise<boolean>; stem: string }> = [];
  if (bridgePort) {
    probes.push({
      label: "com.claudestra.bridge",
      name: `bridge HTTP :${bridgePort}`,
      stem: "bridge",
      // 端口在听不够 —— 必须真的答一个 HTTP，这正是试装现场那一幕
      probe: () => httpOk(`http://127.0.0.1:${bridgePort}/stats`, 4_000),
    });
  }
  if (webPort) {
    probes.push({
      label: "com.claudestra.web",
      name: `web :${webPort}`,
      stem: "web",
      probe: () => portListening(webPort),
    });
  }

  const out: DaemonHealth[] = [];
  for (const p of probes) {
    let healthy = await waitFor(p.probe, 12_000);
    let repaired = false;
    if (!healthy) {
      spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${p.label}`], { encoding: "utf8" });
      repaired = true;
      healthy = await waitFor(p.probe, 15_000);
    }
    out.push({
      label: p.label,
      name: p.name,
      healthy,
      repaired,
      ...(healthy ? {} : { log: tailFile(`${LOG_DIR}/${p.stem}.err`, 6) }),
    });
  }
  return out;
}

/** .env 里的 BRIDGE_PORT（用户改过端口的机器不能按默认值去探） */
function readBridgePort(repoRoot: string): number | null {
  try {
    const m = readFileSync(`${repoRoot}/.env`, "utf-8").match(/^\s*BRIDGE_PORT\s*=\s*(\d+)/m);
    const n = m ? Number(m[1]) : 3847;
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3847;
  } catch {
    return null; // 没有 .env = 还没配过，谈不上探活
  }
}

async function httpOk(url: string, timeoutMs: number): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function portListening(port: number): Promise<boolean> {
  const r = spawnSync("/usr/sbin/lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-n", "-P"], { encoding: "utf8" });
  return Promise.resolve(r.status === 0 && !!(r.stdout || "").trim());
}

function tailFile(path: string, n: number): string[] {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
    // 同一句报错常刷几十遍（KeepAlive 重试），去重后更有信息量
    return [...new Set(lines.slice(-200))].slice(-n);
  } catch {
    return [];
  }
}
