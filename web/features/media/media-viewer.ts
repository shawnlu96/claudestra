/**
 * 大图查看器（owner 2026-09-28「点开一张图片，可以一直往前翻」）：PhotoSwipe 动态数据源 + 媒体索引分页。
 * 正序排列（左 = 更早），numItems = 筛选结果总数，下标没加载到的先出转圈、离已加载边界 EDGE 张以内就往那头补一页；
 * 显示版走服务端 ?display=1（HEIC 可看、走中继省流量），保存 / 分享取原图。PhotoSwipe 保留（owner 2026-07-14 选定），
 * 手势：捏合 / 双击缩放、下拉关闭、单击关闭，桌面方向键左右翻。
 * 两种来源：媒体索引（openMediaViewer）与气泡里现成的几张图（openStaticViewer，旧 bridge 没有 /media 时的退路）。
 * 图片自己取成 object URL、只留最近 MAX_DECODED 张，其余回收，关掉查看器全回收（不走 AuthImg 那份永不回收的全局缓存）。
 */
import type PhotoSwipe from "photoswipe";
import type { SlideData } from "photoswipe";
import { selfIds } from "@/lib/api/history";
import { listMedia, mediaRawUrl, type MediaCursor, type MediaItem, type MediaPage, type MediaQuery } from "@/lib/api/media";
import { shareFile } from "../chat/attachment-share";
import { fetchAuthBlob, saveBlob } from "../chat/components/auth-img";
import { fmtTs } from "../chat/fmt-time";
import { placePage, wantsDisplayVariant, whoLabel } from "./media-logic";

const PAGE = 40;
const EDGE = 4;
const MAX_DECODED = 12;
/** 索引首建时等它建完再开（否则总数会在翻看中途变），最多等这么多轮、每轮 1 秒 */
const BUILD_POLLS = 8;

export interface ViewerSlide {
  key: string;
  /** 显示用地址（API 路径，带凭据取） */
  url: string;
  /** 保存 / 分享用的原图地址 */
  saveUrl: string;
  name: string;
  caption?: string;
  item?: MediaItem;
}

export interface ViewerText {
  t: (s: string) => string;
  /** 媒体项 → 顶部说明；不给就是「谁发的 · 时间」 */
  caption?: (item: MediaItem) => string;
  /** 本人的发送者 id（认「我发的」）；不给就现取 */
  self?: ReadonlySet<string>;
  onLocate?: (item: MediaItem) => void;
}

