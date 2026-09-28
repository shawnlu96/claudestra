"use client";
/**
 * 协作视图首页（第一屏，ux.md §3）：一句话状态 → PM 调度窄条 → 按关注度排好的任务线 → 今日完成一行。
 * 点一条线在右侧开详情（手机全屏，collab-detail.tsx），首页不被替换。
 */
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { useChatStore } from "../chat/chat-store";
import { useChatNav } from "../chat/components/nav-context";
import { actionLine } from "./collab-action";
import { CollabDetail } from "./collab-detail";
import { Icon } from "./collab-icons";
import { CollabLine, LineHeaderCols } from "./collab-line";
import { columnOf, homeView, type HomeView, type LedgerOverview, type LineView, type Tr } from "./collab-model";
import { openCollabTask, useCollabNav } from "./collab-nav";
import { useCollab, type Advance } from "./use-collab";
import { cachedOverview } from "./collab-cache";
import s from "./collab.module.css";

/** 模块级稳定引用：详情里的 effect 依赖它，每次渲染换新函数会白跑 */
const closeTask = () => openCollabTask(null);

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function Headline({ v, tr, connected, now, projectName }: { v: HomeView; tr: Tr; connected: boolean; now: number; projectName: string }) {
  const parts: { cls?: string; text: string }[] = [{ text: tr("{n} 条在推进", { n: v.headline.advancing }) }];
  if (v.headline.problem) parts.push({ cls: s.bad, text: tr("{n} 条出问题", { n: v.headline.problem }) });
  if (v.headline.stuck) parts.push({ cls: s.stuck, text: tr("{n} 条卡住", { n: v.headline.stuck }) });
  return (
    <div className={s.top}>
      <div className={s.status}>
        <div className={s.s1}>
          {parts.map((p, i) => (
            <span key={p.text} style={{ display: "contents" }}>
              {i > 0 && <span className={s.sep}>·</span>}
              <span className={p.cls}>{p.text}</span>
            </span>
          ))}
          {v.todayDone.length > 0 && <span className={s.dim}>· {tr("今日完成 {n}", { n: v.todayDone.length })}</span>}
        </div>
        <div className={s.s2}>
          <span className={s.clk}>
            <span className={`${s.live} ${connected ? "" : s.off}`} />
            <b>{hhmm(now)}</b>
            {connected ? tr("实时") : tr("重连中")}
          </span>
          <span>· {projectName}</span>
        </div>
      </div>
    </div>
  );
}

function PmStrip({ v, action, tr }: { v: HomeView; action: string; tr: Tr }) {
  if (!v.pm.pm) return null;
  return (
    <div className={s.pmstrip}>
      <span className={s.who}>
        <Icon name="clipboard" size={14} />
        <b>PM · {v.pm.pm}</b>
        <span>{tr("调度")}</span>
      </span>
      <span className={s.vsep} />
      <span className={s.d}>{action}</span>
      <span className={s.vsep} />
      <span className={s.kv}>
        {tr("在管")} <b>{v.pm.managing}</b> · {tr("在审")} <b>{v.pm.reviewing}</b> · {tr("排队")} <b>{v.pm.queued.length}</b>
        {v.pm.queued.length > 0 && ` (${v.pm.queued.slice(0, 3).join(" ")})`}
      </span>
      {v.pm.frozen && (
        <>
          <span className={s.vsep} />
          <span className={s.warnText}>{tr("合并队列冻结：{r}", { r: v.pm.frozen })}</span>
        </>
      )}
    </div>
  );
}

function DoneRow({ ov, ids, tr, onOpen }: { ov: LedgerOverview; ids: string[]; tr: Tr; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!ids.length) return null;
  const byId = new Map(ov.tasks.map((t) => [t.id, t]));
  return (
    <div className={s.done}>
      <button type="button" className={s.tg} onClick={() => setOpen((o) => !o)}>
        <Icon name="circleCheck" size={14} />
        {tr("今日完成")} <b>{ids.length}</b>
        <span className={s.ids}>{ids.map((id) => <span key={id}>{id}</span>)}</span>
        <Icon name="chevronRight" size={12} className={open ? "rotate-90" : ""} />
      </button>
      {open &&
        ids.map((id) => {
          const t = byId.get(id);
          return (
            <div key={id} className={s.dl} onClick={() => onOpen(id)}>
              <span className={s.tid}>{id}</span>
              <span>{t?.title}</span>
              <span className={s.x}>{t?.metrics.endTs ? hhmm(t.metrics.endTs) : ""}</span>
            </div>
          );
        })}
    </div>
  );
}

