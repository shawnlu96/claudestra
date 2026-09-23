import type { AgentSession } from "../type";

/** 侧栏行首状态点（从 agent-row.tsx 原样搬出）。 */
export function StatusDot({ status, busy, compacting }: { status: AgentSession["status"]; busy?: boolean; compacting?: boolean }) {
  if (status === "active") {
    // 运行中：实心核心点 + 柔和呼吸外晕（cstra-breathe，替换生硬的 animate-ping）。
    // 正在干活（tmux 非空闲 / 本端流式中）→ 黄色；空闲 → 绿色；
    // v2.21.2+ 正在压缩上下文 → 蓝色（既不是空闲也不是普通回合）。
    const tone = compacting ? "bg-info" : busy ? "bg-warning" : "bg-success";
    return (
      <span className="relative flex size-2.5 shrink-0 items-center justify-center">
        <span className={`animate-cstra-breathe absolute inline-flex size-2.5 rounded-full ${tone}`} />
        <span className={`relative inline-flex size-2 rounded-full ${tone}`} />
      </span>
    );
  }
  return (
    <span className="inline-flex size-2.5 shrink-0 rounded-full bg-base-content/25" />
  );
}
