/**
 * 大图查看器（owner 2026-09-28「点开一张图片，可以一直往前翻」）：PhotoSwipe 动态数据源 + 媒体索引分页。
 * 正序排列（左 = 更早），numItems = 筛选结果总数，下标没加载到的先出转圈、离已加载边界 EDGE 张以内就往那头补一页；
 * 显示版走服务端 ?display=1（HEIC 可看、走中继省流量），保存 / 分享取原图。PhotoSwipe 保留（owner 2026-07-14 选定），
 * 手势：捏合 / 双击缩放、下拉关闭、单击关闭，桌面方向键左右翻。
 * 两种来源：媒体索引（openMediaViewer）与气泡里现成的几张图（openStaticViewer，旧 bridge 没有 /media 时的退路）。
 */
import type PhotoSwipe from "photoswipe";
import type { SlideData } from "photoswipe";
import { listMedia, mediaRawUrl, type MediaCursor, type MediaItem, type MediaPage, type MediaQuery } from "@/lib/api/media";
import { uiAgentName } from "@/lib/chat/agents";
import { fetchAuthBlob, resolveAuthUrl, saveBlob } from "../chat/components/auth-img";
import { fmtTs } from "../chat/fmt-time";
import { placePage, wantsDisplayVariant } from "./media-logic";

const PAGE = 40;
const EDGE = 4;

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
    const file = new File([blob], name || "image.png", { type: blob.type || "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    saveBlob(blob, file.name);
  } catch {
    /* 用户取消分享面板也会 throw；取不到原图时查看器里什么也不做，不弹错 */
  }
}

/** 已解码的尺寸（PhotoSwipe 要宽高才能排版）：object URL → naturalWidth/Height */
const dims = new Map<string, { src: string; w: number; h: number }>();
function decode(url: string): Promise<{ src: string; w: number; h: number }> {
  const hit = dims.get(url);
  if (hit) return Promise.resolve(hit);
  return resolveAuthUrl(url).then(
    (src) =>
      new Promise((ok, fail) => {
        const img = new Image();
        img.onload = () => {
          const d = { src, w: img.naturalWidth || 1600, h: img.naturalHeight || 1200 };
          dims.set(url, d);
          ok(d);
        };
        img.onerror = () => fail(new Error("decode"));
        img.src = src;
      }),
  );
}

function slideOf(item: MediaItem, text: ViewerText): ViewerSlide {
  return {
    key: item.id,
    url: mediaRawUrl(item.id, wantsDisplayVariant(item.name)),
    saveUrl: mediaRawUrl(item.id),
    name: item.name,
    caption: text.caption?.(item) ?? [item.dir === "in" ? text.t("我发的") : uiAgentName(item.agent), fmtTs(item.ts ?? undefined)].join(" · "),
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
  const refresh = (indexes: number[]) => indexes.forEach((i) => pswp.refreshSlideContent(i));
  pswp.addFilter("numItems", () => src.total);
  pswp.addFilter("itemData", (_d: SlideData, i: number): SlideData => {
    const s = src.get(i);
    if (s === "loading") return { html: SPINNER };
    if (s === "gone") return { html: note(text.t("文件已不在本机")) };
    if (s.item && !s.item.available) return { html: note(text.t(s.item.restricted ? "这张图来源不唯一，只有管理设备能查看" : "文件已不在本机")) };
    const d = dims.get(s.url);
    if (d) return { src: d.src, width: d.w, height: d.h, alt: s.name };
    decode(s.url).then(() => refresh([i]), () => undefined); // 解码失败：这一格留着转圈，旁边的照常翻
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

/** 媒体索引来源：从锚点（媒体 id，或气泡里的文件名 + 会话 + seq）取一窗，翻到边界往两头补页。锚点找不到返回 false */
export async function openMediaViewer(query: MediaQuery, anchor: MediaCursor, text: ViewerText): Promise<boolean> {
  const q: MediaQuery = { ...query, kind: "image" };
  let first: MediaPage;
  try {
    first = await listMedia(q, { ...anchor, limit: PAGE });
  } catch {
    return false; // 404（没进索引 / 旧 bridge 没这个端点）→ 调用方退回气泡里的几张图
  }
  const total = first.total;
  let slots = placePage(new Map(), first);
  const at = [...slots].find(([, it]) => it.id === first.anchor)?.[0] ?? total - 1;
  let older = first.older;
  let newer = first.newer;
  const busy = { older: false, newer: false };
  const lo = () => Math.min(...slots.keys());
  const hi = () => Math.max(...slots.keys());
  const load = async (side: "older" | "newer", refresh: (idx: number[]) => void) => {
    const cursor = side === "older" ? older : newer;
    if (!cursor || busy[side]) return;
    busy[side] = true;
    try {
      const page = await listMedia(q, side === "older" ? { before: cursor, limit: PAGE } : { after: cursor, limit: PAGE });
      const before = new Set(slots.keys());
      slots = placePage(slots, { ...page, total });
      if (side === "older") older = page.older;
      else newer = page.newer;
      refresh([...slots.keys()].filter((k) => !before.has(k)));
    } catch {
      /* 网络抖一下：这一侧保持转圈，下次翻页再试 */
    } finally {
      busy[side] = false;
    }
  };
  return launch(
    {
      total,
      start: at,
      get: (i) => {
        const it = slots.get(i);
        return it ? slideOf(it, text) : "loading";
      },
      near: (i, refresh) => {
        if (i - lo() < EDGE) void load("older", refresh);
        if (hi() - i < EDGE) void load("newer", refresh);
      },
    },
    text,
  ).then(() => true);
}

/** 静态来源：气泡里现成的几张图（没有媒体索引时的退路，不能往前翻、没有定位） */
export function openStaticViewer(slides: ViewerSlide[], start: number, text: ViewerText): Promise<void> {
  return launch({ total: slides.length, start, get: (i) => slides[i] ?? "gone", near: () => undefined }, { t: text.t });
}
