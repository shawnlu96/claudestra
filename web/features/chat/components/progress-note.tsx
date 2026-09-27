"use client";
import { memo } from "react";
import { useIsExport } from "../export-context";

/**
 * v2.21.3+ 进度句(💭)（从 message-list.tsx 原样搬出）:Fable 5.1 在长工具链里把
 * 「接下来我会…」写进 progress-update thinking 块而不是 text。比旁白(TextBlock muted)
 * 再弱一档——纯文本、斜体、无竖线,只为让人知道 agent 没停、在干什么。
 * 时间不再点击开关（owner 2026-09-27）：PC 端由侧槽标签给（./msg-time.tsx），移动端不显示。
 */
export const ProgressNote = memo(function ProgressNote({ text }: { text: string }) {
  const exporting = useIsExport();
  if (exporting) return null; // 导出里去掉 thinking 类内容（owner 2026-09-24）
  return (
    <div
      // break-words 不是装饰：进度句是**裸文本**（不过 DOMD，拿不到它的
      // word-wrap: break-word），而模型爱在里面写
      // `loadCommands`/`loadExecutions`/`toNumber` 这种没有空格的长串。
      // 缺了它那一串不断行 → 撑破 342px 的气泡 → 整个消息区可以横向拖动
      // （owner 2026-09-22「pi agent 还是出现下面多个滑动条导致乱套」，
      //  实测那条进度句超框 110px，消息区 scrollWidth 比可视宽多 86px）。
      className="my-1 break-words pl-2.5 text-[length:calc(var(--chat-narr-size,13.5px)_-_1px)] italic leading-[var(--cstra-lead-note)] text-base-content/45"
    >
      <span className="mr-1 not-italic">💭</span>
      {text}
    </div>
  );
});
