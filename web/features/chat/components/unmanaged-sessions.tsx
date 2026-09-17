"use client";
import { useCallback, useEffect, useState, useRef } from "react";
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
/** 临时目录（测试/探针/子代理 scratchpad）的会话不算「未纳管」噪声源，列表与计数都不含它们 */
function isTempSession(cwd: string): boolean {
  return /^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders)\//.test(cwd || "");
}

export function RuntimeBadge({ runtime, className = "" }: { runtime: string; className?: string }) {
  if (runtime !== "pi") return null;
  return (
    <span className={`badge badge-xs border-primary/40 bg-primary/10 text-[10px] text-primary ${className}`}>
      Pi
    </span>
  );
}

/**
 * 左滑露出快捷动作（与侧栏 agent 行同一套手感：跟手位移、松手吸附、纵向意图让给滚动）。
 * owner 2026-09-14：未纳管会话也要快捷按钮，归档要能直接点。
 */
export function SwipeActions({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions: { label: string; className: string; onClick: () => void }[];
}) {
  const W = actions.length * 68;
  const [dx, setDx] = useState(0);
  // 拖动中不做过渡（跟手要瞬时），只在松手吸附时走 150ms；动作钮也只在露出时挂载 ——
  // 否则每一帧重绘都可能让底下那排浅色按钮闪一下，看着像"左滑瞬间白屏"（owner 2026-09-14）。
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; open: boolean; locked: boolean } | null>(null);
  return (
    <div className="relative overflow-hidden rounded-lg">
      {(dx !== 0 || dragging) && (
      <div className="absolute inset-y-0 right-0 flex">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={`w-[68px] shrink-0 text-[11px] font-medium ${a.className}`}
            onClick={() => {
              setDx(0);
              a.onClick();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      )}
      <div
        /* 必须是**不透明**的背景：跟手层透明时，后面那排动作按钮会从行下面透出来 ——
           看着像"没左滑就冒出按钮"（owner 2026-09-14 手机实报）。 */
        className={`relative bg-base-100 ${dragging ? "" : "transition-transform duration-150"}`}
        style={{ transform: `translateX(${dx}px)` }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          start.current = { x: t.clientX, y: t.clientY, open: dx !== 0, locked: false };
          setDragging(true);
        }}
        onTouchMove={(e) => {
          const st = start.current;
          if (!st) return;
          const t = e.touches[0];
          const ddx = t.clientX - st.x;
          const ddy = t.clientY - st.y;
          // 纵向意图让给列表滚动（前 8px 判定）
          if (!st.locked) {
            if (Math.abs(ddy) > Math.abs(ddx) && Math.abs(ddy) > 8) {
              start.current = null;
              return;
            }
            if (Math.abs(ddx) > 8) st.locked = true;
          }
          const base = st.open ? -W : 0;
          setDx(Math.min(0, Math.max(-W - 16, base + ddx)));
        }}
        onTouchEnd={() => {
          setDragging(false);
          if (!start.current) return;
          setDx(dx < -W / 2 ? -W : 0);
          start.current = null;
        }}
      >
        {children}
      </div>
    </div>
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

  const count = sessions.filter((s) => s.agentName === null && !isTempSession(s.cwd)).length;

  const [confirming, setConfirming] = useState<string | null>(null);

  /** 列表里左滑直接处置（不必点进抽屉）；成功后重拉列表 */
  const manageFromList = async (s: SessionRow, action: "archive" | "delete") => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runtime: s.runtime, cwd: s.cwd }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setConfirming(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  // 未纳管会话里塞着大量**测试遗留**（dailies 探针 / spike / 子代理 scratchpad）：
  // 它们的 cwd 在临时目录下，列出来只是噪声（owner 2026-09-14 实测：20 个未纳管 Pi
  // 会话里 8+ 个是 /tmp 下的）。临时目录的会话不进列表——真想看还有 CLI
  // `manager sessions`（isTempSession 见组件上方，与组头计数同一判据）。
  const unmanaged = sessions.filter((s) => !s.agentName && !isTempSession(s.cwd));

  // 「刚刚活跃」= 会话文件 2 分钟内还在写（真在跑的会话持续落盘）。
  // ⚠ 这是**启发式**，不是进程检测：Pi 进程的命令行被 setproctitle 盖成 `pi`，
  // 未纳管会话又没有扩展心跳，所以只能拿写入时间当代理信号。
  const LIVE_MS = 2 * 60_000;
  const isLive = (s: SessionRow) => {
    const t = Date.parse(s.modifiedAt);
    return Number.isFinite(t) && Date.now() - t < LIVE_MS;
  };

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
        {/* 触摸目标：原先只有 px-1.5 的裸字符（≈14×20px），手机上点不中 ——
            而且紧挨折叠按钮，手指落点全被邻居吃掉（owner 2026-09-14 实报）。
            给 36×36 的格子（iOS 建议 44，列表头里 36 是合理折中）+ touch-manipulation */}
        {open ? (
          <button
            type="button"
            className="grid size-9 shrink-0 touch-manipulation place-items-center rounded-md text-base text-base-content/45 transition-colors hover:text-base-content/80 active:bg-base-200/70"
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
                <SwipeActions
                  actions={[
                    {
                      label: t("归档"),
                      className: "bg-base-300/70 text-base-content/80",
                      onClick: () => void manageFromList(s, "archive"),
                    },
                    {
                      label: confirming === s.sessionId ? t("确认删除") : t("删除"),
                      className: "bg-error/80 text-error-content",
                      onClick: () =>
                        confirming === s.sessionId
                          ? void manageFromList(s, "delete")
                          : setConfirming(s.sessionId),
                    },
                  ]}
                >
                <button
                  className="flex w-full flex-col gap-0.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-base-200/60"
                  onClick={() => setViewing(s)}
                >
                  <span className="flex items-center gap-1.5 text-sm">
                    <RuntimeBadge runtime={s.runtime} />
                    {isLive(s) ? (
                      <span
                        className="shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] text-success"
                        title={t("会话文件 2 分钟内还在写 —— 大概率正在运行（启发式）")}
                      >
                        {t("活跃")}
                      </span>
                    ) : null}
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
                </SwipeActions>
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
  const [confirmDel, setConfirmDel] = useState(false);
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

  /**
   * 处置未纳管会话：archive = 先快照进归档目录再删原文件（可逆）；delete = 只删（不可逆）。
   * 后端还挡一道「文件 2 分钟内还在写 = 像在跑」的保护。
   */
  const manage = async (action: "archive" | "delete") => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runtime: session.runtime, cwd: session.cwd }),
      });
      const json = (await res.json()) as { data?: { archived?: boolean }; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(
        action === "archive"
          ? t("已归档并从列表移除（内容留在归档目录，可找回）")
          : t("已删除"),
      );
      // 复用父级的「处理完刷新」回调（名字来自收编流程，这里只是关抽屉 + 重拉列表）
      setTimeout(onAdopted, 1200);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
            <div className="flex flex-wrap items-center gap-2">
              {/* 手机上没有返回按钮可点：抽屉右上那个 ✕ 会被刘海/状态栏压住（owner
                  2026-09-14 实报「左滑不能回退、也没有回上一步的按钮」）。底部动作行
                  里固定给一个「返回」，任何机型都能点到。 */}
              <button className="btn btn-ghost btn-sm shrink-0" onClick={onClose}>
                {t("← 返回")}
              </button>
              <span className="text-xs text-base-content/50">
                {t("这个会话没有纳管，现在收不到消息。收编后会建窗口、能对话、进 agent 列表。")}
              </span>
              <button className="btn btn-outline btn-sm ml-auto" onClick={() => setAdopting(true)}>
                {t("收编为 agent")}
              </button>
              {/* v2.23+ 未纳管会话的处置：归档（可逆）/ 删除（二次确认） */}
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void manage("archive")}
              >
                {t("归档")}
              </button>
              {confirmDel ? (
                <button
                  className="btn btn-error btn-sm"
                  disabled={busy}
                  onClick={() => void manage("delete")}
                >
                  {t("确认删除")}
                </button>
              ) : (
                <button
                  className="btn btn-ghost btn-sm text-error"
                  disabled={busy}
                  onClick={() => setConfirmDel(true)}
                >
                  {t("删除")}
                </button>
              )}
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
