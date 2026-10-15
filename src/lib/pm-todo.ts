/**
 * PM 按需拉取的上线后待办（docs/architecture/pm-digest.md「通知级别」）：常规通知只记卡片、不推给 PM，PM 要看时跑 `ledger pm-todo` 一次拉全。
 * 口径与上线后提醒（scheduler-post-verify.ts）同一套：stage=verified、规格有 `## 上线后 PM` 一节、台账还没有 post-verify-done:<卡>。
 * due = 规格第一行写的观察期已过（没写或写错按已到期）；这里只读，不写台账、不发消息。
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup, listTasks } from "./ledger-store.js";
import { parseObservation } from "./scheduler-post-verify-defer.js";
import { postVerifyDoneKey, postVerifySection, verifiedAt } from "./scheduler-post-verify-ledger.js";

export interface PmTodo { task: string; verifiedAt: number; hours: number | null; due: boolean; dueAt: number; what: string }

const HOUR_MS = 3600_000;
const WHAT_MAX = 120;

/** 该节第一行如果是观察期就跳过，取下一条非空正文作一句话提示 */
function firstPoint(section: string): string {
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = (lines[0]?.includes("观察期") ? lines[1] : lines[0]) ?? "";
  return line.length > WHAT_MAX ? `${line.slice(0, WHAT_MAX)}…` : line;
}

export function pmTodos(db: Database, project: string, readSpec: (taskId: string) => string | null | undefined, now: number): PmTodo[] {
  const out: PmTodo[] = [];
  for (const t of listTasks(db, project)) {
    if (t.stage !== "verified" || getEventByDedup(db, postVerifyDoneKey(t.id))) continue;
    const section = postVerifySection(readSpec(t.id));
    if (!section) continue;
    const at = verifiedAt(db, t), o = parseObservation(section);
    const hours = o && o !== "bad" ? o.hours : null, dueAt = at + (hours ?? 0) * HOUR_MS;
    out.push({ task: t.id, verifiedAt: at, hours, due: now >= dueAt, dueAt, what: firstPoint(section) });
  }
  return out.sort((a, b) => Number(b.due) - Number(a.due) || a.dueAt - b.dueAt);
}
