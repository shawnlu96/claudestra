"use client";
/**
 * 选图 → 上传到 talk 附件库（/talk/atts，bridge 剥元数据后按内容存）→ 预览条。Chat 输入框和指派事项的作答卡共用：
 * 上传中的半透明，失败的标出来、不随消息发；最多 max 张。
 */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { uploadImage, type TalkAtt } from "@/lib/api/talk";
import { CloseIcon } from "./talk-icons";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export interface PendingImage {
  local: string;
  att: TalkAtt | null;
  error?: string;
}

export function usePendingImages(max = 9) {
  const [atts, setAtts] = useState<PendingImage[]>([]);
  const add = (files: FileList | null) => {
    for (const f of Array.from(files ?? []).slice(0, max - atts.length)) {
      const local = URL.createObjectURL(f);
      setAtts((xs) => [...xs, { local, att: null }]);
      uploadImage(f)
        .then((r) => setAtts((xs) => xs.map((x) => (x.local === local ? { ...x, att: r.att } : x))))
        .catch((e) => setAtts((xs) => xs.map((x) => (x.local === local ? { ...x, error: (e as Error).message } : x))));
    }
  };
  const remove = (a: PendingImage) => (URL.revokeObjectURL(a.local), setAtts((xs) => xs.filter((x) => x !== a)));
  const clear = () => (atts.forEach((a) => URL.revokeObjectURL(a.local)), setAtts([]));
  /** 都传完了（成功或失败）才能发 */
  const ready = atts.every((a) => a.att || a.error);
  const uploaded = atts.flatMap((a) => (a.att ? [a.att] : []));
  return { atts, add, remove, clear, ready, uploaded };
}

export function PendingStrip({ atts, onRemove }: { atts: PendingImage[]; onRemove: (a: PendingImage) => void }) {
  const t = useT();
  if (!atts.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {atts.map((a) => (
        <div key={a.local} className="relative h-16 w-16 overflow-hidden rounded-lg border border-base-300">
          {/* eslint-disable-next-line @next/next/no-img-element -- 本地 object URL 预览，不走 next/image */}
          <img src={a.local} alt="" className={`h-full w-full object-cover ${a.att ? "" : "opacity-50"}`} />
          {a.error && <span className="absolute inset-x-0 bottom-0 bg-error/80 px-1 text-[10px] text-error-content">{t("上传失败")}</span>}
          <button className="absolute right-0.5 top-0.5 rounded-full bg-base-100/80 p-0.5" aria-label={t("移除")} onClick={() => onRemove(a)}>
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
