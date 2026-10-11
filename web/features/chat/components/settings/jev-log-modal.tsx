"use client";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { jevLog, type JevLog, type JevLogEntry, type JevVerdict } from "@/lib/api/settings";
import { CenteredModal } from "../centered-modal";

/**
 * Jev 调用记录（owner 2026-09-28：守门对用户无打扰，出了问题分不清是 Jev 挂了降级还是判定通过了）。
 * 数据 = bridge 的 guard-log.jsonl（GET /jev/log），每条守门判定一行：通过 / 可疑 / 拦下 / 降级（Jev 失败，照常投递）。
 * 叠在设置弹窗之上（layer top）；只读，刷新按钮重拉。
 */
type Filter = "all" | JevVerdict;
const FILTERS: Filter[] = ["all", "pass", "flag", "block", "error"];
const LABEL: Record<Filter, string> = { all: "全部", pass: "通过", flag: "可疑", block: "拦下", error: "降级" };
const TONE: Record<JevVerdict, string> = {
  pass: "bg-success/15 text-success",
  flag: "bg-warning/15 text-warning",
  block: "bg-error/15 text-error",
  error: "bg-base-content/10 text-base-content/70",
};
const ACTION: Record<NonNullable<JevLogEntry["action"]>, string> = { released: "已放行", dropped: "已丢弃" };

const pad = (n: number) => String(n).padStart(2, "0");
function when(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function Row({ e }: { e: JevLogEntry }) {
  const t = useT();
  const detail =
    e.verdict === "error"
      ? e.error
      : [e.top ? `${e.top.id} ${e.top.score?.toFixed(2) ?? "—"}` : "", e.ms !== undefined ? `${e.ms} ms` : "", e.tokens ? `${e.tokens} tok` : ""].filter(Boolean).join(" · ");
  return (
    <li className="border-b border-base-content/5 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE[e.verdict]}`}>{t(LABEL[e.verdict])}</span>
        <span className="font-mono text-base-content/50">{when(e.ts)}</span>
        <span className="font-medium">{e.agent}</span>
        <span className="text-base-content/50">← {e.sender.name}</span>
        {e.action && (
          <span className="text-base-content/60">
            · {t(ACTION[e.action])}
            {e.by ? ` · ${e.by}` : ""}
          </span>
        )}
        {e.verdict === "block" && !e.action && <span className="text-warning">· {t("待放行")}</span>}
      </div>
      {detail && <div className={`mt-1 break-all font-mono text-[11px] ${e.verdict === "error" ? "text-error/80" : "text-base-content/50"}`}>{detail}</div>}
      {e.preview && <div className="mt-1 line-clamp-2 break-all text-xs text-base-content/70">{e.preview}</div>}
    </li>
  );
}

export function JevLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [log, setLog] = useState<JevLog | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // 打开时直接拉、只在 promise 回调里改状态（react-hooks/set-state-in-effect）；刷新按钮是事件，先亮 loading 再拉
  const fetchLog = useCallback(
    () =>
      jevLog()
        .then((l) => {
          setLog(l);
          setErr("");
        })
        .catch((e: Error) => setErr(e.message || "读取失败"))
        .finally(() => setLoading(false)),
    [],
  );
  useEffect(() => {
    if (open) void fetchLog();
  }, [open, fetchLog]);
  const load = () => {
    setLoading(true);
    void fetchLog();
  };
  if (!open) return null;
  const s = log?.stats;
  const items = (log?.items ?? []).filter((i) => filter === "all" || i.verdict === filter);
  return (
    <CenteredModal onClose={onClose} layer="top">
      <div className="flex items-center justify-between px-5 pb-2 pt-4">
        <span className="text-base font-semibold">{t("Jev 调用记录")}</span>
        <div className="flex items-center gap-1">
          <button className="btn btn-ghost btn-xs" disabled={loading} onClick={load}>
            {loading ? t("加载中…") : t("刷新")}
          </button>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="px-5 text-xs text-base-content/60">
        {t("每条 = 一次 Chat Guard 判定。「降级」= Jev 调用失败，消息未经判定照常送达。")}
        {s && s.total > 0 && (
          <div className="mt-1 font-mono text-[11px]">
            {t("近期判定")} {s.total} · {t("通过")} {s.pass} · {t("可疑")} {s.flag} · {t("拦下")} {s.block} · {t("降级")} {s.error}
            {s.avgMs !== null ? ` · ${t("平均")} ${s.avgMs} ms` : ""}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1 px-5 pt-2">
        {FILTERS.map((f) => (
          <button key={f} className={`btn btn-xs ${filter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(f)}>
            {t(LABEL[f])}
            {s && f !== "all" ? ` ${s[f]}` : ""}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-1">
        {err && <div className="mt-2 rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{t(err)}</div>}
        {!err && log && items.length === 0 && <div className="py-6 text-center text-xs text-base-content/50">{t("暂无记录")}</div>}
        <ul>
          {items.map((e) => (
            <Row key={`${e.id}-${e.ts}`} e={e} />
          ))}
        </ul>
      </div>
    </CenteredModal>
  );
}
