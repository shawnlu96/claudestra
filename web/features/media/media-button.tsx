"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { ImagesIcon } from "./media-icons";
import { MediaPanel } from "./media-panel";

const SIDEBAR_ICON_BTN = "flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content";

/** 侧栏头部的「图片与文件」入口：全部会话（可在面板里再按会话筛），样式与旁边的用量 / 设置按钮一致 */
export function SidebarMediaButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = t("图片与文件");
  return (
    <>
      <button className={SIDEBAR_ICON_BTN} title={label} aria-label={label} onClick={() => setOpen(true)}>
        <ImagesIcon />
      </button>
      {open && <MediaPanel onClose={() => setOpen(false)} />}
    </>
  );
}
