/**
 * 额度撞墙的原文识别（纯函数，单测 tests/quota-wall-text.test.ts）。
 *
 * CC 撞额度时把一句合成的 assistant 文字写进 jsonl（model "<synthetic>"、isApiErrorMessage、error "rate_limit"）：
 *   "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)" / "You've hit your session limit · resets 10:40pm (Asia/Tokyo)"
 *   "You've hit your limit · resets 2am (Asia/Shanghai)"；Codex 译过来的是 "You've hit your usage limit. … try again at 8:41 AM."
 * 同样 error=rate_limit 的还有 429「This request would exceed your account's rate limit」——那是临时限流、不带重置时间，
 * 不算撞墙（按普通 API 错误续跑）。只认句首：agent 自己的话里引用这句不能被当成撞墙。
 */
import { parseResetText } from "./usage-window.js";

const LIMIT_HIT_RE = /^(?:You['’]?ve hit your (?:[\w-]+ )?limit|Hit your (?:rate |usage )?limit)/i;

export const isLimitHitText = (text: string): boolean => LIMIT_HIT_RE.test(text.trim());

type WallKind = "weekly" | "session" | "unknown";

export interface WallHit {
  kind: WallKind;
  /** 解析出的重置时刻（epoch ms）；原文没有或认不出 = null */
  resetsAt: number | null;
  /** "resets" 后面那段原文，通知里照写（带时区） */
  resetsText: string | null;
}

/** 撞墙原文 → 种类 + 重置时刻；不是撞墙原文返回 null */
export function parseWallText(text: string, now: number): WallHit | null {
  const t = text.trim();
  if (!isLimitHitText(t)) return null;
  const k = /hit your ([\w-]+) limit/i.exec(t)?.[1]?.toLowerCase();
  const kind: WallKind = k === "weekly" ? "weekly" : k === "session" ? "session" : "unknown";
  const rm = /\bresets\s+(.+?)\s*$/i.exec(t.split("\n")[0]);
  const resetsText = rm ? rm[1].trim() : null;
  return { kind, resetsAt: resetsText ? parseResetText(resetsText, now) : null, resetsText };
}
