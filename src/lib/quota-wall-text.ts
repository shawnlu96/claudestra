/**
 * 额度撞墙的原文识别（纯函数，单测 tests/quota-wall-text.test.ts）。
 *
 * CC 撞额度时把一句合成的 assistant 文字写进 jsonl（model "<synthetic>"、isApiErrorMessage、error "rate_limit"）：
 *   "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)" / "You've hit your session limit · resets 10:40pm (Asia/Tokyo)"
 *   "You've hit your limit · resets 2am (Asia/Shanghai)"；Codex 译过来的是 "You've hit your usage limit. … try again at 8:41 AM."
 * 同样 error=rate_limit 的还有 429「This request would exceed your account's rate limit」——那是临时限流、不带重置时间，
 * 不算撞墙（按普通 API 错误续跑）。调用方只拿 CC / Codex 合成的错误条目来问（jsonl-watcher 看 isApiErrorMessage / error），
 * agent 自己的正文不问；这里再只认句首、limit 后面紧跟标点或行尾，「You've hit your API limit on GitHub」这类话也不算。
 */
import { parseResetAt } from "./autopilot-run.js";

/** 「hit」是额度窗口，「reached your Fable limit」「Fable 5 limit」是单个模型的额度（本机实录 99 条） */
const LIMIT_HIT_RE = /^(?:You['’]?ve (?:hit|reached) your (?:[\w.-]+ ){0,3}limit|Hit your (?:rate |usage )?limit)(?=\s*(?:[·.,;:!\n]|$))/i;

export const isLimitHitText = (text: string): boolean => LIMIT_HIT_RE.test(text.trim());

export type WallKind = "weekly" | "session" | "unknown";

export interface WallHit {
  kind: WallKind;
  /** 解析出的重置时刻（epoch ms）；原文没有或认不出 = null */
  resetsAt: number | null;
  /** "resets" 后面那段原文，通知里照写（带时区） */
  resetsText: string | null;
}

/** 整个账号的额度窗口；别的词是单个模型的额度（「reached your Fable limit」「hit your Opus limit」），换模型就能接着用 */
const ACCOUNT_WINDOWS = new Set(["weekly", "session", "usage"]);

/** 一条 API 错误条目算不算撞墙（进闸的唯一判据，额度闸和 Stop 兜底共用）：error 是 rate_limit 且原文是账号级额度 */
export const wallHitOf = (error: string, text: string, now: number): WallHit | null => (error === "rate_limit" ? parseWallText(text, now) : null);

/** 撞墙原文 → 种类 + 重置时刻；不是撞墙原文、或只是单个模型的额度（不闸整台机器）返回 null */
export function parseWallText(text: string, now: number): WallHit | null {
  const t = text.trim();
  if (!isLimitHitText(t)) return null;
  const k = /(?:hit|reached) your ((?:[\w-]+ ){0,1}[\w-]+) limit/i.exec(t)?.[1]?.toLowerCase();
  if (k && !ACCOUNT_WINDOWS.has(k)) return null;
  const kind: WallKind = k === "weekly" ? "weekly" : k === "session" ? "session" : "unknown";
  // CC「resets Fri 9am (Asia/Tokyo)」，Codex「try again at 8:41 AM」「try again in 3 hours」；解析与 Autopilot 同一份
  const rm = /\b(?:resets|try again)\s+(.+?)\s*$/i.exec(t.split("\n")[0]);
  const resetsText = rm ? rm[1].replace(/[.。]$/, "").trim() : null;
  return { kind, resetsAt: resetsText ? parseResetAt(t, now) : null, resetsText };
}

/**
 * CC 撞墙后弹的菜单（rate_limit_options_menu，选项由 CC 按账号动态拼）。2026-09-28 实录：
 *   What do you want to do?
 *   ❯ 1. Stop and wait for limit to reset
 *     2. Wait here, then continue automatically at Sep 30 at 6am
 *     3. Switch to usage credits
 *   Enter to confirm · Esc to cancel
 * 下面的选项文案取自 CC 2.1.28x 安装包里的字符串。出闸时只对**完整认得**的菜单发一次 Esc（= 取消，不选任何一项；
 * 3「usage credits」会花钱、Upgrade 会换套餐，绝不选）：标题行、连续编号、第 1 项是「Stop and wait」、每一项都在下面、
 * 底部提示行，缺一样或多出一个不认识的选项就不发键，只记日志、在出闸通知里列出来让人处理。
 */
const MENU_OPTIONS = [
  /^Stop and wait for limit to reset$/,
  /^Wait here, then continue automatically (?:shortly|when the limit resets|at .+)$/,
  /^Switch to usage credits$/,
  /^Upgrade your plan$/,
  /^Ask your admin for more usage$/,
  /^Add funds to continue with .+$/,
];

/** pane 画面底部是不是一个完整认得的撞墙菜单 */
export function matchLimitMenu(pane: string): boolean {
  const lines = pane.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = lines.lastIndexOf("What do you want to do?");
  if (head < 0) return false;
  const rest = lines.slice(head + 1);
  const foot = rest.findIndex((l) => /^Enter to confirm\s*·\s*Esc to cancel$/.test(l));
  // 提示行必须是画面最后一行有字的内容：下面还有东西 = 菜单不在最上层（或者是别的画面里引用了这段文字）
  if (foot < 1 || foot !== rest.length - 1) return false;
  const opts = rest.slice(0, foot);
  return opts.every((l, i) => {
    const m = /^(?:❯\s*)?(\d+)\.\s+(.+)$/.exec(l);
    return !!m && Number(m[1]) === i + 1 && MENU_OPTIONS.some((re) => re.test(m[2].trim())) && (i > 0 || /^Stop and wait/.test(m[2]));
  });
}

/** owner 用了重置卡（/limit-reset 成功）时 CC 回显的「Limits reset · your weekly reset day stays … · … left」，不落 jsonl，只能看画面 */
export function countLimitsResetEcho(pane: string): number {
  return (pane.match(/^\s*(?:⎿\s*)?Limits reset\s*·/gm) ?? []).length;
}
