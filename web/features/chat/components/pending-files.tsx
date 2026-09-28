"use client";
import { useEffect } from "react";
import { useT } from "@/lib/i18n";

/**
 * 缩略图的 blob URL：同一个 File 只建一次，移出待发列表就 revoke（D8-3）。
 * 以前在渲染体里直接 createObjectURL——打字、遥测、列表轮询每触发一次重渲染就新建一个
 * URL、缩略图重新解码（iOS 上随打字闪），而且从不 revoke，附过的图整页生命周期都释放不掉。
 * 放模块级而不是 ref：渲染期要读它，ref 在渲染期不能碰；Composer 同时只有一个。
 */
const pendingUrls = new Map<File, string>();
function pendingUrl(f: File): string {
  let u = pendingUrls.get(f);
  if (!u) {
    u = URL.createObjectURL(f);
    pendingUrls.set(f, u);
  }
  return u;
}
function releasePendingUrls(keep: File[]) {
  const live = new Set(keep);
  for (const [f, u] of pendingUrls) {
    if (!live.has(f)) {
      URL.revokeObjectURL(u);
      pendingUrls.delete(f);
    }
  }
}

/** 待发送文件的缩略图 / 文件卡片，点 ✕ 移除。 */
export function PendingFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (i: number) => void;
}) {
  const t = useT();
  // 不做卸载时全清：StrictMode 的假卸载会把还在显示的缩略图 revoke 掉；
  // 残留的会在下一次列表变化（发送清空也算）时一并释放
  useEffect(() => releasePendingUrls(files), [files]);
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-1 pt-3">
      {files.map((f, i) => {
        const isImg = f.type.startsWith("image/");
        return isImg ? (
          <div
            key={i}
            className="group relative size-16 overflow-hidden rounded-lg border border-base-content/10 bg-base-300"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pendingUrl(f)}
              alt={f.name}
              className="size-full object-cover"
            />
            <RemoveBtn onClick={() => onRemove(i)} />
          </div>
        ) : (
          <div
            key={i}
            title={f.name}
            className="group relative flex h-16 w-44 items-center gap-2.5 overflow-hidden rounded-lg border border-base-content/10 bg-base-300 px-3"
          >
            <span className="text-lg">📎</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-base-content/85">
                {f.name}
              </div>
              <div className="text-[10.5px] text-base-content/40">{t("文件")}</div>
            </div>
            <RemoveBtn onClick={() => onRemove(i)} />
          </div>
        );
      })}
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("移除")}
      aria-label={t("移除")}
      className="absolute right-0.5 top-0.5 flex size-[18px] items-center justify-center rounded-full bg-black/60 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100"
    >
      ✕
    </button>
  );
}
