#!/usr/bin/env bash
# 从开发机把共享台账中心部署到一台 Linux 主机（复用主机上已有的 nginx 与 TLS 证书），或卸载。
# 用法：deploy/shared-ledger/deploy.sh <ssh 目标> --host-name <域名> [--port <回环端口，默认 8797>] [--bun <远端 bun，默认 /usr/local/bin/bun>] [--dry-run]
#       deploy/shared-ledger/deploy.sh <ssh 目标> --uninstall [--dry-run]
# 步骤：记下 commit → 按 src/shared-ledger.ts 与 scripts/shared-ledger-admin.ts 的 import 闭包（closure.ts，bun 解析）暂存源码 → rsync 到远端独立目录
#       → 远端跑 remote.sh（经 ssh stdin 传过去，不落盘）：账号 / 目录 / systemd 单元 / 回环健康检查 / nginx server 块 / 每日备份 timer。
# 幂等：可以重跑；代码与渲染出的文件都没变时不写文件、不 reload、不重启。--dry-run 只读远端（rsync -n、nginx -T 等）并打印每一步。
# 前提：ssh 目标免密且是 root；远端有 rsync、nginx、systemd、curl 和系统级 bun（见 README）。开发机 rsync 可以是 GNU rsync 或 macOS 自带的 openrsync。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]:?}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
APP_DIR=$(sed -n 's/^APP_DIR=//p' "$HERE/remote.sh")

usage() { sed -n '3,4s/^# \{0,1\}//p' "${BASH_SOURCE[0]}" >&2; exit 2; }

TARGET=${1:-}
[[ -n $TARGET && $TARGET != -* ]] || usage
shift
HOST_NAME="" PORT=8797 BUN=/usr/local/bin/bun DRY=0 MODE=install
while [[ $# -gt 0 ]]; do
  case $1 in
    --host-name) HOST_NAME=${2:-}; shift 2 || usage ;;
    --port) PORT=${2:-}; shift 2 || usage ;;
    --bun) BUN=${2:-}; shift 2 || usage ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done
[[ $TARGET =~ ^[A-Za-z0-9_.@:-]+$ ]] || { echo "ssh 目标只许 [A-Za-z0-9_.@:-]：$TARGET" >&2; exit 2; }

dry_flag=()
[[ $DRY == 1 ]] && dry_flag=(--dry-run)

remote() { # 把 remote.sh 从 stdin 喂给远端 bash；参数逐个转义
  local quoted
  quoted=$(printf ' %q' "$@")
  ssh "$TARGET" "bash -s --$quoted" < "$HERE/remote.sh"
}

if [[ $MODE == uninstall ]]; then
  echo "→ 卸载 $TARGET 上的共享台账中心（保留库与备份）"
  remote uninstall ${dry_flag[@]+"${dry_flag[@]}"}
  exit 0
fi

[[ -n $HOST_NAME ]] || { echo "缺 --host-name <域名>" >&2; usage; }
COMMIT=$(git -C "$ROOT" rev-parse --short HEAD)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "→ 暂存 $COMMIT 的中心源码（src/shared-ledger.ts 与入组码管理脚本的 import 闭包 + 备份脚本）"
FILES=$(cd "$ROOT" && bun "$HERE/closure.ts" src/shared-ledger.ts scripts/shared-ledger-admin.ts)
FILES+=$'\n'"deploy/shared-ledger/backup.ts"
while IFS= read -r f; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$ROOT/$f" "$STAGE/$f"
done <<< "$FILES"
echo "$COMMIT" > "$STAGE/.shared-ledger-commit"
echo "  $(wc -l <<< "$FILES" | tr -d ' ') 个文件"

echo "→ rsync 到 $TARGET:$APP_DIR$([[ $DRY == 1 ]] && echo '（dry-run：rsync -n，不写远端）')"
# 不带 -t、用 --checksum：内容没变就没有任何 itemize 输出，远端据此决定要不要重启；文件归 root、服务账号只读
rsync_flags=(-rl --checksum --delete --itemize-changes -e ssh)
# macOS 15+ 自带的 openrsync 不认 --chmod=D755,F644：本地空跑探一下，不支持就不带；远端 remote.sh 无论如何都把代码目录收成 755/644
if rsync -n -r --chmod=D755,F644 "$STAGE/" "$STAGE/" >/dev/null 2>&1; then
  rsync_flags+=(--chmod=D755,F644)
else
  echo "  本机 rsync 不支持 --chmod（openrsync？）：不带它同步，代码目录权限由远端统一收成 755/644"
fi
[[ $DRY == 1 ]] && rsync_flags+=(-n)
CHANGES=$(rsync "${rsync_flags[@]}" "$STAGE/" "$TARGET:$APP_DIR/")
CODE_CHANGED=0
if [[ -n $CHANGES ]]; then CODE_CHANGED=1; sed 's/^/  /' <<< "$CHANGES"; else echo "  代码未变"; fi

remote install --host-name "$HOST_NAME" --port "$PORT" --bun "$BUN" --code-changed "$CODE_CHANGED" ${dry_flag[@]+"${dry_flag[@]}"}
