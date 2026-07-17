"use client";
import { fmtAgo } from "../fmt-time";
import { useT } from "@/lib/i18n";

/** 聊天记录搜索命中（/api/chat/search 返回项）——侧栏全局搜索与会话内搜索共用。 */
export interface ChatSearchHit {
  agent: string;
  sessionId: string;
  seq: number;
  ts: string | null;
  role: string;
  snippet: string;
  from?: string;
  compact?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** snippet 里的命中词高亮。 */
export function Highlighted({ text, q }: { text: string; q: string }) {
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded-sm bg-warning/40 px-0.5 text-inherit">
            {p}
          </mark>
        ) : (
          p
        )
      )}
    </>
  );
}

/** 一条搜索命中：来源 + 时间 + 正文节选（命中高亮）。showAgent=false 用于
 *  会话内搜索（来源不言自明）。可点击时 onOpen 打开对应会话。 */
export function ChatHitRow({
  hit,
  q,
  canOpen,
  onOpen,
  showAgent = true,
}: {
  hit: ChatSearchHit;
  q: string;
  canOpen: boolean;
  onOpen?: () => void;
  showAgent?: boolean;
}) {
  const t = useT();
  const agentLabel = hit.agent === "__master__" ? t("大总管") : hit.agent;
  return (
    <button
      className={`flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors ${
        canOpen ? "hover:bg-base-300/50" : "cursor-default"
      }`}
      onClick={canOpen ? onOpen : undefined}
    >
      <span className="flex items-center gap-1.5 text-[11px] text-base-content/45">
        <span className="shrink-0">{hit.role === "user" ? "👤" : "✦"}</span>
        {showAgent && (
          <span className="truncate font-medium text-base-content/60">{agentLabel}</span>
        )}
        {hit.compact && <span className="shrink-0 rounded bg-base-300 px-1">{t("📦 压缩摘要")}</span>}
        {hit.ts && <span className="ml-auto shrink-0 tabular-nums">{fmtAgo(Date.parse(hit.ts))}</span>}
      </span>
      <span className="line-clamp-3 text-xs leading-relaxed text-base-content/75">
        <Highlighted text={hit.snippet} q={q} />
      </span>
    </button>
  );
}
