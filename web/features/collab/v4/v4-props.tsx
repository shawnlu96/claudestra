"use client";
/**
 * 详情各页（桌面在右侧抽屉 project-tabs/task-drawer.tsx 里，手机整屏）：选中任务时是现成的任务详情（collab-detail.tsx，多挂一段「它的因果线」）；
 * 其余几页在这里——边 = 条件原文与判定依据，折叠组 = 成员，「待你处理」= 挂在这个项目上的那几条，
 * 团队成员 = 他在本项目手上的卡（team-panel-cards.tsx）+ 本机的打开会话。项目总览在 project-tabs/overview-tab.tsx，从这里取 TaskLink / WaitGo。
 */
import { mirrorAt, type LedgerDepView, type LedgerOverview, type OwnerWait, type Tr } from "../collab-model";
import { useChatStoreApi } from "../../chat/chat-store";
import { useChatNav } from "../../chat/components/nav-context";
import { uiAgentName } from "@/lib/chat/agents";
import { closeCollab } from "../collab-nav";
import { TeamPanelCards } from "../team-panel-cards";
import type { Member } from "./v4-selection";
import { Icon } from "../collab-icons";
import { asksStore } from "../../asks/asks-store";
import { useLang } from "@/lib/i18n";
import { featureProposalsTr } from "@/lib/i18n-dict-feature-proposals";
import s from "../collab.module.css";
import type { CFold } from "./causal-model";
import { causeOf, edgeBasis, STATE_WORD } from "./v4-model";
import { MACHINE_WORDS } from "@/lib/owner-words";
import { instanceName } from "../team-instance-names";
import { sharedIdentity } from "../team-source-key";
import { refreshBindings } from "@/lib/collab-source-binding";
import { waitsText } from "../owner-waits";
import { useInstanceNames } from "../work/use-work-board";
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

export function TaskLink({ id, ov, onPick }: { id: string; ov: LedgerOverview; onPick: (id: string) => void }) {
  const t = ov.tasks.find((x) => x.id === id);
  return (
    <button type="button" className={v.link} onClick={() => onPick(id)}>
      <span className={v.tid}>{id}</span> {t?.title ?? ""}
    </button>
  );
}

/** 每一行都给一个「去处理」：打开全站收件箱并定位到这张卡（作答只在那里做，协作视图里不另做一套）；有卡号的行卡号照旧点进任务详情 */
export function WaitGo({ w }: { w: OwnerWait }) {
  const tr = featureProposalsTr(useLang());
  return (
    <button type="button" className={s.btn} style={{ alignSelf: "flex-start" }} aria-label={`${tr("去处理")} ${w.title}`} onClick={() => asksStore.openDrawer(w.id)}>
      {tr("去处理")} <Icon name="chevronRight" size={13} />
    </button>
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

/** 「待你处理」读不到时的重试（UXCARD3）：重读待办列表和这台机器的团队绑定，不整页刷新 */
export function retryWaits(project: string) {
  void asksStore.refresh();
  const machine = sharedIdentity(project)?.machine;
  if (machine) void refreshBindings(machine);
}

export function WaitsPage({ waits, unknown, project, ov, onPick, onClose, tr }: {
  waits: readonly OwnerWait[]; unknown?: boolean; project: string; ov: LedgerOverview; onPick: (id: string) => void; onClose: () => void; tr: Tr;
}) {
  return (
    <Shell title={tr("待你处理")} sub={tr("这个项目上开着、等你的")} onClose={onClose} tr={tr}>
      {unknown ? (
        <div className={v.muted} data-waits="unknown">{waitsText(tr, "读不到")}{" "}
          <button type="button" className={s.btn} onClick={() => retryWaits(project)}>{waitsText(tr, "重试")}</button></div>
      ) : waits.length ? waits.map((w) => (
        <div key={w.id} className={v.row}>{w.taskId && <TaskLink id={w.taskId} ov={ov} onPick={onPick} />}<div>{w.title}</div><WaitGo w={w} /></div>
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

/** 团队卡的执行证据；实例 id 按本机快照换成机器显示名。 */
export function TeamFactsSec({ id, ov, now, tr, project = "" }: { project?: string; id: string; ov: Pick<LedgerOverview, "tasks">; now: number; tr: Tr }) {
  const f = ov.tasks.find((t) => t.id === id)?.team, identity = sharedIdentity(project);
  const names = useInstanceNames(identity && f?.executorInstanceId !== identity.homeInstanceId ? identity.machine : null);
  if (!f) return null;
  const mirror = mirrorAt(f, now);
  const machine = instanceName(f.executorInstanceId, names, identity?.homeInstanceId ?? null);
  const inst = machine === "本机" || machine === "其他成员的机器" || !machine ? tr(machine ?? "暂无") : machine;
  const rows: [string, React.ReactNode][] = [
    ["成员代号", f.assigneeCode || tr("暂无")],
    [MACHINE_WORDS.machine, inst],
    ["head", shortHead(f.head) ?? tr("暂无")],
    ["阻塞提问", f.blockingAsks],
    [MACHINE_WORDS.syncSection, mirror === "stale" ? <span className={v.warn}>{tr(MACHINE_WORDS.stale)}</span> : tr(mirror === "fresh" ? MACHINE_WORDS.fresh : "暂无")],
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
    <Shell title={m.peer ? `${m.name}@${m.peer}` : m.name} sub={tr(m.peer ? MACHINE_WORDS.otherMembers : "本机成员")} onClose={onClose} tr={tr}>
      {m.agent && <button type="button" className={v.link} onClick={open}>{tr("打开会话")} →</button>}
      <TeamPanelCards key={m.id} project={project} peer={m.peer ?? ""} agent={m.name} />
    </Shell>
  );
}
