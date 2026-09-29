/**
 * 答完一张「待你处理」卡后的过渡：这张先在原位淡出（fading），再让下一张顶上来；顶上来之后短暂不收点击（guard），
 * 不加任何文字（owner：「你就做一个淡出动画，用户不就可以知道了吗」）。作答是乐观的（asks-store.answer），原来卡片瞬间移走，
 * 下一张顶到同一个位置、按钮字一样时像「没点上」，再点一下就答掉了下一张（tests/web-answer-cooldown.test.ts）。
 */
import { deletedAsk, type WebAsk } from "./asks-model";

export const FADE_MS = 450;
export const GUARD_MS = 800;

export interface Answered {
  id: string;
  phase: "fading" | "guard";
  /** 点下去那一刻的卡：淡出期间按它原来的位置、原来的样子画（ask-fade.ts），服务端改了 / 删了都不影响这 0.45 秒 */
  card?: WebAsk;
}

let active: Answered | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];
const subs = new Set<() => void>();
const set = (a: Answered | null) => {
  active = a;
  subs.forEach((f) => f());
};

/** 在 asksStore.answer / dismiss 之前调用：store 一通知，抽屉重渲染时就已经知道这张要淡出 */
export function markAnswered(id: string, card?: WebAsk): void {
  timers.forEach(clearTimeout);
  timers = [setTimeout(() => set({ id, phase: "guard" }), FADE_MS), setTimeout(() => set(null), FADE_MS + GUARD_MS)];
  set({ id, phase: "fading", card });
}

/** 作答失败（asks-store 已回滚）：当场结束过渡，这张照常显示失败原因、马上能重答 */
export function clearAnswered(id: string): void {
  if (active?.id !== id) return;
  timers.forEach(clearTimeout);
  timers = [];
  set(null);
}

/**
 * 抽屉怎么用这一笔：淡出中的那张（留在原位，ask-fade.ts），以及别的开着的卡要不要暂不收点击。
 * store 里这张又是 open（且没标删掉）= 作答 / 删卡已失败回滚（或还没生效），不淡出也不挡别的，免得失败原因跟着淡没
 */
export function cooldownView(just: Answered | null, asks: readonly { id: string; state: string; extra?: WebAsk["extra"] }[]): { fadingId: string | null; guard: boolean } {
  const cur = just ? asks.find((a) => a.id === just.id) : undefined;
  if (!just || (cur?.state === "open" && !deletedAsk(cur))) return { fadingId: null, guard: false };
  return { fadingId: just.phase === "fading" ? just.id : null, guard: true };
}

export function subscribeAnswered(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

export const activeAnswered = (): Answered | null => active;
