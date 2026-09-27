"use client";
import type { ReactNode } from "react";
import type { AssistantSegment } from "../type";
import { groupSegments, leadOf, segTs } from "../time-groups";
import { GutterTime } from "./msg-time";
import { useT } from "@/lib/i18n";

/** 过程叙述 ↔ 最终回复 之间的淡分隔线（仅两者都在时出现）。放在回复组的 relative 盒**外面**：
 *  在盒内的话组标签会对齐分隔线而不是正文首行（Shawn 评审 #54，偏约 25px）。 */
export function ReplyDivider() {
  const t = useT();
  return (
    <div className="my-2.5 flex items-center gap-2" aria-hidden>
      <span className="h-px flex-1 bg-base-content/10" />
      <span className="text-[10px] font-medium tracking-wide text-base-content/30">
        {t("回复")}
      </span>
      <span className="h-px flex-1 bg-base-content/10" />
    </div>
  );
}

/**
 * AI 消息段的时间轨道（PC ≥lg 才可见，标签本身 hidden lg:block）：按 ../time-groups.ts 分组，每组一个
 * relative 包装 + 常显 sticky 标签，组滚过时贴顶跟随、被下一组顶走。组内其余段各自再包一层 group/seg，
 * 带一个平时透明的标签，鼠标悬停该段时显示（owner 2026-09-27：标签全生成，按分组挑常显，其余 hover 才见）。
 * 段的渲染本身由调用方的 render 给，这里只管轨道；render 返回 null 的段不包装。
 */
export function SegGroups({
  segs,
  ts,
  render,
}: {
  segs: AssistantSegment[];
  ts?: string;
  render: (seg: AssistantSegment, i: number) => ReactNode;
}) {
  return (
    <>
      {groupSegments(segs, ts).map((g) => (
        <div key={g.start}>
          {g.start > 0 && segs[g.start].kind === "reply" && <ReplyDivider />}
          <div className="relative">
            <GutterTime ts={g.ts} side="left" lead={g.lead} />
            {segs.slice(g.start, g.end).map((seg, k) => {
              const i = g.start + k;
              const node = render(seg, i);
              if (k === 0 || node == null) return node;
              return (
                <div key={i} className="group/seg relative">
                  <GutterTime
                    ts={segTs(seg)}
                    side="left"
                    lead={leadOf(seg)}
                    hover
                  />
                  {node}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
