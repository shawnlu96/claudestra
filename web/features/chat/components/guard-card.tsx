"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { dropGuard, releaseGuard, type GuardItem } from "@/lib/api/guard";
import { removeGuardLocal, useGuardPending } from "../guard-store";
import { fmtTs } from "../fmt-time";

/**
 * 输入框上方的「待放行」卡（docs/design-chat-guard.md）：被 Chat Guard 隔离的入站消息，不在历史里，钉在这里等 owner 处理。
 * 放行 → bridge 把原信封原路投给 agent；丢弃 → 作废。没有 manage 权限的凭据点了会得到 403，按钮照常给（服务端是裁判）。
 */
function Row({ item }: { item: GuardItem }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const top = item.hits.find((h) => h.verdict === "block") ?? item.hits[0];
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      removeGuardLocal(item.agent, item.id);
    } catch (e) {
      setErr((e as Error).message || t("操作失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-base-content/70">
        <span className="font-medium text-warning">⛔ {t("守门拦下一条消息")}</span>
        <span>
          {t("来自")} {item.from}
        </span>
        {top && (
          <span className="font-mono text-[11px] text-base-content/50">
            {top.id} {typeof top.score === "number" ? top.score.toFixed(2) : ""}
          </span>
        )}
        <span className="font-mono text-[11px] text-base-content/40">{fmtTs(item.at)}</span>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-base-content/85">{item.text}</div>
      <div className="mt-2 flex items-center justify-end gap-2">
        {err && <span className="mr-auto text-[12px] text-error">{err}</span>}
        <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void act(() => dropGuard(item.id))}>
          {t("丢弃")}
        </button>
        <button className="btn btn-warning btn-xs" disabled={busy} onClick={() => void act(() => releaseGuard(item.id))}>
          {t("放行")}
        </button>
      </div>
    </div>
  );
}

export function GuardCard({ agent }: { agent?: string }) {
  const items = useGuardPending(agent);
  if (!agent || items.length === 0) return null;
  return (
    <div className="mb-2 space-y-2">
      {items.map((i) => (
        <Row key={i.id} item={i} />
      ))}
    </div>
  );
}
