"use client";
import { memo, useState } from "react";
import { fmtTs } from "../fmt-time";
import { hasLiveSelection } from "../select-mode";

/**
 * v2.21.3+ 进度句(💭)（从 message-list.tsx 原样搬出）:Fable 5.1 在长工具链里把
 * 「接下来我会…」写进 progress-update thinking 块而不是 text。比旁白(TextBlock muted)
 * 再弱一档——纯文本、斜体、无竖线,只为让人知道 agent 没停、在干什么;点一下显示时间。
 */
export const ProgressNote = memo(function ProgressNote({ text, ts }: { text: string; ts?: string }) {
  const [showTs, setShowTs] = useState(false);
  return (
    <div
      // break-words 不是装饰：进度句是**裸文本**（不过 DOMD，拿不到它的
      // word-wrap: break-word），而模型爱在里面写
      // `loadCommands`/`loadExecutions`/`toNumber` 这种没有空格的长串。
      // 缺了它那一串不断行 → 撑破 342px 的气泡 → 整个消息区可以横向拖动
      // （owner 2026-09-22「pi agent 还是出现下面多个滑动条导致乱套」，
      //  实测那条进度句超框 110px，消息区 scrollWidth 比可视宽多 86px）。
      className="my-1 break-words pl-2.5 text-[12.5px] italic leading-snug text-base-content/45"
      onClick={() => {
        if (hasLiveSelection()) return;
        setShowTs((v) => !v);
      }}
    >
      <span className="mr-1 not-italic">💭</span>
      {text}
      {showTs && ts && (
        <div className="mt-0.5 font-mono text-[10px] not-italic tabular-nums opacity-40">{fmtTs(ts)}</div>
      )}
    </div>
  );
});
