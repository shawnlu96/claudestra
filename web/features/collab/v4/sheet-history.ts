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
 * 接手了这条就不动它。tests/web-dom-collab-sheet-history.test.ts。
 */
export function useSheetHistory(open: boolean, push: boolean, id: string, onClose: () => void, h: HistoryPort): void {
  const owned = useRef<string | null>(null); // 自己压进去的那条 hash
  const live = useRef({ open, onClose });
  useEffect(() => { live.current = { open, onClose }; }); // popstate 异步到：读的是最近一次渲染的 open / onClose
  useEffect(() => h.onPop(() => {
    if (!owned.current || h.hash() === owned.current) return;
    owned.current = null;
    if (live.current.open) live.current.onClose();
  }), [h]);
  useEffect(() => {
    const hash = h.hash();
    if (!open) {
      const mine = owned.current !== null && hash === owned.current;
      owned.current = null; // 先放手：back 带来的 popstate 不再回调 onClose
      if (mine) h.back();
      return;
    }
    if (!push || hash.split("?")[0] !== "#chat") return;
    const tagged = `#chat?${COLLAB_Q}${encodeURIComponent(id)}`;
    if (hash.includes(COLLAB_Q)) h.replace(tagged);
    else h.push(tagged);
    owned.current = tagged;
  }, [open, push, id, h]);
}
