#!/bin/bash
# Claudestra statusline(v2.20.1+,peer 方案 2026-08-27):
# Claude Code 每次渲染状态栏都把 rate_limits JSON 喂进来——被动落盘用量缓存,
# 让 bridge 免于 /status TUI 抓取(那条路已经攒了 9 条不变量的补丁)。
# 同时输出一行简洁状态栏(模型 · ctx余量 · 5h/7d 用量)。
#
# 安装:~/.claude/settings.json 里
#   "statusLine": { "type": "command", "command": "<repo>/scripts/statusline-usage.sh" }
# 已有自己 statusline 的用户:在自己脚本末尾追加本文件的落盘段即可(见 README)。
#
# 降级安全:输入缺 rate_limits(旧版 CC)→ 不写缓存、不留 tmp;python3 不在 →
# 输出空行,CC 状态栏空但会话不受影响。

input=$(cat)

python3 - "$input" <<'PYEOF'
import json, os, sys, time

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
five_reset = (rl.get("five_hour") or {}).get("resets_at")
week_reset = (rl.get("seven_day") or {}).get("resets_at")

# 状态栏文本(有什么显什么,别渲染 null)
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

# 用量落盘(原子写;与 peer HedeMacBook-Pro-3 的缓存格式兼容,多带 weekResets)
if five is not None or week is not None:
    cache_dir = os.path.expanduser("~/.claude-orchestrator")
    if os.path.isdir(cache_dir):
        payload = {
            "sessionPct": five,
            "weekPct": week,
            "sessionResets": five_reset,
            "weekResets": week_reset,
            "scrapedAt": int(time.time() * 1000),
            "source": "statusline",
        }
        tmp = os.path.join(cache_dir, f"usage-cache.json.{os.getpid()}.tmp")
        try:
            with open(tmp, "w") as f:
                json.dump(payload, f)
            os.replace(tmp, os.path.join(cache_dir, "usage-cache.json"))
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
PYEOF
