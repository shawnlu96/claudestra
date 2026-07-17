/**
 * i18n 字典：中文原文 → 英文。缺失回退中文（见 lib/i18n.tsx）。
 *
 * 维护规则：
 * - key 必须与源码里的原文**逐字一致**（含全角/半角标点、前后空格——拆段
 *   拼接的条目靠空格对齐语序，行尾注释标注了这类条目）。
 * - 句中片段（如「重置」「已重启」）英文故意小写、无句号。
 * - 品牌名（Claudestra）、模型名、工具名（Read/Edit/Bash）、agent 名不进字典。
 */
export const DICT: Record<string, string> = {
  // ── 通用 ─────────────────────────────────────────────
  "关闭": "Close",
  "保存": "Save",
  "取消": "Cancel",
  "删除": "Delete",
  "完成": "Done",
  "管理": "Manage",
  "重启": "Restart",
  "停止": "Stop",
  "清空": "Clear",
  "清除": "Clear",
  "重试": "Retry",
  "返回": "Back",
  "移除": "Remove",
  "提交": "Submit",
  "搜索": "Search",
  "开启": "Enable",
  "安装": "Install",
  "创建": "Create",
  "回复": "Reply",
  "文件": "File",
  "终端": "Terminal",
  "模型": "Model",
  "任务": "Tasks",
  "刚刚": "just now",
  "重置": "resets",
  "加载中…": "Loading…",
  "暂无数据": "No data yet",
  "未设置": "Not set",
  "未登录": "Not signed in",
  "已保存": "Saved",
  "已清除": "Cleared",
  "保存失败": "Save failed",
  "保存中…": "Saving…",
  "读取失败": "Failed to load",
  "操作失败": "Operation failed",
  "创建失败": "Create failed",
  "登录失败": "Login failed",
  "已配置": "Configured",

  // ── 设置弹窗 ─────────────────────────────────────────
  "设置": "Settings",
  "个人资料": "Profile",
  "头像和昵称显示在对话里（只影响本界面展示,不进对话数据）。":
    "Avatar and nickname are shown in this UI only — never sent into the conversation.",
  "我": "Me",
  "你的昵称": "Your nickname",
  "Claude 的名称": "Claude's name",
  "保存资料": "Save profile",
  "图片读取失败": "Failed to read image",
  "选择头像(再点一次图可移除)": "Choose avatar (tap again to remove)",
  "选图": "Pick",
  "Claude 全局默认": "Claude global defaults",
  "影响所有未单独钉模型/effort 的新会话（含终端里直接开的 claude）。已钉的 agent 不受影响。":
    "Applies to new sessions without a pinned model/effort (including claude started in a terminal). Pinned agents are unaffected.",
  "推送通知": "Push notifications",
  "Web 端发起的对话有回复时,推送到本设备(页面开着时不打扰)。Discord 发起的照旧走 Discord @。":
    "Get notified on this device when a web conversation gets a reply (quiet while the page is open). Discord conversations still ping via Discord.",
  "语音识别 · Groq API Key": "Speech-to-text · Groq API Key",
  "当前:": "Current: ", // 值尾带空格(EN 拼接不粘连)
  "（输入新值覆盖）": " (enter a new key to replace)", // 值首带空格
  "未配置。console.groq.com 免费注册,API Keys 页生成。":
    "Not configured. Sign up free at console.groq.com and create a key on the API Keys page.",
  "已保存,语音输入即时生效": "Saved — voice input works immediately",
  // BFF route 下发的固定错误/引导串(渲染点 t() 兜底,2026-07-18 review 补齐)
  "语音识别未配置——点侧栏 ⚙️ 设置里填入 Groq API Key": "Speech-to-text not configured — add a Groq API Key in Settings (⚙️ in the sidebar)",
  "音频过大（>20MB）": "Audio too large (>20MB)",
  "需要 model 或 effort": "model or effort required",
  "写入失败": "Write failed",
  "groqApiKey 必须是字符串（空串=清除）": "groqApiKey must be a string (empty = clear)",
  "key 格式不像有效的 API key": "That doesn't look like a valid API key",
  "agent/action 非法": "Invalid agent/action",
  "agent 和 action 不能为空": "agent and action are required",
  "agent 和内容不能为空": "agent and message are required",

  // ── 侧栏 / 会话列表 ──────────────────────────────────
  "会话": "Sessions",
  "总控": "Master",
  "大总管": "Master",
  "工作中": "Working",
  "暂无会话": "No sessions",
  "取消置顶": "Unpin",
  "置顶": "Pin",
  "删除失败:": "Delete failed: ", // 值尾带空格
  "确认?": "Confirm?",
  "部分删除失败:": "Some deletions failed: ", // 值尾带空格
  "退出多选": "Exit multi-select",
  "多选管理（批量删除）": "Multi-select (batch delete)",
  "多选管理": "Multi-select",
  "用量看板": "Usage dashboard",
  "搜索会话 / 聊天记录…": "Search sessions / chats…",
  "清除搜索": "Clear search",
  "正在搜聊天记录…": "Searching chats…",
  "搜聊天记录「": 'Search chats for "',
  "」": '"',
  "聊天记录": "Chats",
  "无命中": "No hits",
  "关闭搜索结果": "Close search results",
  "对话正文里没有「": 'No matches in conversations for "',
  "总控调度 · 新建会话找它": "Master orchestrator · ask it to create sessions",
  "没有匹配「": 'No sessions matching "',
  "」的会话": '"',
  " · 归档保留": " · archives kept", // key/值均带前导空格
  "确认删除 ": "Confirm delete ", // key/值尾带空格
  " 个?": "?", // key 带前导空格

  // ── 输入区（composer）────────────────────────────────
  "按住说话，松开结束": "Hold to talk, release to finish",
  "没听清，再试一次": "Didn't catch that, try again",
  "识别失败": "Transcription failed",
  "识别请求失败": "Transcription request failed",
  "无法访问麦克风（权限被拒,或当前模式不支持录音）":
    "Can't access the microphone (permission denied, or recording unsupported in this mode)",
  "上下文已": "Context at",
  "，建议压缩以保持质量": ", compacting recommended to keep quality", // 值首带逗号+空格
  "请求压缩": "Compact",
  "本会话不再提示": "Don't remind again this session",
  "正在回复…": "Replying…",
  "发送即插入当前会话，将在当前步骤后生效": "Sending now inserts into this turn, applied after the current step",
  "正在录音": "Recording",
  "松开结束": "release to finish",
  "识别中…": "Transcribing…",
  "先选择一个会话…": "Select a session first…",
  "继续输入，随时插话…": "Keep typing to chime in anytime…",
  "（Enter 发送）": " (Enter to send)", // 值带前导空格
  "发消息给": "Message",
  "添加附件（也可直接粘贴）": "Add attachment (or just paste)",
  "添加附件": "Add attachment",
  "Skills（斜杠命令面板）": "Skills (slash command panel)",
  "打开 Skills 面板": "Open Skills panel",
  "按住说话": "Hold to talk",
  "暂停（停止当前回复，Ctrl+C）": "Pause (stop current reply, Ctrl+C)",
  "暂停": "Pause",
  "插入当前会话（当前步骤后生效）": "Insert into this turn (applies after current step)",
  "发送": "Send",
  "取消引用": "Cancel quote",

  // ── 消息流（message-list / chat）─────────────────────
  "已打断": "Interrupted",
  "出错": "Error",
  "已被用户中断": "Interrupted by user",
  "📦 上下文已压缩": "📦 Context compacted",
  "上下文已压缩": "Context compacted", // history route 的 system 行 fallback(不带 📦)
  "📦 压缩摘要": "📦 Compact summary",
  "选择左侧一个会话开始": "Pick a session on the left to start",
  "消息经 Bridge 投递到对应 Claude Code 会话": "Messages are delivered via the Bridge to the matching Claude Code session",
  "加载历史消息…": "Loading history…",
  "历史加载失败": "Failed to load history",
  "加载更早的消息…": "Load earlier messages…",
  "返回会话列表": "Back to session list",
  "当前会话上下文占用(建议在对话里让 agent /compact)": "Context usage of this session (ask the agent to /compact)",
  "Agent 管理(生命周期操作,不经过 LLM)": "Agent management (lifecycle ops, no LLM)",
  " 失败": " failed", // key/值均带前导空格
  "更多操作": "More actions",

  // ── CC 任务面板 / 后台任务 ────────────────────────────
  "下一项:": "Next: ", // 值尾带空格
  "全部完成": "All done",
  "待": "waiting on",
  "后台命令": "Background command",
  "请求 agent 停止此任务": "Ask the agent to stop this task",
  "停止任务": "Stop task",
  "收起": "Dismiss",
  "收起任务卡": "Dismiss task card",
  "等待输出…": "Waiting for output…",
  "后台任务": "Background tasks",

  // ── 用量看板 ─────────────────────────────────────────
  "强制刷新账号用量": "Force refresh account usage",
  "强制重抓账号用量（最长约 20 秒）": "Force re-scrape account usage (takes up to ~20s)",
  "账号用量抓取中…约几秒后自动显示，也可点右上角刷新强制重抓":
    "Fetching account usage… it will show in a few seconds, or tap refresh (top right) to force a re-scrape",
  "本时段用量": "Current period usage",
  "本周用量": "Weekly usage",
  "今日全机用量": "Today (all agents)",
  "本周全机用量": "This week (all agents)",
  "成本为 API 牌价折算（订阅制实际不按此扣费）· 活跃 agent 合计":
    "Cost estimated at API list prices (subscriptions aren't billed this way) · active agents combined",
  "账号用量抓取于": "Account usage scraped",
  "⚠️ 数据偏旧": "⚠️ may be stale",
  "各会话上下文占用": "Context usage by session",

  // ── Agent 管理面板 / 新建 / 清空 ──────────────────────
  "Agent 管理": "Manage Agents",
  "＋ 新建": "＋ New",
  "已重启": "restarted",
  "已停止": "stopped",
  "确认重启?": "Confirm restart?",
  "确认停止?": "Confirm stop?",
  "新建会话": "New Session",
  "在指定目录起一个 Claude Code agent（经 Bridge）。": "Start a Claude Code agent in a given directory (via the Bridge).",
  "名称": "Name",
  "工作目录": "Working directory",
  "~/code/project 或 /abs/path": "~/code/project or /abs/path",
  "用途（可选）": "Purpose (optional)",
  "这个 agent 干什么": "What this agent is for",
  "默认（跟随全局）": "Default (follow global)",
  "只钉这个 agent（重启保持），不改全局默认——和终端里 /model、/effort 会写全局不同。":
    "Pins this agent only (kept across restarts) without touching the global default — unlike /model and /effort in the terminal, which write global settings.",
  "name 和 dir 必填": "Name and directory are required",
  "🧹 清空会话": "🧹 Clear Session",
  "远程执行 Claude Code 原生": "Remotely runs Claude Code's native",
  "：上下文清零、会话轮转（旧会话自动归档，历史仍可回看）。进行中的回合需先「停止」。":
    ": context wiped, session rotated (the old session is auto-archived, history stays browsable). Stop any running turn first.",
  "开机指令": "Startup message",
  "（clear 后自动作为第一条消息发送；留空则不发）": "(sent automatically as the first message after clear; leave empty to skip)",
  "大总管的人设由其 CLAUDE.md 自动重载，通常无需开机指令。":
    "The master orchestrator's persona reloads automatically from its CLAUDE.md, so a startup message is usually unnecessary.",
  "例如：读 xx 文件 / 加载项目上下文…": "e.g. read file xx / load project context…",
  "clear 失败": "Clear failed",
  "确认清空": "Confirm clear",

  // ── Skills / 会话内搜索 ──────────────────────────────
  "关闭 Skills": "Close Skills",
  "搜索 skill…": "Search skills…",
  "内建": "Built-in",
  "插件": "Plugin",
  "技能": "Skill",
  "项目": "Project",
  "搜索本会话聊天记录": "Search this session's chat history",
  "关闭搜索": "Close search",
  "搜本会话聊天记录…": "Search this session's history…",
  "输入关键词搜这个会话的全部历史记录": "Type keywords to search this session's full history",
  "（包括压缩前和更早轮换的会话）": "(including pre-compact and earlier rotated sessions)",

  // ── AUQ / 权限卡 ─────────────────────────────────────
  "agent 在等你选": "The agent is waiting for your choice",
  "可多选": "multi-select",
  "单选": "single-select",
  "取消 (Esc)": "Cancel (Esc)",
  "提交失败": "Submit failed",
  "取消失败": "Cancel failed",
  "会话已闲置，Claude Code 询问如何继续": "Session idle — Claude Code is asking how to proceed",
  "需要授权": "Permission needed",
  "应答失败": "Answer failed",

  // ── 推送 / 安装引导 / Splash ──────────────────────────
  "开启推送通知": "Enable push notifications",
  "Web 端发起的对话有回复时通知你(页面开着时不打扰)": "Get notified when web-initiated conversations get a reply (no alerts while the page is open)",
  "不再提示": "Don't show again",
  "安装到主屏幕": "Add to Home Screen",
  "点浏览器的分享按钮": "Tap the browser's Share button",
  "→ 选「添加到主屏幕」": '→ choose "Add to Home Screen"',
  "用浏览器菜单里的「安装应用」": 'Use "Install app" in the browser menu',
  "你的 Claude Code 指挥台": "Your Claude Code command center",
  "此环境不支持推送(iOS 需先「添加到主屏幕」并从主屏打开)": "Push not supported here (on iOS, add to Home Screen first and open from there)",
  "通知权限被拒绝——请在系统设置里允许后重试": "Notification permission denied — allow it in system settings and retry",
  "已开启:应该立刻弹了一条本地测试通知": "Enabled: a local test notification should appear right away",
  "本设备未订阅": "This device is not subscribed",
  "已关闭本设备推送": "Push disabled on this device",
  "推送已开启 ✅": "Push enabled ✅",
  "这条是本地测试——能看到它,说明通知展示没问题": "This is a local test — if you can see it, notification display works",

  // ── 登录页 ───────────────────────────────────────────
  "用户名或密码错误": "Incorrect username or password",
  "登录尝试过于频繁，请稍后再试": "Too many login attempts — try again later",
  "用户名和密码不能为空": "Username and password are required",
  "本机 SSH 账号登录": "Sign in with your local SSH account",
  "账号": "Username",
  "密码": "Password",
  "登录": "Sign in",

  // ── 终端 ─────────────────────────────────────────────
  "连接终端…": "Connecting to terminal…",
  "终端会话已结束": "Terminal session ended",
  "连接出错": "Connection error",
  "连接失败": "Connection failed",
  "连接中断": "Connection lost",
  "重新连接": "Reconnect",
  "跟随桌面端窗口尺寸": "follows desktop window size",
  "打开远程终端（实时镜像 + 可输入）": "Open remote terminal (live mirror, input enabled)",
  "打开远程终端": "Open remote terminal",
  "加载终端…": "Loading terminal…",
  "返回会话": "Back to session",
  "实时镜像 tmux 会话 · 关闭即断开（不影响运行）": "Live tmux mirror · closing disconnects (session keeps running)",
  "关闭终端": "Close terminal",
  "唤起键盘输入": "Show keyboard",
  "Shift+Tab（切换权限模式）": "Shift+Tab (cycle permission modes)",
  "上选（菜单/选项）": "Up (menus/options)",
  "下选（菜单/选项）": "Down (menus/options)",
  "PageUp（快速上翻一页）": "PageUp (page up quickly)",
  "PageDown（快速下翻一页）": "PageDown (page down quickly)",
  "End（跳到最新输出/底部）": "End (jump to latest output/bottom)",
  "Ctrl+C（中断）": "Ctrl+C (interrupt)",
  "Ctrl+O（Claude Code 转录视图，可滚动）": "Ctrl+O (Claude Code transcript view, scrollable)",

  // ── store 系统提示 ───────────────────────────────────
  "无活动会话": "No active session",
};
