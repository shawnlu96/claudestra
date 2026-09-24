/**
 * 被邀请方这一侧「收邀请」的小状态（tests/web-invite-intake.test.ts）：
 * - 浏览器登记：让本浏览器用这个 Claudestra 打开 web+claudestra: 链接（邀请落地页的「在我的 Claudestra 中打开」）。
 *   浏览器不告诉我们用户允没允许，只能等真有一次经登记跳进 /join（?i=）才算确认；确认前隔几天提醒一次。
 * - 剪贴板里的邀请：同一个邀请码只提示一次（处理过的记下来）。
 * 所有 localStorage 读写都包 try/catch：隐私模式 / 禁存储时照样能用，只是会多提醒。
 */

export const INVITE_PROTOCOL = "web+claudestra";
const HANDLER_KEY = "cstra_invite_handler";
const SEEN_KEY = "cstra_invite_seen";
const REMIND_MS = 3 * 24 * 3600_000;

type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 禁用存储的环境：当作什么都没记过
  }
};

/** 该不该弹「允许用 Claudestra 打开邀请链接」：支持登记、还没确认过、且不在「以后再说」的冷却期里 */
export function shouldAskHandler(supported: boolean, now = Date.now(), s: Store | null = store()): boolean {
  if (!supported) return false;
  const v = s?.getItem(HANDLER_KEY) ?? "";
  if (v === "confirmed") return false;
  const later = /^later:(\d+)$/.exec(v);
  return !later || now - Number(later[1]) > REMIND_MS;
}

export function setHandlerState(state: "confirmed" | "later", now = Date.now(), s: Store | null = store()): void {
  try {
    s?.setItem(HANDLER_KEY, state === "confirmed" ? "confirmed" : `later:${now}`);
  } catch {
    /* 存不进：下次还会提醒，不影响功能 */
  }
}

/** 这个邀请码提示过没有；没有就记下（返回 true = 第一次见） */
export function firstSeen(code: string, s: Store | null = store()): boolean {
  let seen: string[] = [];
  try {
    seen = JSON.parse(s?.getItem(SEEN_KEY) || "[]") as string[];
  } catch {
    seen = []; // 内容坏了当没见过：最坏多提示一次
  }
  const key = code.slice(-24);
  if (seen.includes(key)) return false;
  try {
    s?.setItem(SEEN_KEY, JSON.stringify([...seen, key].slice(-50)));
  } catch {
    /* 存不进：下次打开可能再提示一次同一个邀请 */
  }
  return true;
}
