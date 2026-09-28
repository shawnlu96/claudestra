/**
 * 窄屏伪路由的历史栈规则，会话页 #chat 与「待你处理」#asks 共用（nav-context.tsx 讲了为什么要靠 hash 历史项：
 * iOS 左缘滑 / 系统返回键只会触发 popstate，单页没有历史项就没有返回）。
 * 两条规矩：① 只对自己 pushState 打过标（state.cstra）的条目 history.back()——刷新 / 深链带 hash 进来的基础条目
 * 没有标，back 会退到应用之前的空白页，只能 replaceState 摘掉 hash；② back 的 popstate 是异步的，在途期间的
 * 重复触发（连点返回 / 连续左滑）一律忽略，否则多退一格也会白屏。判定是纯函数，测试见 tests/web-hash-nav.test.ts；
 * 接浏览器的那几行（全页那道闸、matchMedia、replaceState）在 hash-nav-browser.ts。
 */

/** 只有手机宽度（< sm 640px）走 hash 伪路由；桌面双栏 / 侧栏抽屉不压栈 */
export const NARROW_QUERY = "(max-width: 639.98px)";

/** 我们自己压的历史项在 state.cstra 上打的标 */
export type NavTag = "chat" | "asks";

export const hashBase = (hash: string): string => hash.split("?")[0];

export const ownsEntry = (state: unknown, tag: NavTag): boolean =>
  !!state && typeof state === "object" && (state as { cstra?: unknown }).cstra === tag;

/** 进入 hash 页：窄屏且还不在这页上才压一条（已在 = 刷新恢复 / 重复点，别叠两条） */
export const shouldPush = (hash: string, pageHash: string, narrow: boolean): boolean => narrow && hashBase(hash) !== pageHash;

/**
 * 离开 hash 页怎么做：
 * wait = 上一次 back 还在途，这次什么都不做；back = 出栈（与左滑同一路径，popstate 收尾）；
 * strip = 没打标的基础条目，摘掉 hash、不动栈；none = 本来就不在这页上，只改界面状态。
 */
export type LeavePlan = "wait" | "back" | "strip" | "none";
export function leavePlan(hash: string, pageHash: string, state: unknown, tag: NavTag, backInFlight: boolean): LeavePlan {
  if (hashBase(hash) !== pageHash) return "none";
  if (backInFlight) return "wait";
  return ownsEntry(state, tag) ? "back" : "strip";
}

/** 横滑是不是「返回 / 前进」：横向为主（|dx| ≥ 1.6|dy|）且够长（≥ 70px），其余（滚列表、点按）都不算 */
export function swipeDir(dx: number, dy: number): "back" | "forward" | null {
  if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return null;
  return dx > 0 ? "back" : "forward";
}

export interface BackEnv {
  back: () => void;
  onceOnPop: (f: () => void) => void;
  later: (f: () => void, ms: number) => void;
}

/** back 在途闸：back() 期间再调直接忽略；这次的 popstate 到达即解锁，popstate 没来（极端情况）800ms 后也解锁，别永久锁死 */
export function createBackGuard(env: BackEnv): { busy: () => boolean; back: () => void } {
  let inFlight = false;
  const unlock = () => {
    inFlight = false;
  };
  return {
    busy: () => inFlight,
    back() {
      if (inFlight) return;
      inFlight = true;
      env.onceOnPop(unlock);
      env.back();
      env.later(unlock, 800);
    },
  };
}

/** 「待你处理」推送的深链 /chat?ask=<id> → ask id（APNs 与 Web Push 同一个 url，src/lib/ask-push.ts）；不是就 null */
export function askFromLink(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url, "http://x").searchParams.get("ask") || null;
  } catch {
    return null; // 坏 url 当普通推送处理，照旧打开 agent 会话
  }
}
