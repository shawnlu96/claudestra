#!/usr/bin/env bash
# 从开发机部署中继到一台主机：记下 commit → rsync 主仓库 → 远端 install.sh（幂等）→ 重启服务 → 看 healthz。
# 用法：deploy/relay/deploy.sh <user@host> [远端目录，默认 /opt/claudestra]
# 环境：RELAY_WITH_WEB=1 先在本机构建前端静态导出（web/out）并一起 rsync 到远端 web/out（中继托管前端，单元里的 RELAY_STATIC_DIR 指它）。
# 前提：远端能免密 ssh、是 root（install.sh 要建用户与装 systemd 单元）；第一次部署后还要按 self-host.md 改单元里的 RELAY_BASE 与配 nginx。
set -euo pipefail

TARGET=${1:?用法: deploy/relay/deploy.sh <user@host> [远端目录]}
REMOTE_DIR=${2:-/opt/claudestra}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]:?}")/../.." && pwd)

# healthz 靠这个文件报 commit（src/relay/env.ts）；文件在 .gitignore 里，只跟着 rsync 走
git -C "${ROOT:?}" rev-parse --short HEAD > "${ROOT:?}/.relay-commit"
echo "→ 部署 $(cat "${ROOT:?}/.relay-commit") 到 ${TARGET:?}:${REMOTE_DIR:?}"

rsync -az --delete \
  --exclude node_modules --exclude web --exclude native --exclude legacy --exclude .git \
  --exclude .env --exclude .next --exclude data --exclude '*.log' \
  "${ROOT:?}/" "${TARGET:?}:${REMOTE_DIR:?}/"

# 前端静态站：构建与 rsync 是两步、不进管道，任何一步失败都停在这里（管道会吞掉 build 的退出码）
if [ "${RELAY_WITH_WEB:-0}" = "1" ]; then
  echo "→ 构建前端静态导出（web/out）"
  npm --prefix "${ROOT:?}/web" run build
  [ -f "${ROOT:?}/web/out/index.html" ] || { echo "web/out 里没有 index.html：next.config 还不是 output: export？" >&2; exit 1; }
  rsync -az --delete "${ROOT:?}/web/out/" "${TARGET:?}:${REMOTE_DIR:?}/web/out/"
fi

# 远端：install.sh 自己会 chown 给 relay 用户；端口从单元文件读，改过 RELAY_PORT 也能探到
ssh "${TARGET:?}" "set -e
bash '${REMOTE_DIR:?}/deploy/relay/install.sh'
systemctl restart claudestra-relay
sleep 1
port=\$(systemctl show -p Environment claudestra-relay | tr ' ' '\n' | sed -n 's/^RELAY_PORT=//p')
curl -fsS \"http://127.0.0.1:\${port:-8787}/healthz\"
echo"
