"use client";
import { useT } from "@/lib/i18n";

export interface ExportMeta {
  version: string;
  commit: string;
  /** 导出人：个人资料昵称，没有就登录用户名 */
  exporter: string;
}

/**
 * 导出文件顶部的抬头（owner 2026-09-25「标明我们的软件、版本、会话 name、导出人」）：
 * 左边品牌 + 版本 + 会话名，右边导出人 / 时间 / 条数，一条细线与正文隔开。
 * 只在导出树里渲染（share-dock.tsx 的 ExportDoc），页面里没有。
 */
export function ExportHeader({ meta, agent, count, at }: { meta: ExportMeta; agent: string; count: number; at: Date }) {
  const t = useT();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return (
    <div className="mb-7 flex items-end justify-between gap-4 border-b border-base-300 pb-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-accent text-[11px] text-white">✦</span>
          <span className="text-[15px] font-semibold tracking-tight">Claudestra</span>
          {meta.version && (
            <span className="font-mono text-[11px] text-base-content/50">
              v{meta.version}
              {meta.commit ? ` · ${meta.commit}` : ""}
            </span>
          )}
        </div>
        <div className="mt-1.5 truncate text-[13px] text-base-content/70">
          <span className="text-base-content/45">{t("会话名")} · </span>
          <span className="font-medium text-base-content/85">{agent}</span>
        </div>
      </div>
      <div className="shrink-0 text-right font-mono text-[11px] leading-relaxed text-base-content/50">
        <div>
          {t("导出人")} {meta.exporter || "—"}
        </div>
        <div>{stamp}</div>
        <div>
          {count} {t("条消息")}
        </div>
      </div>
    </div>
  );
}
