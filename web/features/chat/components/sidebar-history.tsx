"use client";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { Chevron } from "./project-group";

/** lucide history */
function HistoryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function HistoryFold({ count, open, onToggle, children }: { count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const t = useT();
  if (!count) return null;
  return (
    <li className="mt-1 rounded-xl bg-base-300/15 p-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] font-medium text-base-content/45 transition-colors hover:bg-base-300/40 hover:text-base-content/70"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron open={open} />
        <span className="flex items-center gap-1">
          <HistoryIcon />
          {t("历史")}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/35">{count}</span>
      </button>
      {open && <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5 opacity-75">{children}</ul>}
    </li>
  );
}
