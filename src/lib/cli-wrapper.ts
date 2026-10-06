/**
 * `claudestra` CLI wrapper（纯 bash）脚本生成：从 cli-install.ts 抽出的纯函数部分。
 * 只拼字符串，不碰文件系统 / launchctl；安装落盘仍在 cli-install.ts 的 writeCliWrapper。
 * cli-install.ts 原样 re-export DAEMONS / cliWrapperScript，调用方不用迁移。
 */
import { TMUX_SOCK } from "./paths.js";

export interface DaemonSpec {
  label: string;
  stem: string;
  /** bun 跑的仓库内脚本 */
  script: string;
}

/** 常驻 daemon 的 launchd 定义。改这里 = 改启动链。 */
export const DAEMONS: DaemonSpec[] = [
  // ⚠ 顺序即 reload 顺序,launcher 必须最后:update 子进程常由 launcher 派生,
  // bootout launcher 会让 launchd 连坐回收它(macOS 责任链不随 detach 断,
  // peer 取证 2026-08-09)——launcher 放最后保证 bridge/cron/scheduler 先完成 reload,
  // 自杀只损失收尾输出。
  { label: "com.claudestra.bridge",   script: "src/bridge.ts",   stem: "bridge" },
  { label: "com.claudestra.cron",     script: "src/cron.ts",     stem: "cron" },
  { label: "com.claudestra.scheduler", script: "src/scheduler.ts", stem: "scheduler" },
  { label: "com.claudestra.launcher", script: "src/launcher.ts", stem: "launcher" },
];

/** `claudestra` 包装脚本的内容（纯函数，单测做 bash -n 语法检查） */
export function cliWrapperScript(repoRoot: string, bunPath = "bun"): string {
  const daemonLabels = DAEMONS.map((d) => `"${d.label}"`).join(" ");
  return `#!/usr/bin/env bash
# claudestra — one-shot launcher (Claudestra-installed, v2.4.1+)
# 用法：
#   claudestra                 检查 daemon 后 attach（在 iTerm 里用 -CC 原生标签，其它终端用普通 tmux）
#   claudestra attach --plain  强制普通 tmux attach（任何终端都能用）
#   claudestra attach --iterm  不在 iTerm 里也唤起 iTerm 新窗口走 -CC
#   claudestra ls              列出 master session 里的窗口（agent）
#   claudestra relay           relay-status 的简写（中继连接状态）
#   claudestra <命令> [参数]   其余一律交给 manager（pair / doctor / version / create …），在仓库目录里跑
# 流程：
#   1) launchctl 检查 3 个 daemon，没 load 的 bootstrap
#   2) 已在 tmux 嵌套，提示 + 退出
#   3) 在 iTerm（且没 --plain）：exec tmux -CC（iTerm 集成需要 tmux 是 iTerm 直接子进程）
#   4) --iterm 且装了 iTerm：osascript 唤起 iTerm 新窗口跑 attach
#   5) 其余（--plain / Terminal.app / ssh 等）：普通 tmux attach（-CC 在普通终端里只会吐控制协议文本；ssh 进来时唤起 iTerm 会开在远端桌面上）
set -u
# 沙箱环境（eval "$(bun run sandbox env)" 之后）里敲 claudestra 会连到生产 tmux / launchd：拒绝
[ "\${CLAUDESTRA_SANDBOX:-}" = "1" ] && { echo "claudestra：当前 shell 带着沙箱环境（CLAUDESTRA_SANDBOX=1），生产命令拒绝执行；开个新 shell 再用" >&2; exit 1; }

REPO=${JSON.stringify(repoRoot)}
SOCK=${JSON.stringify(TMUX_SOCK)}
DAEMONS=(${daemonLabels})
PLIST_DIR="$HOME/Library/LaunchAgents"
ATTACH=(tmux -S "$SOCK" -CC attach -t master)
PLAIN_ATTACH=(tmux -S "$SOCK" attach -t master)
BUN=${JSON.stringify(bunPath)}

MODE=auto
case "\${1:-}" in
  ls|list)
    echo "会话在私有 socket（\${SOCK}）里，普通 tmux ls 看不到是正常的。"
    exec tmux -S "$SOCK" list-windows -t master -F '#{window_index}  #{window_name}'
    ;;
  attach)
    case "\${2:-}" in
      --plain) MODE=plain ;;
      --iterm) MODE=iterm ;;
    esac
    ;;
  --plain) MODE=plain ;;
  --iterm) MODE=iterm ;;
  "") ;;
  -h|--help|help)
    echo "用法: claudestra [attach [--plain|--iterm] | ls | relay | <manager 命令> ...]"
    echo "manager 命令（在 $REPO 里跑）："
    cd "$REPO" && "$BUN" run src/manager.ts help 2>/dev/null | "$BUN" -e 'const t = await Bun.stdin.text(); try { for (const u of JSON.parse(t).usage) console.log("  " + u) } catch { console.log(t) }'
    exit 0
    ;;
  relay) shift; cd "$REPO" && exec "$BUN" run src/manager.ts relay-status "$@" ;;
  *)
    # 在仓库目录里跑（与 daemon 的 WorkingDirectory 一致，也不会读到调用者当前目录里别的项目的 .env）；
    # 所以先把 . / .. / ./x / ../x 这种相对路径参数换成绝对路径（create / resume / cron-add 的目录参数）
    ARGS=()
    for a in "$@"; do
      case "$a" in
        .|..|./*|../*) ARGS+=("$(cd "$a" 2>/dev/null && pwd || echo "$PWD/$a")") ;;
        *) ARGS+=("$a") ;;
      esac
    done
    cd "$REPO" && exec "$BUN" run src/manager.ts "\${ARGS[@]}"
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
echo "$CI 会话在私有 socket 里，普通 tmux ls 看不到是正常的；看窗口用 claudestra ls；iTerm 外的终端自动走普通 tmux attach"

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
if [ "$MODE" != plain ] && [ "\${TERM_PROGRAM:-}" = "iTerm.app" ]; then
  echo "$CI 在 iTerm，exec tmux -CC（iTerm 集成会切到 native tabs）"
  exec "\${ATTACH[@]}"
fi

# 其余一律普通 tmux attach，任何终端都能用；只有显式 --iterm 才去唤起 iTerm
if [ "$MODE" != iterm ] || [ ! -d /Applications/iTerm.app ]; then
  [ "$MODE" = iterm ] && echo "$CW 没装 iTerm，改用普通 tmux attach"
  echo "$CI 普通 tmux attach（切窗口 Ctrl-B n/p，离开 Ctrl-B d；要 iTerm 原生标签：claudestra attach --iterm）"
  exec "\${PLAIN_ATTACH[@]}"
fi

# --iterm 且不在 iTerm：osascript 唤起 iTerm 新窗口跑 attach
echo "$CI AppleScript 唤起 iTerm 新窗口…"
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

/**
 * 非 macOS 平台的替代方案提示：一个可直接抄用的 systemd user unit 模板。
 * 四个 daemon 只有入口脚本不同，故只给一份带占位的模板。
 */
export function systemdUnitHint(repoRoot: string, bunPath: string): string {
  return [
    `  # ~/.config/systemd/user/claudestra-bridge.service`,
    `  # （launcher / cron / scheduler 同理，把 ExecStart 换成对应入口，`,
    `  #   服务名相应改成 claudestra-launcher / claudestra-cron / claudestra-scheduler）`,
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
