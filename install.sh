#!/usr/bin/env bash
#
# Claudestra 一键安装脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
# 或
#   curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh -o install.sh
#   bash install.sh
#
# 可选环境变量：
#   CLAUDESTRA_DIR    — 克隆目录（默认 ~/repos/claudestra）
#   CLAUDESTRA_REPO   — git 仓库地址（默认 https://github.com/shawnlu96/claudestra.git）
#   CLAUDESTRA_BRANCH — 分支（默认 main）
#   CLAUDESTRA_YES    — 设为 1 时跳过所有确认，全自动装

set -euo pipefail

# ────────────────────────────────────────────
# 配置
# ────────────────────────────────────────────

CLAUDESTRA_REPO="${CLAUDESTRA_REPO:-https://github.com/shawnlu96/claudestra.git}"
CLAUDESTRA_BRANCH="${CLAUDESTRA_BRANCH:-main}"
CLAUDESTRA_DIR="${CLAUDESTRA_DIR:-$HOME/repos/claudestra}"
CLAUDESTRA_YES="${CLAUDESTRA_YES:-0}"

# ────────────────────────────────────────────
# 终端颜色
# ────────────────────────────────────────────

if [ -t 1 ]; then
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m')
  BLUE=$(printf '\033[34m')
  CYAN=$(printf '\033[36m')
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  RESET=$(printf '\033[0m')
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; CYAN=""; BOLD=""; DIM=""; RESET=""
fi

say()  { printf "${CYAN}▶${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${RESET}  %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
fail() { printf "${RED}✗${RESET}  %s\n" "$*" >&2; }
die()  { fail "$*"; exit 1; }

# 读 stdin 兜底（`curl | bash` 的情况下 stdin 是 pipe，需要从 /dev/tty 读）
read_answer() {
  local prompt="$1"
  local default="$2"
  local ans=""
  if [ "$CLAUDESTRA_YES" = "1" ]; then
    echo "$default"
    return
  fi
  if [ -t 0 ]; then
    read -r -p "$prompt" ans
  elif [ -e /dev/tty ]; then
    read -r -p "$prompt" ans </dev/tty
  else
    ans="$default"
  fi
  echo "${ans:-$default}"
}

confirm() {
  local question="$1"
  local default_yes="${2:-y}"
  local hint
  if [ "$default_yes" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  local ans
  ans=$(read_answer "${BOLD}${question}${RESET} ${DIM}${hint}${RESET} " "$default_yes")
  # 兼容 macOS 自带的 bash 3.2，不用 ${var,,}
  ans_lower=$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')
  case "$ans_lower" in
    y|yes) return 0 ;;
    n|no)  return 1 ;;
    *)
      if [ "$default_yes" = "y" ]; then return 0; else return 1; fi
      ;;
  esac
}

# ────────────────────────────────────────────
# 平台检测
# ────────────────────────────────────────────

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}  Claudestra 一键安装脚本${RESET}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux"  ;;
  *)      die "不支持的系统: $OS（只支持 macOS / Linux）" ;;
esac
ok "系统: $OS"

# ────────────────────────────────────────────
# 前置：包管理器
# ────────────────────────────────────────────

install_homebrew() {
  say "安装 Homebrew"
  if [ -e /dev/tty ]; then
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  else
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi

  # 把 brew 加到 PATH（Apple Silicon 和 Intel 路径不同）
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

if [ "$PLATFORM" = "darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    warn "检测不到 Homebrew"
    if confirm "要我帮你装 Homebrew 吗？" y; then
      install_homebrew
    else
      die "没有 Homebrew 就没法自动装依赖。去 https://brew.sh 装完再重跑本脚本。"
    fi
  fi
  ok "Homebrew: $(command -v brew)"
else
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "Linux 自动安装目前只支持 Debian/Ubuntu 系（需要 apt-get）"
    die "在非 Debian 系系统上，请手动安装 git / tmux / node / bun / pm2 / claude 后重跑本脚本。"
  fi
  ok "apt-get: $(command -v apt-get)"
fi

# ────────────────────────────────────────────
# 依赖安装
# ────────────────────────────────────────────

install_via_brew() {
  local pkg="$1"
  brew install "$pkg"
}

install_via_apt() {
  local pkg="$1"
  sudo apt-get update -qq
  sudo apt-get install -y "$pkg"
}

install_bun() {
  say "curl -fsSL https://bun.sh/install | bash"
  if [ -e /dev/tty ]; then
    bash -c 'curl -fsSL https://bun.sh/install | bash' </dev/tty
  else
    bash -c 'curl -fsSL https://bun.sh/install | bash'
  fi
  # 把 ~/.bun/bin 加到当前 shell 的 PATH
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

install_failed=0

install_pkg() {
  # $1 = friendly label, $2 = command to verify, $3 = install fn name
  local label="$1"
  local cmd="$2"
  local installer="$3"

  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$label — 已安装"
    return 0
  fi

  say "安装 $label"
  # 临时关掉 set -e，不让安装失败杀死整个脚本
  set +e
  "$installer"
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    warn "$label 安装命令返回了错误码 $rc"
  fi

  # 刷新 shell 命令缓存，否则刚装的二进制可能找不到
  hash -r 2>/dev/null || true

  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$label 安装成功"
  else
    fail "$label 安装后仍然找不到 '$cmd'，可能需要新开一个终端让 PATH 生效"
    install_failed=1
  fi
  return 0
}

# git
_install_git() {
  case "$PLATFORM" in
    darwin) install_via_brew git ;;
    linux)  install_via_apt git ;;
  esac
}

# tmux
_install_tmux() {
  case "$PLATFORM" in
    darwin) install_via_brew tmux ;;
    linux)  install_via_apt tmux ;;
  esac
}