const ICON = {
  save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  locate:
    '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/>' +
    '<line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (paths: string) =>
  // 与 PhotoSwipe 自带按钮同位（按钮 50×60，图标居中）；颜色取它的 --pswp-icon-color，否则会继承页面的深色文字色
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
  `style="position:absolute;top:18px;left:13px;color:var(--pswp-icon-color,#fff)">${paths}</svg>`;
const note = (text: string) => `<div class="flex h-full w-full items-center justify-center px-8 text-center text-sm text-white/60">${text}</div>`;
const SPINNER = '<div class="flex h-full w-full items-center justify-center"><span class="loading loading-spinner loading-md text-white/60"></span></div>';

/** 分享 / 保存原图：iOS 上走系统分享面板（能存进相册），不支持就下载 */
export async function shareOrSave(url: string, name: string): Promise<void> {
  try {
    const blob = await fetchAuthBlob(url);
    // 与气泡里的文件 chip 共用系统分享（../chat/attachment-share）；不支持就下载原图
    if ((await shareFile(blob, name || "image.png")) === "unsupported") saveBlob(blob, name || "image.png");
  } catch {
    /* 取不到原图时查看器里什么也不做，不弹错：图正显示着，多半是缓存被清，关掉重开即可 */
  }
}

/** 一个查看器实例的图片缓存：地址 → object URL + 原图宽高（PhotoSwipe 要宽高才能排版）；超出 MAX_DECODED 按最久未用回收 */
class Decoder {
  private done = new Map<string, { src: string; w: number; h: number }>();
  private pending = new Map<string, Promise<void>>();

  get(url: string): { src: string; w: number; h: number } | undefined {
    const hit = this.done.get(url);
    if (hit) {
      this.done.delete(url); // 挪到最新
      this.done.set(url, hit);
    }
    return hit;
  }

  load(url: string): Promise<void> {
    let p = this.pending.get(url);
    if (!p) {
      p = fetchAuthBlob(url)
        .then((b) => {
          const src = URL.createObjectURL(b);
          return new Promise<void>((ok, fail) => {
            const img = new Image();
            img.onload = () => {
              this.done.set(url, { src, w: img.naturalWidth || 1600, h: img.naturalHeight || 1200 });
              this.evict();
              ok();
            };
            img.onerror = () => {
              URL.revokeObjectURL(src);
              fail(new Error("decode"));
            };
            img.src = src;
          });
        })
        .finally(() => this.pending.delete(url));
      this.pending.set(url, p);
    }
    return p;
  }

  private evict(): void {
    while (this.done.size > MAX_DECODED) {
      const [url, d] = this.done.entries().next().value!;
      URL.revokeObjectURL(d.src);
      this.done.delete(url);
    }
  }

  clear(): void {
    for (const d of this.done.values()) URL.revokeObjectURL(d.src);
    this.done.clear();
  }
}

function slideOf(item: MediaItem, text: ViewerText): ViewerSlide {
  return {
    key: item.id,
    url: mediaRawUrl(item.id, wantsDisplayVariant(item.name)),
    saveUrl: mediaRawUrl(item.id),
    name: item.name,
    caption: text.caption?.(item) ?? [whoLabel(item, text.self ?? new Set(), text.t), fmtTs(item.ts ?? undefined)].join(" · "),
    item,
  };
}

interface Source {
  total: number;
  start: number;
  get(i: number): ViewerSlide | "loading" | "gone";
  /** 当前停在 i：需要的话往两头补页，补到了回调要刷新的下标 */
  near(i: number, refresh: (indexes: number[]) => void): void;
}

async function launch(src: Source, text: ViewerText): Promise<void> {
  const { default: PhotoSwipeCtor } = await import("photoswipe");
  const pswp: PhotoSwipe = new PhotoSwipeCtor({
    dataSource: [],
    index: src.start,
    loop: false,
    bgOpacity: 0.95,
    zoom: false,
    pinchToClose: true,
    closeOnVerticalDrag: true,
    tapAction: "close",
    imageClickAction: "close",
    bgClickAction: "close",
    arrowPrev: src.total > 1,
    arrowNext: src.total > 1,
  });
  const dec = new Decoder();
  pswp.on("destroy", () => dec.clear());
  // 总数变了（翻看中有新图进来）：刷新计数与箭头；下标从最早一张数起，新图加在最新一端，已加载的下标不动
  const refresh = (indexes: number[]) => {
    indexes.forEach((i) => pswp.refreshSlideContent(i));
    pswp.dispatch("change");
  };
  pswp.addFilter("numItems", () => src.total);
  pswp.addFilter("itemData", (_d: SlideData, i: number): SlideData => {
    const s = src.get(i);
    if (s === "loading") return { html: SPINNER };
    if (s === "gone") return { html: note(text.t("文件已不在本机")) };
    if (s.item && !s.item.available) return { html: note(text.t(s.item.restricted ? "这张图来源不唯一，只有管理设备能查看" : "文件已不在本机")) };
    const d = dec.get(s.url);
    if (d) return { src: d.src, width: d.w, height: d.h, alt: s.name };
    dec.load(s.url).then(() => pswp.refreshSlideContent(i), () => undefined); // 解码失败：这一格留着转圈，旁边的照常翻
    return { html: SPINNER };
  });
  const current = (): ViewerSlide | null => {
    const s = src.get(pswp.currIndex);
    return typeof s === "string" ? null : s;
  };
  pswp.on("uiRegister", () => {
    pswp.ui?.registerElement({
      name: "media-caption",
      order: 6,
      appendTo: "bar",
      className: "pswp__media-caption",
      html: "",
      onInit: (el) => {
        el.style.cssText = "flex:1;min-width:0;align-self:center;padding:0 8px;color:#fff;opacity:.8;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        const upd = () => (el.textContent = current()?.caption ?? "");
        pswp.on("change", upd);
        pswp.on("contentActivate", upd);
        upd();
      },
    });
    if (text.onLocate) {
      pswp.ui?.registerElement({
        name: "media-locate",
        order: 7,
        isButton: true,
        title: text.t("定位到消息"),
        html: icon(ICON.locate),
        onClick: () => {
          const item = current()?.item;
          if (!item) return;
          pswp.close();
          text.onLocate?.(item);
        },
      });
    }
    pswp.ui?.registerElement({
      name: "media-save",
      order: 8,
      isButton: true,
      title: text.t("保存"),
      html: icon(ICON.save),
      onClick: () => {
        const s = current();
        if (s && s.item?.available !== false) void shareOrSave(s.saveUrl, s.name);
      },
    });
  });
  pswp.on("change", () => src.near(pswp.currIndex, refresh));
  pswp.init();
  src.near(src.start, refresh);
}

/** 第一页：索引还在首建就每秒再拉一次，建完（或等够了）再开，免得总数在翻看中途变；锚点找不到（404 等）返回 null */
async function firstPage(q: MediaQuery, anchor: MediaCursor): Promise<MediaPage | null> {
  let page: MediaPage | null = null;
  for (let i = 0; i < BUILD_POLLS; i++) {
    try {
      page = await listMedia(q, { ...anchor, limit: PAGE });
    } catch {
      return page; // 404（气泡区间里没有这张 / 没进索引 / 旧 bridge 没这个端点）→ 调用方退回气泡里的几张图
    }
    if (!page.building) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return page;
}

/** 媒体索引来源：从锚点（媒体 id，或气泡里的文件名 + 会话 + seq 区间）取一窗，翻到边界往两头补页。锚点找不到返回 false */
export async function openMediaViewer(query: MediaQuery, anchor: MediaCursor, text: ViewerText): Promise<boolean> {
  const q: MediaQuery = { ...query, kind: "image" };
  const [first, self] = await Promise.all([firstPage(q, anchor), text.self ?? selfIds().catch(() => new Set<string>())]);
  if (!first || !first.anchor) return false;
  const src: Source = { total: first.total, start: 0, get: () => "loading", near: () => undefined };
  let slots = placePage(new Map(), first);
  src.start = [...slots].find(([, it]) => it.id === first.anchor)?.[0] ?? first.total - 1;
  let older = first.older;
  let newer = first.newer;
  const busy = { older: false, newer: false };
  const lo = () => Math.min(...slots.keys());
  const hi = () => Math.max(...slots.keys());
  const place = (page: MediaPage, refresh: (idx: number[]) => void) => {
    const before = new Set(slots.keys());
    slots = placePage(slots, page); // 各页用自己的 total / newerCount 定位：新图进来两者同增，已有下标不变
    src.total = Math.max(src.total, page.total);
    refresh([...slots.keys()].filter((k) => !before.has(k)));
  };
  const load = async (side: "older" | "newer", refresh: (idx: number[]) => void) => {
    const cursor = side === "older" ? older : newer;
    if (busy[side] || (!cursor && side === "older")) return;
    // 最新一端没有游标：总数长了（有新图）才值得再问一次，围绕已加载的最新一张取窗拿到新游标
    const newest = slots.get(hi());
    if (!cursor && (hi() >= src.total - 1 || !newest)) return;
    busy[side] = true;
    try {
      const c = cursor ? (side === "older" ? { before: cursor } : { after: cursor }) : { around: newest!.id };
      const page = await listMedia(q, { ...c, limit: PAGE });
      if (side === "older") older = page.older;
      else newer = page.newer;
      place(page, refresh);
    } catch {
      /* 网络抖一下：这一侧保持转圈，下次翻页再试 */
    } finally {
      busy[side] = false;
    }
  };
  src.get = (i) => {
    const it = slots.get(i);
    return it ? slideOf(it, { ...text, self }) : "loading";
  };
  src.near = (i, refresh) => {
    if (i - lo() < EDGE) void load("older", refresh);
    if (hi() - i < EDGE) void load("newer", refresh);
  };
  return launch(src, text).then(() => true);
}

/** 静态来源：气泡里现成的几张图（没有媒体索引时的退路，不能往前翻、没有定位） */
export function openStaticViewer(slides: ViewerSlide[], start: number, text: ViewerText): Promise<void> {
  return launch({ total: slides.length, start, get: (i) => slides[i] ?? "gone", near: () => undefined }, { t: text.t });
}
