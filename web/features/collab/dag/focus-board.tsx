"use client";
/**
 * 子 DAG 默认视图「进行中优先」的分区列表（team-project-SUBDAG4）：头部（分段进度条、[列表 | 图]、版本按钮、数字行）+ 进行中 / 接下来 / 已完成三个分区。
 * 字段全来自 subdag-focus.ts 的 subdagFocus；本机和团队是同一个组件，只是团队行没有已耗 / 事件，对应项整项不出。
 * 悬停或聚焦一张卡：接下来、已完成里它的上下游行描边，其余变淡。点 chip 或从「谁在干活」跳来：先展开所在折叠，再滚到那一行闪一次
 * （dag.module.css 的 .flash）。头部图视图也用（FocusHead），接在画布上面，随时能切回列表。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Tr } from "../collab-model";
import type { DagView } from "./use-dag-ui";
import type { BoardNode, FeatureCard } from "./dag-types";
import type { FocusCard, FocusModel } from "./subdag-focus";
import { FocusCardView } from "./focus-card";
import { FocusDone } from "./focus-done";
import { FocusNext, useExiting, type RowLinks } from "./focus-next";
import type { Ft } from "./focus-i18n";
import d from "./dag.module.css";
import s from "./focus-board.module.css";

type Section = "active" | "next" | "done";

interface HeadProps {
  model: FocusModel;
  feature: FeatureCard;
  view: DagView;
  setView: (v: DagView) => void;
  onVersions: (featureId: string) => void;
  /** 列表视图下点分段滚到对应分区；图视图不给 */
  onSeg?: (section: Section) => void;
  ft: Ft;
  tr: Tr;
  narrow?: boolean;
}

const machineName = (m: string, ft: Ft) => (m === "local" ? ft("本机") : m);

/** 在干活的卡按机器计数（head.machines 连在等的卡也算，放在「在干活 a」后面会对不上） */
function workingMachines(active: readonly FocusCard[]): [string, number][] {
  const out = new Map<string, number>();
  for (const c of active) if ((c.state === "working" || c.state === "over") && c.machine !== null) out.set(c.machine, (out.get(c.machine) ?? 0) + 1);
  return [...out];
}

export function FocusHead({ model, feature, view, setView, onVersions, onSeg, ft, tr, narrow }: HeadProps) {
  const { head } = model;
  const segs = [
    { k: "done", n: head.done, cls: s.segOk, to: "done", label: ft("已完成 {n}", { n: head.done }) },
    { k: "active", n: head.active, cls: s.segRun, to: "active", label: ft("在干活 {n}", { n: head.active }) },
    { k: "waiting", n: head.waiting, cls: s.segWait, to: "active", label: ft("在等 {n}", { n: head.waiting }) },
    { k: "idle", n: head.idle, cls: s.segIdle, to: "next", label: ft("没开始 {n}", { n: head.idle }) },
  ] as const;
  const machines = workingMachines(model.active);
  const words = [
    head.done24h !== null && ft("近 24 小时完成 {n}", { n: head.done24h }),
    ft("在干活 {n}", { n: head.active }) + (machines.length ? `（${machines.map(([m, n]) => `${machineName(m, ft)} ${n}`).join(" / ")}）` : ""),
    ft("在等 {n}", { n: head.waiting }),
  ].filter(Boolean).join(" · ");
  return (
    <div className={s.head}>
      <div className={s.headTop}>
        <div className={s.bar}>
          {segs.map((g) => (onSeg
            ? <button key={g.k} type="button" className={`${s.barSeg} ${g.cls}`} style={{ flexGrow: g.n }} title={g.label} aria-label={g.label} onClick={() => onSeg(g.to)} />
            : <span key={g.k} className={`${s.barSeg} ${g.cls}`} style={{ flexGrow: g.n }} title={g.label} />))}
        </div>
        {!narrow && <div className={s.toggle} role="group">
          {(["list", "graph"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{ft(k === "list" ? "列表" : "图")}</button>
          ))}
        </div>}
        <button type="button" className={d.vbtn} onClick={() => onVersions(feature.id)} aria-label={tr("版本")}>
          v{feature.currentVersion}
          {feature.pending && <span className={d.pend} title={tr("待批")} />}
        </button>
      </div>
      <div className={s.words}>{words}</div>
    </div>
  );
}

interface BoardProps extends Omit<HeadProps, "onSeg"> {
  now: number;
  /** 刚推进的任务 id：那一张卡用 accent */
  hot: string | null;
  /** 从「谁在干活」跳来的目标（只给一次，处理完 onFlashed） */
  flash: { key: string; seq: number } | null;
  onFlashed: (seq: number) => void;
  onNode: (key: string) => void;
  onOwner: (agent: string, taskId: string | null) => void;
}

function useRelation(nodes: readonly BoardNode[]) {
  const [hover, setHover] = useState<FocusCard | null>(null);
  const keys = useMemo(() => new Set(nodes.map((n) => n.key)), [nodes]);
  const near = hover ? new Set([...hover.up.map((u) => u.nodeKey), ...hover.down]) : null;
  const rel = (key: string): "on" | "off" | undefined => (!near || !keys.has(key) ? undefined : near.has(key) ? "on" : "off");
  return { rel, setHover };
}

