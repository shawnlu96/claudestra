/**
 * 淡出期间这张卡钉在原位（T61，T56 终审 P2）：点下去那一刻按它当时的样子（answer-cooldown 记的 card）算出在哪一组第几张，
 * 之后 0.45 秒都画这份快照、放在这个位置——期间进来更高优先级的卡不会把它挤走，服务端把这一行撤了 / 删了它也不会凭空消失。
 * 别的卡照常按实时数据排；快照只是画面，不是状态：它一直是 leaving（不收点击），已撤销的卡不会因此变回能点。
 * 单测 tests/web-answer-cooldown.test.ts。
 */
import { groupAsks, type AskGroups, type WebAsk } from "./asks-model";
import { isAskForViewer } from "./ask-viewer";

export interface FadeSlot {
  card: WebAsk;
  section: keyof AskGroups;
  index: number;
}

/** 当时的位置：把快照放回列表（换掉实时那份，或补回被删的那份）再分组 */
export function fadeSlot(asks: readonly WebAsk[], card: WebAsk): FadeSlot {
  const g = groupAsks([...asks.filter((a) => a.id !== card.id), card]);
  for (const section of ["waiting", "accept", "recent"] as const) {
    const index = g[section].findIndex((a) => a.id === card.id);
    if (index >= 0) return { card, section, index };
  }
  return { card, section: "recent", index: 0 }; // 快照本身被判成删掉的（不该发生）：放最近一组顶上
}

/** 实时分组里拿掉这张，再把快照插回当时的位置 */
export function withFade(g: AskGroups, slot: FadeSlot | null): AskGroups {
  if (!slot || !isAskForViewer(slot.card)) return g;
  const strip = (l: WebAsk[]) => l.filter((a) => a.id !== slot.card.id);
  const out: AskGroups = { waiting: strip(g.waiting), accept: strip(g.accept), recent: strip(g.recent) };
  const list = out[slot.section];
  out[slot.section] = [...list.slice(0, slot.index), slot.card, ...list.slice(slot.index)];
  return out;
}
