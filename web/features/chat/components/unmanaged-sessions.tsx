"use client";
import { useCallback, useEffect, useState } from "react";
import { fmtAgo } from "../fmt-time";
import { useT } from "@/lib/i18n";

/**
 * 侧栏「未纳管会话」分区（v2.23+）。
 *
 * 侧栏原来只列**纳管**的 agent（有频道、能对话）。但机器上还有一堆没纳管的会话：
 * pi-web 起的 Pi 会话、终端里手敲的 `pi`/`claude`、别人的会话……它们此前在网页里
 * 完全不可见。这个分区把它们摆出来 —— **能看历史、能收编**，但**不能直接对话**
 * （没挂 Claudestra 扩展就没有消息注入通道，这是硬边界，收编后才可对话）。
 *
 * 数据源：BFF /api/sessions（代理 Bridge GET /api/v1/session-list，manager 扫盘得到，
 * 两种 runtime 合并、按最近活动排序）。
 */

interface SessionRow {
  sessionId: string;
  name: string;
  slug: string;
  project: string;
  cwd: string;
  runtime: string;
  age: string;
  modifiedAt: string;
  lastMessage: string;
  agentName: string | null;
}

interface HistoryTool {
  name: string;
  summary: string;
  detail?: string;
  error?: boolean;
}

interface HistoryMsg {
  seq: number;
  ts?: string;
  role: "user" | "assistant" | "system";
  text?: string;
  tools?: HistoryTool[];
}

/**
 * 运行时徽章：Claude Code 不标（它是默认），Pi 标出来 —— 两者行为差异大，该看得见。
 * v2.23+ 导出给侧栏 agent 行复用，保证「未纳管会话」与 agent 列表是同一套视觉语言。
 */
export function RuntimeBadge({ runtime, className = "" }: { runtime: string; className?: string }) {
  if (runtime !== "pi") return null;
  return (
    <span className={`badge badge-xs border-primary/40 bg-primary/10 text-[10px] text-primary ${className}`}>
      Pi
    </span>
  );
}

