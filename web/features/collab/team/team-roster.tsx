"use client";
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
/**
 * Shared and local sources feed the same pure model and member cards. Selection props are reserved for member details.
 * Directory and seats load separately: only a directory that was read and is absent may say "no team directory".
 */
export function TeamRoster({ project, ov, now }: TeamPanelProps) {
  const data = useTeamRoster(project);
  const t = useRosterT();
  const tasks = ov?.tasks ?? [];
  const input: RosterInput = { ...data, tasks: tasks.map(task => ({ id: task.id, title: task.title, stage: task.stage,
    assigneeCode: task.team?.assigneeCode ?? null, executorInstanceId: task.team?.executorInstanceId ?? null })), now };
  const view = rosterOf(input);
  const people = [...view.people].sort((a, b) => Number(b.isSelf) - Number(a.isSelf)
    || Number(b.teamRole === "owner") - Number(a.teamRole === "owner") || a.code.localeCompare(b.code));
  const dir = data.directoryStatus;
  const reason = data.rosterLoading ? "正在读取位子" : data.roster?.dropped ? "部分机器读不到" : data.reason;
  const unknown = !data.roster || data.roster.dropped > 0;
  return <div className={s.roster}>
    <Metrics input={input} reason={reason} seatsLoading={data.rosterLoading} /><SlotLegend />
    {dir !== "ready" && <p className={s.note} data-roster-state={`directory-${dir}`} aria-busy={dir === "loading"}>{t(DIRECTORY_NOTE[dir])}</p>}
    {dir === "ready" && data.directory === null && <p className={s.note}>{t("没有团队目录，按机器显示")}</p>}
    {data.rosterLoading && <p className={s.note} data-roster-state="seats-loading" aria-busy>{t("正在读取位子")}</p>}
    <div className={s.grid}>
      {people.map(person => <MemberCard key={person.personId} person={person} machines={person.machines} cards={person.cards} tasks={tasks} now={now}
        reason={unknown ? reason : person.slotNote ?? reason} />)}
      {!!view.unclaimed.length && <MemberCard person={null} machines={view.unclaimed} tasks={tasks} now={now} reason={reason}
        cards={[...new Set(view.unclaimed.flatMap(m => [...m.workers.flatMap(w => w.taskId ? [w.taskId] : []), ...m.cards.merge, ...m.cards.live, ...m.cards.blocked]))]
          .map(id => ({ id, title: tasks.find(task => task.id === id)?.title ?? null, stage: tasks.find(task => task.id === id)?.stage ?? null }))} />}
    </div>
    {!people.length && !view.unclaimed.length && dir === "ready" && !data.rosterLoading && <p className={s.note}>{t("没有名册数据")}</p>}
  </div>;
}
