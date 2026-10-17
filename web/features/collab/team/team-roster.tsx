"use client";
import { useEffect } from "react";
import type { TeamPanelProps } from "../team-panel";
import { rosterMetrics, rosterOf, type RosterInput } from "./roster-model";
import { useTeamRoster } from "./use-team-roster";
import { useRosterT } from "./roster-i18n";
import { MemberCard } from "./member-card";
import { SlotLegend } from "./slot-strip";
import s from "./team-roster.module.css";

const DIRECTORY_NOTE = { loading: "正在读取团队目录", error: "团队目录读取失败", ready: "没有团队目录" } as const;
function Metrics({ input, reason, seatsLoading }: { input: RosterInput; reason: string; seatsLoading: boolean }) {
  const t = useRosterT();
  const dir = input.directoryStatus ?? "ready";
  const missing = (label: string) => t((label === "成员" ? dir === "loading" : seatsLoading) ? "读取中" : "暂无");
  const m = rosterMetrics(rosterOf(input), input.roster);
  const usage = (v: typeof m.claude) => v ? `${v.used}/${v.total}${v.partial ? " + ?" : ""}` : null;
  const rows: [string, string | number | null][] = [["成员", m.members], ["机器在线", m.online ? `${m.online.n}/${m.online.m}` : null],
    ["Claude 在用 / 总", usage(m.claude)], ["Codex 在用 / 总", usage(m.codex)], ["在写/修", m.writing], ["在审", m.reviewing],
    ["等合并", m.awaitingMerge], ["今天交付", m.deliveredToday]];
  return <div className={s.metrics}>{rows.map(([label, value]) => <div key={label} title={value === null ? t(label === "成员" ? DIRECTORY_NOTE[dir] : reason) : undefined} data-roster-metric={label}>
    <span>{t(label)}</span><strong>{value ?? missing(label)}</strong>
  </div>)}</div>;
}
/** Placeholder count before the directory lands: the last settled card count for this project, else 3 (per-viewer, best effort). */
const CARDS_KEY = (project: string) => `claudestra.roster.cards:${project}`;
function cachedCards(project: string): number {
  try { const n = Number(localStorage.getItem(CARDS_KEY(project))); return Number.isInteger(n) && n > 0 && n <= 50 ? n : 3; } catch { return 3; }
}
function rememberCards(project: string, n: number) {
  try { localStorage.setItem(CARDS_KEY(project), String(n)); } catch { /* storage blocked: next cold open uses the default */ }
}
/**
 * Shared and local sources feed the same pure model and member cards. Selection props are reserved for member details.
 * Directory and seats load separately: only a directory that was read and is absent may say "no team directory".
 * Loading never reflows: placeholders take the cards' boxes until the directory lands, seats fill in place inside the cards,
 * and every status note shares one fixed-height line.
 */
export function TeamRoster({ project, ov, now }: TeamPanelProps) {
  const data = useTeamRoster(project);
  const t = useRosterT();
  const tasks = ov?.tasks ?? [];
  const input: RosterInput = { ...data, tasks: tasks.map(task => ({ id: task.id, title: task.title, stage: task.stage,
    assigneeCode: task.team?.assigneeCode ?? null, executorInstanceId: task.team?.executorInstanceId ?? null })), now };
  const view = rosterOf(input);
  const people = [...view.people].sort((a, b) => Number(b.isSelf) - Number(a.isSelf)
    || Number(b.teamRole === "owner") - Number(a.teamRole === "owner") || a.code.localeCompare(b.code) || a.personId.localeCompare(b.personId));
  const dir = data.directoryStatus;
  const reason = data.rosterLoading ? "正在读取位子" : data.roster?.dropped ? "部分机器读不到" : data.reason;
  const unknown = !data.roster || data.roster.dropped > 0;
  const noDirectory = dir === "ready" && data.directory === null;
  const cardCount = people.length + (view.unclaimed.length ? 1 : 0);
  const settled = dir === "ready" && !data.rosterLoading;
  useEffect(() => { if (settled && cardCount) rememberCards(project, cardCount); }, [settled, cardCount, project]);
  // Directory pending: person-shaped placeholders; known to be absent: one machine card's box until the seats land.
  const placeholders = dir === "loading" ? cachedCards(project) : noDirectory && data.rosterLoading && !view.unclaimed.length ? 1 : 0;
  const notes: [string, string][] = [
    ...dir !== "ready" ? [[`directory-${dir}`, DIRECTORY_NOTE[dir]] as [string, string]] : [],
    ...noDirectory ? [["directory-none", "没有团队目录，按机器显示"] as [string, string]] : [],
    ...data.rosterLoading ? [["seats-loading", "正在读取位子"] as [string, string]] : [],
    ...!cardCount && settled ? [["empty", "没有名册数据"] as [string, string]] : [],
  ];
  return <div className={s.roster}>
    <Metrics input={input} reason={reason} seatsLoading={data.rosterLoading} /><SlotLegend />
    <p className={s.status} role="status" title={notes.map(([, text]) => t(text)).join(" · ") || undefined}>
      {notes.map(([state, text], i) => <span key={state} data-roster-state={state} aria-busy={state.endsWith("loading") || undefined}>
        {i ? " · " : ""}{t(text)}</span>)}
    </p>
    <div className={s.grid}>
      {people.map(person => <MemberCard key={person.personId} person={person} machines={person.machines} cards={person.cards} tasks={tasks} now={now}
        reason={unknown ? reason : person.slotNote ?? reason} seatsLoading={data.rosterLoading} />)}
      {!!view.unclaimed.length && <MemberCard key="unclaimed" person={null} machines={view.unclaimed} tasks={tasks} now={now} reason={reason}
        cards={[...new Set(view.unclaimed.flatMap(m => [...m.workers.flatMap(w => w.taskId ? [w.taskId] : []), ...m.cards.merge, ...m.cards.live, ...m.cards.blocked]))]
          .map(id => ({ id, title: tasks.find(task => task.id === id)?.title ?? null, stage: tasks.find(task => task.id === id)?.stage ?? null }))} />}
      {Array.from({ length: placeholders }, (_, i) => <MemberCard key={`placeholder-${i}`} loading person={null} machines={[]} cards={[]} tasks={tasks}
        now={now} reason="读取中" seatsLoading />)}
    </div>
  </div>;
}
