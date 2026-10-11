"use client";
import { useEffect, useRef, useState } from "react";
import type { Selection } from "../v4/v4-selection";
import d from "./dag.module.css";

/** The work board renders task rows, so a node owner targets its card row, including the hidden mobile segment. */
export function useNodeCardOwner(narrow: boolean, openTask: string | null, select: (s: Selection) => void, jumpRow: (agent: string) => void, progress: boolean) {
  const [jump, setJump] = useState<{ agent: string; taskId: string | null; seq: number } | null>(null);
  const consumed = useRef(0);
  useEffect(() => {
    if (!progress || !jump || consumed.current === jump.seq) return;
    let flashed: HTMLElement | null = null;
    const reveal = () => {
      const board = document.querySelector("[data-work-board]");
      const rows = [...(board?.querySelectorAll<HTMLButtonElement>("section button") ?? [])];
      const row = rows.find(r => jump.taskId
        ? [...r.querySelectorAll("span")].some(s => s.textContent === jump.taskId)
        : r.firstElementChild?.textContent === jump.agent);
      if (!row) return;
      const column = row.closest("section");
      if (column?.getAttribute("data-active") === "false") {
        const columns = [...(board?.querySelectorAll("section") ?? [])];
        board?.querySelectorAll<HTMLButtonElement>("[role=tab]")[columns.indexOf(column)]?.click();
      }
      if (!row.getClientRects().length) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.remove(d.nodeRowFlash);
      void row.offsetWidth;
      row.classList.add(d.nodeRowFlash);
      flashed = row;
      consumed.current = jump.seq;
      observer.disconnect();
    };
    const observer = new MutationObserver(reveal);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-active"] });
    reveal();
    const stop = window.setTimeout(() => observer.disconnect(), 5000);
    return () => { observer.disconnect(); window.clearTimeout(stop); flashed?.classList.remove(d.nodeRowFlash); };
  }, [progress, jump]);
  return (agent: string, taskId: string | null = null) => {
    if (narrow) {
      if (openTask && window.location.hash.includes("collab=")) window.history.back();
      select(null);
    }
    setJump(previous => ({ agent, taskId, seq: (previous?.seq ?? 0) + 1 }));
    jumpRow(agent);
  };
}