# node（pm2 / claude 的前置）
_install_node() {
  case "$PLATFORM" in
    darwin) install_via_brew node ;;
    linux)  install_via_apt nodejs ;;
  esac
  # 有些 apt 包名 nodejs 不带 npm，需要单独装
  if [ "$PLATFORM" = "linux" ] && ! command -v npm >/dev/null 2>&1; then
    sudo apt-get install -y npm
  fi
}

# pm2
_install_pm2() {
  sudo_npm_install pm2 || npm install -g pm2
}

# claude
_install_claude() {
  sudo_npm_install @anthropic-ai/claude-code || npm install -g @anthropic-ai/claude-code
}

sudo_npm_install() {
  # npm -g 在系统 node 下需要 sudo；在 brew/nvm 下不需要
  local pkg="$1"
  if npm install -g "$pkg" 2>/dev/null; then
    return 0
  fi
  if [ -t 0 ] || [ -e /dev/tty ]; then
    sudo npm install -g "$pkg"
  else
    return 1
  fi
}

# 缺什么就提前列出来，让用户一次性确认
missing=()
check_missing() {
  local cmd="$1"
  local label="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$label")
  fi
}
check_missing git   "git"
check_missing tmux  "tmux"
check_missing node  "node (npm 的前置)"
check_missing bun   "bun"
check_missing pm2   "pm2"
check_missing claude "claude (Claude Code CLI)"

if [ ${#missing[@]} -gt 0 ]; then
  printf "\n${BOLD}需要安装的依赖：${RESET}\n"
  for m in "${missing[@]}"; do
    printf "  ${DIM}•${RESET} %s\n" "$m"
  done
  printf "\n"
  if ! confirm "开始安装？" y; then
    die "已取消。"
  fi
  printf "\n"
fi

install_pkg "git"    git    _install_git
install_pkg "tmux"   tmux   _install_tmux
install_pkg "node"   node   _install_node
install_pkg "bun"    bun    install_bun
install_pkg "pm2"    pm2    _install_pm2
install_pkg "claude" claude _install_claude

printf "\n"

if [ "$install_failed" = "1" ]; then
  fail "部分依赖没装上。请检查上面的错误，装完后重跑本脚本"
  exit 1
fi

ok "所有依赖就绪 ✨"

# ────────────────────────────────────────────
# 克隆代码
# ────────────────────────────────────────────

printf "\n"
if [ -d "$CLAUDESTRA_DIR/.git" ]; then
  say "检测到已有仓库: $CLAUDESTRA_DIR"
  (cd "$CLAUDESTRA_DIR" && git fetch --tags --quiet origin 2>/dev/null) || true
else
  if [ -e "$CLAUDESTRA_DIR" ]; then
    die "$CLAUDESTRA_DIR 已存在但不是 git 仓库，请先移走或清空"
  fi
  say "克隆 $CLAUDESTRA_REPO → $CLAUDESTRA_DIR"
  mkdir -p "$(dirname "$CLAUDESTRA_DIR")"
  git clone "$CLAUDESTRA_REPO" "$CLAUDESTRA_DIR"
  ok "代码已克隆"
fi

cd "$CLAUDESTRA_DIR"

# 切换到最新 release 版本（如果有的话）
GITHUB_API_REPO=$(echo "$CLAUDESTRA_REPO" | sed -n 's|.*github\.com[:/]\(.*\)\.git$|\1|p')
if [ -n "$GITHUB_API_REPO" ]; then
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${GITHUB_API_REPO}/releases/latest" 2>/dev/null | grep -o '"tag_name":"[^"]*"\|"tag_name": "[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$LATEST_TAG" ]; then
    git checkout "$LATEST_TAG" --quiet 2>/dev/null || true
    ok "版本: $LATEST_TAG"
  else
    warn "没有找到 release 版本，使用 main 分支最新代码"
  fi
fi

# ────────────────────────────────────────────
# 装项目依赖
# ────────────────────────────────────────────

printf "\n"
say "bun install"
bun install

say "playwright install chromium ${DIM}(终端截图用)${RESET}"
if ! bunx playwright install chromium 2>/dev/null; then
  warn "bunx playwright 失败，尝试 npx"
  npx --yes playwright install chromium || warn "Playwright 没装上，截图功能会不可用"
fi

ok "项目依赖安装完成"

# ────────────────────────────────────────────
# 下一步
# ────────────────────────────────────────────

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  ✨ 系统已就绪，现在跑配置向导${RESET}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

printf "配置向导会带你创建 Discord bot、收集 ID、写 .env、启动服务。\n"
printf "预计 ${BOLD}10 分钟${RESET}。\n\n"

if confirm "现在跑 ${CYAN}bun run setup${RESET}？" y; then
  printf "\n"
  cd "$CLAUDESTRA_DIR"
  # curl|bash 下 stdin 是管道。先用 exec 重定向把 shell 自身的 fd 0
  # 切到 /dev/tty（控制终端），再 exec 替换进程。
  # 两步 exec 确保子进程继承的 fd 0 一定是终端。
  if [ -e /dev/tty ]; then
    exec </dev/tty
  fi
  exec bun run setup
else
  printf "\n稍后手动跑：\n"
  printf "  ${CYAN}cd $CLAUDESTRA_DIR${RESET}\n"
  printf "  ${CYAN}bun run setup${RESET}\n\n"
fi
