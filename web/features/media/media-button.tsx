"use client";
import { useState, type ReactNode } from "react";
import { MediaPanel } from "./media-panel";

/**
 * 「我的」里的「图片与文件」（NAVBAR1 起从侧栏顶栏的图标按钮挪进去）：全部会话（可在面板里再按会话筛）。
 * 不像管理类那样只给全权设备（useFullScope）：/media 按 scope 过滤、非全权只给可信文件，guest 也能用。node = 面板，调用方常挂。
 */
export function useMediaEntry(): { open: () => void; node: ReactNode } {
  const [open, setOpen] = useState(false);
  return { open: () => setOpen(true), node: open && <MediaPanel onClose={() => setOpen(false)} /> };
}
