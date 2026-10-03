/**
 * 打断抬头的开头措辞：生成（lib/turn-cuts.ts 的 preemptHeadline / stopHeadline / heldAcrossStopNote）和
 * 历史剥离（lib/inbound-body.ts）共用这一处。以前两边各写一份，09-30 改了抢占抬头的措辞、剥离没跟上，
 * 网页刷新后 owner 的消息带着抬头多出一条（i28-INT1）。
 */

/** 新消息自动抢占上一回合（preemptHeadline） */
export const PREEMPT_NOTE_LEAD = "⚡ 收到这条新消息，系统自动中断了上一回合";
/** 停字 / 停止按钮（stopHeadline） */
export const STOP_NOTE_LEAD = "⏹ 这是一条「停」指令";
/** 押在叫停之前、之后才送到（heldAcrossStopNote） */
export const HELD_NOTE_LEAD = "⏹ 这条是叫停之前";
/** 09-30 之前的抢占抬头：会话历史里还有这种旧记录 */
const LEGACY_PREEMPT_NOTE_LEAD = "⚡ 这条消息打断了你";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 正文开头是 bridge 写的打断抬头（只认措辞；是否真由 bridge 加，调用方另看 interrupt_note="true" 属性） */
export const INTERRUPT_NOTE_RE = new RegExp(
  `^\\s*\\[(?:${[PREEMPT_NOTE_LEAD, STOP_NOTE_LEAD, HELD_NOTE_LEAD, LEGACY_PREEMPT_NOTE_LEAD].map(escapeRe).join("|")})`,
);
