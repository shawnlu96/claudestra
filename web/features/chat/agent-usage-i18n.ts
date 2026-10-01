/** Local token-ledger vocabulary; no global short-word translations. */
export const AGENT_USAGE_WORDS: Record<string, string> = {
  "token 账": "Token usage", "今天": "Today", "近 7 天": "Last 7 days", "合计": "Total",
  "输入": "Input", "cache 读": "Cache read", "cache 写": "Cache write", "输出": "Output", "推理": "Reasoning", "调用数": "Calls",
  "看到的上下文": "Context seen", "新产出": "New output", "最近轮次": "Recent turns", "加载更多": "Load more",
  "请求": "requested", "第 {n} 轮": "Round {n}", "步骤不明": "Unknown step", "轮次不明": "Unknown round",
  "暂时没有 token 记录。": "No token records yet.", "尚未建立 token 账。": "The token ledger is not available yet.",
  "轮次明细已超过 30 天保留期。": "Turn details have passed the 30-day retention period.",
  "加载中": "Loading", "重试": "Retry", "打开卡片": "Open card",
  "人工输入": "Human", "频道消息": "Channel", "Peer 消息": "Peer", "后台通知": "Notification", "定时唤醒": "Scheduled",
  "命令": "Command", "子 agent": "Subagent", "续接会话": "Continued", "其他来源": "Other",
  "协调开销": "Coordination", "多卡窗口重叠": "Overlapping tasks", "不在步骤窗口": "Outside step window",
  "未纳入台账": "Not in ledger", "会话主人未知": "Unknown agent", "执行者不明": "Unknown executor", "待归属": "Pending attribution",
  "复述": "Restate", "写": "Write", "初审": "Review", "终审": "Final review", "修": "Fix", "合并": "Merge", "验证": "Verify",
  "看界面": "UI check", "核对": "Verify", "合并部署": "Merge & deploy",
};
export const SOURCE_LABELS: Record<string, string> = {
  human: "人工输入", channel: "频道消息", peer: "Peer 消息", notification: "后台通知", scheduled: "定时唤醒",
  command: "命令", subagent: "子 agent", continued: "续接会话", other: "其他来源",
};
export const BASIS_LABELS: Record<string, string> = {
  coordination: "协调开销", overlap: "多卡窗口重叠", outside_window: "不在步骤窗口", not_in_ledger: "未纳入台账",
  unowned: "会话主人未知", executor_lost: "执行者不明", pending: "待归属",
};
export const STEP_LABELS: Record<string, string> = {
  restate: "复述", write: "写", review: "初审", final_review: "终审", fix: "修", merge: "合并", verify: "验证", ui_check: "看界面",
};