/** 只观察分区与滚动口相交；root 与 sticky 使用同一个滚动口，避免手机外壳改变高度后锚点错位。 */
function useSectionAnchor(root: RefObject<HTMLDivElement | null>, narrow: boolean | undefined, counts: string) {
  const [active, setActive] = useState<Section>("active");
  useEffect(() => {
    const el = root.current;
    if (!narrow || !el) return;
    const sections = [...el.querySelectorAll<HTMLElement>("[data-section]")];
    const nav = el.querySelector<HTMLElement>("[data-focus-anchors]");
    let observer: IntersectionObserver | null = null;
    const measure = () => {
      el.style.setProperty("--focus-scroll-height", `${el.clientHeight}px`);
      observer?.disconnect();
      const navHeight = nav?.offsetHeight ?? 53;
      observer = new IntersectionObserver(() => {
        const edge = nav?.getBoundingClientRect().bottom ?? el.getBoundingClientRect().top + navHeight;
        const nearTitle = sections.find((section) => {
          const r = section.querySelector("h3")?.getBoundingClientRect();
          return r && r.top >= edge - 1 && r.top < edge + 44 && r.bottom > edge;
        });
        const current = nearTitle ?? sections.find((section) => {
          const r = section.getBoundingClientRect();
          return r.top <= edge + 1 && r.bottom > edge + 1;
        }) ?? sections[0];
        if (current) setActive(current.dataset.section as Section);
      }, { root: el, rootMargin: `-${navHeight}px 0px -${Math.max(0, el.clientHeight - navHeight - 44)}px 0px`, threshold: [0, 0.1, 0.5, 1] });
      for (const section of sections) {
        observer.observe(section);
        const title = section.querySelector("h3");
        if (title) observer.observe(title);
      }
    };
    const size = new ResizeObserver(measure);
    measure();
    size.observe(el);
    return () => { observer?.disconnect(); size.disconnect(); };
  }, [root, narrow, counts]);
  return active;
}

function FocusAnchors({ model, next, active, onSeg, ft }: { model: FocusModel; next: number; active: Section; onSeg: (s: Section) => void; ft: Ft }) {
  const items = [{ key: "active", label: "进行中 {n}", n: model.active.length },
    { key: "next", label: "接下来 {n}", n: next }, { key: "done", label: "已完成 {n}", n: model.done.length }] as const;
  return <div className={s.anchors} data-focus-anchors>
    {items.map((i) => <button key={i.key} type="button" aria-pressed={active === i.key} disabled={!i.n} onClick={() => onSeg(i.key)}>
      {ft(i.label, { n: i.n })}
    </button>)}
  </div>;
}

export function FocusBoard(p: BoardProps) {
  const { model, feature, ft, tr } = p;
  const root = useRef<HTMLDivElement>(null);
  const active = useSectionAnchor(root, p.narrow, `${feature.id}:${model.active.length}:${model.done.length}:${model.head.idle}`);
  const nodes = useMemo(() => new Map(feature.nodes.map((n) => [n.key, n])), [feature.nodes]);
  const { rel, setHover } = useRelation(feature.nodes);
  const [pulse, setPulse] = useState<{ key: string; seq: number } | null>(null);
  const [handled, setHandled] = useState(0);
  const go = (key: string) => setPulse((x) => ({ key, seq: (x?.seq ?? 0) + 1 }));
  if (p.flash && p.flash.seq !== handled) {
    setHandled(p.flash.seq);
    go(p.flash.key);
  }
  const flashSeq = p.flash?.seq;
  const { onFlashed } = p;
  useEffect(() => {
    if (flashSeq !== undefined) onFlashed(flashSeq);
  }, [flashSeq, onFlashed]);
  useEffect(() => {
    const el = pulse && root.current?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(pulse.key)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove(d.flash);
    void el.offsetWidth;
    el.classList.add(d.flash);
  }, [pulse]);
  const toSection = (k: Section) => root.current?.querySelector(`[data-section="${k}"]`)?.scrollIntoView({ block: "start",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  const cards = useExiting(model.active, (c) => c.nodeKey);
  const links: RowLinks = { rel, onRow: p.onNode };
  const nNext = model.next.ready.length + model.next.oneHop.length + model.next.far.length;
  const head = <FocusHead model={model} feature={feature} view={p.view} setView={p.setView} onVersions={p.onVersions}
    onSeg={p.narrow ? undefined : toSection} narrow={p.narrow} ft={ft} tr={tr} />;
  return (
    <div className={`${s.pane} ${p.narrow ? s.narrow : ""}`}>
      {!p.narrow && head}
      <div ref={root} className={s.scroll} data-focus-board={feature.id}>
        {p.narrow && <>{head}<FocusAnchors model={model} next={nNext} active={active} onSeg={toSection} ft={ft} /></>}
        {cards.length > 0 && (
          <section data-section="active" className={s.section}>
            <h3 className={s.secTitle}>{ft("进行中 {n}", { n: model.active.length })}</h3>
            <div className={s.cards}>
              {cards.map(({ item: c, leaving }) => (
                <FocusCardView key={c.nodeKey} card={c} node={nodes.get(c.nodeKey)} now={p.now} hot={!!p.hot && c.taskId === p.hot} leaving={leaving}
                  onOpen={p.onNode} onOwner={p.onOwner} onChip={go} onHover={setHover} ft={ft} tr={tr} />
              ))}
            </div>
          </section>
        )}
        {nNext > 0 && (
          <section data-section="next" className={s.section}>
            <h3 className={s.secTitle}>{ft("接下来 {n}", { n: nNext })}</h3>
            <FocusNext next={model.next} links={links} reveal={pulse} ft={ft} tr={tr} />
          </section>
        )}
        {model.done.length > 0 && (
          <section data-section="done" className={s.section}>
            <FocusDone featureId={feature.id} done={model.done} done24h={model.head.done24h} autoOpen={model.autoOpenDone} now={p.now} links={links} reveal={pulse} ft={ft} />
          </section>
        )}
      </div>
    </div>
  );
}
