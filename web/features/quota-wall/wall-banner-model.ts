/**
 * 额度闸（bridge GET /api/v1/quota/wall）的纯模型：闸开着 / 恢复中时，顶部额度卡里 Claude 那一行写什么（features/quota/quota-notice-model.ts 合并）。
 * 单测 tests/web-quota-notice-model.test.ts。文案是中文原文（词在 lib/owner-words QUOTA_WORDS），渲染点包 t() 翻译（lib/i18n-dict-quota.ts）。
 */
import { QUOTA_WORDS as Q } from "@/lib/owner-words";

export interface WallResponse {
  active?: boolean;
  queued?: number;
  /** 停在菜单 / 倒计时上的窗口押着的人发的消息 */
  queuedHuman?: number;
  /** 持有的重置次数（owner 自己在会话里 /limit-reset 用；bridge 不自动用） */
  credits?: number | null;
  wall?: {
    kind?: string;
    resetsAt?: number | null;
    resetsText?: string | null;
    agents?: string[];
    enteredAt?: number;
    recovering?: boolean;
    /** 只读用量探测不可用：只能等回显、到点或点「已恢复」 */
    probeDown?: boolean;
  } | null;
}

/** 带 {placeholder} 的中文原文与变量 */
export interface Phrase { text: string; vars: Record<string, string | number> }

export interface WallLine {
  /** out = 闸开着（用完）；recovering = 已恢复、正在补投 */
  level: "out" | "recovering";
  /** 这道闸的身份（enteredAt），关掉记录按它和重置时刻认 */
  id: string;
  resetsAt: number | null;
  title: Phrase;
  detail: Phrase[];
  /** 闸开着时给「已恢复」按钮（= quota-wall clear） */
  canClear: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 本地时区的「月/日 时:分」 */
export const localWhen = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function spanText(ms: number): Phrase {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return { text: "约 {m} 分钟后", vars: { m: min } };
  return { text: "约 {h} 小时后", vars: { h: Math.round(min / 60) } };
}

function outTitle(kind: string | undefined, resetsAt: number | null): Phrase {
  const family = "Claude";
  if (resetsAt === null) {
    return { text: kind === "weekly" ? Q.weekOutNoTime : kind === "session" ? Q.sessionOutNoTime : Q.anyOutNoTime, vars: { family } };
  }
  return { text: kind === "weekly" ? Q.weekOut : kind === "session" ? Q.sessionOut : Q.anyOut, vars: { family, when: localWhen(resetsAt) } };
}

/** 闸的回包 → Claude 那一行；没闸（也不在恢复）= null */
export function wallLine(r: WallResponse | null | undefined, now: number): WallLine | null {
  const w = r?.wall;
  if (!w) return null;
  const id = `wall:${w.enteredAt ?? ""}`;
  const resetsAt = typeof w.resetsAt === "number" ? w.resetsAt : null;
  if (w.recovering) return { level: "recovering", id, resetsAt, title: { text: Q.recovering, vars: {} }, detail: [], canClear: false };
  if (!r?.active) return null;
  const detail: Phrase[] = [];
  if (resetsAt === null) detail.push({ text: "重置时间未知", vars: {} });
  else if (resetsAt > now) detail.push(spanText(resetsAt - now));
  detail.push({ text: "排队 {n} 条 agent 消息，恢复后自动送达", vars: { n: r.queued ?? 0 } });
  if (r.queuedHuman) detail.push({ text: "人发的消息 {n} 条押在停着菜单 / 倒计时的窗口上，恢复后送达", vars: { n: r.queuedHuman } });
  if (w.probeDown) detail.push({ text: "用量探测不可用：只能等重置回显、到点，或点「已恢复」", vars: {} });
  if (r.credits) detail.push({ text: Q.credits, vars: { n: r.credits } });
  return { level: "out", id, resetsAt, title: outTitle(w.kind, resetsAt), detail, canClear: true };
}
