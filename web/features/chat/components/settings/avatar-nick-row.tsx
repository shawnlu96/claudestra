"use client";
import { useRef } from "react";
import { useT } from "@/lib/i18n";

/** 选中的图片 → 128×128 居中裁剪 jpeg data URL（~10-20KB,存库直出）。 */
async function fileToAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** 一行「头像选择器 + 昵称输入」——我的资料与 Claude 的资料共用。 */
export function AvatarNickRow({
  label,
  fallback,
  avatar,
  nick,
  nickPlaceholder,
  onAvatar,
  onNick,
  onError,
}: {
  label: string;
  fallback: string;
  avatar: string;
  nick: string;
  nickPlaceholder: string;
  onAvatar: (v: string) => void;
  onNick: (v: string) => void;
  onError: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();
  return (
    <div className="mb-2.5 flex items-center gap-3">
      <span className="w-12 shrink-0 text-xs text-base-content/50">{label}</span>
      <button
        className="group relative size-11 shrink-0 overflow-hidden rounded-full border border-base-300 bg-base-200"
        title={t("选择头像(再点一次图可移除)")}
        onClick={() => {
          if (avatar) onAvatar("");
          else fileRef.current?.click();
        }}
      >
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-base opacity-40">{fallback}</span>
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/40 text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {avatar ? t("移除") : t("选图")}
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          fileToAvatar(f).then(onAvatar).catch(onError);
          e.target.value = "";
        }}
      />
      <input
        type="text"
        value={nick}
        onChange={(e) => onNick(e.target.value)}
        placeholder={nickPlaceholder}
        maxLength={32}
        autoComplete="off"
        className="input input-bordered input-sm w-full text-sm"
      />
    </div>
  );
}
