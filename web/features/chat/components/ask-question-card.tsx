"use client";
import { useState } from "react";
import type { PendingAsk } from "../type";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";

/**
 * AskUserQuestion 交互卡（Claude Code 内建工具的 Web 化）。1-4 题，每题单/多选。
 * 提交 → BFF → Bridge 把选择翻译成 tmux 键序列（buildAuqKeystrokes）发给 agent TUI。
 * 取消 → 给 agent 发 Esc。
 */
export function AskQuestionCard({ a }: { a: PendingAsk }) {
  const t = useT();
  const store = useChatStoreApi();
  // sel[qIdx] = 第 qIdx 题选中的 option index 数组（0-based）
  const [sel, setSel] = useState<number[][]>(() => a.questions.map(() => []));
  const [busy, setBusy] = useState<"" | "submit" | "cancel">("");
  const [error, setError] = useState("");

  const toggle = (qi: number, oi: number, multi: boolean) => {
    if (busy) return;
    setSel((prev) => {
      const next = prev.map((x) => x.slice());
      if (multi) {
        const idx = next[qi].indexOf(oi);
        if (idx >= 0) next[qi].splice(idx, 1);
        else next[qi].push(oi);
      } else {
        next[qi] = next[qi][0] === oi ? [] : [oi];
      }
      return next;
    });
  };

  // 单选题必须选一个才能提交；多选题允许 0 选
  const canSubmit = a.questions.every(
    (q, qi) => q.multiSelect || sel[qi].length > 0
  );

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy("submit");
    setError("");
    const res = await store.submitAsk(sel);
    setBusy("");
    if (!res.ok) setError(res.error || "提交失败");
  };

  const cancel = async () => {
    if (busy) return;
    setBusy("cancel");
    setError("");
    const res = await store.cancelAsk();
    setBusy("");
    if (!res.ok) setError(res.error || "取消失败");
  };

  return (
    <div className="chat chat-start">
      <div className="chat-bubble max-w-[85%] overflow-hidden rounded-xl border border-info/40 bg-info/[0.08] p-0 text-base-content">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          <span className="text-sm">🎛</span>
          <span className="text-sm font-semibold text-info">{t("agent 在等你选")}</span>
        </div>
        <div className="flex flex-col gap-3 px-3 py-2">
          {a.questions.map((q, qi) => (
            <div key={qi} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-info/15 px-1.5 py-0.5 text-[11px] font-semibold text-info">
                  {q.header || `Q${qi + 1}`}
                </span>
                <span className="text-[11px] opacity-50">
                  {q.multiSelect ? t("可多选") : t("单选")}
                </span>
              </div>
              <div className="text-[13.5px] font-medium leading-snug opacity-90">
                {q.question}
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((o, oi) => {
                  const on = sel[qi].includes(oi);
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={busy !== ""}
                      onClick={() => toggle(qi, oi, q.multiSelect)}
                      className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                        on
                          ? "border-info bg-info/15"
                          : "border-base-content/10 bg-base-100/40 hover:bg-base-content/[0.04]"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[10px] ${
                          q.multiSelect ? "rounded-[4px]" : "rounded-full"
                        } border ${
                          on
                            ? "border-info bg-info text-info-content"
                            : "border-base-content/30"
                        }`}
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium opacity-90">{o.label}</span>
                        {o.description && (
                          <span className="ml-1 opacity-50">{o.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-base-content/[0.06] px-3 py-2">
          <button
            className="btn btn-info btn-xs"
            disabled={busy !== "" || !canSubmit}
            onClick={submit}
          >
            {busy === "submit" ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              t("提交")
            )}
          </button>
          <button
            className="btn btn-ghost btn-xs"
            disabled={busy !== ""}
            onClick={cancel}
          >
            {busy === "cancel" ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              t("取消 (Esc)")
            )}
          </button>
          {error && <span className="truncate text-xs text-error">{t(error)}</span>}
        </div>
      </div>
    </div>
  );
}
