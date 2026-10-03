"use client";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { ApiError } from "@/lib/api/client";
import { machines } from "@/lib/machines";
import { createShell, listShells, shortPath, type ShellInfo, type ShellList } from "@/lib/api/terminal";
import { CenteredModal } from "../chat/components/centered-modal";
import { TerminalIcon } from "./terminal-button";
import { useShellView } from "./use-shell-view";

const SIDEBAR_ICON_BTN = "flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content";
/** 上次选的起始目录（本设备的便利项，丢了就回到第一项） */
const DIR_KEY = "cstra_shell_dir";

function savedDir(): string {
  try {
    return localStorage.getItem(DIR_KEY) ?? "";
  } catch {
    return ""; // 隐私模式：每次从第一项（家目录）开始
  }
}

/** 新终端面板：选起始目录新开一个，或回到已开的（shell 持久，断开不结束） */
function ShellPicker({ list, onClose, onOpen }: { list: ShellList; onClose: () => void; onOpen: (s: ShellInfo) => void }) {
  const t = useT();
  const [dir, setDir] = useState(savedDir);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = list.dirs.some((d) => d.dir === dir) ? dir : (list.dirs[0]?.dir ?? "");
  const full = list.shells.length >= list.max;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose(); // 桌面 Esc 关，同 collab-detail / media-panel
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const { shell } = await createShell(chosen || undefined);
      try {
        localStorage.setItem(DIR_KEY, chosen);
      } catch {
        /* 隐私模式：下次不记得目录而已 */
      }
      onOpen(shell);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredModal layer="base" onClose={onClose}>
      <header className="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 py-3">
        <span className="font-semibold">{t("新终端")}</span>
        <button className="btn btn-ghost btn-sm ml-auto" aria-label={t("关闭")} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-xs text-base-content/60">{t("在这台机器上开一个 shell，粘贴命令直接跑")}</p>
        <div className="flex items-center gap-2">
          <select className="select select-sm min-w-0 flex-1" aria-label={t("起始目录")} value={chosen} onChange={(e) => setDir(e.target.value)}>
            {list.dirs.map((d) => (
              <option key={d.dir} value={d.dir}>
                {d.label === "~" ? "~" : `${d.label} (${shortPath(d.dir, list.home)})`}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" disabled={busy || full || !list.dirs.length} onClick={() => void create()}>
            {t("新开一个")}
          </button>
        </div>
        {full && <p className="text-xs text-warning">{t("最多同时开 {n} 个终端，先关掉一个", { n: list.max })}</p>}
        {err && <p className="text-xs break-all text-error">{err}</p>}
        <div className="text-xs text-base-content/50">{t("已开的终端（断开不会结束，可以回来接着用）")}</div>
        {list.shells.length ? (
          list.shells.map((s) => (
            <button key={s.id} className="btn btn-ghost btn-sm justify-start truncate font-mono" onClick={() => onOpen(s)}>
              {shortPath(s.cwd, list.home) || s.id}
            </button>
          ))
        ) : (
          <div className="text-sm text-base-content/40">{t("还没有开着的终端")}</div>
        )}
      </div>
    </CenteredModal>
  );
}

/**
 * 侧栏头部的「新终端」：在这台机器上开宿主 shell（bridge/web-shell.ts），手机上粘贴命令直接跑。
 * 入口只在 GET /shells 答 200 时出现：403（没有覆盖 master 的终端授予）、404（bridge 太老）都不给入口。
 */
export function SidebarShellButton() {
  const t = useT();
  const [list, setList] = useState<ShellList | null>(null);
  const [picker, setPicker] = useState(false);

  const refresh = useCallback(() => {
    const fp = machines.currentFp();
    listShells().then(
      (l) => machines.currentFp() === fp && setList(l),
      // 403 / 404 = 这台机器不给入口；其它失败（网络抖动、bridge 重启）留着上一份，回前台再问
      (e) => machines.currentFp() === fp && e instanceof ApiError && (e.status === 403 || e.status === 404) && setList(null),
    );
  }, []);
  useEffect(() => {
    let fp = machines.currentFp();
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    const unsub = machines.subscribe(() => {
      if (machines.currentFp() === fp) return;
      fp = machines.currentFp();
      setList(null);
      refresh();
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      unsub();
    };
  }, [refresh]);

  const { show, view } = useShellView(list?.home ?? "", refresh);
  return (
    <>
      {list && (
        <button className={SIDEBAR_ICON_BTN} title={t("新终端（在这台机器上开 shell）")} aria-label={t("新终端")} onClick={() => (setPicker(true), refresh())}>
          <TerminalIcon />
        </button>
      )}
      {picker && list && (
        <ShellPicker
          list={list}
          onClose={() => setPicker(false)}
          onOpen={(s) => {
            setPicker(false);
            show(s);
            refresh();
          }}
        />
      )}
      {view}
    </>
  );
}
