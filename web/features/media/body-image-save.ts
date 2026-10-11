/**
 * 大图查看器「保存」的新适配（media-viewer.ts 的保存按钮只做薄接线；附件条和正文图共用）。
 * - 同一手势：查看器显示时已把图取成 Blob（显示地址就是原图地址时），点「保存」在这次点击的同步调用栈里直接 share，
 *   不先 await 取图——iOS 只在用户手势刚发生时放行 navigator.share。
 * - 缓存没有才现取；现取完手势已失效（blocked）就提示「再点一次保存」，取到的 Blob 留着，下一次点击直接同步 share。
 * - 普通网页不支持文件分享 → 下载；原生壳不做无效下载，下载抛错同样提示截屏；取图失败可见提示，不再当成功。
 * - 用户取消分享不报错、不偷偷下载。
 * 取图 / 下载由调用方注入（auth-img.tsx 带 React，纯逻辑这边不 import 它）。
 */
import { shareFile, type ShareNav } from "../chat/attachment-share";
import { BODY_INLINE_KEY } from "@/components/domd/body-image-group";

export interface SaveDeps {
  fetch: (url: string) => Promise<Blob>;
  save: (blob: Blob, name: string) => void;
  native: () => boolean;
  nav?: ShareNav;
  /** 手势失效后留着的原图（按保存地址）：归属一个查看器实例，关闭时由查看器清空，不跨查看器 / 机器复用 */
  held: Map<string, Blob>;
}

export interface SaveSlide {
  key: string;
  saveUrl: string;
  name: string;
}

/** 保存之后要给的提示：再点一次 / 这台设备存不了 / 取不到原图；null = 已交给系统（分享、取消、下载） */
export type SaveNotice = "retry" | "nosave" | "failed";

export const NOTICE_TEXT: Record<SaveNotice, string> = {
  retry: "再点一次保存",
  nosave: "这台设备不能保存图片，可以截屏",
  failed: "保存失败",
};

const OCTET = "application/octet-stream";
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
};

/**
 * 交给分享 / 下载的文件：附件和媒体索引原名原样；正文内联图（image-n）按实际 MIME 补扩展名，
 * MIME 缺失或认不出时不冒充 PNG，按二进制类型给 .bin。没有名字的沿用旧口径 image.png。
 */
export function fileFor(slide: SaveSlide, blob: Blob): { blob: Blob; name: string } {
  if (!slide.key.startsWith(BODY_INLINE_KEY)) return { blob, name: slide.name || "image.png" };
  const type = blob.type.split(";")[0].trim().toLowerCase();
  const ext = EXT[type];
  if (ext) return { blob, name: `${slide.name}.${ext}` };
  return { blob: blob.type === OCTET ? blob : new Blob([blob], { type: OCTET }), name: `${slide.name}.bin` };
}

/** 手势失效后留着的原图（按保存地址），下一次点击直接同步 share；只留最近几张 */
const HELD_MAX = 4;

function hold(held: Map<string, Blob>, url: string, blob: Blob): void {
  held.delete(url);
  held.set(url, blob);
  while (held.size > HELD_MAX) held.delete(held.keys().next().value!);
}

/** 手里已有 Blob：shareFile 在这一调用栈里同步调到 navigator.share（async 函数在第一个 await 之前同步执行） */
async function deliver(slide: SaveSlide, raw: Blob, deps: SaveDeps): Promise<SaveNotice | null> {
  const { blob, name } = fileFor(slide, raw);
  const r = await shareFile(blob, name, undefined, deps.nav);
  if (r === "blocked") {
    hold(deps.held, slide.saveUrl, raw);
    return "retry";
  }
  deps.held.delete(slide.saveUrl);
  if (r !== "unsupported") return null; // shared / cancelled：用户自己关了分享面板也不算失败、不改下载
  if (deps.native()) return "nosave"; // 壳不处理 WKDownload，下载就是点了没反应
  try {
    deps.save(blob, name);
    return null;
  } catch {
    return "nosave"; // 下载都发不起来：和壳里一样提示截屏，不当成功
  }
}

/** decoded：查看器已解码的这张图（显示地址等于原图地址时才给），没有就看留着的，再没有才现取 */
export function saveSlide(slide: SaveSlide, decoded: Blob | undefined, deps: SaveDeps): Promise<SaveNotice | null> {
  const ready = decoded ?? deps.held.get(slide.saveUrl);
  if (ready) return deliver(slide, ready, deps);
  return deps.fetch(slide.saveUrl).then(
    (b) => deliver(slide, b, deps),
    (): SaveNotice => "failed",
  );
}

/** 保存按钮与提示框（根 tsconfig 不带 DOM 类型，按用到的几项写） */
type NoticeBox = { className: string; textContent: string | null; style: { cssText: string }; setAttribute(k: string, v: string): void; remove(): void };
/** appendChild 写成 never：真元素的参数是泛型 Node，结构类型对不上，挂的确实是 createElement 出来的 div */
type NoticeEl = { parentElement: { appendChild(n: never): unknown } | null; ownerDocument: { createElement(tag: "div"): NoticeBox } };
const flashing = new WeakMap<object, { box: NoticeBox; timer: ReturnType<typeof setTimeout> }>();

/**
 * 提示放在顶栏下沿的独立浮层（挂在顶栏里，随顶栏让出安全区），不塞进 50px 的按钮：
 * 按钮会被顶栏 flex 挤窄、自带 overflow:hidden，窄屏上长提示被裁、计数被挤换行。浮层不占顶栏宽度，过长就换行。
 */
export const NOTICE_CSS =
  "position:absolute;top:100%;right:8px;max-width:calc(100% - 16px);padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.75);" +
  "color:#fff;font-size:12px;line-height:1.4;white-space:normal;overflow-wrap:anywhere;pointer-events:none";

/** 顶栏下沿弹一行提示，4 秒后消失；按钮图标不动，提示期间再点照常保存 */
export function flashNotice(el: NoticeEl, text: string): void {
  const was = flashing.get(el);
  if (was) (clearTimeout(was.timer), was.box.remove());
  const bar = el.parentElement;
  if (!bar) return;
  const box = el.ownerDocument.createElement("div");
  box.className = "pswp__save-notice";
  box.setAttribute("role", "status");
  box.style.cssText = NOTICE_CSS;
  box.textContent = text;
  bar.appendChild(box as never);
  const timer = setTimeout(() => (box.remove(), flashing.delete(el)), 4000);
  flashing.set(el, { box, timer });
}

/** 查看器保存按钮的一次点击：取图失败 / 手势失效 / 存不了都给可见提示 */
export function saveFromViewer(slide: SaveSlide, decoded: Blob | undefined, el: NoticeEl, t: (s: string) => string, deps: SaveDeps): Promise<void> {
  return saveSlide(slide, decoded, deps).then((n) => {
    if (n) flashNotice(el, t(NOTICE_TEXT[n]));
  });
}
