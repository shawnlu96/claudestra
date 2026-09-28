"use client";
import { useEffect, useState } from "react";
import { mediaRawUrl, type MediaItem, type MediaQuery } from "@/lib/api/media";
import { uiAgentName } from "@/lib/chat/agents";
import { useT } from "@/lib/i18n";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { fetchAuthBlob, saveBlob } from "../chat/components/auth-img";
import { ResponsiveShell } from "../chat/components/responsive-shell";
import { fmtTs } from "../chat/fmt-time";
import { MediaFilters, type MediaFilterState } from "./media-filters";
import { BackIcon, CloseIcon } from "./media-icons";
import { FileList, ImageGrid } from "./media-items";
import { previewable, sinceOf } from "./media-logic";
import { openMediaViewer } from "./media-viewer";
import { useMediaList } from "./use-media-list";

/**
 * 「图片与文件」视图（owner 2026-09-28「能看到聊天中有哪些图片和文件，方便定位到所在的会话」）。
 * 入口两个：会话顶栏（agent = 本会话）与侧栏（不传 agent = 全部会话，可再按会话筛）。
 * 图片页签是按天分组的缩略图网格，点开进大图查看器、左右翻限定在当前筛选结果里；文件页签是列表，点开预览或下载。
 * 每一项都能「定位到消息」：进那个会话、跳到那条消息并高亮（chat-store.jumpToContext，与搜索跳转同一条路）。
 */
function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

async function openFile(item: MediaItem): Promise<void> {
  // 预览要在点击的同一拍里开窗口，await 之后再开会被浏览器当弹窗拦掉
  const win = previewable(item.name) ? window.open("about:blank", "_blank") : null;
  try {
    const blob = await fetchAuthBlob(mediaRawUrl(item.id));
    if (win) win.location.href = URL.createObjectURL(blob);
    else saveBlob(blob, item.name);
  } catch {
    win?.close(); // 取不到（刚被清理 / 权限变了）：关掉空白页，列表下次刷新会显示「文件已不在」
  }
}

function toQuery(f: MediaFilterState, q: string): MediaQuery {
  const cat = f.tab === "file" && f.cat ? f.cat : undefined;
  return { agent: f.pick || undefined, kind: f.tab, q: q || undefined, dir: f.dir || undefined, cat, since: sinceOf(f.range) };
}

export function MediaPanel({ agent, onClose }: { agent?: string; onClose: () => void }) {
  const t = useT();
  const store = useChatStoreApi();
  const agents = useChatStore((s) => s.state.agents);
  const [f, setF] = useState<MediaFilterState>({ tab: "image", q: "", pick: agent ?? "", dir: "", cat: "", range: "all" });
  const dq = useDebounced(f.q.trim(), 300);
  const query = toQuery(f, dq);
  const { items, total, fresh, error, building, loading, retry, endMarker } = useMediaList(query, JSON.stringify({ ...query, since: f.range }));

  // 桌面 Esc 关面板；大图查看器开着时 Esc 归它（PhotoSwipe 自己关），面板不跟着关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".pswp") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const locate = (it: MediaItem) => {
    void store.openAgent(uiAgentName(it.agent)).then(() => store.jumpToContext(it.sessionId, it.seq));
    onClose();
  };
  const caption = (it: MediaItem) => {
    const who = it.dir === "in" ? t("我发的") : uiAgentName(it.agent);
    return [who, !agent && it.dir === "in" ? uiAgentName(it.agent) : "", fmtTs(it.ts ?? undefined)].filter(Boolean).join(" · ");
  };
  const openImage = (it: MediaItem) => void openMediaViewer(query, { around: it.id }, { t, caption, onLocate: locate });

  return (
    <ResponsiveShell z="z-50" panelClass="sm:max-w-3xl sm:h-[82dvh]" onClose={onClose}>
      <div className="flex shrink-0 flex-col gap-2 border-b border-base-300 px-3 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost btn-sm -ml-1 px-2 sm:hidden" onClick={onClose} aria-label={t("关闭")}>
            <BackIcon size={22} />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t("图片与文件")}
            <span className="ml-1.5 font-normal text-base-content/45">{agent ? uiAgentName(agent) : t("全部会话")}</span>
          </div>
          <button className="btn btn-ghost btn-sm btn-square max-sm:hidden" onClick={onClose} aria-label={t("关闭")}>
            <CloseIcon />
          </button>
        </div>
        <MediaFilters f={f} set={(p) => setF((cur) => ({ ...cur, ...p }))} agents={agent ? undefined : agents} />
      </div>
      <div className="flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2 py-1" style={{ WebkitOverflowScrolling: "touch", paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}>
        {!!items?.length && <div className="px-1 pt-1 text-xs text-base-content/45">{t("共 {n} 项", { n: total })}</div>}
        {building && <div className="px-1 py-1 text-xs text-base-content/45">{t("正在整理历史里的图片和文件，第一次会慢一些…")}</div>}
        {error && (
          <div className="px-3 py-8 text-center text-sm text-base-content/50">
            {t("加载失败")}
            <button className="btn btn-ghost btn-xs ml-2" onClick={retry}>
              {t("重试")}
            </button>
          </div>
        )}
        {fresh && items?.length === 0 && !building && (
          <div className="px-3 py-10 text-center text-sm text-base-content/40">{f.tab === "image" ? t("没有符合条件的图片") : t("没有符合条件的文件")}</div>
        )}
        {items && f.tab === "image" && <ImageGrid items={items} onOpen={openImage} />}
        {items && f.tab === "file" && <FileList items={items} showAgent={!agent} onOpen={(it) => void openFile(it)} onLocate={locate} />}
        <div ref={endMarker} className="h-8" />
        {loading && (
          <div className="flex justify-center py-3">
            <span className="loading loading-spinner loading-sm text-base-content/40" />
          </div>
        )}
      </div>
    </ResponsiveShell>
  );
}
