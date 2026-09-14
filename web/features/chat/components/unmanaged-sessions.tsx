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

/** 运行时徽章：Claude Code 不标（它是默认），Pi 标出来 —— 两者行为差异大，该看得见 */
function RuntimeBadge({ runtime }: { runtime: string }) {
  if (runtime !== "pi") return null;
  return (
    <span className="badge badge-xs border-primary/40 bg-primary/10 text-[10px] text-primary">
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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/sessions");
      const json = (await res.json()) as {
        data?: { sessions?: SessionRow[] };
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSessions(json.data?.sessions ?? []);
    } catch (e) {
      setError((e as Error).message);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 只在用户展开时拉（不放进 effect：数据来自外部接口、又只在点开后才需要），
  // 收编成功后会再拉一次。
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  const unmanaged = sessions.filter((s) => !s.agentName);

  return (
    <div className="border-t border-base-300/60">
      <div className="flex w-full items-center gap-1 px-3 py-2 text-xs text-base-content/60">
        <button
          className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-base-content/80"
          onClick={toggle}
        >
          <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
          <span>{t("未纳管会话")}</span>
          {open && !loading && !error ? (
            <span className="text-base-content/40">{unmanaged.length}</span>
          ) : null}
          {loading ? <span className="loading loading-spinner loading-xs" /> : null}
          {open ? null : <span className="ml-auto text-base-content/30">{t("展开")}</span>}
        </button>
        {open ? (
          <button
            className="btn btn-ghost btn-xs"
            title={t("刷新")}
            disabled={loading}
            onClick={() => void load()}
          >
            ⟳
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="pb-2">
          {error ? (
            <div className="px-3 py-2 text-xs text-error break-words">
              {t("读取失败")}: {error}
            </div>
          ) : null}
          {!loading && !error && unmanaged.length === 0 ? (
            <div className="px-3 py-2 text-xs text-base-content/40">
              {t("没有未纳管的会话")}
            </div>
          ) : null}
          <ul className="max-h-64 overflow-y-auto">
            {unmanaged.map((s) => (
              <li key={s.sessionId}>
                <button
                  className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-base-200/60"
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
    </div>
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
