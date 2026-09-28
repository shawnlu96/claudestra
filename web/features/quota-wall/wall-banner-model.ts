/**
 * 额度闸横幅的纯模型（bridge GET /api/v1/quota/wall → 要不要显示、显示什么）。单测 tests/web-quota-wall-banner.test.ts。
 * 文案是中文原文，渲染点包 t() 翻译（lib/i18n-dict-quota.ts）。
 */

export interface WallResponse {
  active?: boolean;
  queued?: number;
  /** 持有的重置次数（owner 自己在撞墙窗口里 /limit-reset 用；bridge 不自动用） */
  credits?: number | null;
  wall?: {
    kind?: string;
    resetsAt?: number | null;
    resetsText?: string | null;
    agents?: string[];
    enteredAt?: number;
    recovering?: boolean;
  } | null;
}

export interface WallBanner {
  /** 同一道闸同一种状态一个 key：用户关掉后只在状态变了（进新闸 / 开始恢复）才再弹 */
  key: string;
  tone: "warning" | "info";
  title: string;
  /** 带 {placeholder} 的中文原文与变量 */
  detail: { text: string; vars: Record<string, string | number> }[];
  /** 闸开着时给「已恢复」按钮（= quota-wall clear） */
  canClear: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localWhen = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function spanText(ms: number): { text: string; vars: Record<string, number> } {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return { text: "约 {m} 分钟后", vars: { m: min } };
  return { text: "约 {h} 小时后", vars: { h: Math.round(min / 60) } };
}

export function wallBanner(r: WallResponse | null, now: number): WallBanner | null {
  const w = r?.wall;
  if (!w) return null;
  const id = String(w.enteredAt ?? "");
  if (w.recovering) {
    return { key: `${id}:recovering`, tone: "info", title: "额度已恢复，正在关菜单、补投消息、续跑", detail: [], canClear: false };
  }
  if (!r?.active) return null;
  const title = w.kind === "weekly" ? "Claude Code 周额度已用完" : w.kind === "session" ? "Claude Code 5 小时额度已用完" : "Claude Code 额度已用完";
  const detail: WallBanner["detail"] = [];
  if (typeof w.resetsAt === "number") {
    detail.push({ text: "{when} 重置", vars: { when: localWhen(w.resetsAt) } });
    if (w.resetsAt > now) detail.push(spanText(w.resetsAt - now));
  } else {
    detail.push({ text: "重置时间未知", vars: {} });
  }
  detail.push({ text: "排队 {n} 条 agent 消息，恢复后自动送达", vars: { n: r.queued ?? 0 } });
  if (r.credits) detail.push({ text: "有 {n} 次重置可用：在撞墙窗口里 /limit-reset", vars: { n: r.credits } });
  return { key: `${id}:active`, tone: "warning", title, detail, canClear: true };
}
