#!/bin/bash
# 用量缓存落盘器(v2.20.2+,peer 建议 2026-08-27):读 stdin 的 Claude Code
# statusline JSON,原子落盘 ~/.claude-orchestrator/usage-cache.json,**零输出**。
#
# 这是字段契约的**唯一实现**——自带 statusline 的用户不要手抄落盘段(peer 手抄
# 漏掉 weekResets,看板静默缺半边,排查方向直接跑偏),在自己脚本末尾加一行即可,
# 与你的 statusline 用什么语言无关:
#
#   printf '%s' "$input" | /path/to/claudestra/scripts/usage-cache-write.sh
#
# 契约:sessionResets/weekResets 透传 CC 的 resets_at(Unix 秒),scrapedAt 毫秒。
# tmp 名带 pid——statusline 每次渲染都跑,多 agent 并发渲染时固定 tmp 名会互相
# 截断(peer 实测),原子写就白做了。
# 降级安全:输入坏/缺 rate_limits/目录不存在 → 静默退出,不写不残留。

# ⚠ 程序体走 heredoc 时 python 的 stdin 已被 heredoc 占用,管道进来的 JSON
# 必须先 capture 再经 argv 传入(直接 json.load(sys.stdin) 只会读到 EOF 静默退出)
input=$(cat)

python3 - "$input" <<'PYEOF'
import json, os, sys, time

try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

rl = d.get("rate_limits") or {}
five = (rl.get("five_hour") or {}).get("used_percentage")
week = (rl.get("seven_day") or {}).get("used_percentage")
if five is None and week is None:
    sys.exit(0)

cache_dir = os.path.expanduser("~/.claude-orchestrator")
if not os.path.isdir(cache_dir):
    sys.exit(0)

payload = {
    "sessionPct": five,
    "weekPct": week,
    "sessionResets": (rl.get("five_hour") or {}).get("resets_at"),
    "weekResets": (rl.get("seven_day") or {}).get("resets_at"),
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
