/**
 * 出借额度线设置的数据形状与纯逻辑（QLINE1）：形状照 bridge local-api/lend-quota-lines.ts 的 LendQuotaLinesView；
 * 状态（below / warn / stop / unknown）由 bridge 判好，这里只决定怎么显示，不按百分比自己猜停没停。
 * 表单只做「是不是 0..100 整数、提醒线是否低于停线」的即时提示，最终以 bridge 校验为准。tests/web-lend-quota.test.ts。
 */
export type QuotaFamily = "codex" | "claude";
export type LineState = "below" | "warn" | "stop" | "unknown";
export type LineLimit = "none" | "half" | "zero";
export type LineMode = "on" | "observe" | "off";

export interface FamilyLine {
  family: QuotaFamily; warnPct: number; stopPct: number; weekUsedPct: number | null; resetAt: number | null;
  observedAt: number | null; source: "live" | "live_stale" | "local_cache" | null;
  freshness: "fresh" | "last_known" | null; state: LineState; mode: LineMode; limit: LineLimit; wouldLimit: LineLimit;
  /** granted = 授权名额；lineCap = 只按额度线收窄的理论上限；available / slots = 实际可接（未套 / 已套额度线），null = 读不到 */
  granted: number; lineCap: number; available: number | null; slots: number | null;
}
export interface QuotaLinesView {
  ok: true;
  config: { status: "ok" | "missing" | "invalid"; error: "config_unreadable" | "config_invalid" | null; mode: LineMode };
  at: number;
  families: FamilyLine[];
  warning?: "replaced_invalid";
}

export interface LineDraft { warn: string; stop: string }

export const draftOf = (f: Pick<FamilyLine, "warnPct" | "stopPct">): LineDraft => ({ warn: String(f.warnPct), stop: String(f.stopPct) });

const pctOf = (s: string): number | null => (/^\d{1,3}$/.test(s.trim()) && Number(s) <= 100 ? Number(s) : null);

/** 表单即时提示：null = 可提交；否则一句（中文原文，界面经 i18n 翻译） */
export function draftProblem(d: LineDraft): string | null {
  const warn = pctOf(d.warn);
  const stop = pctOf(d.stop);
  if (warn === null || stop === null) return "要是 0 到 100 的整数";
  if (warn >= stop) return "提醒线要低于停接线";
  return null;
}

/** 提交体：只带这一族的两条线 */
export const lineBody = (family: QuotaFamily, d: LineDraft) => ({ family, warnPct: Number(d.warn.trim()), stopPct: Number(d.stop.trim()) });

export const isDirty = (f: Pick<FamilyLine, "warnPct" | "stopPct">, d: LineDraft): boolean => d.warn.trim() !== String(f.warnPct) || d.stop.trim() !== String(f.stopPct);

/** 状态 → 文案与色调；停接只看 bridge 给的 state，不看百分比 */
export function stateBadge(f: Pick<FamilyLine, "state" | "mode" | "limit">): { text: string; tone: "success" | "warning" | "error" | "muted" } {
  if (f.state === "unknown") return { text: "用量未知", tone: "muted" };
  if (f.state === "stop") return f.limit === "zero" ? { text: "已停接", tone: "error" } : { text: "超过停接线（未执行）", tone: "warning" };
  if (f.state === "warn") return { text: f.limit === "half" ? "提醒 · 已缩减" : "提醒", tone: "warning" };
  return { text: "正常", tone: "success" };
}

/** 已用百分比：unknown 显示「未知」，不显示成 0% */
export const usedText = (f: Pick<FamilyLine, "weekUsedPct">): string => (f.weekUsedPct === null ? "未知" : `${f.weekUsedPct}%`);

/** 进度条宽度（0..100）；unknown = null（不画条） */
export const barWidth = (f: Pick<FamilyLine, "weekUsedPct">): number | null => (f.weekUsedPct === null ? null : Math.min(100, Math.max(0, f.weekUsedPct)));

/** 实际可接：读不到显示「未知」，不当 0 也不当满 */
export const slotsText = (f: Pick<FamilyLine, "slots">): string => (f.slots === null ? "未知" : String(f.slots));

/** bridge 的固定错误码 → 文案（中文原文，界面经 i18n 翻译） */
export const configErrorText = (c: QuotaLinesView["config"]): string | null =>
  c.status !== "invalid" ? null : c.error === "config_unreadable" ? "配置文件读不了或不是合法 JSON，正按默认 70/80 执行；保存一次即修复"
    : "配置文件内容不合法，正按默认 70/80 执行；保存一次即修复";
export const warningText = (w: QuotaLinesView["warning"]): string | null => (w === "replaced_invalid" ? "原配置文件损坏，已另存备份后按这次保存的内容重写" : null);
