#!/usr/bin/env bash
# Claudestra 中继主机安装（Ubuntu 20.04+，root 运行，幂等：重复跑不重建用户、不重装 bun、不动数据）。
# 前提：主仓库已 rsync 到 /opt/claudestra（排除 node_modules / web / native / legacy / .git）。
# 之后：编辑 /etc/systemd/system/claudestra-relay.service 里的 RELAY_BASE，systemctl enable --now claudestra-relay；nginx 见 nginx.conf。
set -euo pipefail

RELAY_USER=relay
RELAY_HOME=/var/lib/claudestra-relay
DATA_DIR=$RELAY_HOME/data
BUN_INSTALL=$RELAY_HOME/.bun
APP_DIR=/opt/claudestra

[[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0" >&2; exit 1; }
[[ -f $APP_DIR/src/relay.ts ]] || { echo "没有 $APP_DIR/src/relay.ts：先把主仓库 rsync 到 $APP_DIR" >&2; exit 1; }

# 1. 系统用户：nologin，家目录放 bun 与数据（不放 /home，systemd 单元里 ProtectHome=true）
if ! id -u "$RELAY_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$RELAY_HOME" --create-home --shell /usr/sbin/nologin "$RELAY_USER"
  echo "已建用户 $RELAY_USER"
fi
install -d -o "$RELAY_USER" -g "$RELAY_USER" -m 750 "$RELAY_HOME"
install -d -o "$RELAY_USER" -g "$RELAY_USER" -m 700 "$DATA_DIR"

# 2. bun：官方安装脚本，装在 relay 用户家目录下（需要 curl + unzip）
if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  apt-get update -qq && apt-get install -y -qq curl unzip
fi
if [[ ! -x $BUN_INSTALL/bin/bun ]]; then
  sudo -u "$RELAY_USER" env HOME="$RELAY_HOME" BUN_INSTALL="$BUN_INSTALL" bash -c 'curl -fsSL https://bun.sh/install | bash'
fi
echo "bun $("$BUN_INSTALL/bin/bun" --version) @ $BUN_INSTALL/bin/bun"

# 3. 代码目录归 relay 用户；装依赖（中继只用到 bun 内建，但 src/lib 的 import 解析需要 node_modules 存在）
chown -R "$RELAY_USER:$RELAY_USER" "$APP_DIR"
chmod 750 "$APP_DIR"
sudo -u "$RELAY_USER" env HOME="$RELAY_HOME" PATH="$BUN_INSTALL/bin:$PATH" bash -c "cd '$APP_DIR' && bun install --production --frozen-lockfile"

# 4. systemd 单元（第一次拷进去；已有就不覆盖——里面有主机自己填的 RELAY_BASE）
if [[ ! -f /etc/systemd/system/claudestra-relay.service ]]; then
  install -m 644 "$APP_DIR/deploy/relay/claudestra-relay.service" /etc/systemd/system/claudestra-relay.service
  echo "已装单元文件：把 /etc/systemd/system/claudestra-relay.service 里的 RELAY_BASE 改成你的域名"
fi
systemctl daemon-reload
if systemctl is-active --quiet claudestra-relay; then
  echo "服务在跑：systemctl restart claudestra-relay 让新代码生效（实例收 1012 会立刻重连）"
else
  echo "下一步：systemctl enable --now claudestra-relay && journalctl -u claudestra-relay -n 20"
fi
