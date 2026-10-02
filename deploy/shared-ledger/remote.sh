#!/usr/bin/env bash
# 共享台账中心：远端主机上的安装 / 卸载步骤（root 运行；deploy.sh 经 `ssh <目标> bash -s -- …` 把本文件从 stdin 喂过去，远端不留副本）。
# 用法：remote.sh install --host-name <域名> --port <回环端口> --bun <远端 bun 路径> --code-changed 0|1 [--dry-run]
#       remote.sh uninstall [--dry-run]
# 幂等：每个文件先渲染再与现有内容比较，相同就不写、不 reload、不重启；--dry-run 只读远端并打印将要做的每一步。
# 本脚本写的文件第一行是 MARK；同名文件已存在而第一行不是 MARK 的（别人的文件）一律拒绝覆盖或删除。
# SHARED_LEDGER_FS_PREFIX / SHARED_LEDGER_HEALTH_TRIES：只给测试用，把所有落盘路径挪到一个临时根下（单元 / nginx 里写的仍是真实路径）；设了它不要求 root。
set -euo pipefail
MARK="# managed-by: claudestra deploy/shared-ledger — 本文件由 deploy.sh 生成，手改会在下次部署被覆盖"
P=${SHARED_LEDGER_FS_PREFIX:-}
SVC=claudestra-shared-ledger
SVC_USER=claudestra-ledger
APP_DIR=/opt/claudestra-shared-ledger
STATE_DIR=/var/lib/claudestra-shared-ledger
DB_DIR=$STATE_DIR/db
DB=$DB_DIR/shared-ledger.sqlite
BACKUP_DIR=/var/backups/claudestra-shared-ledger
UNIT_DIR=/etc/systemd/system
NGINX_DIR=/etc/nginx/conf.d
NGINX_FILE=$NGINX_DIR/$SVC.conf
MIN_BUN=1.3.0
# 与 src/lib/shared-ledger-contract.ts 的 SHARED_LEDGER_MAX_BODY_BYTES（1 MiB）一致；tests/shared-ledger-deploy.test.ts 核对
BODY_LIMIT=1m
# 与 src/shared-ledger/service.ts 的路由正则一致：只有 /v1/teams/<team>/<资源>[/<id>] 会被反代
API_RE='^/v1/teams/[A-Za-z0-9_.:-]+/(features|commands|imports|projections)(/[A-Za-z0-9_.:-]+)?$'
MODE=${1:-}; shift || true
HOST_NAME="" PORT="" BUN="" CODE_CHANGED=0 DRY=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --host-name) HOST_NAME=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --bun) BUN=${2:?}; shift 2 ;;
    --code-changed) CODE_CHANGED=${2:?}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "remote.sh: 未知参数 $1" >&2; exit 2 ;;
  esac
