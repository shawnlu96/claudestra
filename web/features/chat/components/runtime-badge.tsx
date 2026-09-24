"use client";

/** 运行时徽章（侧栏行、用量看板、会话列表共用）：三家都标，谁也不是默认——只标非默认的，就等于说 Claude Code 是本体 */
export function RuntimeBadge({ runtime, className = "" }: { runtime: string; className?: string }) {
  // 空串 = 老 bridge / 老 registry 没带 runtime，那时只有 Claude Code，照它标
  if (runtime === "claude-code" || runtime === "") {
    return (
      <span className={`badge badge-xs border-orange-500/35 bg-orange-500/10 text-[10px] text-orange-700 dark:text-orange-300 ${className}`}>
        Claude
      </span>
    );
  }
  if (runtime === "pi") {
    return (
      <span className={`badge badge-xs border-primary/40 bg-primary/10 text-[10px] text-primary ${className}`}>
        Pi
      </span>
    );
  }
  if (runtime === "codex") {
    // v2.24+ Codex：能收编（入站走 `codex queue`）。徽章用中性色，与 Pi 区分开。
    return (
      <span className={`badge badge-xs border-base-content/25 bg-base-content/10 text-[10px] text-base-content/70 ${className}`}>
        Codex
      </span>
    );
  }
  return null;
}
