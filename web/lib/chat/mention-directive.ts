/**
 * 输入框 @ 的委托指令（tests/web-mention.test.ts）：@ 不是把对方拉进当前会话，而是「让当前 agent 去找它」。
 * 发送时 wire 末尾追加一行指令，用户气泡只显示原文；历史还原与他端回显用 stripMentionDirective 剥掉这行——
 * 但只剥 owner 本人的消息（调用方判来源），且只剥能按 zh / en 逐字重建出来的规范行：外源消息的末行就是 agent
 * 看到的末行，宽松剥离等于让外源在 owner 眼前藏一段 agent 看得见的话。bridge 另把外源正文里的 [📨 中和掉。
 * 名字须过 isSafeMentionName（mention-name.ts）：对方 agent 名是不可信文本，会原样进指令行。
 */
import { isSafeMentionName } from "./mention-name";

export interface MentionTarget {
  kind: "local" | "peer";
  /** 本机：前端会话名（不带 agent- 前缀）；peer：对方 /agents 返回的原名 */
  agent: string;
  /** peer 在本机 peers.json 里的名字（send_to_agent 的 <agent>@<peer> 用它） */
  peer?: string;
  /** peer 实例指纹：发送前核对，peer 改名 / 换了同名的另一台时不会误投 */
  fp?: string;
}

/** 输入框里的标记（@ 后面那段）：本机 = 会话名，peer = 去掉 agent- 前缀的名字 @ peer 名 */
export function mentionLabel(t: MentionTarget): string {
  return t.kind === "peer" ? `${t.agent.replace(/^agent-/, "")}@${t.peer}` : t.agent;
}

/** send_to_agent 的 target：本机名（bridge 自动补 agent- 前缀）或 <agent>@<peer> 短格式（peer 名可能带点，不用 peer:X.Y） */
export function mentionAddress(t: MentionTarget): string {
  return t.kind === "peer" ? `${t.agent}@${t.peer}` : t.agent;
}

const MARK_ZH = "[📨 委托转达]";
const MARK_EN = "[📨 Delegate]";

/** 指令行本身（单行，剥离时按行尾整行认）。文案按界面语言走，agent 两种都读得懂 */
export function mentionDirective(t: MentionTarget, lang: "zh" | "en"): string {
  const label = mentionLabel(t);
  const addr = mentionAddress(t);
  if (lang === "en") {
    const who = t.kind === "peer" ? `an agent that peer "${t.peer}" shares with us` : "another agent on this machine";
    return `${MARK_EN} The user @-mentioned ${label} (${who}). Use send_to_agent(target="${addr}") to relay the question in the message above to it. `
      + "Relay only this one question, and do not attach any other context or files. Then wait for its reply to be pushed back and bring it to the user with reply. "
      + "If it can't be sent or the other side times out, tell the user directly.";
  }
  const who = t.kind === "peer" ? `peer「${t.peer}」开放给我们的 agent` : "本机的另一个 agent";
  return `${MARK_ZH} 用户 @ 了 ${label}（${who}）。请用 send_to_agent(target="${addr}") 把上面这条消息的问题转述给它，只转这一次的问题，`
    + "不要附带其它上下文或文件；然后等它的回复推回来，再用 reply 把回复带回给用户。发不出去或者对方超时，就直接告诉用户。";
}

export function withMentionDirective(text: string, t: MentionTarget, lang: "zh" | "en"): string {
  return `${text}\n\n${mentionDirective(t, lang)}`;
}

/** send_to_agent 的 target → 目标（名字不合规就不认）。与 mentionAddress 互逆 */
function targetOfAddress(addr: string): MentionTarget | null {
  const parts = addr.split("@");
  if (!parts.every(isSafeMentionName) || parts.length > 2) return null;
  return parts.length === 2 ? { kind: "peer", agent: parts[0], peer: parts[1] } : { kind: "local", agent: parts[0] };
}

/**
 * 去掉末尾的委托指令行：末段（最后一个空行之后）必须逐字等于 mentionDirective 按某种语言重建的结果，
 * 否则原样返回——用户自己写的、外源伪造的、带多余字的都不剥。只对 owner 本人的消息调用。
 */
export function stripMentionDirective(text: string): string {
  const i = text.lastIndexOf("\n\n");
  const tail = i < 0 ? "" : text.slice(i + 2).trimEnd(); // 历史记录尾部可能多个换行
  if (!tail.startsWith("[📨 ")) return text;
  const addr = /target="([^"\n]+)"/.exec(tail)?.[1];
  const t = addr ? targetOfAddress(addr) : null;
  if (!t || (tail !== mentionDirective(t, "zh") && tail !== mentionDirective(t, "en"))) return text;
  return text.slice(0, i);
}
