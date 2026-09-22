#!/usr/bin/env bash
#
# Claudestra one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
# or
#   curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh -o install.sh
#   bash install.sh
#
# Optional environment variables:
#   CLAUDESTRA_DIR    — clone target (default ~/repos/claudestra)
#   CLAUDESTRA_REPO   — git remote (default https://github.com/shawnlu96/claudestra.git)
#   CLAUDESTRA_BRANCH — branch or tag to install (e.g. main). When set, the latest
#                       release tag is NOT checked out — you get exactly this ref.
#                       Unset (default): install the latest published release.
#   CLAUDESTRA_YES    — set to 1 to skip every confirmation (unattended)
#   CLAUDESTRA_NO_SETUP — set to 1 to stop after dependencies + clone (skip the wizard).
#                       Useful for CI / smoke tests, and for configuring later by hand.
#   CLAUDESTRA_LANG   — zh | en (default: auto-detect from locale)

set -euo pipefail

# ────────────────────────────────────────────
# 配置
# ────────────────────────────────────────────

CLAUDESTRA_REPO="${CLAUDESTRA_REPO:-https://github.com/shawnlu96/claudestra.git}"
# ⚠ 之前这个变量声明了、文档里也写了，但**脚本从头到尾没用过它**（git clone 不带
#   -b，后面也没 checkout），于是「装某个分支/标签」这件事根本做不到——而下面又
#   无条件切到最新 release tag，结果是「装最新代码」也做不到。要验主干上的改动
#   （发版前的功能、修完还没发的 bug）时只能手工 clone，这跟一键安装的目的相悖。
if [ -n "${CLAUDESTRA_BRANCH:-}" ]; then CLAUDESTRA_REF_EXPLICIT=1; else CLAUDESTRA_REF_EXPLICIT=0; fi
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

