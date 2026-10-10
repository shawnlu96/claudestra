"use client";
/**
 * 子 DAG 在右区「属性」的三页：节点（卡标题、负责人、步骤、依赖、PR / 分支、差异原因）、版本（每版的原因类型图标 + 原因首行 +
 * 提出人 / 批准人 + 时间，选两版对比；默认当前版和上一版，有待批的重写时它只能当 to）、差异（增 / 删 / 带入有改 / 取消四类，
 * 取消带原因，rewrittenDone 单列）。手机上版本页整屏、差异页是底部抽屉，都是这几个组件。
 */
import { PlannedNodeSections } from "./node-card-section";
import { useState } from "react";
import { STAGE_NAME } from "../collab-detail-model";
import { fmtDuration, type Stage, type Tr } from "../collab-model";
import { Icon, type IconName } from "../collab-icons";
import { hhmm, Sec, Shell } from "../v4/v4-props";
import v from "../v4/v4.module.css";
import { compareOf, defaultCompare, diffLists, type Compare, type DiffItem, type DiffMark } from "./dag-diff";
import { StepBar, stepText } from "./dag-node";
import type { BoardNode, FeatureCard, FeatureDetail, ReasonKind, VersionMeta } from "./dag-types";
import type { CompareData } from "./use-dag-board";
import d from "./dag.module.css";

const REASON_ICON: Record<ReasonKind, IconName> = { initial: "flag", new_issue: "circleAlert", requirement_change: "messageSquare", p1_fallback: "rotateCcw" };
const REASON_WORD: Record<ReasonKind, string> = { initial: "初版", new_issue: "发现新问题", requirement_change: "需求变了", p1_fallback: "P1 退路" };
const firstLine = (s: string) => s.split("\n")[0] ?? "";

export function NodePage(props: {
  planned?: boolean; feature: FeatureCard; node: BoardNode; owner: { agent: string; role: string } | null; mark: DiffMark | null; now: number;
  onTask: (taskId: string) => void; onOwner: (agent: string) => void; onNode: (key: string) => void; onClose: () => void; tr: Tr;
}) {
  const { feature: f, node: n, owner, mark, tr } = props;
  const status = n.status === null ? tr("找不到这张卡") : n.status === "planned" ? tr("计划中") : tr(STAGE_NAME[n.status as Stage] ?? n.status);
  return (
    <Shell title={`${n.key} · ${n.oneLine}`} sub={f.title} onClose={props.onClose} tr={tr} className={d.touch}>
      <Sec title={tr("现在")}>
        <div className={`${v.kv} ${n.missing ? v.warn : ""}`}>{status}{n.since !== null && n.phase === "active" ? ` · ${fmtDuration(Math.max(0, props.now - n.since), tr)}` : ""}</div>
        {owner && <button type="button" className={v.link} onClick={() => props.onOwner(owner.agent)}>{owner.agent} →</button>}
        {n.stepLine && <><StepBar node={n} /><div className={v.muted}>{stepText(n, tr)}</div></>}
      </Sec>
      {mark?.cancelled !== undefined && <Sec title={tr("取消原因")}><div className={v.quote}>{mark.cancelled || "—"}</div></Sec>}
      {n.taskId && (
        <Sec title={tr("卡")}>
          <button type="button" className={v.link} onClick={() => props.onTask(n.taskId!)}><span className={v.tid}>{n.taskId}</span> {n.title ?? ""}</button>
          {(n.pr || n.branch) && <div className={v.muted}>{[n.pr, n.branch].filter(Boolean).join(" · ")}</div>}
        </Sec>
      )}
      {n.deps.length > 0 && (
        <Sec title={tr("前置")}>
          {n.deps.map((k) => {
            const dep = f.nodes.find((x) => x.key === k);
            return <button key={k} type="button" className={v.link} onClick={() => props.onNode(k)}><span className={v.tid}>{k}</span> {dep?.oneLine ?? ""}</button>;
          })}
        </Sec>
      )}
      {n.estimate && <Sec title={tr("粗估")}><div className={v.kv}>{n.estimate}</div></Sec>}
      {props.planned && <PlannedNodeSections feature={f} node={n} tr={tr} />}
    </Shell>
  );
}

type Pick2 = (number | "pending")[];

