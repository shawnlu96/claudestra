import type { AgentSession } from "../type";
import { RuntimeBadge } from "./runtime-badge";

/**
 * 会话行首：运行时图标 + 状态点合一（owner 2026-09-25「把 status dot absolute 在 agent icon 左上角，
 * 略微缩小；已经停止的灰色 dot 不必显示，直接把图标 filter 成 gray」）。
 * 运行中：左上角 7px 呼吸点——黄=忙（tmux 非空闲 / 本端流式中）/ 绿=闲 / 蓝=压缩中，
 * 描一圈行底色把它从图标上抠开；已停止：不出点，图标去色压淡。
 */
export function RuntimeStatusIcon({ a, busy, compacting }: { a: AgentSession; busy?: boolean; compacting?: boolean }) {
  const active = a.status === "active";
  const tone = compacting ? "bg-info" : busy ? "bg-warning" : "bg-success";
  return (
    <span className="relative shrink-0">
      <RuntimeBadge runtime={a.runtime ?? ""} className={active ? "" : "opacity-45 grayscale"} />
      {active && (
        <span className="absolute -left-[3px] -top-[3px] flex size-[9px] items-center justify-center">
          <span className={`animate-cstra-breathe absolute inline-flex size-[9px] rounded-full ${tone}`} />
          <span className={`relative inline-flex size-[7px] rounded-full ring-[1.5px] ring-base-200 ${tone}`} />
        </span>
      )}
    </span>
  );
}
