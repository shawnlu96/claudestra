/**
 * 本机交接（bridge/local-api/handoff.ts）收的 localStorage 键。旧族 cstra_ 永远收；新族 floka_ 只在接收 on 时收，
 * off / observe 与现行一样静默丢掉。同一后缀两族都给了、值又不同 = 冲突，整份拒（不替调用方挑一个）。
 */
import { BROWSER_NAMES } from "./names.js";
import { observeBrowser, type BrowserPolicy } from "./policy.js";

const SUFFIX = "[\\w.:-]{1,120}";
const OLD_RE = new RegExp(`^${BROWSER_NAMES.claudestra.storagePrefix}${SUFFIX}$`);
const NEW_RE = new RegExp(`^${BROWSER_NAMES.floka.storagePrefix}${SUFFIX}$`);

export function handoffKeyAllowed(key: string, p: BrowserPolicy): boolean {
  return OLD_RE.test(key) || (p.receive === "on" && NEW_RE.test(key));
}

/** 两族同后缀不同值 → 冲突（返回冲突的后缀）；看的是过滤前的原始键，observe 只记一行 */
export function handoffConflict(entries: Record<string, unknown>, p: BrowserPolicy): string | null {
  if (p.receive === "off") return null;
  const old = BROWSER_NAMES.claudestra.storagePrefix, neu = BROWSER_NAMES.floka.storagePrefix;
  for (const [k, v] of Object.entries(entries)) {
    if (!NEW_RE.test(k) || typeof v !== "string") continue;
    const twin = entries[old + k.slice(neu.length)];
    if (typeof twin !== "string" || !OLD_RE.test(old + k.slice(neu.length)) || twin === v) continue;
    if (p.receive === "on") return k.slice(neu.length);
    observeBrowser("handoff", "on would reject conflicting key families");
    return null;
  }
  if (p.receive === "observe" && Object.keys(entries).some((k) => NEW_RE.test(k))) observeBrowser("handoff", "on would accept new key family");
  return null;
}