function VersionRow({ m, no, on, onToggle, tr }: { m: VersionMeta; no: number | "pending"; on: boolean; onToggle: () => void; tr: Tr }) {
  return (
    <button type="button" className={`${d.vrow} ${on ? d.vrowOn : ""}`} aria-pressed={on} onClick={onToggle} title={m.reasonText}>
      <Icon name={REASON_ICON[m.reasonKind] ?? "fileText"} size={14} />
      <span className={d.vno}>{no === "pending" ? tr("待批") : `v${no}`}</span>
      <span className={d.vtxt}>{firstLine(m.reasonText) || tr(REASON_WORD[m.reasonKind] ?? m.reasonKind)}</span>
      <span className={d.vmeta}>{[m.proposedBy, m.approvedBy].filter(Boolean).join(" / ")} · {hhmm(m.createdAt)}</span>
    </button>
  );
}

export function VersionsPage(props: {
  feature: FeatureCard; detail: FeatureDetail | null; compare: Compare | null; onCompare: (c: Compare) => void; onClose: () => void; tr: Tr;
}) {
  const { feature: f, detail, tr } = props;
  const init = props.compare?.featureId === f.id ? props.compare : defaultCompare(f.id, f.currentVersion);
  const [picked, setPicked] = useState<Pick2>(init ? [init.from, init.to] : [f.currentVersion]);
  const toggle = (no: number | "pending") => setPicked((p) => (p.includes(no) ? p.filter((x) => x !== no) : [...p, no].slice(-2)));
  const c = picked.length === 2 ? compareOf(f.id, picked[0]!, picked[1]!) : null;
  const versions = [...(detail?.versions ?? [])].reverse();
  return (
    <Shell title={f.title || f.id} sub={tr("版本")} onClose={props.onClose} tr={tr} className={d.touch}>
      <button type="button" className={d.go} disabled={!c} onClick={() => c && props.onCompare(c)}>
        <Icon name="gitCompare" size={14} />{tr("对比")}
      </button>
      {f.pending && <VersionRow m={f.pending} no="pending" on={picked.includes("pending")} onToggle={() => toggle("pending")} tr={tr} />}
      {versions.map((m) => <VersionRow key={m.version} m={m} no={m.version} on={picked.includes(m.version)} onToggle={() => toggle(m.version)} tr={tr} />)}
      {!detail && <div className={v.muted}>{tr("正在读取…")}</div>}
    </Shell>
  );
}

const KINDS = [
  ["added", "增", "plus"], ["removed", "删", "x"], ["changed", "带入有改", "rotateCcw"], ["cancelled", "取消", "circleX"], ["rewrittenDone", "已完成被改写", "circleAlert"],
] as const;

function Items({ list, kind, icon }: { list: DiffItem[]; kind: string; icon: IconName }) {
  return list.map((it) => (
    <div key={it.key}>
      <div className={`${d.ditem} ${d[`dk_${kind}`] ?? ""}`}><Icon name={icon} size={12} /><span className={v.tid}>{it.key}</span><span>{it.oneLine}</span></div>
      {it.reason !== undefined && <div className={d.dreason}>{it.reason || "—"}</div>}
    </div>
  ));
}

export function DiffPage(props: { feature: FeatureCard; compare: Compare; data: CompareData | null; onVersions: () => void; onClose: () => void; tr: Tr }) {
  const { feature: f, compare: c, data, tr } = props;
  const lists = data ? diffLists(data.diff, data.fromNodes, data.toNodes) : null;
  const title = `v${c.from} → ${c.to === "pending" ? tr("待批") : `v${c.to}`}`;
  return (
    <Shell title={title} sub={f.title || f.id} onClose={props.onClose} tr={tr} className={d.touch}>
      <button type="button" className={v.link} onClick={props.onVersions}><Icon name="history" size={13} />{tr("版本")}</button>
      {!lists && <div className={v.muted}>{tr("正在读取…")}</div>}
      {lists && KINDS.filter(([k]) => k !== "rewrittenDone" || lists.rewrittenDone.length > 0).map(([k, label, icon]) => (
        <Sec key={k} title={`${tr(label)} · ${lists[k].length}`}>
          <Items list={lists[k]} kind={k === "rewrittenDone" ? "rewritten" : k} icon={icon} />
        </Sec>
      ))}
    </Shell>
  );
}
