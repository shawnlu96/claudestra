"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { AgentSession } from "../chat/type";
import { TerminalModal } from "./terminal-modal";
import { TerminalPage } from "./terminal-page";
import { useT } from "@/lib/i18n";

/** 终端：>_ 提示符图标（顶栏平铺按钮与窄屏折叠菜单项共用） */
export function TerminalIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

const TERMINAL_HASH = "#terminal";
const isTerminalHash = () =>
  typeof window !== "undefined" &&
  window.location.hash.split("?")[0] === TERMINAL_HASH;
/** 与 chat.tsx 的 isNarrow 同一断点：< sm(640px) 走 hash 路由页 */
const isNarrow = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 639.98px)").matches;

/** 顶栏平铺的终端入口按钮，只管触发；状态在 useTerminalEntry */
export function TerminalButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content"
      title={t("打开远程终端（实时镜像 + 可输入）")}
      aria-label={t("打开远程终端")}
      onClick={onClick}
    >
      <TerminalIcon />
    </button>
  );
}

/**
 * 会话详情顶栏的「终端」入口状态（master 也可用——它同样有 tmux window）。
 * 入口可以有两个（宽屏平铺按钮 / 窄屏折叠菜单项），都调这里的 open；状态只能有
 * 一份——恢复标记只该消费一次、popstate 只该接一次，所以做成 hook 而不是按钮组件。
 *
 * 形态分流（owner 2026-07-11）：
 * - 窄屏（手机）：hash 伪路由 #terminal 全屏页，左滑/返回键退出
 *   （pushState + popstate，与 #chat 会话页同一套导航栈）。
 * - 宽屏（桌面）：大模态框。
 */
export function useTerminalEntry(agent: AgentSession): { available: boolean; open: () => void; view: ReactNode } {
  const [openModal, setOpenModal] = useState(false);
  const [openPage, setOpenPage] = useState(false);

  // 左滑/系统返回：hash 离开 #terminal 即关页
  useEffect(() => {
    if (!openPage) return;
    const onPop = () => {
      if (!isTerminalHash()) setOpenPage(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openPage]);

  // [iOS PWA] 冷恢复(整页重载)时 #terminal 悬空被 chat.tsx 降级,同时留下恢复
  // 标记——挂载后自动重开终端页,回到用户离开时的位置(2026-07-14 owner:
  // 「终端的重连从来没成功过,每次点过去都是点到聊天框里」)。
  useEffect(() => {
    if (agent.status !== "active" || !isNarrow()) return;
    try {
      const raw = sessionStorage.getItem("cstra_term_restore");
      if (!raw) return;
      sessionStorage.removeItem("cstra_term_restore");
      if (Date.now() - Number(raw) > 60_000) return; // 陈旧标记(非本次恢复)不消费
      if (!isTerminalHash()) window.history.pushState(null, "", TERMINAL_HASH);
      setOpenPage(true);
    } catch {
      /* 隐私模式等 sessionStorage 不可用 */
    }
  }, [agent.status]);

  const open = () => {
    if (isNarrow()) {
      if (!isTerminalHash()) window.history.pushState(null, "", TERMINAL_HASH);
      setOpenPage(true);
    } else {
      setOpenModal(true);
    }
  };

  // 显式返回按钮：出栈（与左滑同一条路径，保持历史栈干净）
  const closePage = () => {
    if (isTerminalHash()) window.history.back();
    else setOpenPage(false);
  };

  // 入口只在 active 时给;已打开的终端页不随 status 抖动卸载——agents 轮询数据
  // 瞬时异常(bridge 重启窗口)不该让用户被丢回聊天页,agent 真停了终端流自己会
  // exit 并给出「已结束」遮罩
  const view = agent.mock ? null : (
    <>
      {openModal && (
        <TerminalModal
          agent={agent.name}
          displayName={agent.displayName}
          onClose={() => setOpenModal(false)}
        />
      )}
      {openPage && (
        <TerminalPage
          agent={agent.name}
          displayName={agent.displayName}
          onClose={closePage}
        />
      )}
    </>
  );
  return { available: agent.status === "active" && !agent.mock, open, view };
}
