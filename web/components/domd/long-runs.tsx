import { Fragment, type ReactNode } from "react";
import { longRunSegments } from "@/lib/chat/long-runs";

/** 纯文本显示：超长无空白串里插 <wbr>（不然 Chromium 排版卡十几秒，见 lib/chat/long-runs.ts）；<wbr> 不进复制出来的文本 */
export function breakLongRuns(text: string): ReactNode {
  const parts = longRunSegments(text);
  if (parts.length === 1) return text;
  return parts.map((s, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {s}
    </Fragment>
  ));
}
