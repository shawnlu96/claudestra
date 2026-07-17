"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChatHitRow, type ChatSearchHit } from "./search-hits";
import { getLang, useT } from "@/lib/i18n";

/**
 * 会话内搜索（owner 2026-07-14:「每个会话右上角加搜索按钮,只搜本 session」）。
 * 🔍 按钮 → 全屏覆盖层(输入 + 结果)。搜索范围是当前 agent 的全部历史会话
 * (含归档)——比字面「本 session」更宽,compact 轮转后的旧 session 也在,
 * 这正是「找回忘掉的事」要覆盖的。
 * ⚠ 覆盖层必须 createPortal 到 body——移动端会话页在 transform 横滑容器里,
 * 容器内 fixed 会定位到屏幕外（页面规矩 5.5）。
 */
export function SessionSearchButton({ agentName }: { agentName: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content"
        title={t("搜索本会话聊天记录")}
        aria-label={t("搜索本会话聊天记录")}
        onClick={() => setOpen(true)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      </button>
      {open && <SearchOverlay agentName={agentName} onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchOverlay({ agentName, onClose }: { agentName: string; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ChatSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const doSearch = async () => {
    const term = query.trim();
    if (term.length < 2 || searching) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/chat/search?q=${encodeURIComponent(term)}&agent=${encodeURIComponent(agentName)}`
      );
      const json = (await res.json()) as { data?: ChatSearchHit[] };
      setHits(Array.isArray(json.data) ? json.data : []);
    } catch {
      setHits([]);
    }
    setSearching(false);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-base-100">
      {/* 搜索条:安全区自垫,返回键 + 输入 + 触发 */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-base-300 px-3 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
      >
        <button className="btn btn-ghost btn-sm -ml-1 px-2" onClick={onClose} aria-label={t("关闭搜索")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <label className="flex flex-1 items-center gap-2 rounded-lg bg-base-300/60 px-2.5 py-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 opacity-40">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHits(null);
            }}
            placeholder={t("搜本会话聊天记录…")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void doSearch();
              }
            }}
            className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-base-content/35 [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <button
          className="btn btn-primary btn-sm shrink-0"
          disabled={query.trim().length < 2 || searching}
          onClick={() => void doSearch()}
        >
          {searching ? <span className="loading loading-spinner loading-xs" /> : t("搜索")}
        </button>
      </div>
      {/* 结果区 */}
      <div
        className="flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2 py-2"
        style={{ WebkitOverflowScrolling: "touch", paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
      >
        {hits === null && !searching && (
          <div className="px-3 py-6 text-center text-sm text-base-content/40">
            {t("输入关键词搜这个会话的全部历史记录")}
            <br />
            {t("（包括压缩前和更早轮换的会话）")}
          </div>
        )}
        {hits !== null && hits.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-base-content/40">
            {getLang() === "en" ? `No results for "${query.trim()}"` : `没搜到「${query.trim()}」`}
          </div>
        )}
        {hits?.map((h, i) => (
          <ChatHitRow
            key={`${h.sessionId}-${h.seq}-${i}`}
            hit={h}
            q={query.trim()}
            canOpen={false}
            showAgent={false}
          />
        ))}
      </div>
    </div>,
    document.body
  );
}