done
say() { echo "  $*"; }
die() { echo "✗ $*" >&2; exit 1; }
# 远端写操作一律经 act：--dry-run 只打印
act() {
  if [[ $DRY == 1 ]]; then echo "  [dry-run] $*"; else echo "  + $*"; "$@"; fi
}
[[ -n $P || $EUID -eq 0 ]] || die "需要 root（deploy.sh 的 ssh 目标要是 root@<主机>）"
# 文件归属：不是本脚本写的（首行不是 MARK）就拒绝动它
is_ours() { [[ "$(head -n 1 "$P$1" 2>/dev/null)" == "$MARK" ]]; }
guard_ours() {
  if [[ -e $P$1 ]] && ! is_ours "$1"; then
    die "$1 已存在且不是本脚本写的（首行没有标记头），拒绝覆盖；先人工确认这个文件归谁"
  fi
}
# 把渲染好的内容 $2 装到 $1：内容相同返回 1（未变更），否则写入（0644）返回 0
put_file() {
  local path=$1 content=$2
  guard_ours "$path"
  if [[ -f $P$path ]] && [[ "$(cat "$P$path")" == "$content" ]]; then say "未变：$path"; return 1; fi
  if [[ $DRY == 1 ]]; then
    echo "  [dry-run] 写入 $path："
    printf '%s\n' "$content" | sed 's/^/      | /'
  else
    printf '%s\n' "$content" > "$P$path.tmp-$$"
    chmod 0644 "$P$path.tmp-$$"
    mv -f "$P$path.tmp-$$" "$P$path"
    echo "  + 写入 $path"
  fi
  return 0
}
ensure_dir() { # 路径 属主 权限
  local path=$1 owner=$2 mode=$3
  if [[ ! -d $P$path ]]; then act mkdir -p "$P$path"; act chown "$owner:$owner" "$P$path"; act chmod "$mode" "$P$path"; return; fi
  [[ "$(stat -c %a "$P$path" 2>/dev/null || stat -f %Lp "$P$path")" == "${mode#0}" ]] || act chmod "$mode" "$P$path"
  [[ -n $P || "$(stat -c %U "$path")" == "$owner" ]] || act chown "$owner:$owner" "$P$path"
}
hardening() { # 两个单元共用的加固；不加 MemoryDenyWriteExecute（会打断 bun 的 JIT）
  cat <<EOF
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
EOF
}
render_unit() {
  cat <<EOF
$MARK
[Unit]
Description=Claudestra shared ledger center (loopback only; nginx terminates TLS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$STATE_DIR
Environment=NODE_ENV=production
Environment=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
# 服务端 startServer 只接受回环地址；--port 是 127.0.0.1 上的端口。网络层再兜一层：只许与本机通信
ExecStart=$BUN --no-env-file src/shared-ledger.ts --db $DB --port $PORT
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
MemoryMax=512M
TasksMax=64
LimitNOFILE=4096
CPUQuota=100%
ReadWritePaths=$DB_DIR
$(hardening)

[Install]
WantedBy=multi-user.target
EOF
}

render_backup_service() {
  cat <<EOF
$MARK
[Unit]
Description=Claudestra shared ledger daily consistent backup (VACUUM INTO, keep 7 days)

[Service]
Type=oneshot
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$STATE_DIR
Environment=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ExecStart=$BUN --no-env-file deploy/shared-ledger/backup.ts $DB $BACKUP_DIR 7
Nice=10
MemoryMax=512M
IPAddressDeny=any
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$DB_DIR $BACKUP_DIR
$(hardening)
EOF
}

render_backup_timer() {
  cat <<EOF
$MARK
[Unit]
Description=Daily backup of the Claudestra shared ledger

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

render_nginx() { # 证书 私钥 是否听 IPv6
  local v6=""
  [[ $3 == 1 ]] && v6="    listen [::]:443 ssl;"
  cat <<EOF
$MARK
# 共享台账中心的 HTTPS 入口：只反代台账 API，其余一律 404。证书复用主机上已有 server 块的那一张，不新申请。
limit_req_zone \$binary_remote_addr zone=claudestra_shared_ledger:10m rate=2r/s;

server {
    listen 443 ssl;
$v6
    server_name $HOST_NAME;

    ssl_certificate     $1;
    ssl_certificate_key $2;

    client_max_body_size $BODY_LIMIT;
    client_body_timeout 10s;
    limit_req zone=claudestra_shared_ledger burst=20 nodelay;
    limit_req_status 429;

    location ~ "$API_RE" {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 5s;
        proxy_send_timeout 15s;
        proxy_read_timeout 15s;
    }

    location / {
        return 404;
    }
}
EOF
}

# 只排除路径和标记头都属于本脚本的配置；其余输出连注释也检查，
# 引号作为边界、尾点归一化，避免等价域名写法绕过检查。误拒比覆盖现有入口安全。
detect_collision() {
  printf '%s\n' "$1" | awk -v ours="$NGINX_FILE" -v mark="$MARK" -v host="$HOST_NAME" '
    function check(    n, a, i) {
      if (file == ours && header == mark) return
      n = split(tolower(content), a, /[[:space:];{}"\047]+/)
      for (i = 1; i <= n; i++) { sub(/\.$/, "", a[i]); if (a[i] == tolower(host)) { hit = 1; print (file == "" ? "<nginx -T>" : file); exit } }
    }
    /^# configuration file / {
      check(); file = $0; sub(/^# configuration file /, "", file); sub(/:$/, "", file)
      content = ""; header = ""; first = 1; next
    }
    { if (first) { header = $0; first = 0 }; content = content $0 "\n" }
    END { if (!hit) check() }'
}

# 证书探测保留现有通配站点复用逻辑；撞名判据独立于指令解析。
detect_cert() {
  printf '%s\n' "$1" | awk -v ours="$NGINX_FILE" -v exact="$(tr '[:upper:]' '[:lower:]' <<< "$HOST_NAME")" -v wild="*.$(tr '[:upper:]' '[:lower:]' <<< "${HOST_NAME#*.}")" '
    /^# configuration file / { file = $4; sub(/:$/, "", file); depth = 0; inserver = 0; next }
    file == ours { next }
    { line = $0; sub(/#.*/, "", line); sub(/^[ \t]+/, "", line) }
    !inserver && line ~ /^server[ \t]*\{/ { inserver = 1; start = depth; names = " "; cert = ""; key = "" }
    inserver && line ~ /^server_name[ \t]/ { v = tolower(line); sub(/^server_name[ \t]+/, "", v); sub(/;.*/, "", v); gsub(/[ \t]+/, " ", v); names = names v " " }
    inserver && line ~ /^ssl_certificate[ \t]/ { split(line, a, /[ \t;]+/); cert = a[2] }
    inserver && line ~ /^ssl_certificate_key[ \t]/ { split(line, a, /[ \t;]+/); key = a[2] }
    {
      depth += gsub(/\{/, "{", line) - gsub(/\}/, "}", line)
      if (inserver && depth <= start) {
        inserver = 0
        if (cert != "" && key != "") {
          if (index(names, " " exact " ") && best == "") best = cert " " key
          else if (index(names, " " wild " ") && second == "") second = cert " " key
        }
      }
    }
    END { if (best != "") print best; else if (second != "") print second }'
}

service_state() { systemctl is-active "$1" 2>/dev/null || true; }

health() {
  local body code i tmp
  tmp=$(mktemp)
  for ((i = 0; i < ${SHARED_LEDGER_HEALTH_TRIES:-10}; i++)); do
    # 不带签名的请求：活着的中心回 401 bad_signature（JSON），这就是健康
    code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/v1/teams/healthcheck/features" 2>/dev/null || true)
    body=$(cat "$tmp" 2>/dev/null || true)
    if [[ $code == 401 && $body == *bad_signature* ]]; then rm -f "$tmp"; say "健康：127.0.0.1:$PORT 回 401 bad_signature（未签名请求被拒 = 服务正常）"; return 0; fi
    sleep 1
  done
  rm -f "$tmp"
  echo "✗ 健康检查失败：127.0.0.1:$PORT 回 ${code:-无响应}；服务日志尾部：" >&2
  journalctl -u "$SVC" -n 50 --no-pager >&2 || true
  exit 1
}

# 只读：从现有 nginx 配置里探测要复用的证书、是否听 IPv6，并拒绝已被占用的域名。装单元 / 起服务之前就跑，冲突时远端什么都不写
CERT="" KEY="" V6=0
probe_nginx() {
  local conf found
  conf=$(nginx -T 2>&1) || die "nginx -T 失败"
  found=$(detect_collision "$conf")
  [[ -z $found ]] || die "nginx 配置（$found）中出现完整域名 token $HOST_NAME；请换一个未被占用的 --host-name（注释中出现也保守拒绝）"
  found=$(detect_cert "$conf")
  [[ -n $found ]] || die "没在已有 nginx server 块里找到覆盖 $HOST_NAME 的证书（server_name 为 $HOST_NAME 或 *.${HOST_NAME#*.}）；本脚本不申请证书、不改 DNS"
  CERT=${found% *}; KEY=${found#* }
  [[ -r $P$CERT && -r $P$KEY ]] || die "探测到的证书文件不可读：$CERT / $KEY"
  if command -v openssl >/dev/null && ! openssl x509 -noout -checkhost "$HOST_NAME" -in "$P$CERT" | grep -q 'does match'; then
    die "证书 $CERT 不覆盖 $HOST_NAME"
  fi
  [[ $conf =~ listen[[:space:]]+\[::\]:443 ]] && V6=1
  say "复用证书：$CERT"
}

install_nginx() {
  local rendered prev=""
  guard_ours "$NGINX_FILE"
  rendered=$(render_nginx "$CERT" "$KEY" "$V6")
  if [[ -f $P$NGINX_FILE ]]; then prev=$(cat "$P$NGINX_FILE"); fi
  if put_file "$NGINX_FILE" "$rendered"; then
    [[ $DRY == 1 ]] && { echo "  [dry-run] nginx -t；通过则 systemctl reload nginx，失败则撤回本次写入"; return 0; }
    if ! nginx -t; then
      if [[ -n $prev ]]; then printf '%s\n' "$prev" > "$P$NGINX_FILE"; echo "  ↩ nginx -t 失败，已恢复 $NGINX_FILE 的上一版" >&2
      else rm -f "$P$NGINX_FILE"; echo "  ↩ nginx -t 失败，已删除本次写入的 $NGINX_FILE" >&2; fi
      die "nginx -t 未通过，未 reload"
    fi
    act systemctl reload nginx
  elif [[ $DRY == 1 ]]; then
    echo "  [dry-run] 经 https://$HOST_NAME 做入口自检（期望 API 401、其他 404）"; return 0
  fi
  # 块没变也照样验：幂等只省掉 reload，不能把上次失败的入口当成功（上次自检失败后不修就重跑，这里仍会失败）
  verify_https
}

# reload 后经本机 443 走一遍真实入口（SNI = 域名，证书照常校验）：API 路径应到中心（401），其他路径 404
verify_https() {
  local api other
  sleep 1
  api=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HOST_NAME:443:127.0.0.1" "https://$HOST_NAME/v1/teams/healthcheck/features" || true)
  other=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HOST_NAME:443:127.0.0.1" "https://$HOST_NAME/" || true)
  if [[ $api != 401 || $other != 404 ]]; then
    die "nginx 已 reload，但经 https://$HOST_NAME 自检不符：API 路径回 ${api:-无响应}（期望 401）、/ 回 ${other:-无响应}（期望 404）；回滚见 README"
  fi
  say "HTTPS 入口自检：API 路径 401、其他路径 404"
}

do_install() {
  [[ $HOST_NAME =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "--host-name 不是合法域名：$HOST_NAME"
  [[ $PORT =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || die "--port 要在 1024–65535：$PORT"
  echo "→ 前置检查"
  for c in systemctl nginx curl journalctl; do command -v "$c" >/dev/null || die "远端缺少 $c"; done
  [[ $BUN == /* && $BUN != /root/* && $BUN != /home/* ]] || die "--bun 要是绝对路径且不在 /root、/home 下（单元开了 ProtectHome）：$BUN"
  [[ -x $P$BUN ]] || die "远端没有可执行的 $BUN；先装一个系统级 bun（见 README 前置条件）"
  local v; v=$("$P$BUN" --version)
  [[ "$(printf '%s\n%s\n' "$MIN_BUN" "$v" | sort -V | head -n 1)" == "$MIN_BUN" ]] || die "远端 bun $v 低于 $MIN_BUN"
  say "bun $v @ $BUN"
  [[ -f $P$APP_DIR/src/shared-ledger.ts ]] || [[ $DRY == 1 ]] || die "$APP_DIR/src/shared-ledger.ts 不存在：代码没同步上来"
  nginx -t >/dev/null 2>&1 || die "现有 nginx 配置 nginx -t 就不通过；先修好现有配置，本脚本不在坏配置上叠加"
  guard_ours "$NGINX_FILE"
  probe_nginx
  if [[ $(service_state "$SVC") != active ]] && command -v ss >/dev/null && [[ -n $(ss -ltnH "sport = :$PORT" 2>/dev/null) ]]; then
    die "127.0.0.1:$PORT 已被别的进程占用；换 --port"
  fi

  echo "→ 服务账号与目录"
  if getent passwd "$SVC_USER" >/dev/null; then say "账号 $SVC_USER 已存在"
  else act useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"; fi
  ensure_dir "$STATE_DIR" "$SVC_USER" 0700
  ensure_dir "$DB_DIR" "$SVC_USER" 0700
  ensure_dir "$BACKUP_DIR" "$SVC_USER" 0700
  local f
  for f in "$P$DB" "$P$DB-wal" "$P$DB-shm"; do
    [[ -f $f ]] && [[ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" != 600 ]] && act chmod 0600 "$f"
  done

  echo "→ systemd 单元"
  local units_changed=0
  put_file "$UNIT_DIR/$SVC.service" "$(render_unit)" && units_changed=1
  put_file "$UNIT_DIR/$SVC-backup.service" "$(render_backup_service)" && units_changed=1
  put_file "$UNIT_DIR/$SVC-backup.timer" "$(render_backup_timer)" && units_changed=1
  [[ $units_changed == 1 ]] && act systemctl daemon-reload
  systemctl is-enabled --quiet "$SVC" 2>/dev/null || act systemctl enable "$SVC"
  systemctl is-enabled --quiet "$SVC-backup.timer" 2>/dev/null || act systemctl enable --now "$SVC-backup.timer"

  echo "→ 服务"
  if [[ $(service_state "$SVC") != active ]]; then act systemctl start "$SVC"
  elif [[ $units_changed == 1 || $CODE_CHANGED == 1 ]]; then act systemctl restart "$SVC"
  else say "服务在跑，单元与代码都没变，不重启"; fi
  if [[ $DRY == 1 ]]; then echo "  [dry-run] 回环健康检查 http://127.0.0.1:$PORT/（期望 401 bad_signature）"; else health; fi

  echo "→ nginx"
  install_nginx
  echo "✓ 完成"
}

do_uninstall() {
  echo "→ 停服务（保留 $DB_DIR 与 $BACKUP_DIR）"
  local u removed=0
  for u in "$SVC.service" "$SVC-backup.service" "$SVC-backup.timer" "$NGINX_FILE"; do
    if [[ $u == /* ]]; then guard_ours "$u"; else guard_ours "$UNIT_DIR/$u"; fi
  done
  for u in "$SVC-backup.timer" "$SVC"; do
    if [[ -f $P$UNIT_DIR/$u || -f $P$UNIT_DIR/$u.service ]]; then act systemctl disable --now "$u"; fi
  done
  for u in "$SVC.service" "$SVC-backup.service" "$SVC-backup.timer"; do
    [[ -e $P$UNIT_DIR/$u ]] || continue
    act rm -f "$P$UNIT_DIR/$u"; removed=1
  done
  [[ $removed == 1 ]] && act systemctl daemon-reload
  echo "→ nginx"
  if [[ -e $P$NGINX_FILE ]]; then
    local prev; prev=$(cat "$P$NGINX_FILE")
    act rm -f "$P$NGINX_FILE"
    if [[ $DRY == 0 ]]; then
      if ! nginx -t; then printf '%s\n' "$prev" > "$P$NGINX_FILE"; die "删除后 nginx -t 不通过，已放回 $NGINX_FILE"; fi
      act systemctl reload nginx
    else echo "  [dry-run] nginx -t && systemctl reload nginx"; fi
  else say "没有 $NGINX_FILE"; fi
  echo "✓ 已卸载；库与备份保留在 $DB_DIR、$BACKUP_DIR，代码目录 $APP_DIR 未删"
}

case $MODE in
  install) do_install ;;
  uninstall) do_uninstall ;;
  *) die "用法: remote.sh install|uninstall …" ;;
esac
