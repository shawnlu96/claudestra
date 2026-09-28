/**
 * 输入框 @ 补全的纯逻辑（tests/web-mention.test.ts）。@ 的语义是「委托当前 agent 去找它」，
 * 指令文案在 lib/chat/mention-directive.ts；这里只管候选从哪来、怎么排、怎么插、发送前怎么复核。
 * 第一期只允许一个目标：已经有生效的 @ 时不再弹候选（删掉那个标记才能换人）。
 */
import { isSafeMentionName, mentionLabel, type MentionTarget } from "@/lib/chat/mention-directive";
import type { PeerContact } from "./contact-types";

export interface MentionCandidate {
  target: MentionTarget;
  label: string;
  /** true 在线 / false 连不上 / null 不知道（单向 peer） */
  online: boolean | null;
  /** 缺省 = 不知道 */
  busy?: boolean;
}

export interface MentionQuery {
  /** @ 所在下标 */
  start: number;
  /** 查询词结束下标（= 光标） */
  end: number;
  q: string;
}

/** 光标前最近的 @ 词：@ 必须在开头或空白后（邮箱 a@b 不弹），@ 到光标之间没有空白 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@(\S{0,80})$/u.exec(before);
  if (!m) return null;
  const start = m.index + m[1].length;
  return { start, end: caret, q: m[2].toLowerCase() };
}

interface LocalAgentLike {
  name: string;
  status: string;
  busy?: boolean;
  pinnedMaster?: boolean;
}

/** 本机候选：不含 master、当前会话、已停止的，以及名字带奇怪字符的（进不了指令行） */
export function localCandidates(agents: LocalAgentLike[], active: string): MentionCandidate[] {
  return agents
    // "__master__" = lib/chat/agents.ts 的 MASTER_AGENT_NAME（那个模块牵着 api 客户端，测试里不引它）
    .filter((a) => !a.pinnedMaster && a.name !== "__master__" && a.name !== active && a.status === "active")
    .filter((a) => isSafeMentionName(a.name))
    .map((a) => {
      const target: MentionTarget = { kind: "local", agent: a.name };
      return { target, label: mentionLabel(target), online: true, busy: !!a.busy };
    });
}

/** 对方开放给我的 agent：列表本来就是对方按我们的 token 过滤过的（bridge 另挡了 master） */
export function peerCandidates(contacts: PeerContact[]): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  for (const c of contacts) {
    if (!isSafeMentionName(c.name)) continue;
    for (const a of c.agents) {
      if (!isSafeMentionName(a.name)) continue;
      const target: MentionTarget = { kind: "peer", agent: a.name, peer: c.name, ...(c.fp ? { fp: c.fp } : {}) };
      out.push({ target, label: mentionLabel(target), online: c.online, ...(typeof a.busy === "boolean" ? { busy: a.busy } : {}) });
    }
  }
  return out;
}

/** 前缀命中优先，其次子串；同级本机在前、在线在前，保持原序。最多 30 条 */
export function matchMentions(cands: MentionCandidate[], q: string): MentionCandidate[] {
  const rank = (c: MentionCandidate) => {
    const l = c.label.toLowerCase();
    const base = !q || l.startsWith(q) ? 0 : l.includes(q) ? 1 : 9;
    return base * 4 + (c.target.kind === "local" ? 0 : 2) + (c.online === true ? 0 : 1);
  };
  return cands
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r < 9 * 4)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, 30)
    .map((x) => x.c);
}

/** 把 @查询词 换成 @标记 + 空格，返回新文本与光标位置 */
export function applyMention(text: string, q: MentionQuery, c: MentionCandidate): { text: string; caret: number } {
  const ins = `@${c.label} `;
  const rest = text.slice(q.end).replace(/^ /, "");
  return { text: text.slice(0, q.start) + ins + rest, caret: q.start + ins.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 输入框里还留着这个标记（用户可能把它删了——删了就不再委托） */
export function mentionPresent(text: string, label: string): boolean {
  return new RegExp(`(^|\\s)@${escapeRe(label)}(?=\\s|$)`, "u").test(text);
}

export type MentionCheck = { ok: true; target: MentionTarget } | { ok: false; reason: "gone" | "stopped" };

/**
 * 发送前复核：peer 按指纹认人（改名了就换成现在的名字；换成同名的另一台就不认），
 * 目标仍须在对方开放的列表里；本机 agent 须还在跑。真正的权限在对方收到时实时鉴权，这里只防明显的误投。
 */
export function recheckMention(t: MentionTarget, contacts: PeerContact[], agents: LocalAgentLike[]): MentionCheck {
  if (t.kind === "local") {
    const a = agents.find((x) => x.name === t.agent);
    if (!a) return { ok: false, reason: "gone" };
    return a.status === "active" ? { ok: true, target: t } : { ok: false, reason: "stopped" };
  }
  const c = t.fp ? contacts.find((x) => x.fp === t.fp) : contacts.find((x) => x.name === t.peer && !x.fp);
  if (!c || !isSafeMentionName(c.name) || !c.agents.some((a) => a.name === t.agent)) return { ok: false, reason: "gone" };
  return { ok: true, target: { ...t, peer: c.name } };
}
