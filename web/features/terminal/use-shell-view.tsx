"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { ApiError } from "@/lib/api/client";
import { closeShell, shellTerminalTarget, shortPath, type ShellInfo } from "@/lib/api/terminal";
import { isNarrow } from "./terminal-button";
import { TerminalModal } from "./terminal-modal";
import { TerminalPage } from "./terminal-page";

const SHELL_HASH = "#shell";
/** 窄屏终端页的恢复标记：iOS PWA 切后台回来常是整页重载，shell 还在服务端活着，照着它重开 */
const RESTORE_KEY = "cstra_shell_open";
const isShellHash = () => window.location.hash.split("?")[0] === SHELL_HASH;

function readRestore(): ShellInfo | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(RESTORE_KEY) ?? "null") as ShellInfo | null;
    return v && typeof v.id === "string" && typeof v.cwd === "string" ? v : null;
  } catch {
    return null; // 隐私模式 / 坏值：不恢复，回到列表页
  }
}

function writeRestore(v: ShellInfo | null): void {
  try {
    if (v) sessionStorage.setItem(RESTORE_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(RESTORE_KEY);
  } catch {
    /* 隐私模式没有 sessionStorage：只是重载后不自动重开 */
  }
}

/**
 * 宿主 shell 的终端视图：窄屏 #shell 伪路由全屏页（左滑 / 返回键退出，同 #terminal），宽屏模态框。
 * 关页只断开 viewer，shell 留着；「关闭此终端」才结束它。onClosed 在视图关掉后调（刷新列表）。
 */
export function useShellView(home: string, onClosed: () => void): { show: (s: ShellInfo) => void; view: ReactNode } {
  const t = useT();
  const [open, setOpen] = useState<{ shell: ShellInfo; page: boolean } | null>(null);
  const page = open?.page ?? false;

  useEffect(() => {
    if (!isShellHash()) return;
    const r = readRestore();
    if (r) setOpen({ shell: r, page: true });
    else window.history.replaceState(null, "", window.location.pathname + window.location.search); // 悬空的 #shell：去掉
  }, []);

  useEffect(() => {
    if (!page) return;
    const onPop = () => {
      if (isShellHash()) return;
      writeRestore(null);
      setOpen(null);
      onClosed();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [page, onClosed]);

  const show = (shell: ShellInfo) => {
    const narrow = isNarrow();
    if (narrow) {
      if (!isShellHash()) window.history.pushState(null, "", SHELL_HASH);
      writeRestore(shell);
    }
    setOpen({ shell, page: narrow });
  };
  const leave = () => {
    if (page && isShellHash()) {
      window.history.back(); // popstate 里收尾，与左滑同一条路
      return;
    }
    setOpen(null);
    onClosed();
  };
  const kill = async () => {
    if (!open || !window.confirm(t("关闭后 shell 和里面正在跑的命令都会结束，确定？"))) return;
    try {
      await closeShell(open.shell.id);
    } catch (e) {
      // 404 = 已经没了（别处关掉 / bridge 重启前就退出），照样关页；其它失败留在页里让人看见
      if (!(e instanceof ApiError && e.status === 404)) {
        window.alert(`${t("关闭失败")}: ${(e as Error).message}`);
        return;
      }
    }
    leave();
  };

  if (!open) return { show, view: null };
  const props = {
    agent: shellTerminalTarget(open.shell.id),
    displayName: shortPath(open.shell.cwd, home) || t("新终端"),
    onClose: leave,
    actions: (
      <button className="btn btn-ghost btn-xs text-[#f38ba8]/90" onClick={() => void kill()}>
        {t("关闭此终端")}
      </button>
    ),
  };
  return { show, view: open.page ? <TerminalPage {...props} /> : <TerminalModal {...props} /> };
}
