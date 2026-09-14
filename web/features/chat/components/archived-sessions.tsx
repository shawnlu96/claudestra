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

interface ArchivedEntry {
  kind: "agent" | "unmanaged";
  id: string;
  /** 归档时的会话 id(s) */
  sessionIds: string[];
  archivedAt: number;
  note?: string;
}

export function ArchivedSessions() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ArchivedEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
              <li key={`${e.kind}:${e.id}`}>
                <div className="flex flex-col gap-0.5 rounded-lg px-1.5 py-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="shrink-0 rounded-full bg-base-100/70 px-1.5 py-0.5 text-[10px] text-base-content/60">
                      {e.kind === "agent" ? t("agent") : t("未纳管")}
                    </span>
                    <span className="truncate text-base-content/80">{e.id}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-base-content/40">
                      {fmtAgo(e.archivedAt)}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-base-content/40">
                    {(e.sessionIds?.length ?? 0)} {t("个会话")}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
