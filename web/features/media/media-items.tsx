"use client";
import { useEffect, useRef, useState } from "react";
import { mediaThumbUrl, type MediaItem } from "@/lib/api/media";
import { uiAgentName } from "@/lib/chat/agents";
import { useT } from "@/lib/i18n";
import { fmtTs } from "../chat/fmt-time";
import { dayLabel, extBadge, fmtSize, groupByDay, whoLabel } from "./media-logic";
import { DownloadIcon, ImageOffIcon, LocateIcon } from "./media-icons";
import { useBlobUrl } from "./use-blob-url";

/* 图片网格（按天分组）与文件列表。缩略图是服务端生成的 360px JPEG；格子离视口近了才取，远了就卸掉、回收 object URL（翻几百张也不涨内存）。 */

/** 离视口 1200px 以内才挂图；不可用的项直接给占位 */
function Thumb({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { src, error: err } = useBlobUrl(near && item.available ? mediaThumbUrl(item.id) : null);
  const noThumb = item.available && err === "unconvertible";
  const tip = item.restricted ? t("这张图来源不唯一，只有管理设备能查看") : noThumb ? t("无法生成缩略图") : !item.available || err ? t("文件已不在本机") : item.name;
  return (
    <button
      ref={ref}
      type="button"
      title={tip}
      onClick={onOpen}
      className="relative aspect-square overflow-hidden rounded-md bg-base-300/70 outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {item.available && !err && src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={item.name} className="h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1 text-center text-base-content/30">
          {(!item.available || err) && <ImageOffIcon size={22} />}
          {noThumb && <span className="text-[10px] leading-3 text-base-content/45">{t("无法生成缩略图")}</span>}
        </span>
      )}
      {item.dir === "out" && <span className="absolute bottom-1 left-1 rounded bg-black/45 px-1 text-[10px] leading-4 text-white/90">{uiAgentName(item.agent)}</span>}
    </button>
  );
}

function DayTitle({ day }: { day: string }) {
  const t = useT();
  const l = dayLabel(day);
  return <div className="sticky top-0 z-[1] bg-base-100/95 px-1 py-1.5 text-xs font-medium text-base-content/55 backdrop-blur">{l.key ? t(l.key) : l.text || t("未知时间")}</div>;
}

export function ImageGrid({ items, onOpen }: { items: MediaItem[]; onOpen: (item: MediaItem) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {groupByDay(items).map((g) => (
        <section key={g.day || "none"}>
          <DayTitle day={g.day} />
          <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
            {g.items.map((it) => (
              <Thumb key={it.id} item={it} onOpen={() => onOpen(it)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 文件一行：类型徽标 · 名字 · 大小 / 时间 / 会话 / 谁发的；右侧 预览或下载、定位到消息（会话已不在时不给定位） */
function FileRow({ item, showAgent, self, onOpen, onLocate }: { item: MediaItem; showAgent: boolean; self: ReadonlySet<string>; onOpen: () => void; onLocate?: () => void }) {
  const t = useT();
  const who = item.dir === "in" ? whoLabel(item, self, t) : t("{agent} 发的", { agent: uiAgentName(item.agent) });
  const meta = [fmtSize(item.size), fmtTs(item.ts ?? undefined), showAgent && item.dir === "in" ? uiAgentName(item.agent) : "", who].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-200/70">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-base-300/70 text-[10px] font-semibold tracking-wide text-base-content/60">{extBadge(item.name)}</span>
      <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-default" onClick={onOpen} disabled={!item.available}>
        <div className={`truncate text-sm ${item.available ? "" : "text-base-content/40 line-through"}`}>{item.name}</div>
        <div className="truncate text-xs text-base-content/50">{item.available ? meta : `${meta} · ${item.restricted ? t("仅管理设备可取") : t("文件已不在本机")}`}</div>
      </button>
      {item.available && (
        <button type="button" className="btn btn-ghost btn-sm btn-square text-base-content/60" title={t("预览或下载")} aria-label={t("预览或下载")} onClick={onOpen}>
          <DownloadIcon />
        </button>
      )}
      {onLocate && (
        <button type="button" className="btn btn-ghost btn-sm btn-square text-base-content/60" title={t("定位到消息")} aria-label={t("定位到消息")} onClick={onLocate}>
          <LocateIcon />
        </button>
      )}
    </div>
  );
}

export function FileList(props: { items: MediaItem[]; showAgent: boolean; self: ReadonlySet<string>; onOpen: (it: MediaItem) => void; onLocate: (it: MediaItem) => (() => void) | undefined }) {
  const { items, showAgent, self, onOpen, onLocate } = props;
  return (
    <div className="flex flex-col">
      {groupByDay(items).map((g) => (
        <section key={g.day || "none"}>
          <DayTitle day={g.day} />
          {g.items.map((it) => (
            <FileRow key={it.id} item={it} showAgent={showAgent} self={self} onOpen={() => onOpen(it)} onLocate={onLocate(it)} />
          ))}
        </section>
      ))}
    </div>
  );
}
