#!/usr/bin/env bash
# 从开发机部署中继到一台主机：记下 commit → rsync 主仓库 → 远端 install.sh（幂等）→ 重启服务 → 看 healthz。
# 用法：deploy/relay/deploy.sh <user@host> [远端目录，默认 /opt/claudestra]
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

# 远端：install.sh 自己会 chown 给 relay 用户；端口从单元文件读，改过 RELAY_PORT 也能探到
ssh "${TARGET:?}" "set -e
bash '${REMOTE_DIR:?}/deploy/relay/install.sh'
systemctl restart claudestra-relay
sleep 1
port=\$(systemctl show -p Environment claudestra-relay | tr ' ' '\n' | sed -n 's/^RELAY_PORT=//p')
curl -fsS \"http://127.0.0.1:\${port:-8787}/healthz\"
echo"