# ── 语言 ──────────────────────────────────────────────
# 此前本脚本全程中文，而它是 README 里的第一条命令 —— 英文用户在有机会选语言
# 之前就得先看几十行中文并决定按不按 y。这里按 locale 自动分流，默认英文；
# CLAUDESTRA_LANG=zh|en 可显式指定。
detect_lang() {
  case "${CLAUDESTRA_LANG:-}" in
    zh|zh_CN|cn) printf 'zh'; return ;;
    en|en_US)    printf 'en'; return ;;
  esac
  case "${LC_ALL:-${LANG:-}}" in
    zh_*|*zh_CN*|*Hans*) printf 'zh' ;;
    *)                   printf 'en' ;;
  esac
}
CS_LANG="$(detect_lang)"
# L <中文> <English>
# ⚠ 在中文串里插变量一律写 ${VAR} 带花括号：`$VAR（`、`$VAR，` 这种紧跟全角标点的
#   写法，bash 会把多字节字节当成变量名的一部分 → set -u 下报 `VAR…: unbound variable`，
#   要说的话一个字都到不了用户眼前（2026-09-22 实测，两处都中招）。
L() { if [ "$CS_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

say()  { printf "${CYAN}▶${RESET} %s\n" "$*"; }
# release tag 落后 origin/main 多少个提交 —— 落后不少时提醒一句，
# 免得有人拿一个月前的 release 去验主干上刚修好的东西。
hint_newer_main() {
  local tag="$1" behind
  behind=$(git rev-list --count "$tag..origin/main" 2>/dev/null || echo 0)
  if [ "${behind:-0}" -gt 0 ]; then
    printf "${YELLOW}⚠${RESET}  %s\n" "$(L "主干(main)比 $tag 新 $behind 个提交。想装最新代码：CLAUDESTRA_BRANCH=main 再跑一次。" "main is $behind commits ahead of $tag. To install the latest code: re-run with CLAUDESTRA_BRANCH=main.")"
  fi
}
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
printf "${BOLD}  $(L "Claudestra 一键安装脚本" "Claudestra one-line installer")${RESET}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux"  ;;
  *)      die "$(L "不支持的系统: ${OS}（只支持 macOS / Linux）" "Unsupported OS: ${OS} (macOS / Linux only)")" ;;
esac
ok "$(L "系统" "OS"): $OS"

# ────────────────────────────────────────────
# 前置：包管理器
# ────────────────────────────────────────────

# 注意：在 `if ! install_homebrew` 里调用时 set -e 不生效，每一步失败都要显式 return 1
install_homebrew() {
  say "$(L "安装 Homebrew" "Installing Homebrew")"
  # NONINTERACTIVE 下 brew 安装器只用 `sudo -n`（不问密码），凭据没缓存就会报
  # 「需要是管理员」——哪怕你就是管理员。所以先在这里要一次密码把凭据缓存上。
  printf "%s\n" "$(L "Homebrew 需要管理员密码（输入时不显示字符）：" "Homebrew needs your admin password (typing is hidden):")"
  if [ -e /dev/tty ]; then
    sudo -v </dev/tty || return 1
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty || return 1
  else
    sudo -v || return 1
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || return 1
  fi

  # 把 brew 加到 PATH（Apple Silicon 和 Intel 路径不同）
  local brew_bin=""
  if [ -x /opt/homebrew/bin/brew ]; then
    brew_bin=/opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then
    brew_bin=/usr/local/bin/brew
  fi
  [ -n "$brew_bin" ] || return 1
  eval "$("$brew_bin" shellenv)"
  # 只在当前进程 eval 的话，新开的终端找不到 brew / tmux / node。和 Homebrew 官方
  # 「Next steps」一样写进 ~/.zprofile，并告诉用户改了什么
  if ! grep -qs "brew shellenv" "$HOME/.zprofile"; then
    printf '\neval "$(%s shellenv)"\n' "$brew_bin" >> "$HOME/.zprofile"
    ok "$(L "已在 ~/.zprofile 末尾加上 brew shellenv（新开的终端才找得到 brew）" "Appended brew shellenv to ~/.zprofile (so new terminals can find brew)")"
  fi
}

if [ "$PLATFORM" = "darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    warn "$(L "检测不到 Homebrew" "Homebrew not found")"
    if confirm "$(L "要我帮你装 Homebrew 吗？" "Install Homebrew for you?")" y; then
      if ! install_homebrew; then
        die "$(L "Homebrew 没装上：上面是它的原始报错。手动装好 https://brew.sh 后重跑本脚本" "Homebrew did not install — its own error is above. Install it from https://brew.sh, then re-run this script")"
      fi
    else
      die "$(L "没有 Homebrew 就没法自动装依赖。去 https://brew.sh 装完再重跑本脚本。" "Without Homebrew this script cannot install dependencies. Install it from https://brew.sh, then re-run.")"
    fi
  fi
  ok "Homebrew: $(command -v brew)"
else
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "$(L "Linux 自动安装目前只支持 Debian/Ubuntu 系（需要 apt-get）" "Automatic install on Linux currently supports Debian/Ubuntu only (needs apt-get)")"
    die "$(L "在非 Debian 系系统上，请手动安装 git / tmux / node / bun / claude 后重跑本脚本。" "On non-Debian systems, install git / tmux / node / bun / claude manually, then re-run this script.")"
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
    ok "$label — $(L "已安装" "already installed")"
    return 0
  fi

  say "$(L "安装" "Installing") $label"
  # 临时关掉 set -e，不让安装失败杀死整个脚本
  set +e
  "$installer"
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    warn "$(L "$label 安装命令返回了错误码 $rc" "install command for $label exited with code $rc")"
  fi

  # 刷新 shell 命令缓存，否则刚装的二进制可能找不到
  hash -r 2>/dev/null || true

  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$label $(L "安装成功" "installed")"
  else
    fail "$(L "$label 安装后仍然找不到 '$cmd'，可能需要新开一个终端让 PATH 生效" "'$cmd' still not found after installing $label — you may need a fresh shell for PATH to take effect")"
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

# node（claude CLI 与 web 客户端的前置）
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
check_missing node  "node ($(L "npm 的前置" "required by npm"))"
check_missing bun   "bun"
check_missing claude "claude (Claude Code CLI)"

if [ ${#missing[@]} -gt 0 ]; then
  printf "\n${BOLD}$(L "需要安装的依赖：" "Dependencies to install:")${RESET}\n"
  for m in "${missing[@]}"; do
    printf "  ${DIM}•${RESET} %s\n" "$m"
  done
  printf "\n"
  if ! confirm "$(L "开始安装？" "Start installing?")" y; then
    die "$(L "已取消。" "Cancelled.")"
  fi
  printf "\n"
fi

install_pkg "git"    git    _install_git
install_pkg "tmux"   tmux   _install_tmux
install_pkg "node"   node   _install_node
install_pkg "bun"    bun    install_bun
install_pkg "claude" claude _install_claude

printf "\n"

if [ "$install_failed" = "1" ]; then
  fail "$(L "部分依赖没装上。请检查上面的错误，装完后重跑本脚本" "Some dependencies failed to install. Check the errors above, then re-run this script.")"
  exit 1
fi

ok "$(L "所有依赖就绪" "All dependencies ready") ✨"

# ────────────────────────────────────────────
# 克隆代码
# ────────────────────────────────────────────

printf "\n"
EXISTING_CHECKOUT=0
if [ -d "$CLAUDESTRA_DIR/.git" ]; then
  EXISTING_CHECKOUT=1
  say "$(L "检测到已有仓库" "Existing checkout found"): $CLAUDESTRA_DIR"
  (cd "$CLAUDESTRA_DIR" && git fetch --tags --quiet origin 2>/dev/null) || true
else
  if [ -e "$CLAUDESTRA_DIR" ]; then
    die "$(L "$CLAUDESTRA_DIR 已存在但不是 git 仓库，请先移走或清空" "$CLAUDESTRA_DIR exists but is not a git repo — move or empty it first")"
  fi
  say "$(L "克隆" "Cloning") $CLAUDESTRA_REPO → $CLAUDESTRA_DIR"
  mkdir -p "$(dirname "$CLAUDESTRA_DIR")"
  git clone "$CLAUDESTRA_REPO" "$CLAUDESTRA_DIR"
  ok "$(L "代码已克隆" "Repository cloned")"
fi

cd "$CLAUDESTRA_DIR"

if [ "$CLAUDESTRA_REF_EXPLICIT" = "1" ]; then
  # 显式指定了 ref：装的就是它，不再切 release tag。
  # origin/<branch> 优先（分支要的是最新提交），失败再当成 tag / commit 试一次。
  if git checkout --quiet "origin/$CLAUDESTRA_BRANCH" 2>/dev/null \
     || CO_ERR=$(git checkout --quiet "$CLAUDESTRA_BRANCH" 2>&1); then
    ok "$(L "版本" "Version"): $CLAUDESTRA_BRANCH ($(git rev-parse --short HEAD))"
  else
    # 打出 git 的原话：可能是本地改动挡住了 checkout，而不是 ref 不存在
    printf "%s\n" "$CO_ERR" >&2
    git status --short >&2 || true
    die "$(L "切不到 ${CLAUDESTRA_BRANCH}（上面是 git 的原始报错）" "Could not check out ${CLAUDESTRA_BRANCH} (git's own error is above)")"
  fi
else
  # 默认：切到最新 release 版本（如果有的话）
  GITHUB_API_REPO=$(echo "$CLAUDESTRA_REPO" | sed -n 's|.*github\.com[:/]\(.*\)\.git$|\1|p')
  if [ -n "$GITHUB_API_REPO" ]; then
    LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${GITHUB_API_REPO}/releases/latest" 2>/dev/null | grep -o '"tag_name":"[^"]*"\|"tag_name": "[^"]*"' | head -1 | cut -d'"' -f4)
    # 只对已有检出生效：全新克隆的 HEAD 是默认分支，天然比 tag 新，照旧切 release
    if [ -n "$LATEST_TAG" ] && [ "$EXISTING_CHECKOUT" = "1" ] \
       && git merge-base --is-ancestor "$LATEST_TAG" HEAD 2>/dev/null \
       && [ "$(git rev-parse HEAD)" != "$(git rev-parse "$LATEST_TAG^{commit}" 2>/dev/null)" ]; then
      # 现在的检出已经比最新 release 新（以前用 CLAUDESTRA_BRANCH=main 装过）：不往回降级
      ok "$(L "版本" "Version"): $(git rev-parse --short HEAD) ($(L "已比 $LATEST_TAG 新，保持不动" "newer than $LATEST_TAG — left as is"))"
    elif [ -n "$LATEST_TAG" ]; then
      if ! CO_ERR=$(git checkout "$LATEST_TAG" --quiet 2>&1); then
        # 以前是 `|| true` 然后照样报「版本: $LATEST_TAG」——装的其实是别的版本
        printf "%s\n" "$CO_ERR" >&2
        git status --short >&2 || true
        die "$(L "切不到 $LATEST_TAG（上面是 git 的原始报错；常见原因是本地有改动）" "Could not check out $LATEST_TAG (git's own error is above; usually local changes)")"
      fi
      ok "$(L "版本" "Version"): $LATEST_TAG"
      hint_newer_main "$LATEST_TAG"
    else
      warn "$(L "没有找到 release 版本，使用默认分支最新代码" "No release tag found — using the default branch")"
    fi
  fi
fi

# 向导契约：本脚本下面承诺的是 Web 优先 + 自动收编的向导（SETUP_CONTRACT >= 2，见
# src/setup.ts）。最新 release 早于它的话，装出来的是旧向导（默认 Discord、没有 web
# 托管和收编），和这里的承诺对不上——问一句，默认改装 main。显式指定了 ref 的尊重用户选择。
# 取出数字按数值比（正则 [2-9] 到 10 就失配了）；取不到按 0 算
SETUP_CONTRACT_VER=$(sed -n 's/.*SETUP_CONTRACT = \([0-9][0-9]*\).*/\1/p' src/setup.ts 2>/dev/null | head -1 || true)
if [ "$CLAUDESTRA_REF_EXPLICIT" != "1" ] && [ "${SETUP_CONTRACT_VER:-0}" -lt 2 ]; then
  warn "$(L "这个版本的配置向导早于 Web 优先向导（没有 web 服务托管、没有会话收编）" "This version's setup wizard predates the Web-first wizard (no web service, no session adoption)")"
  if confirm "$(L "改装 main 分支的最新代码吗？" "Install the latest main branch instead?")" y; then
    if CO_ERR=$(git checkout --quiet origin/main 2>&1); then
      ok "$(L "版本" "Version"): main ($(git rev-parse --short HEAD))"
    else
      printf "%s\n" "$CO_ERR" >&2
      die "$(L "切不到 origin/main（上面是 git 的原始报错）" "Could not check out origin/main (git's own error is above)")"
    fi
  else
    warn "$(L "保持当前版本：下面的向导流程会和本脚本的描述不一致" "Keeping this version: the wizard below will not match what this script describes")"
  fi
fi

# ────────────────────────────────────────────
# 装项目依赖
# ────────────────────────────────────────────

printf "\n"
say "bun install"
bun install

# 浏览器版本必须与 playwright-core 对齐：executablePath() 按**本地 playwright-core 的**
# 期望 revision 拼路径，而 `playwright install` 不带版本号时装的是最新版 —— 装完
# existsSync 为 false，截图在每台新机器上都是坏的（本机只是碰巧留着旧 revision）。
say "playwright install chromium ${DIM}($(L "终端截图用" "for terminal screenshots"))${RESET}"
if ! bunx playwright@1.58.2 install chromium 2>/dev/null; then
  warn "$(L "bunx playwright 失败，尝试 npx" "bunx playwright failed — falling back to npx")"
  npx --yes playwright@1.58.2 install chromium || warn "$(L "Playwright 没装上，截图功能会不可用" "Playwright not installed — terminal screenshots will be unavailable")"
fi

ok "$(L "项目依赖安装完成" "Project dependencies installed")"

# ────────────────────────────────────────────
# 下一步
# ────────────────────────────────────────────

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  ✨ $(L "系统已就绪，现在跑配置向导" "Everything is ready — time for the setup wizard")${RESET}\n"
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

printf "%s\n" "$(L "配置向导默认只装 Web 端：写 .env、签 API token、构建前端、装成开机自启，跑完给你一个网址。" "The wizard installs the Web frontend by default: writes .env, issues an API token, builds the frontend, installs it for autostart, and prints you a URL.")"
printf "%s\n" "$(L "Discord 是可选项（要自己建 bot，多 5 个步骤）——向导里选上才会问。" "Discord is optional (you would create your own bot — 5 extra steps); the wizard only asks if you pick it.")"
printf "%s\n\n" "$(L "预计 5-15 分钟（大头是依赖下载与前端构建）。" "Budget 5-15 minutes — mostly downloads and the frontend build.")"

if [ "${CLAUDESTRA_NO_SETUP:-0}" = "1" ]; then
  printf "%s\n" "$(L "CLAUDESTRA_NO_SETUP=1 —— 依赖与代码已就绪，跳过配置向导。" "CLAUDESTRA_NO_SETUP=1 — dependencies and code are ready; skipping the wizard.")"
  printf "  ${CYAN}cd $CLAUDESTRA_DIR${RESET}\n"
  printf "  ${CYAN}bun run setup${RESET}\n\n"
elif confirm "$(L "现在跑" "Run") ${CYAN}bun run setup${RESET} $(L "吗？" "now?")" y; then
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
  printf "\n%s\n" "$(L "稍后手动跑：" "Run it later with:")"
  printf "  ${CYAN}cd $CLAUDESTRA_DIR${RESET}\n"
  printf "  ${CYAN}bun run setup${RESET}\n\n"
fi
