/**
 * 消息正文里的图片（do-md 的 SafeImg）点开大图：同一条消息当前已呈现、已加载成功的正文图按正文顺序组成一组，
 * 交给 features/media/media-viewer.ts 的 openStaticViewer 左右翻（不查媒体索引、不跨会话）。
 * 这里只有纯逻辑（谁进组、什么顺序、slide 长什么样）；挂载登记和点击在 ./body-image-zoom.tsx。
 * - 进组：本机附件、data: / blob: 内联图；外链图永远不进（查看器要 fetch 取图，外链跨域取不到，也不能替它发请求）。
 * - 不进：嵌在 <a> 里的图（点图照旧跟随外层链接）、已卸载 / 还没加载出来 / 加载失败的图（不预取未呈现的图）。
 */
import { ATTACHMENT_API } from "@/lib/chat/attachments";
import type { ImageSrcKind } from "@/lib/chat/md-guard";

/** 内联图的 slide key 前缀：保存时据此按实际 MIME 补扩展名（features/media/body-image-save.ts） */
export const BODY_INLINE_KEY = "body-inline:";

/** 用到的 <img> 能力（测试传假对象） */
export interface BodyImageEl {
  isConnected: boolean;
  complete: boolean;
  naturalWidth: number;
  closest(selector: string): unknown;
  /** 参数在真实 DOM 里是 Node；这里只会传同组的另一张图 */
  compareDocumentPosition(other: never): number;
}

export interface BodyImageEntry {
  el: BodyImageEl;
  url: string;
  kind: ImageSrcKind;
  label: string;
}

/** 与 media-viewer 的 ViewerSlide 同形（那个模块带 React 依赖，这里不 import 它） */
export interface BodySlide {
  key: string;
  url: string;
  saveUrl: string;
  name: string;
  caption?: string;
}

/** 点了这张图之后怎么办：进查看器 / 新窗口开外链原图 / 什么都不做（链接里的图交给链接） */
export type BodyImageAction = "viewer" | "external" | "none";

/** Node.DOCUMENT_POSITION_FOLLOWING：b 在 a 后面 */
const FOLLOWING = 4;

export function inLink(el: BodyImageEl): boolean {
  return !!el.closest("a[href]");
}

/** 已经显示出来的图：挂在文档里、解码完成且有尺寸（加载失败的 complete 也是 true，但宽为 0） */
function shown(el: BodyImageEl): boolean {
  return el.isConnected && el.complete && el.naturalWidth > 0;
}

export function actionFor(kind: ImageSrcKind, el: BodyImageEl): BodyImageAction {
  if (inLink(el)) return "none";
  if (kind === "attachment" || kind === "inline") return "viewer";
  return kind === "external" ? "external" : "none";
}

/** 附件地址（md-guard 已校验过是单段文件名）→ 文件名；解不开就用整段原样（不会发生：校验时已解过一次） */
export function attachmentName(url: string): string {
  const raw = url.slice(ATTACHMENT_API.length).split("?")[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // imageSrcKind 判 attachment 前已成功解码过，这里只是类型上的兜底
  }
}

/** 第 n 张（从 1 数）正文图的 slide：附件用原文件名，内联图先叫 image-n，扩展名保存时按实际 MIME 补 */
function slideOf(e: BodyImageEntry, n: number): BodySlide {
  const attachment = e.kind === "attachment";
  return {
    key: `${attachment ? "body-att:" : BODY_INLINE_KEY}${n}:${e.url}`,
    url: e.url,
    saveUrl: e.url,
    name: attachment ? attachmentName(e.url) : `image-${n}`,
    caption: e.label || undefined,
  };
}

/**
 * 点了 clicked：同组（调用方已按消息实例筛好）里能进查看器的图按文档顺序排好，返回 slides 和起始下标。
 * clicked 本身不在可看的一组里（链接里 / 外链 / 还没加载出来）返回 null。
 */
export function groupFor(entries: Iterable<BodyImageEntry>, clicked: BodyImageEl): { slides: BodySlide[]; start: number } | null {
  const seen = new Set<BodyImageEl>();
  const list: BodyImageEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.el) || !shown(e.el) || actionFor(e.kind, e.el) !== "viewer") continue;
    seen.add(e.el); // 同一个元素登记两次（重挂时序）只算一张
    list.push(e);
  }
  list.sort((a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el as never) & FOLLOWING ? -1 : 1));
  const start = list.findIndex((e) => e.el === clicked);
  if (start < 0) return null;
  return { slides: list.map((e, i) => slideOf(e, i + 1)), start };
}