function Empty({ icon, title, children }: { icon: "listTree" | "clock" | "circleCheck"; title: string; children?: React.ReactNode }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIc}>
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** 刚推进的那一条；没有实时推进时，取最近进入当前阶段的那条（首屏也有一条亮着，和原型一致） */
function hotOf(lines: LineView[], adv: Advance | null): { id: string | null; from: number | null } {
  if (adv && lines.some((l) => l.id === adv.id)) return { id: adv.id, from: columnOf(adv.from) };
  const fresh = lines.filter((l) => l.dwellMs !== null).sort((a, b) => a.dwellMs! - b.dwellMs!)[0];
  return { id: fresh?.id ?? null, from: null };
}

export function CollabView({ project }: { project: string }) {
  const tr = useT();
  const nav = useChatNav();
  const { task: openTask } = useCollabNav();
  const agents = useChatStore((st) => st.state.agents);
  const projects = useChatStore((st) => st.state.projects);
  // 本项目的 agent：registry 里归这个项目的，加上台账任务挂着的执行者 / PM（缓存的总览里有）
  const members = useMemo(() => {
    const set = new Set(agents.filter((a) => a.projectId === project).map((a) => a.name));
    for (const t of cachedOverview(project)?.ov.tasks ?? []) for (const n of [t.agent, t.pm]) if (n) set.add(n.replace(/^agent-/, ""));
    return set;
  }, [agents, project]);
  const { load, now, actions, connected, rev, advance, refetch } = useCollab(project, members);
  const busy = useMemo(() => new Map(agents.map((a) => [a.name, a.busy])), [agents]);
  const ov = load.status === "ok" ? load.ov : null;
  const view = useMemo(() => (ov ? homeView(ov, now, tr) : null), [ov, now, tr]);
  const projectName = projects.find((p) => p.id === project)?.name || project;

  const lineAction = (l: LineView) => {
    const waitLabel = l.attention === "waiting" || l.attention === "stuck" ? l.stageLabel : null;
    return l.agent ? actionLine(actions.get(l.agent), busy.get(l.agent), waitLabel) : { kind: "idle" as const, text: "" };
  };
  const pmAction = (() => {
    if (!view?.pm.pm) return "";
    const a = actionLine(actions.get(view.pm.pm), busy.get(view.pm.pm), null);
    return a.text ? `${tr("运行工具")} · ${a.text}` : tr(a.kind === "thinking" ? "思考中" : "空闲");
  })();
  const hot = view ? hotOf(view.lines, advance) : { id: null, from: null };

  let body: React.ReactNode;
  if (load.status === "loading") body = <Empty icon="clock" title={tr("正在读取台账…")} />;
  else if (load.status === "forbidden") body = <Empty icon="listTree" title={tr("这台设备没有读台账的权限")}>{tr("需要全部 agent 范围、带管理权限的设备。")}</Empty>;
  else if (load.status === "error")
    body = (
      <Empty icon="listTree" title={tr("读台账失败")}>
        <div>{load.message}</div>
        <button type="button" className={s.ib} style={{ marginTop: 12 }} onClick={() => void refetch()}>{tr("重试")}</button>
      </Empty>
    );
  else if (!ov!.exists || ov!.tasks.length === 0)
    body = (
      <Empty icon="listTree" title={tr("这个项目还没有台账")}>
        {tr("PM 派发任务后，这里会按关注度列出每条任务线。已有旧台账可以导入：")}
        <div style={{ marginTop: 8 }}><code>bun src/manager.ts ledger import &lt;ledger.json&gt; --map &lt;map.json&gt;</code></div>
      </Empty>
    );
  else
    body = (
      <>
        <Headline v={view!} tr={tr} connected={connected} now={now} projectName={projectName} />
        <PmStrip v={view!} action={pmAction} tr={tr} />
        <div className={s.lines}>
          {view!.lines.length > 0 ? <LineHeaderCols tr={tr} /> : <Empty icon="circleCheck" title={tr("没有进行中的任务")} />}
          {view!.lines.map((l) => (
            <CollabLine key={l.id} line={l} action={lineAction(l)} hot={hot.id === l.id} hotFrom={hot.id === l.id ? hot.from : null}
              selected={openTask === l.id} onOpen={() => openCollabTask(l.id)} tr={tr} />
          ))}
          <DoneRow ov={ov!} ids={view!.todayDone} tr={tr} onOpen={(id) => openCollabTask(id)} />
        </div>
      </>
    );

  return (
    <div className={`${s.tokens} ${s.root} ${openTask ? s.panelOn : ""}`}>
      <div className={s.home}>
        <div className={s.mtop}>
          <button type="button" className={s.ib} aria-label={tr("返回")} onClick={nav.toList}>
            <Icon name="arrowLeft" size={16} />
          </button>
          <span className={s.ttl2}>{tr("协作视图")}</span>
        </div>
        {body}
      </div>
      {openTask && ov && (
        <CollabDetail project={project} id={openTask} rev={rev} now={now} ov={ov} line={view?.lines.find((l) => l.id === openTask) ?? null}
          action={(l) => lineAction(l)} onClose={closeTask} />
      )}
    </div>
  );
}