export function UnmanagedSessions() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<SessionRow | null>(null);

  /** 拉一次会话清单（纯取数，不改状态）——挂载 effect 与 load() 共用一份 */
  const fetchSessions = useCallback(async (): Promise<SessionRow[]> => {
    const res = await fetch("/api/sessions");
    const json = (await res.json()) as {
      data?: { sessions?: SessionRow[] };
      error?: string;
    };
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data?.sessions ?? [];
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSessions(await fetchSessions());
    } catch (e) {
      setError((e as Error).message);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [fetchSessions]);

  // 折叠头要显示条数 ⇒ 挂载时拉一次（只有这一发；之后靠展开/刷新/收编后重拉，不轮询）。
  // 这里**不直接调 load()**：它开头会同步 setLoading(true)，在 effect 里同步 setState
  // 会触发 react-hooks/set-state-in-effect（级联渲染）。绕过方式就是让状态更新只发生
  // 在 promise 回调里（规则本身推荐的做法）。
  useEffect(() => {
    let cancelled = false;
    void fetchSessions()
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchSessions]);

  const count = sessions.filter((s) => s.agentName === null).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  const unmanaged = sessions.filter((s) => !s.agentName);

  return (
    <li className="mx-2 mt-1 rounded-xl bg-base-300/25 p-1 list-none">
      <div className="flex w-full items-center">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] font-medium tracking-wide text-base-content/55 transition-colors hover:text-base-content/85"
          onClick={toggle}
          aria-expanded={open}
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
          <span className="shrink-0 text-[13px] opacity-80">{open ? "🗂" : "🗂"}</span>
          <span className="truncate">{t("未纳管会话")}</span>
          {/* 折叠态也给计数：不给条数用户没有点开的动机（视觉审查 P1） */}
          {count !== null ? (
            <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/40">{count}</span>
          ) : loading ? (
            <span className="ml-auto loading loading-spinner loading-xs" />
          ) : null}
        </button>
        {open ? (
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 text-sm text-base-content/40 transition-colors hover:text-base-content/80"
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
            <div className="px-1.5 py-2 text-xs text-error break-words">
              {t("读取失败")}: {error}
            </div>
          ) : null}
          {!loading && !error && unmanaged.length === 0 ? (
            <div className="px-1.5 py-2 text-xs text-base-content/40">
              {t("没有未纳管的会话")}
            </div>
          ) : null}
          <ul className="max-h-64 overflow-y-auto">
            {unmanaged.map((s) => (
              <li key={s.sessionId}>
                <button
                  className="flex w-full flex-col gap-0.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-base-200/60"
                  onClick={() => setViewing(s)}
                >
                  <span className="flex items-center gap-1.5 text-sm">
                    <RuntimeBadge runtime={s.runtime} />
                    <span className="truncate text-base-content/80">
                      {s.name || s.sessionId.slice(0, 8)}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-base-content/40">
                      {s.age || fmtAgo(Date.parse(s.modifiedAt))}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[11px] text-base-content/40">
                    {s.project}
                  </span>
                  {s.lastMessage ? (
                    <span className="truncate text-[11px] text-base-content/50">
                      {s.lastMessage}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {viewing ? (
        <SessionViewer
          session={viewing}
          onClose={() => setViewing(null)}
          onAdopted={() => {
            setViewing(null);
            void load();
          }}
        />
      ) : null}
    </li>
  );
}

/** 只读会话视图：看历史 + 收编成 agent（收编后才可对话） */
function SessionViewer({
  session,
  onClose,
  onAdopted,
}: {
  session: SessionRow;
  onClose: () => void;
  onAdopted: () => void;
}) {
  const t = useT();
  const [messages, setMessages] = useState<HistoryMsg[] | null>(null);
  const [error, setError] = useState("");
  const [adopting, setAdopting] = useState(false);
  const [name, setName] = useState(session.slug || session.sessionId.slice(0, 8));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ runtime: session.runtime, cwd: session.cwd, limit: "200" });
    fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/history?${qs.toString()}`)
      .then(async (res) => {
        const json = (await res.json()) as {
          data?: { messages?: HistoryMsg[] };
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setMessages(json.data?.messages ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const adopt = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const res = await fetch("/api/agents/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: n,
          sessionId: session.sessionId,
          runtime: session.runtime,
          cwd: session.cwd,
        }),
      });
      const json = (await res.json()) as { data?: { hint?: string }; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(
        json.data?.hint ||
          t("已受理，正在后台收编（约 10-40 秒），完成后会出现在 agent 列表里。")
      );
      setTimeout(onAdopted, 1500);
    } catch (e) {
      setNotice("");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col bg-base-100 shadow-xl">
        <header className="flex items-center gap-2 border-b border-base-300 px-4 py-3">
          <RuntimeBadge runtime={session.runtime} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {session.name || session.sessionId.slice(0, 8)}
            </div>
            <div className="truncate font-mono text-[11px] text-base-content/50">
              {session.cwd}
            </div>
          </div>
          <button className="btn btn-ghost btn-xs ml-auto" onClick={onClose}>
            {t("关闭")}
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <div className="mb-3 text-sm text-error break-words">{error}</div>
          ) : null}
          {messages === null && !error ? (
            <div className="text-sm text-base-content/50">{t("加载历史消息…")}</div>
          ) : null}
          {messages?.length === 0 ? (
            <div className="text-sm text-base-content/50">{t("这个会话还没有消息")}</div>
          ) : null}
          <div className="flex flex-col gap-3">
            {(messages ?? []).map((m) => (
              <div key={m.seq} className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-base-content/40">
                  {m.role === "user" ? t("用户") : m.role === "assistant" ? t("助手") : t("系统")}
                  {m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : ""}
                </span>
                {m.tools?.map((tool, i) => (
                  <div
                    key={`${m.seq}-t${i}`}
                    className={`rounded border border-base-300/70 bg-base-200/40 px-2 py-1 font-mono text-[11px] ${
                      tool.error ? "text-error" : "text-base-content/70"
                    }`}
                  >
                    {tool.summary || tool.name}
                  </div>
                ))}
                {m.text ? (
                  <div className="whitespace-pre-wrap break-words text-sm text-base-content/90">
                    {m.text}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <footer className="border-t border-base-300 px-4 py-3">
          {notice ? (
            <div className="mb-2 text-xs text-success break-words">{notice}</div>
          ) : null}
          {adopting ? (
            <div className="flex items-center gap-2">
              <input
                className="input input-bordered input-sm flex-1"
                placeholder={t("agent 名字")}
                value={name}
                disabled={busy}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void adopt();
                }}
              />
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void adopt()}>
                {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                {t("收编")}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => setAdopting(false)}
              >
                {t("取消")}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-base-content/50">
                {t("这个会话没有纳管，现在收不到消息。收编后会建窗口、能对话、进 agent 列表。")}
              </span>
              <button className="btn btn-outline btn-sm ml-auto" onClick={() => setAdopting(true)}>
                {t("收编为 agent")}
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
