"use client";
import type { CardView, MachineView, PersonView } from "./roster-model";
import type { LedgerTaskView } from "../collab-model";
import { openCollabTask } from "../collab-nav";
import { rosterText, useRosterT } from "./roster-i18n";
import { RosterIcon } from "./roster-icons";
import { SlotStrip } from "./slot-strip";
import s from "./team-roster.module.css";

function CardLink({ card, tasks }: { card: CardView; tasks: readonly LedgerTaskView[] }) {
  const t = useRosterT();
  const task = tasks.find(task => task.id === card.id);
  const label = rosterText(card.id, rosterText(card.title, t("暂无")));
  return task ? <button className={s.cardLink} type="button" onClick={() => openCollabTask(task.id)}>{label}</button> : <span className={s.cardText}>{label}</span>;
}
function OutputBars({ machines }: { machines: MachineView[] }) {
  const t = useRosterT();
  const buckets = new Map<string, { delivered: number; reviewed: number }>();
  for (const m of machines) for (const day of m.output) {
    const old = buckets.get(day.day) ?? { delivered: 0, reviewed: 0 };
    buckets.set(day.day, { delivered: old.delivered + day.delivered, reviewed: old.reviewed + day.reviewed });
  }
  const days = [...buckets].sort(([a], [b]) => a.localeCompare(b)).slice(-7);
  const max = Math.max(1, ...days.flatMap(([, d]) => [d.delivered, d.reviewed]));
  const today = days.at(-1)?.[1];
  return <div className={s.output}>
    {days.length ? <div className={s.bars} aria-label={`${t("交付")} / ${t("审完")}`}>
      {days.map(([day, d]) => <div key={day} className={s.day} title={`${day} · ${t("交付")} ${d.delivered} · ${t("审完")} ${d.reviewed}`}>
        <i style={{ height: `${Math.max(2, d.delivered / max * 28)}px` }} /><i style={{ height: `${Math.max(2, d.reviewed / max * 28)}px` }} />
      </div>)}
    </div> : <span>{t("暂无")}</span>}
    <div>{t("今天")} {t("交付")} {today?.delivered ?? t("暂无")} · {t("审完")} {today?.reviewed ?? t("暂无")}</div>
  </div>;
}
function MachineBlock({ machine, now }: { machine: MachineView; now: number }) {
  const t = useRosterT();
  const age = machine.helloAt;
  const presence = machine.latencyMs != null ? `${machine.latencyMs} ms` : age != null ? `${t("心跳")} ${Math.max(0, Math.floor((now - age) / 1000))} ${t("秒前")}` : t("暂无");
  return <div className={s.machine} data-roster-machine={machine.key}>
    <div className={s.machineHead}><RosterIcon name="server" /><strong>{machine.isSelf ? t("本机") : rosterText(machine.name, t("未知"))}</strong>
      <span className={s.presence} title={t(machine.online == null ? "未知" : machine.online ? "在线" : "离线")}>{presence}</span></div>
    <SlotStrip family="Claude" slots={machine.slots.claude} now={now} reason="这台设备读不到位子" />
    <SlotStrip family="Codex" slots={machine.slots.codex} now={now} reason="这台设备读不到位子" />
  </div>;
}
/** loading = placeholder before the directory lands; seatsLoading = seats not read yet, filled in place in the same boxes. */
export function MemberCard({ person, machines, cards, tasks, now, reason, loading = false, seatsLoading = false }: {
  person: PersonView | null; machines: MachineView[]; cards: CardView[]; tasks: readonly LedgerTaskView[]; now: number; reason: string;
  loading?: boolean; seatsLoading?: boolean;
}) {
  const t = useRosterT();
  const title = loading ? t("读取中") : person ? rosterText(person.code, t("未知")) : t("未认领的机器");
  const running = new Set(machines.flatMap(m => m.workers.flatMap(w => w.taskId ? [w.taskId] : [])));
  const settled = new Set(machines.flatMap(m => [...m.cards.merge, ...m.cards.live, ...m.cards.blocked]));
  const active = cards.filter(c => !settled.has(c.id) && (running.has(c.id) || ["build", "fix", "review", "restate"].includes(c.stage ?? "")));
  const counts = ["merge", "live", "blocked"].map(stage => new Set([
    ...machines.flatMap(m => m.cards[stage as "merge" | "live" | "blocked"]), ...cards.filter(c => c.stage === stage).map(c => c.id),
  ]).size);
  return <article className={loading ? `${s.member} ${s.placeholder}` : s.member} aria-busy={loading || undefined}
    {...loading ? { "data-roster-placeholder": "" } : { "data-roster-member": person?.personId ?? "unclaimed" }}>
    <header className={s.memberHead}><span className={s.avatar}>{loading ? "" : Array.from(title)[0]?.toUpperCase()}</span>
      <div><h3>{title}{person?.isSelf && <small>{t("你")}</small>}</h3>
        <p>{loading ? "\u00a0" : person ? t(person.teamRole === "owner" ? "团队 owner" : "团队成员") : t("机器尚未归属成员")}</p></div>
    </header>
    {machines.map(m => <MachineBlock key={m.key} machine={m} now={now} />)}
    {!machines.length && (seatsLoading ? <div className={s.machine} aria-busy>
      <div className={s.machineHead}><RosterIcon name="server" /><strong>{t("读取中")}</strong></div>
      <SlotStrip family="Claude" slots={null} now={now} reason={reason} loading /><SlotStrip family="Codex" slots={null} now={now} reason={reason} loading />
    </div> : <div className={s.machine}>
      <SlotStrip family="Claude" slots={null} now={now} reason={reason} /><SlotStrip family="Codex" slots={null} now={now} reason={reason} />
      <p className={s.note}>{t(reason)}</p>
    </div>)}
    <div className={s.working}><h4><RosterIcon name="pencil" />{t("正在做")}</h4>
      {active.slice(0, 4).map(card => <div key={card.id} className={s.workRow}>
        <RosterIcon name={card.stage === "review" ? "eye" : card.stage === "fix" ? "wrench" : "pencil"} />
        <CardLink card={card} tasks={tasks} /><span>{rosterText(card.title, "")}</span>
      </div>)}
      {active.length > 4 && <p>{t("另有")} {active.length - 4} {t("个")}</p>}
      {!active.length && <p className={s.note}>{t(loading ? "读取中" : "暂无进行中的卡")}</p>}
    </div>
    <div className={s.badges}>{["等合并", "已上线待验", "被挡"].map((label, i) => counts[i] ?
      <span key={label}><RosterIcon name={i === 0 ? "merge" : "eye"} />{t(label)} {counts[i]}</span> : null)}</div>
    <OutputBars machines={machines} />
  </article>;
}
