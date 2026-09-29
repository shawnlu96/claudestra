"use client";
/**
 * v4 右区「属性」：选中任务时是现成的任务详情（collab-detail.tsx，多挂一段「它的因果线」）；其余几页在这里——
 * 没选中 = 项目概览，边 = 条件原文与判定依据，折叠组 = 成员，「待你处理」= 挂在这个项目上的那几条，
 * 团队成员 = 他在本项目手上的卡（team-panel-cards.tsx）+ 本机的打开会话；手机上团队面板本身也用这里的外框整屏打开。
 */
import type { HomeView, LedgerDepView, LedgerOverview, OwnerWait, Tr } from "../collab-model";
import { useChatStoreApi } from "../../chat/chat-store";
import { useChatNav } from "../../chat/components/nav-context";
import { uiAgentName } from "@/lib/chat/agents";
import { closeCollab } from "../collab-nav";
import { TeamPanelCards } from "../team-panel-cards";
import type { Member } from "./v4-selection";
import { Icon } from "../collab-icons";
import s from "../collab.module.css";
import type { CFold } from "./causal-model";
import { causeOf, edgeBasis, STATE_WORD, stageCounts } from "./v4-model";
import v from "./v4.module.css";

const hhmm = (ms: number) => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function Shell({ title, sub, onClose, children, tr }: { title: string; sub?: string; onClose?: () => void; children: React.ReactNode; tr: Tr }) {
  return (
    <aside className={`${s.tokens} ${s.panel}`}>
      <div className={s.ph}>
        <div className={s.tt}>
          <div className={s.a}>{title}</div>
          {sub && <div className={s.b}>{sub}</div>}
        </div>
        {onClose && (
          <button type="button" className={s.ib} aria-label={tr("关闭")} onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
      <div className={s.pb}>{children}</div>
    </aside>
  );
}

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={s.sec}>
      <h5>{title}</h5>
      {children}
    </section>
  );
}

function TaskLink({ id, ov, onPick }: { id: string; ov: LedgerOverview; onPick: (id: string) => void }) {
  const t = ov.tasks.find((x) => x.id === id);
  return (
    <button type="button" className={v.link} onClick={() => onPick(id)}>
      <span className={v.tid}>{id}</span> {t?.title ?? ""}
    </button>
  );
}

export function Overview(props: {
  ov: LedgerOverview; view: HomeView; waits: readonly OwnerWait[]; projectName: string; onPick: (id: string) => void; tr: Tr;
  /** 「上次来之后」（collab-since-card.tsx），没有上次记录时不给 */
  since?: React.ReactNode;
}) {
  const { ov, view, waits, projectName, onPick, tr } = props;
  const h = view.headline;
  return (
    <Shell title={projectName} sub={tr("项目概览")} tr={tr}>
      {props.since}
      <Sec title={tr("现在")}>
        <div className={v.kv}>
          {tr("{n} 条在推进", { n: h.advancing })}
          {h.problem > 0 && <span className={v.bad}> · {tr("{n} 条出问题", { n: h.problem })}</span>}
          {h.stuck > 0 && <span className={v.warn}> · {tr("{n} 条卡住", { n: h.stuck })}</span>}
          {view.pm.frozen && <span className={v.warn}> · {tr("合并队列冻结：{r}", { r: view.pm.frozen })}</span>}
        </div>
      </Sec>
      <Sec title={tr("要你定的")}>
        {waits.length ? waits.map((w) => (
          <div key={w.id} className={v.row}>{w.taskId ? <TaskLink id={w.taskId} ov={ov} onPick={onPick} /> : null} {w.title}</div>
        )) : <div className={v.muted}>{tr("没有")}</div>}
      </Sec>
      <Sec title={tr("各阶段")}>
        <div className={v.counts}>
          {stageCounts(ov).map((c) => (
            <span key={c.label} className={v.count}><b>{c.n}</b> {tr(c.label)}</span>
          ))}
        </div>
      </Sec>
      {view.pm.pm && <Sec title="PM"><div className={v.kv}>{view.pm.pm} · {tr("在管")} {view.pm.managing} · {tr("排队")} {view.pm.queued.length}</div></Sec>}
    </Shell>
  );
}

function DepBody({ dep, ov, onPick, tr }: { dep: LedgerDepView; ov: LedgerOverview; onPick: (id: string) => void; tr: Tr }) {
  return (
    <>
      <Sec title={tr("条件原文")}><div className={v.quote}>{dep.when || tr("（没写条件）")}</div></Sec>
      <Sec title={tr("现在")}>
        <div className={`${v.kv} ${v[`st_${dep.effective}`] ?? ""}`}>{tr(STATE_WORD[dep.effective])}</div>
        <div className={v.muted}>{edgeBasis(dep, tr)}</div>
        {dep.fromCancelled && <div className={v.warn}>{tr("前置已取消：这条边永远到不了「已成立」，请 PM 删边或改指向")}</div>}
      </Sec>
      <Sec title={tr("判定依据")}>
        <div className={v.muted}>{tr("{who} 建于 {t}，最后改于 {u}", { who: dep.createdBy, t: hhmm(dep.createdAt), u: hhmm(dep.updatedAt) })}</div>
      </Sec>
      <Sec title={tr("两端")}>
        <TaskLink id={dep.from} ov={ov} onPick={onPick} />
        <TaskLink id={dep.to} ov={ov} onPick={onPick} />
      </Sec>
    </>
  );
}

