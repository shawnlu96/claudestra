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
import { looksLikeId } from "../team-source-adapter";
import v from "./v4.module.css";

export const hhmm = (ms: number) => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** 右区一页的外框（子 DAG 的节点 / 版本 / 差异页也用，dag/dag-props.tsx） */
export function Shell({ title, sub, onClose, children, tr, className }: { title: string; sub?: string; onClose?: () => void; children: React.ReactNode; tr: Tr; className?: string }) {
  return (
    <aside className={`${s.tokens} ${s.panel} ${className ?? ""}`}>
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

export function Sec({ title, children }: { title: string; children: React.ReactNode }) {
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
      {ov.mirror && <MirrorSec m={ov.mirror} tr={tr} />}
      {view.pm.pm && <Sec title="PM"><div className={v.kv}>{view.pm.pm} · {tr("在管")} {view.pm.managing} · {tr("排队")} {view.pm.queued.length}</div></Sec>}
    </Shell>
  );
}

/**
 * 团队总览：各 feature 执行镜像的新鲜度（过期 = 看到的可能不是现在的状态）。有过期的报过期数；全部有镜像且都新鲜才说最新；
 * 有 feature 还没有镜像（没有证据）就是暂无，不凭缺值说最新。本机总览没有 mirror，不显示
 */
function MirrorSec({ m, tr }: { m: NonNullable<LedgerOverview["mirror"]>; tr: Tr }) {
  return (
    <Sec title={tr("镜像")}>
      <div className={v.kv}>
        {m.stale > 0 ? <span className={v.warn}>{tr("{n} 个 feature 主场镜像过期", { n: m.stale })}</span>
          : m.none === 0 && m.fresh > 0 ? tr("主场镜像最新") : tr("暂无")}
      </div>
    </Sec>
  );
}

/** 边的建立者 / 时间：团队数据没有边级元数据（null），不调 hhmm（0 会出 1970、null 出 Invalid Date），也不留空名字 */
function edgeMeta(dep: LedgerDepView, tr: Tr): string {
  if (!dep.createdBy || !dep.createdAt || !dep.updatedAt) return tr("建立者 / 时间未记录（团队数据没有边级元数据）");
  return tr("{who} 建于 {t}，最后改于 {u}", { who: dep.createdBy, t: hhmm(dep.createdAt), u: hhmm(dep.updatedAt) });
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
        <div className={v.muted}>{edgeMeta(dep, tr)}</div>
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

/** head 只显示短 SHA（8 位，和步骤线 collab-step-line-model.ts 同口径）；不像 commit 的不显示原文 */
const shortHead = (h: string | null) => (h && /^[0-9a-f]{7,64}$/i.test(h.trim()) ? h.trim().slice(0, 8) : null);

/**
 * 任务详情里团队卡多挂的一段：执行镜像带来的成员代号（不是本机 agent，不给打开会话）、执行实例（像 id 的不显示原文）、
 * head（只显示短 SHA）、主场开着的阻塞提问数、镜像新鲜度。不知道的写「暂无」（镜像没有证据也是暂无，不说最新）；本机卡没有 team，整段不显示。
 */
export function TeamFactsSec({ id, ov, tr }: { id: string; ov: Pick<LedgerOverview, "tasks">; tr: Tr }) {
  const f = ov.tasks.find((t) => t.id === id)?.team;
  if (!f) return null;
  const inst = f.executorInstanceId ? (looksLikeId(f.executorInstanceId) ? tr("主场实例") : f.executorInstanceId) : tr("暂无");
  const rows: [string, React.ReactNode][] = [
    ["成员代号", f.assigneeCode || tr("暂无")],
    ["执行实例", inst],
    ["head", shortHead(f.head) ?? tr("暂无")],
    ["阻塞提问", f.blockingAsks],
    ["镜像", f.mirror === "stale" ? <span className={v.warn}>{tr("主场镜像过期")}</span> : tr(f.mirror === "fresh" ? "主场镜像最新" : "暂无")],
  ];
  return (
    <Sec title={tr("团队")}>
      {rows.map(([k, val]) => <div key={k} className={v.kv} data-team-fact={k}>{tr(k)}{tr("：")}{val}</div>)}
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
