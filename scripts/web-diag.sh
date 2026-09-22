#!/usr/bin/env bash
# Claudestra web 服务起不来的一次性取证（只读，不改任何东西）
R="${CLAUDESTRA_DIR:-$HOME/repos/claudestra}"
P="$HOME/Library/LaunchAgents/com.claudestra.web.plist"
echo "=== 1. 代码版本 ==="
git -C "$R" log -1 --format='%h %s' 2>&1
echo
echo "=== 2. launchd 状态（PID 是 - 就是没跑；第二列是退出码）==="
launchctl list | grep claudestra || echo "(没有 claudestra 的 job)"
echo
echo "=== 3. plist 在不在 / 是不是新版生成的 / 到底执行什么 ==="
if [ -f "$P" ]; then
  grep -q ClaudestraGenerated "$P" && echo "标记: 新版生成 ✓" || echo "标记: 无 —— 还是旧文件或手写的 ✗"
  echo "--- ProgramArguments ---"
  /usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$P" 2>/dev/null || sed -n '/ProgramArguments/,/<\/array>/p' "$P"
  echo "--- WorkingDirectory ---"
  /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$P" 2>/dev/null
else
  echo "plist 不存在 ✗"
fi
echo
echo "=== 4. 它要执行的东西真的在吗 ==="
command -v node && node -v || echo "PATH 里没有 node ✗"
ls -l "$R/web/node_modules/next/dist/bin/next" 2>&1 | head -1
ls -l "$R/web/node_modules/.bin/next" 2>&1 | head -1
echo
echo "=== 5. 四个前置条件 ==="
for f in "$R/web/package.json" "$R/web/.env.local" "$R/web/node_modules/.bin/next" "$R/web/.next/BUILD_ID"; do
  [ -e "$f" ] && echo "✓ $f" || echo "✗ $f  ← 缺这个"
done
echo
echo "=== 6. 错误日志（最关键）==="
tail -25 "$HOME/.claude-orchestrator/logs/web.err" 2>/dev/null || echo "(没有 web.err)"
echo "--- 旧版可能写在 /tmp ---"
tail -10 /tmp/claudestra-web.err 2>/dev/null || true
echo
echo "=== 7. 3333 端口上有谁 ==="
lsof -iTCP:3333 -sTCP:LISTEN -n -P 2>/dev/null || echo "(没有进程监听 3333)"
echo
echo "=== 8. 手动前台跑一次（看它到底报什么）==="
# ⚠ 3333 已经有人监听就跳过：那说明服务其实是好的，再起一个只会 EADDRINUSE，
#   还可能打扰正在用的实例。
if lsof -iTCP:3333 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "(3333 已有进程监听，跳过手动试跑 —— 服务是好的，打不开多半是地址/登录问题)"
elif [ ! -x "$R/web/node_modules/.bin/next" ]; then
  echo "(next 不在，跳过 —— 先解决上面第 5 节缺的东西)"
else
  ( cd "$R/web" && node ./node_modules/next/dist/bin/next start -p 3333 >/tmp/cs-probe.log 2>&1 & echo $! >/tmp/cs-probe.pid )
  sleep 8
  echo "--- 前台进程的输出 ---"; tail -15 /tmp/cs-probe.log 2>/dev/null
  echo "--- curl ---"; curl -sI http://127.0.0.1:3333 2>&1 | head -1
  kill "$(cat /tmp/cs-probe.pid 2>/dev/null)" 2>/dev/null
  rm -f /tmp/cs-probe.pid /tmp/cs-probe.log
fi