/** 一条依赖，或画布上合成一根线的几条（指向折叠组时）：逐条列出，各自的状态和条件都看得到 */
export function EdgePage({ deps, ov, onPick, onClose, tr }: { deps: readonly LedgerDepView[]; ov: LedgerOverview; onPick: (id: string) => void; onClose: () => void; tr: Tr }) {
  const one = deps.length === 1 ? deps[0]! : null;
  const title = one ? `${one.from} → ${one.to}` : tr("{n} 条依赖", { n: deps.length });
  return (
    <Shell title={title} sub={one ? tr(one.kind === "branch" ? "分支依赖" : "前置依赖") : tr("画布上合成一根线")} onClose={onClose} tr={tr}>
      {one ? <DepBody dep={one} ov={ov} onPick={onPick} tr={tr} /> : deps.map((d) => (
        <div key={`${d.from}>${d.to}`} className={v.depItem}>
          <div className={v.depHead}>{d.from} → {d.to}</div>
          <DepBody dep={d} ov={ov} onPick={onPick} tr={tr} />
        </div>
      ))}
    </Shell>
  );
}

export function FoldPage({ fold, ov, onPick, onClose, tr }: { fold: CFold; ov: LedgerOverview; onPick: (id: string) => void; onClose: () => void; tr: Tr }) {
  return (
    <Shell title={tr("{n} 件在等 {x}", { n: fold.members.length, x: fold.waitFor })} onClose={onClose} tr={tr}>
      <Sec title={tr("在等")}><TaskLink id={fold.waitFor} ov={ov} onPick={onPick} /></Sec>
      <Sec title={tr("成员")}>{fold.members.map((id) => <TaskLink key={id} id={id} ov={ov} onPick={onPick} />)}</Sec>
    </Shell>
  );
}

export function WaitsPage({ waits, ov, onPick, onClose, tr }: { waits: readonly OwnerWait[]; ov: LedgerOverview; onPick: (id: string) => void; onClose: () => void; tr: Tr }) {
  return (
    <Shell title={tr("待你处理")} sub={tr("这个项目上开着、等你的")} onClose={onClose} tr={tr}>
      {waits.length ? waits.map((w) => (
        <div key={w.id} className={v.row}>{w.taskId && <TaskLink id={w.taskId} ov={ov} onPick={onPick} />}<div>{w.title}</div></div>
      )) : <div className={v.muted}>{tr("没有")}</div>}
    </Shell>
  );
}

/** 任务详情里多挂的一段：它在等什么、谁在等它（点一条看边） */
export function CauseSec({ id, deps, onEdge, tr }: { id: string; deps: readonly LedgerDepView[]; onEdge: (d: LedgerDepView) => void; tr: Tr }) {
  const { incoming, outgoing } = causeOf(id, deps);
  if (!incoming.length && !outgoing.length) return null;
  const row = (d: LedgerDepView, other: string) => (
    <button key={`${d.from}>${d.to}`} type="button" className={`${v.link} ${v[`st_${d.effective}`] ?? ""}`} onClick={() => onEdge(d)}>
      <span className={v.tid}>{other}</span> {d.when || "—"} · {tr(STATE_WORD[d.effective])}
    </button>
  );
  return (
    <Sec title={tr("它的因果线")}>
      {incoming.length > 0 && <div className={v.muted}>{tr("在等")}</div>}
      {incoming.map((d) => row(d, d.from))}
      {outgoing.length > 0 && <div className={v.muted}>{tr("谁在等它")}</div>}
      {outgoing.map((d) => row(d, d.to))}
    </Sec>
  );
}

/** 团队成员：本项目里他手上的卡（点开是任务详情）；本机 agent 还能直接打开会话 */
export function MemberPage({ m, project, onClose, tr }: { m: Member; project: string; onClose: () => void; tr: Tr }) {
  const store = useChatStoreApi();
  const nav = useChatNav();
  const open = () => {
    if (!m.agent) return;
    closeCollab();
    void store.openAgent(uiAgentName(m.agent));
    nav.toContent();
  };
  return (
    <Shell title={m.peer ? `${m.name}@${m.peer}` : m.name} sub={tr(m.peer ? "外部实例成员" : "本机成员")} onClose={onClose} tr={tr}>
      {m.agent && <button type="button" className={v.link} onClick={open}>{tr("打开会话")} →</button>}
      <TeamPanelCards key={m.id} project={project} peer={m.peer ?? ""} agent={m.name} />
    </Shell>
  );
}

/** 手机：团队面板整屏（桌面在中区「团队」标签里） */
export function TeamPage({ onClose, tr, children }: { onClose: () => void; tr: Tr; children: React.ReactNode }) {
  return <Shell title={tr("团队")} sub={tr("最近 10 分钟的真实往来")} onClose={onClose} tr={tr}>{children}</Shell>;
}
