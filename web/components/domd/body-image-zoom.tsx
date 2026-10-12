"use client";
/**
 * 正文图片点开大图（SafeImg 里一行接线：`Object.assign(props, useBodyImageZoom(...))`，把 ref / 点击 / 键盘入口并进真实 <img>）。
 * - 附件图、data: / blob: 内联图：进 PhotoSwipe（openStaticViewer），同一条消息当前已呈现、已加载成功的正文图按正文顺序左右翻，
 *   底栏「保存」与附件条同一个（../../features/media/body-image-save.ts）。
 * - 已主动加载的外链图：新窗口开原图地址（noopener + noreferrer），由系统浏览器保存；不进查看器、不发 CORS 取图、不带凭据。
 * - 嵌在链接里的图：什么都不加，点图照旧跟随外层链接（已知限制：链接里的图本卡不放大）。
 * 分组边界是消息实例：AssistantBody 用 <BodyImageScope> 包住同一条消息的所有正文段；没有包的（附件预览、入站气泡等单个 Domd）
 * 按所在的 do-md 根节点分组。组在点开那一刻现建：折叠段卸载了就不在、展开后下次打开自然带上，不预取未呈现的图。
 */
import { createContext, useCallback, useContext, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { ImageSrcKind } from "@/lib/chat/md-guard";
import { useT } from "@/lib/i18n";
import { openStaticViewer } from "@/features/media/media-viewer";
import { actionFor, groupFor, type BodyImageEntry } from "./body-image-group";

type Scope = object;
const ScopeCtx = createContext<Scope | null>(null);

/** 一条消息的正文图分组边界（消息实例级：同 id 的另一份渲染是另一个 scope，不串组） */
export function BodyImageScope({ children }: { children: ReactNode }) {
  const [scope] = useState<Scope>(() => ({}));
  return <ScopeCtx.Provider value={scope}>{children}</ScopeCtx.Provider>;
}

/** 已挂载的正文图：元素 → 登记信息（卸载时删掉，重挂 / 流式重建不留重复项） */
const live = new Map<HTMLImageElement, BodyImageEntry & { el: HTMLImageElement; scope: Scope | null }>();

/** do-md 的根节点：没有消息级 scope 时按它分组 */
const domdRoot = (el: Element) => el.closest(".DOMD-Root") ?? el.parentElement;

function peersOf(el: HTMLImageElement): BodyImageEntry[] {
  const me = live.get(el);
  if (!me) return [];
  const root = me.scope ? null : domdRoot(el);
  return [...live.values()].filter((e) => (me.scope ? e.scope === me.scope : !e.scope && domdRoot(e.el) === root));
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 给 <img> 的附加属性；不该有入口的图（链接里 / 外链没加载 / 被拦下）只拿到 ref，className 原样 */
export function useBodyImageZoom(src: { url: string; kind: ImageSrcKind; label: string; load: boolean }, props: Record<string, unknown>) {
  const t = useT();
  const scope = useContext(ScopeCtx);
  const [linked, setLinked] = useState(true); // 挂上之前先当在链接里：首帧不出入口，量过再给
  const { url, kind, label, load } = src;
  const ref = useCallback(
    (el: HTMLImageElement | null) => {
      if (!el) return;
      live.set(el, { el, url, kind, label, scope });
      setLinked(actionFor(kind, el) === "none");
      return () => {
        live.delete(el);
      };
    },
    [url, kind, label, scope],
  );
  const usable = kind === "attachment" || kind === "inline" || (kind === "external" && load);
  if (!usable || linked) return { ref };
  const open = (e: MouseEvent<HTMLImageElement> | KeyboardEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    const act = actionFor(kind, el);
    if (act === "none") return; // 移进链接了（重排）：交给链接
    e.preventDefault();
    e.stopPropagation();
    if (act === "external") return openExternal(url);
    const group = groupFor(peersOf(el), el);
    if (group) void openStaticViewer(group.slides, group.start, { t });
  };
  return {
    ref,
    role: "button",
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: KeyboardEvent<HTMLImageElement>) => (e.key === "Enter" || e.key === " ") && open(e),
    className: [props.className, kind === "external" ? "cursor-pointer" : "cursor-zoom-in"].filter(Boolean).join(" "),
  };
}
