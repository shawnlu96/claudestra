"use client";
import type { PendingAsk } from "../type";
import { useT } from "@/lib/i18n";

/**
 * AskUserQuestion 通知卡（Claude Code 内建工具的 Web 化）：只读列出 1-4 题和选项，作答请到终端。
 * 远程提交停用（bridge/auq-answer.ts）：画面身份核对还证明不了旧卡的下标一定落在同一个弹框上，替 owner 按错键的代价太大
 */
export function AskQuestionCard({ a }: { a: PendingAsk }) {
  const t = useT();
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
              <ol className="flex flex-col gap-1">
                {q.options.map((o, oi) => (
                  <li key={oi} className="rounded-lg border border-base-content/10 bg-base-100/40 px-2.5 py-1.5 text-[13px]">
                    <span className="font-medium opacity-90">{oi + 1}. {o.label}</span>
                    {o.description && <span className="ml-1 opacity-50">{o.description}</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <div className="border-t border-base-content/[0.06] px-3 py-2 text-xs font-medium text-warning">
          {t("请到终端作答")}
        </div>
      </div>
    </div>
  );
}
