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
# 契约:sessionResets/weekResets 透传 CC 的 resets_at(Unix 秒),scrapedAt 毫秒。\n# 写入是**字段级合并 + 窗口单调**(不是整体覆盖):详见脚本内注释——多写者\n# (N 个 agent 各自渲染)时,null/陈旧快照不得抹掉别人写的新值。
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
five_reset = (rl.get("five_hour") or {}).get("resets_at")
week_reset = (rl.get("seven_day") or {}).get("resets_at")
if five is None and week is None:
    sys.exit(0)

cache_dir = os.path.expanduser("~/.claude-orchestrator")
if not os.path.isdir(cache_dir):
    sys.exit(0)
cache_path = os.path.join(cache_dir, "usage-cache.json")

# ── 字段级合并 + 窗口单调性(peer 实报 2026-08-27:多写者竞争) ──────────
# statusline 时代写者有 N 个(每个 agent 各一份),各自视角、各自新鲜度:
# 长期空闲的 session 其 CC 可能整个不给 five_hour(→ null),或给的是几小时前
# 的旧快照(7d 悄悄倒退)。「谁最后渲染就听谁的」= 整机看板被最弱的写者抹掉。
# 规则(session/week 两窗口各自独立判):
#   新值 None            → 保留旧字段(别拿 null 覆盖数字)
#   旧值/旧 reset 缺失    → 直接写新
#   reset 变了(窗口轮转) → 无条件写新(该清零/换周期了)
#   同窗口               → 新 pct ≥ 旧 pct 才写(窗口内用量单调递增,更小 = 陈旧快照,丢弃)
old = {}
try:
    with open(cache_path) as f:
        old = json.load(f) or {}
except Exception:
    old = {}

def merge(new_pct, new_reset, old_pct, old_reset):
    if new_pct is None:
        return old_pct, old_reset
    if old_pct is None or old_reset is None:
        return new_pct, new_reset
    if new_reset != old_reset:
        return new_pct, new_reset
    if new_pct >= old_pct:
        return new_pct, new_reset
    return old_pct, old_reset

sess_pct, sess_reset = merge(five, five_reset, old.get("sessionPct"), old.get("sessionResets"))
week_pct, week_reset_out = merge(week, week_reset, old.get("weekPct"), old.get("weekResets"))

payload = {
    "sessionPct": sess_pct,
    "weekPct": week_pct,
    "sessionResets": sess_reset,
    "weekResets": week_reset_out,
    "scrapedAt": int(time.time() * 1000),
    "source": "statusline",
}
tmp = os.path.join(cache_dir, f"usage-cache.json.{os.getpid()}.tmp")
try:
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, cache_path)
except Exception:
    try:
        os.unlink(tmp)
    except Exception:
        pass
PYEOF
