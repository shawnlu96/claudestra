"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { PeersModal } from "./peers-modal";

/**
 * 侧栏顶部的 Peer 入口（owner 2026-09-24「把 Peer 做成一个单独的按钮，不要藏在设置里」）：
 * 在线列表、邀请、加入都在这个弹窗里。样式与同排的项目 / 用量 / 设置按钮一致。
 */
export function PeersButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
        title={t("Peer 协作")}
        aria-label={t("Peer 协作")}
        onClick={() => setOpen(true)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </button>
      <PeersModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
