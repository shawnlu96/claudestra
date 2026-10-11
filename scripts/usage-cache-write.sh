#!/bin/bash
# 用量缓存落盘器(v2.20.2+,peer 建议 2026-08-27):读 stdin 的 Claude Code
# statusline JSON,原子落盘到状态目录的 usage-cache.json(默认 ~/.claude-orchestrator,
# CLAUDESTRA_STATE_DIR 覆盖),**零输出**。
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
import json, math, os, sys, time

try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

rl = d.get("rate_limits") or {}
five = (rl.get("five_hour") or {}).get("used_percentage")
week = (rl.get("seven_day") or {}).get("used_percentage")
five_reset = (rl.get("five_hour") or {}).get("resets_at")
week_reset = (rl.get("seven_day") or {}).get("resets_at")

# ── v2.21.1+ context_window 也落盘(peer 2026-08-30):context_window_size 是
# 各 agent **真实窗口**的权威来源(175K/240K/2M 因模型与 1M beta 而异),
# used_percentage 连百分比都算好了。bridge 的 auto save-compact 阈值与看板
# 百分比都靠它,不再拿硬编码 1M 猜。按 session_id 分键——statusline 是每个
# agent 各写各的,单键全局值会互相踩(usage 的多写者坑同款)。
cw = d.get("context_window") or {}
sid = d.get("session_id")
has_ctx = bool(sid) and isinstance(cw, dict) and isinstance(cw.get("context_window_size"), (int, float)) and cw.get("context_window_size") > 0

if five is None and week is None and not has_ctx:
    sys.exit(0)

# 状态目录跟 lib/paths.ts 同一口径:CLAUDESTRA_STATE_DIR 优先(沙箱 agent 的启动前缀带着它,
# statusline 子进程继承;不认它 = 沙箱里每刷新一次状态栏就写一次生产的用量缓存)
cache_dir = os.environ.get("CLAUDESTRA_STATE_DIR", "").strip() or os.path.expanduser("~/.claude-orchestrator")
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
#   7d 例外(peer 实报 2026-09-02:7d 卡在历史峰值 31%,活跃 agent 一致报 22%)
#     → 7d 允许**下降**,但只接受**带 five_hour 的写者**。依据:CC 只给活跃 session
#       five_hour,长期空闲的 session 整个不给(本机 16 个 pane 实测:只有 2 个活跃
#       agent 有 5h,其余全无)——有 5h = 新鲜快照凭证;没 5h 的写者报的 7d 更小,
#       仍按陈旧丢弃。peer 提的「按写入时间取胜」不行:陈旧 session 一重绘,写入
#       时间就是现在,照样把真值盖掉。
old = {}
try:
    with open(cache_path) as f:
        old = json.load(f) or {}
except Exception:
    old = {}

now_ms = int(time.time() * 1000)

def window_time(key):
    if key in old:
        return old[key]
    return old.get("scrapedAt")

def merge(new_pct, new_reset, old_pct, old_reset, old_at, allow_decrease=False):
    valid_pct = isinstance(new_pct, (int, float)) and not isinstance(new_pct, bool) and math.isfinite(new_pct) and new_pct >= 0
    # Clock rollback must not relabel an existing observation as a new one.
    if not valid_pct or (isinstance(old_at, (int, float)) and old_at > now_ms):
        return old_pct, old_reset, False
    if old_pct is None or old_reset is None or new_reset != old_reset or new_pct >= old_pct or allow_decrease:
        return new_pct, new_reset, True
    return old_pct, old_reset, False

sess_at = window_time("sessionObservedAt")
week_at = window_time("weekObservedAt")
sess_pct, sess_reset, sess_updated = merge(five, five_reset, old.get("sessionPct"), old.get("sessionResets"), sess_at)
# Preserve the existing same-window week decrease rule: only a writer with five_hour can decrease it.
week_pct, week_reset_out, week_updated = merge(week, week_reset, old.get("weekPct"), old.get("weekResets"), week_at,
                                              allow_decrease=(five is not None))
sess_at = now_ms if sess_updated else sess_at
week_at = now_ms if week_updated else week_at
def qualification(key, updated):
    if updated:
        return "observed"
    return old.get(key.replace("ObservedAt", "ObservationQualification"),
                   "observed" if key in old else "legacy_lower_bound")

# Keep the original lower bound for legacy readers; context renders never advance quota time.
times = [at for val, at in [(sess_pct, sess_at), (week_pct, week_at)]
         if val is not None and isinstance(at, (int, float)) and math.isfinite(at) and at > 0]
quota_at = min(times) if times else old.get("scrapedAt", 0)

# sessions 按 session_id 分键合并:只更新自己这条,别人的保留;7 天没更新的
# 条目清掉(session 已死/已轮转),上限 200 条防无限膨胀。
sessions = old.get("sessions") if isinstance(old.get("sessions"), dict) else {}
if has_ctx:
    sessions[sid] = {
        "window": int(cw["context_window_size"]),
        "usedPct": cw.get("used_percentage"),
        "inputTokens": cw.get("total_input_tokens"),
        "ts": now_ms,
    }
sessions = {k: v for k, v in sessions.items()
            if isinstance(v, dict) and now_ms - (v.get("ts") or 0) < 7 * 86400 * 1000}
if len(sessions) > 200:
    keep = sorted(sessions.items(), key=lambda kv: kv[1].get("ts") or 0, reverse=True)[:200]
    sessions = dict(keep)

payload = {
    "sessionPct": sess_pct,
    "weekPct": week_pct,
    "sessionResets": sess_reset,
    "weekResets": week_reset_out,
    "scrapedAt": quota_at,
    "sessionObservedAt": sess_at,
    "weekObservedAt": week_at,
    "sessionObservationQualification": qualification("sessionObservedAt", sess_updated),
    "weekObservationQualification": qualification("weekObservedAt", week_updated),
    "contextUpdatedAt": now_ms if has_ctx else old.get("contextUpdatedAt"),
    "source": "statusline",
    "sessions": sessions,
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
