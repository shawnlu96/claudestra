"use client";
/**
 * 侧栏「归档」栏（v2.23+）。
 *
 * owner 2026-09-14 两次纠正后的语义：**这里只放"我们手动归档过的"**。
 * 数据源是桥接的**归档台账**（~/.claude-orchestrator/archived.json），
 * 不是归档目录 —— 目录里还有每日兜底给在跑 agent 做的安全快照、退役自动快照，
 * 那是防丢机制，不是"归档"（直接列目录会让这一栏冒充成"所有会话"）。
 * 归档动作 = 快照 + 停掉 agent/挪走会话文件；agent 的注册表条目保留，
 * 之后仍可 `manager resume <name> <sessionId>` 恢复。
 */
import { useCallback, useEffect, useState } from "react";
import { fmtAgo } from "../fmt-time";
import { useT } from "@/lib/i18n";
import { SwipeActions } from "./unmanaged-sessions";

interface ArchivedEntry {
  /** agent 名或会话 id（「归档」区里的目录名） */
  id: string;
  /** 里面有多少个会话文件 */
  sessions: number;
  bytes: number;
  archivedAt: number;
}

function fmtBytes(n: number): string {
  if (!n) return "0";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

export function ArchivedSessions() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ArchivedEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  /** 回归：agent 走 resume 回工作列表；未纳管会话把文件搬回原位（重回未纳管列表）。 */
  const restore = async (id: string) => {
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(`/api/sessions/archived/${encodeURIComponent(id)}/restore`, {
        method: "POST",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
      // agent 的恢复是异步受理（起窗口 + CC 冷启动 1-2 分钟），先给个提示再刷新
      setError("");
      await load();
      setTimeout(() => void load(), 90_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/sessions/archived");
      const json = (await res.json()) as { data?: { entries?: ArchivedEntry[] }; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setEntries(json.data?.entries ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const count = entries.length;

  return (
    <li className="mx-2 mt-1 rounded-xl bg-base-300/25 p-1 list-none">
      <div className="flex w-full items-center">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm font-medium"
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-base-content/40 transition-transform ${open ? "" : "-rotate-90"}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span className="shrink-0 text-[13px] opacity-80">🗄</span>
          <span className="truncate">{t("归档")}</span>
          <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/40">
            {count}
          </span>
        </button>
        {open ? (
          <button
            type="button"
            className="grid size-9 shrink-0 touch-manipulation place-items-center rounded-md text-base text-base-content/45"
            title={t("刷新")}
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation();
              void load();
            }}
          >
            ⟳
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="pb-1">
          {error ? (
            <div className="px-1.5 py-2 text-xs text-error break-words">{t("读取失败")}: {error}</div>
          ) : null}
          {!loading && !error && count === 0 ? (
            <div className="px-1.5 py-2 text-xs text-base-content/40">{t("归档是空的")}</div>
          ) : null}
          <ul className="max-h-64 overflow-y-auto">
            {entries.map((e) => (
              <li key={e.id}>
                {/* 左滑「恢复」：归档是类别，进来之后要能回去（owner 2026-09-14） */}
                <SwipeActions
                  actions={[
                    {
                      label: busyId === e.id ? t("…") : t("恢复"),
                      className: "bg-primary/80 text-primary-content",
                      onClick: () => void restore(e.id),
                    },
                  ]}
                >
                <div className="flex flex-col gap-0.5 rounded-lg bg-base-100 px-1.5 py-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="shrink-0 text-[13px] opacity-70">📦</span>
                    <span className="truncate text-base-content/80">{e.id}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-base-content/40">
                      {fmtAgo(e.archivedAt)}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-base-content/40">
                    {(e.sessions ?? 0)} {t("个会话")} · {fmtBytes(e.bytes ?? 0)}
                  </span>
                </div>
                </SwipeActions>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
