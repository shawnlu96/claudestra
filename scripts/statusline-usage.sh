#!/bin/bash
# Claudestra statusline(v2.20.1+,peer 方案 2026-08-27):
# Claude Code 每次渲染状态栏都把 rate_limits JSON 喂进来——输出一行简洁状态栏
# (模型 · ctx余量 · 5h/7d 用量),并把用量交给 usage-cache-write.sh 落盘,
# 让 bridge 免于 /status TUI 抓取。
#
# 安装:~/.claude/settings.json 里
#   "statusLine": { "type": "command", "command": "<repo>/scripts/statusline-usage.sh" }
#
# 已有自己 statusline 的用户:setup/update 不改你的配置,只生成包装计划,本机 owner
# 批准后改成 `<本脚本> --wrap '<你的原命令>'`——原命令照样跑、输出与退出码原样透传,
# 本脚本只多做一步落盘(lib/statusline-usage-install.ts)。也可以自己在脚本末尾加一行:
#   printf '%s' "$input" | <repo>/scripts/usage-cache-write.sh
#
# 降级安全:输入缺 rate_limits(旧版 CC)→ 不落盘;python3 不在 → 状态栏空行,
# 会话不受影响。

input=$(cat)

if [ "$1" = "--wrap" ]; then
  printf '%s' "$input" | /bin/sh -c "$2"
  rc=$?
  printf '%s' "$input" | "$(dirname "${BASH_SOURCE[0]}")/usage-cache-write.sh"
  exit $rc
fi

# 状态栏渲染(只管显示;落盘在下面统一走 usage-cache-write.sh,契约单点)
python3 - "$input" <<'PYEOF'
import json, sys

try:
    d = json.loads(sys.argv[1])
except Exception:
    print("")
    sys.exit(0)

model = (d.get("model") or {}).get("display_name") or ""
ctx = (d.get("context_window") or {}).get("remaining_percentage")
rl = d.get("rate_limits") or {}
five = (rl.get("five_hour") or {}).get("used_percentage")
week = (rl.get("seven_day") or {}).get("used_percentage")

parts = []
if model:
    parts.append(model)
if ctx is not None:
    parts.append(f"ctx {round(ctx)}%")
if five is not None:
    parts.append(f"5h {round(five)}%")
if week is not None:
    parts.append(f"7d {round(week)}%")
print(" · ".join(parts))
PYEOF

printf '%s' "$input" | "$(dirname "${BASH_SOURCE[0]}")/usage-cache-write.sh"
