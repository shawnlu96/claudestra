#!/usr/bin/env bash
#
# Claudestra 一键安装脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/<owner>/claudestra/main/install.sh | bash
# 或
#   curl -fsSL https://raw.githubusercontent.com/<owner>/claudestra/main/install.sh -o install.sh
#   bash install.sh
#
# 可选环境变量：
#   CLAUDESTRA_DIR    — 克隆目录（默认 ~/repos/claudestra）
#   CLAUDESTRA_REPO   — git 仓库地址（默认 https://github.com/<owner>/claudestra.git）
#   CLAUDESTRA_BRANCH — 分支（默认 main）

set -euo pipefail

# ────────────────────────────────────────────
# 配置
# ────────────────────────────────────────────

CLAUDESTRA_REPO="${CLAUDESTRA_REPO:-https://github.com/shawnlu96/claudestra.git}"
CLAUDESTRA_BRANCH="${CLAUDESTRA_BRANCH:-main}"
CLAUDESTRA_DIR="${CLAUDESTRA_DIR:-$HOME/repos/claudestra}"

# ────────────────────────────────────────────
# 颜色输出
# ────────────────────────────────────────────

if [ -t 1 ]; then
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m')
  BLUE=$(printf '\033[34m')
  BOLD=$(printf '\033[1m')
  RESET=$(printf '\033[0m')
else
  GREEN=""; YELLOW=""; RED=""; BLUE=""; BOLD=""; RESET=""
fi

say() { printf "${BLUE}==>${RESET} %s\n" "$*"; }
ok()  { printf "${GREEN}✓${RESET}  %s\n" "$*"; }
warn(){ printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
die() { printf "${RED}✗${RESET}  %s\n" "$*" >&2; exit 1; }

# ────────────────────────────────────────────
# 前置检查
# ────────────────────────────────────────────

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}  Claudestra 一键安装脚本${RESET}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

OS="$(uname -s)"
if [ "$OS" != "Darwin" ] && [ "$OS" != "Linux" ]; then
  die "不支持的系统: $OS（只支持 macOS / Linux）"
fi
ok "系统: $OS"

check_cmd() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    warn "缺少 $cmd"
    printf "   安装方式：$install_hint\n"
    MISSING=1
  else
    ok "$cmd: $(command -v "$cmd")"
  fi
}

MISSING=0
check_cmd git    "brew install git  # 或系统自带"
check_cmd tmux   "brew install tmux"
check_cmd bun    "curl -fsSL https://bun.sh/install | bash"
check_cmd pm2    "npm install -g pm2"
check_cmd claude "npm install -g @anthropic-ai/claude-code"

if [ "$MISSING" -eq 1 ]; then
  printf "\n${RED}请先装好上述依赖，再重跑本脚本。${RESET}\n"
  exit 1
fi

# 版本提醒（不强制）
BUN_VERSION="$(bun --version 2>/dev/null || echo unknown)"
say "bun 版本: $BUN_VERSION"

# ────────────────────────────────────────────
# 克隆代码
# ────────────────────────────────────────────

printf "\n"
if [ -d "$CLAUDESTRA_DIR/.git" ]; then
  say "检测到已有仓库: $CLAUDESTRA_DIR"
  printf "要 ${YELLOW}git pull${RESET} 更新到最新吗？[Y/n] "
  read -r ans </dev/tty || ans=""
  if [[ ! "$ans" =~ ^[Nn] ]]; then
    (cd "$CLAUDESTRA_DIR" && git pull --ff-only)
    ok "代码已更新"
  else
    ok "保留现有代码"
  fi
else
  if [ -e "$CLAUDESTRA_DIR" ]; then
    die "$CLAUDESTRA_DIR 已存在但不是 git 仓库，请先移走或清空"
  fi
  say "克隆 $CLAUDESTRA_REPO → $CLAUDESTRA_DIR"
  mkdir -p "$(dirname "$CLAUDESTRA_DIR")"
  git clone --branch "$CLAUDESTRA_BRANCH" "$CLAUDESTRA_REPO" "$CLAUDESTRA_DIR"
  ok "代码已克隆"
fi

cd "$CLAUDESTRA_DIR"

# ────────────────────────────────────────────
# 装依赖
# ────────────────────────────────────────────

printf "\n"
say "安装 node 依赖 (bun install)"
bun install

say "安装 Playwright Chromium（用于终端截图渲染）"
if ! bunx playwright install chromium 2>/dev/null; then
  warn "bunx playwright 失败，尝试 npx"
  npx --yes playwright install chromium || warn "Playwright 没装上，截图功能可能不可用"
fi

ok "依赖安装完成"

# ────────────────────────────────────────────
# 下一步提示
# ────────────────────────────────────────────

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}  安装完成！接下来：${RESET}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

printf "${BOLD}1.${RESET} 跑配置向导（收集 Discord token/guild/channel 等）:\n"
printf "   ${GREEN}cd $CLAUDESTRA_DIR${RESET}\n"
printf "   ${GREEN}bun run setup${RESET}\n\n"

printf "${BOLD}2.${RESET} 跟着 setup 打印的提示：\n"
printf "   • 注册 MCP server：claude mcp add ...\n"
printf "   • 启 pm2：pm2 start ecosystem.config.cjs\n\n"

printf "${BOLD}3.${RESET} Discord 发消息给 bot 测试 👍\n\n"

printf "详细说明：${BLUE}$CLAUDESTRA_DIR/SETUP.md${RESET}\n\n"
