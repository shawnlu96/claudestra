"use client";

/** 顶栏的「模型 · 档位」徽章（Pi、Codex 的切换器共用；点开下拉面板） */
export function SwitcherBadge(p: { label: string; effort: string | null | undefined; title: string; maxW: string; onClick: () => void }) {
  return (
    <button
      className="flex items-center gap-1 rounded-full bg-base-200 px-2 py-0.5 font-mono text-[10.5px] text-base-content/60 transition-colors hover:bg-base-300"
      title={p.title}
      onClick={p.onClick}
    >
      <span className={`${p.maxW} truncate`}>{p.label}</span>
      <span className="opacity-40">·</span>
      <span>{p.effort || "?"}</span>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-50">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

/** 档位按钮排（当前档高亮；切换中的那个显示 …） */
export function EffortButtons(p: {
  levels: readonly string[];
  current: string | null | undefined;
  saving: string | null;
  disabled: boolean;
  onPick: (level: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {p.levels.map((e) => (
        <button
          key={e}
          className={`btn btn-xs font-mono ${p.current === e ? "btn-primary" : "btn-ghost bg-base-200"}`}
          disabled={p.disabled}
          onClick={() => p.onPick(e)}
        >
          {p.saving === e ? "…" : e}
        </button>
      ))}
    </div>
  );
}
