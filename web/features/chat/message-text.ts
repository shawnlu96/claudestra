/**
 * message-list.tsx 渲染体里的纯逻辑（D8-9：原样搬出，单测见 tests/web-message-text.test.ts）。
 * 只放不碰 React / DOM 的东西：工具行图标与摘要清洗、引用回复拆分、「复制整条」的纯文本、
 * agent chip 名单的订阅键编码与解析。
 */
import type { ChatMessage } from "./type";
import { inlineButtonsToText } from "@/lib/chat/inline-buttons";

export const TOOL_ICONS: Record<string, string> = {
  Read: "📄",
  Write: "📝",
  Edit: "✏️",
  Bash: "💻",
  Grep: "🔍",
  Glob: "📂",
  Task: "🤖",
  Agent: "🤖",
  TodoWrite: "📋",
  Skill: "⚡",
  WebFetch: "🌐",
  WebSearch: "🌐",
};
export const toolIcon = (n: string) => TOOL_ICONS[n] || "🔧";

/** formatTool 的 Bash 摘要用 ||command|| 包裹命令，展示时去掉这对标记。 */
export function cleanSummary(s: string): string {
  return s.replace(/\|\|/g, " ").replace(/\s+/g, " ").trim();
}

/** 引用回复格式(左滑引用):「> 引用\n\n正文」→ 拆成引用条 + 正文。 */
export function splitQuoted(content: string): { quoted?: string; body: string } {
  const qm = content.match(/^> (.+?)\n\n([\s\S]*)$/);
  return { quoted: qm?.[1], body: qm ? qm[2] : content };
}

/**
 * 整条 assistant 消息的纯文本（「复制整条」用）：按段序取叙述 + reply，工具卡
 * 不进剪贴板（复制回复是为了转发文字，不是转发执行日志）。
 * 去重是必须的——旧快照里 reply 既可能在段里、又挂在 replyText 上（AssistantBody
 * 的两条渲染路径），不去重就会复制两遍。
 */
export function messagePlainText(m: ChatMessage): string {
  const parts: string[] = [];
  const push = (t?: string) => {
    // 行内按钮语法在剪贴板里退化成 [label] 文本(复制是为了转发文字)
    const v = t && inlineButtonsToText(t).trim();
    if (v && !parts.includes(v)) parts.push(v);
  };
  if (m.segments?.length) {
    for (const seg of m.segments) {
      if (seg.kind === "tools") continue;
      if (seg.kind === "text" && seg.progress) continue; // 进度句不算正文
      push(seg.text);
    }
  } else {
    push(m.content);
  }
  push(m.replyText);
  return parts.join("\n\n");
}

/**
 * agent chip 名单的订阅键（D8-4）：AssistantBody 只需要 agents 的 name / displayName /
 * pinnedMaster，订阅整个数组的话每 15 秒列表轮询都会让窗口里每条助手气泡重渲染。
 * 压成字符串订阅：内容不变 = 同一个串，Object.is 相等不重渲染。按数组引用缓存，一次轮询只拼一次。
 */
const agentLabelKeyCache = new WeakMap<object, string>();
export const KEY_FIELD = "\u0001";
export const KEY_ROW = "\u0002";
export function agentLabelKey(agents: { name: string; displayName?: string; pinnedMaster?: boolean }[]): string {
  let k = agentLabelKeyCache.get(agents);
  if (k === undefined) {
    k = agents.map((a) => [a.name, a.displayName ?? "", a.pinnedMaster ? "1" : ""].join(KEY_FIELD)).join(KEY_ROW);
    agentLabelKeyCache.set(agents, k);
  }
  return k;
}

/**
 * 从订阅键还原 chip 可跳转名单：labels = 所有可点的名字（name / displayName / master 别名），
 * resolve(label) → 前端 agent 名（master 别名映射到 pinnedMaster 那一个，即 __master__）。
 */
export function agentChipIndex(agentKey: string): { labels: string[]; resolve: (label: string) => string | null } {
  const agents = agentKey
    ? agentKey.split(KEY_ROW).map((row) => {
        const [name, displayName, pinned] = row.split(KEY_FIELD);
        return { name, displayName: displayName || undefined, pinnedMaster: pinned === "1" };
      })
    : [];
  const labels: string[] = [];
  const resolve = (label: string) => {
    for (const a of agents) {
      if (a.name === label || a.displayName === label) return a.name;
      if (a.pinnedMaster && label === "master") return a.name;
    }
    return null;
  };
  for (const a of agents) {
    labels.push(a.name);
    if (a.displayName) labels.push(a.displayName);
    if (a.pinnedMaster) labels.push("master");
  }
  return { labels, resolve };
}
