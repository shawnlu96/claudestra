/**
 * 侧栏「未纳管会话」与归档的 i18n 词条，由 i18n-dict.ts 的 DICT 一行合入。维护规则同 i18n-dict.ts 文件头。
 */
export const SESSIONS_DICT: Record<string, string> = {
  "未纳管会话": "Unmanaged sessions",
  "没有未纳管的会话": "No unmanaged sessions",
  "会话文件 2 分钟内还在写 —— 大概率正在运行（启发式）": "Session file written in the last 2 minutes — probably still running (heuristic)",
  "活跃": "Active",
  "子会话": "Sub-session",
  "自动审查": "Auto review",
  "已归档并从列表移除（内容留在归档目录，可找回）": "Archived and removed from the list (the content stays in the archive and can be restored)",
  "已受理，正在后台收编（约 10-40 秒），完成后会出现在 agent 列表里。":
    "Accepted — adopting in the background (about 10–40 s). It will show up in the agent list when done.",
  "这个会话还没有消息": "This session has no messages yet",
  "用户": "User",
  "助手": "Assistant",
  "系统": "System",
  "agent 名字": "Agent name",
  "收编": "Adopt",
  "收编为 agent": "Adopt as agent",
  "← 返回": "← Back",
  "这个会话没有纳管，现在收不到消息。收编后会建窗口、能对话、进 agent 列表。":
    "This session isn't managed, so it can't receive messages. Adopting it opens a window for it, lets you chat with it and adds it to the agent list.",
  "这种运行时的会话只读：历史能看能搜，但收编不了——Claudestra 还没法往这种会话里发消息。":
    "Sessions from this runtime are read-only: you can browse and search the history but can't adopt them — Claudestra can't send messages into them yet.",
  "刷新": "Refresh",
  "归档是空的": "The archive is empty",
  "恢复": "Restore",
  "{n} 个会话": "{n} session|{n} sessions",
  "归档失败:": "Archive failed: ", // 值尾带空格
  "沉寂": "Dormant",
  // 子会话收编确认（components/adopt-panel.tsx）
  "另一个会话": "another session",
  "确认收编子会话": "Confirm adopting a sub-session",
  "这是「{parent}」的自动审查线程，通常不需要单独收编——它会跟着主会话走。确定要把它单独收编成 agent 吗？":
    "This is an auto-review thread of “{parent}” and usually doesn't need adopting on its own — it follows the main session. Adopt it as a separate agent anyway?",
  "这是「{parent}」的子会话，通常不需要单独收编——它会跟着主会话走。确定要把它单独收编成 agent 吗？":
    "This is a sub-session of “{parent}” and usually doesn't need adopting on its own — it follows the main session. Adopt it as a separate agent anyway?",
  "仍然收编": "Adopt anyway",
};
