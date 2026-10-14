/**
 * 会话页记录 → 只读查看器的消息（team-project-TEAMVIS8）。纯函数，单测 tests/web-collab-team-session.test.ts。
 * 主场写的记录正文（src/lib/team-body-session.ts recordOf）：首行「[用户 | 助手 | 系统]」，随后是消息文字，
 * 有工具调用时再接一行「[工具]」和每行一条的「工具名: 摘要」；sourceKey = 「会话 id:消息序号」。
 * 遮蔽：主场把命中的整段换成占位符，这里只数占位符个数（契约没有「已截断」位，不按长度猜截断）。
 * 顺序：一个会话内按消息序号从旧到新；会话之间按主场给页的先后（作者在前，读完一个会话再接下一个）。
 */
import type { TeamBodyRecordWire } from "@/lib/api/shared-ledger-team-body";

export type SessionRole = "user" | "assistant" | "system";
/** name 为空 = 这一行认不出工具名（整段被遮蔽、或摘要折了行） */
export interface SessionTool { name: string; summary: string; masked: number }
export interface SessionMessage {
  key: string; sessionId: string; seq: number; role: SessionRole;
  text: string; masked: number; tools: SessionTool[];
}
export interface SessionGroup { sessionId: string; messages: SessionMessage[] }

const ROLES: Record<string, SessionRole> = { "用户": "user", "助手": "assistant", "系统": "system" };
const TOOLS_MARK = "\n[工具]\n";
/** 主场的占位符是半角冒号（team-body-scrub.ts TEAM_BODY_MASK）；全角写法一并认 */
const MASK = /\[已遮蔽[:：]疑似密钥\]/g;
const TOOL_LINE = /^([A-Za-z_][\w.-]{0,127}): ?(.*)$/;

export const maskCount = (text: string): number => text.match(MASK)?.length ?? 0;

function toolsOf(block: string): SessionTool[] {
  const out: SessionTool[] = [];
  for (const line of block.split("\n")) {
    const m = TOOL_LINE.exec(line);
    if (m) out.push({ name: m[1]!, summary: m[2]!, masked: 0 });
    else if (out.length) out[out.length - 1]!.summary += `\n${line}`;
    else if (line.trim()) out.push({ name: "", summary: line, masked: 0 });
  }
  for (const t of out) t.masked = maskCount(t.summary);
  return out;
}

/** sourceKey 末段是消息序号（可带两位小数），前面是会话 id；不是这个形状的按整串当会话、序号 0 */
function keyOf(sourceKey: string): { sessionId: string; seq: number } {
  const at = sourceKey.lastIndexOf(":");
  const seq = at > 0 ? Number(sourceKey.slice(at + 1)) : NaN;
  return Number.isFinite(seq) ? { sessionId: sourceKey.slice(0, at), seq } : { sessionId: sourceKey, seq: 0 };
}

export function parseSessionRecord(r: Pick<TeamBodyRecordWire, "sourceKey" | "text">): SessionMessage {
  const head = /^\[([^\]\n]{1,8})\](?:\n|$)/.exec(r.text);
  const role = head ? ROLES[head[1]!] : undefined;
  // 首行不是认得的角色：整段当系统消息原样显示，不丢内容
  const body = head && role ? `\n${r.text.slice(head[0].length)}` : `\n${r.text}`;
  const cut = body.lastIndexOf(TOOLS_MARK);
  const text = (cut >= 0 ? body.slice(0, cut) : body).replace(/^\n/, "");
  const tools = cut >= 0 ? toolsOf(body.slice(cut + TOOLS_MARK.length)) : [];
  return { key: r.sourceKey, ...keyOf(r.sourceKey), role: role ?? "system", text, masked: maskCount(text), tools };
}

/** 同一条（sourceKey 相同）只留后到的那份 */
export function sessionGroups(records: readonly Pick<TeamBodyRecordWire, "sourceKey" | "text">[]): SessionGroup[] {
  const groups = new Map<string, Map<string, SessionMessage>>();
  for (const r of records) {
    const m = parseSessionRecord(r);
    let g = groups.get(m.sessionId);
    if (!g) groups.set(m.sessionId, (g = new Map()));
    g.set(m.key, m);
  }
  return [...groups].map(([sessionId, g]) => ({ sessionId, messages: [...g.values()].sort((a, b) => a.seq - b.seq) }));
}

export const messageCount = (groups: readonly SessionGroup[]): number => groups.reduce((n, g) => n + g.messages.length, 0);
