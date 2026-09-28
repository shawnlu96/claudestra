/**
 * 消息列表的滚动锚定与吸底判据（纯函数，单测 tests/web-scroll-anchor.test.ts）。
 * 全量重拉整体替换 messages（直播气泡换成 h<seq> 正主、窗口随条数滑动、富文本重挂先矮后高），
 * scrollTop 按像素不动视口就换了内容，所以锚点按消息 id / seq 记、按 DOM 实测算位移。
 */
import type { ChatMessage } from "./type";
import { isNearBottom } from "./scroll-follow";

export interface ViewAnchor {
  /** 重拉前是否贴底——贴底的恢复就是继续贴底，不看锚点 */
  atBottom: boolean;
  /** 视口顶部第一条（部分）可见气泡的 id */
  id: string | null;
  /** 该气泡的 jsonl seq（h<seq>；跨 session 翻页的 h<seq>~ns 与直播气泡为 null） */
  seq: number | null;
  /** 该气泡顶边相对视口顶边的像素（在视口上方为负） */
  offset: number;
}

export interface RowBox {
  id: string;
  /** 相对滚动容器视口顶边 */
  top: number;
  bottom: number;
}

/** h<seq> → seq；其余（直播 / 乐观 / 跨 session 命名空间 / 分隔条）→ null */
export function seqOfId(id: string): number | null {
  const m = /^h(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * rows 按文档顺序；视口顶边 = 0。锚点取视口顶部第一条（部分）可见的气泡；它若是直播气泡
 * （没有 seq，重拉后会换成 h<seq> 正主、id 对不上），改用它前面最近的历史气泡（前面没有就用后面的）——
 * 偏移照样按那条自己的位置记，恢复精度不变。
 */
export function captureAnchor(
  rows: readonly RowBox[],
  view: { scrollTop: number; scrollHeight: number; clientHeight: number; following?: boolean },
): ViewAnchor {
  // 吸底跟随中也算贴底：手指按住时流式长高会让几何上离底，但抬手后本该继续吸底
  const atBottom = !!view.following || isNearBottom(view.scrollHeight, view.scrollTop, view.clientHeight);
  const at = rows.findIndex((r) => r.bottom > 0);
  if (at < 0) return { atBottom, id: null, seq: null, offset: 0 };
  const hasSeq = (r: RowBox) => seqOfId(r.id) !== null;
  let hit = hasSeq(rows[at]) ? rows[at] : undefined;
  for (let i = at - 1; !hit && i >= 0; i--) if (hasSeq(rows[i])) hit = rows[i];
  hit ??= rows.slice(at + 1).find(hasSeq) ?? rows[at];
  return { atBottom, id: hit.id, seq: seqOfId(hit.id), offset: hit.top };
}

export type AnchorMatch = { id: string; how: "same" | "seq" } | { id: null; how: "none" };

/**
 * 新列表里找回锚点：同 id 优先；id 变了（直播气泡换成正主、合并边界移动）按 seq 取
 * 「seq ≤ 锚点的最后一个 h 气泡」——锚点落在合并气泡内部时就是包含它的那条。
 */
export function resolveAnchor(anchor: Pick<ViewAnchor, "id" | "seq">, ids: readonly string[]): AnchorMatch {
  if (anchor.id && ids.includes(anchor.id)) return { id: anchor.id, how: "same" };
  if (anchor.seq === null) return { id: null, how: "none" };
  let best: string | null = null;
  for (const id of ids) {
    const n = seqOfId(id);
    if (n !== null && n <= anchor.seq) best = id;
  }
  return best ? { id: best, how: "seq" } : { id: null, how: "none" };
}

/** 让锚点气泡回到原偏移，scrollTop 要加多少（nodeTop 相对视口顶边）。 */
export function anchorScrollDelta(nodeTop: number, wantOffset: number): number {
  return nodeTop - wantOffset;
}

/**
 * 往上翻着时渲染窗口按顶部那条定位，不按尾部条数滑。窗口是「尾部 N 条」：尾部新增 k 条顶部就滑掉 k 条，
 * 尾部合并 / 清掉 k 条顶部就插进更早的 k 条，视口里的内容被整体推走（iOS 没有 overflow-anchor 补偿）。
 * 返回让原顶部那条仍在窗口顶所需的条数；已经是、或它已不在列表里（换会话 / 重拉换了 id）返回 null。
 */
export function windowForTop(topId: string | null, ids: readonly string[], windowSize: number): number | null {
  const idx = topId ? ids.indexOf(topId) : -1;
  if (idx < 0) return null;
  const need = ids.length - idx;
  return need !== windowSize ? need : null;
}

/**
 * 一次 scroll 事件之后还吸不吸底。scrollTop 变小通常 = 用户上滑、退出吸底；但内容变矮 / 视口变高时
 * 浏览器把 scrollTop 夹到新的最大值（max 变小），iOS 底部回弹落位时 scrollTop 从越界值回到 max——
 * 这两种不是用户动作，误判会关掉吸底、随后内容长高就把人留在上面。只凭「停在最底」判不行：
 * 高 DPR 触控板慢速上滑单帧 ≤1px，会被当成夹回、流式时拖不动。prev = 上一次事件时的 scrollTop 与 max。
 */
export function followAfterScroll(prev: { top: number; max: number }, top: number, scrollHeight: number, clientHeight: number): boolean {
  const max = scrollHeight - clientHeight;
  if (top >= max - 1 && (max < prev.max || prev.top > prev.max)) return true;
  return top >= prev.top && isNearBottom(scrollHeight, top, clientHeight);
}

/**
 * 全量重拉在用户往上翻时保留已翻出的更早前缀：新窗口只含最近一页，锚点若在更早的页里
 * 重拉后就没了。前缀 = 当前视图里排在新窗口第一个 h 气泡之前、seq 更小的部分；
 * 跨 session 命名空间气泡与换纸分隔条都在前缀里原样保留。新窗口里没有 h 气泡、或当前视图
 * 与新窗口不重叠（切走期间来了一整页以上，拼上就会漏掉中间那段）时不拼。
 */
export function keepOlderPrefix(current: readonly ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  let firstSeq: number | null = null;
  for (const m of next) {
    const n = seqOfId(m.id);
    if (n !== null) {
      firstSeq = n;
      break;
    }
  }
  if (firstSeq === null) return next;
  const cut = current.findIndex((m) => {
    const n = seqOfId(m.id);
    return n === null ? !isOlderPage(m.id) : n >= firstSeq;
  });
  if (cut <= 0 || seqOfId(current[cut].id) === null) return next;
  return [...current.slice(0, cut), ...next];
}

/** loadOlder 拼进来的跨 session 气泡（h<seq>~ns）与换纸分隔条——只会出现在头部 */
function isOlderPage(id: string): boolean {
  return /^h\d+~/.test(id) || id.startsWith("sessdiv_");
}
