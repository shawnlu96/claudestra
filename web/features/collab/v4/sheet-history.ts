"use client";
import { useEffect, useRef } from "react";

const COLLAB_Q = "collab=";

/** 用到的 history 能力：生产是 lib/hash-nav-browser.ts 的 browserHistory；本文件不碰 window，仓库根的测试能直接引用 */
export interface HistoryPort {
  hash(): string;
  push(hash: string): void;
  replace(hash: string): void;
  back(): void;
  onPop(f: () => void): () => void;
}

/**
 * 手机整屏页（团队 / 待你处理 / 成员…）占一条历史记录 #chat?collab=~<kind>：系统左滑 / 返回键先收起这一层。
 * 条目归属和「此刻是不是窄屏」分开：只在窄屏压，但压过的条目切到宽屏后照样认 popstate。层被任何路径收起（×、跳进度的
 * select(null)、切宽屏后点 ×）时，当前条目还是自己的就 back 消掉，免得留一条空记录要多退一次；详情已经 replaceState
 * 接手了这条就不动它。返回的 prepare 要在「打开这一层」的事件里、setState 之前调：WKWebView 左滑预览用的是压栈那一刻
 * 截的图，等渲染完再压（effect 里压），图里已经有这一层，松手像弹回来（同 chat.tsx toContent 先压再切）。
 * tests/web-dom-collab-sheet-history.test.ts。
 */
export function useSheetHistory(open: boolean, push: boolean, id: string, onClose: () => void, h: HistoryPort): (next: string) => void {
  const owned = useRef<string | null>(null); // 自己压进去的那条 hash
  // 自己收起时调的 back 还在途：它落地的 popstate 不是用户返回。在途期间又打开的层先不认领，落地后再对账，
  // 否则新层会 replace 掉旧条目、随后被旧 back 的 popstate 当成用户返回关掉（PR556-r1 P1）
  const backing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ open, push, id, onClose });
  useEffect(() => { live.current = { open, push, id, onClose }; }); // popstate 异步到：读最近一次渲染的值
  /** 层开着、窄屏、在 #chat：把当前条目换成 / 压成自己的 */
  const claim = (s: { open: boolean; push: boolean; id: string }) => {
    const hash = h.hash();
    if (!s.open || !s.push || hash.split("?")[0] !== "#chat") return;
    const tagged = tagOf(s.id);
    if (hash !== tagged) {
      if (hash.includes(COLLAB_Q)) h.replace(tagged);
      else h.push(tagged); // 没经 prepare 打开的（切回窄屏时层还开着、back 在途时打开的）：补压
    }
    owned.current = tagged;
  };
  const landed = () => { // 自己的 back 落地（popstate 到了，或 800ms 没到也放行，别永久卡住）
    if (backing.current) clearTimeout(backing.current);
    backing.current = null;
    claim(live.current);
  };
  useEffect(() => h.onPop(() => {
    if (backing.current) return landed();
    if (!owned.current || h.hash() === owned.current) return;
    owned.current = null;
    if (live.current.open) live.current.onClose();
  })); // 每次渲染重挂：闭包里的 landed / claim 总是最新的
  useEffect(() => () => { if (backing.current) clearTimeout(backing.current); }, []);
  useEffect(() => {
    if (backing.current) return; // 等自己的 back 落地再对账
    if (open) return claim({ open, push, id });
    const mine = owned.current !== null && h.hash() === owned.current;
    owned.current = null;
    if (!mine) return;
    backing.current = setTimeout(landed, 800);
    h.back();
  }); // 每次渲染都核一遍（幂等）：prepare 压了但这层没真打开（选中的目标刷新后没了）也能消掉
  return (next) => {
    const hash = h.hash();
    if (!push || backing.current || owned.current || hash.split("?")[0] !== "#chat" || hash.includes(COLLAB_Q)) return; // 已开着 / 详情占着 / back 在途：交给 effect
    owned.current = tagOf(next);
    h.push(owned.current);
  };
}

const tagOf = (id: string) => `#chat?${COLLAB_Q}${encodeURIComponent(id)}`;
