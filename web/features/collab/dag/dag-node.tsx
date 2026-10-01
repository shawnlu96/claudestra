"use client";
/**
 * 子 DAG 的节点卡（桌面画布与手机列表共用）：key + 一句话、节点内进度条（dag-steps.ts）、负责人和角色（点了跳进度图那一行）、
 * 此刻动作、在此阶段多久（有 since 才显示）。差异标记只改描边 / 角标：增 = plus 角标、带入有改 = 琥珀点、取消 = 红删除线、
 * rewrittenDone = error 描边；幽灵节点虚线。卡标题不在卡上，放属性区。
 */
import { fmtDuration, type Tr } from "../collab-model";
import { Icon } from "../collab-icons";
import type { DNodeKind } from "./dag-layout";
import type { DiffMark } from "./dag-diff";
import { nodeSteps } from "./dag-steps";
import type { BoardNode } from "./dag-types";
import d from "./dag.module.css";

export interface NodeLook {
  node: BoardNode;
  kind: DNodeKind;
  mark: DiffMark | null;
  owner: { agent: string; role: string } | null;
  act: string;
  now: number;
  hot: boolean;
  selected: boolean;
  flash: number | null;
}

const ROLE: Record<string, string> = { executor: "执行者", reviewer: "审查员", pm: "PM", dispatcher: "调度", owner: "你" };

/** 「审 · 第 2 轮」：审查一律带轮次，其余第 2 轮起才带 */
export function stepWord(slot: { key: string; label: string }, round: number, tr: Tr): string {
  return round > 1 || slot.key === "review" ? `${tr(slot.label)} · ${tr("第 {r} 轮", { r: Math.max(1, round) })}` : tr(slot.label);
}

/** 节点此刻在哪一步；没有当前步骤 = "" */
export function stepText(node: Pick<BoardNode, "stepLine">, tr: Tr): string {
  const c = nodeSteps(node.stepLine).current;
  return c ? stepWord(c, c.round, tr) : "";
}

export function StepBar({ node }: { node: Pick<BoardNode, "stepLine"> }) {
  return (
    <span className={d.steps} aria-hidden>
      {nodeSteps(node.stepLine).slots.map((s) => <span key={s.key} className={`${d.seg} ${s.state === "done" ? d.segDone : s.state === "cur" ? d.segCur : ""}`} />)}
    </span>
  );
}

export function nodeClass(l: Pick<NodeLook, "node" | "kind" | "mark" | "hot" | "selected">): string {
  const m = l.mark;
  return [d.node, d[l.kind], l.node.phase === "done" && d.isDone, l.node.missing && d.missing, m?.added && d.added, m?.cancelled !== undefined && d.cancelled,
    m?.rewrittenDone && d.rewritten, l.selected && d.sel, l.hot && d.hot].filter(Boolean).join(" ");
}

/** 卡的里子：外框（定位 / 列表）由调用方给 className 和 style */
export function NodeBody(props: NodeLook & { onPick: () => void; onOwner: (agent: string) => void; tr: Tr }) {
  const { node: n, kind, mark, owner, tr } = props;
  const full = kind === "full";
  const step = full ? stepText(n, tr) : "";
  return (
    <>
      <button type="button" className={d.nmain} onClick={props.onPick} title={n.oneLine}>
        <span className={d.nh}>
          <span className={d.key}>{n.key}</span>
          <span className={d.one}>{n.oneLine}</span>
        </span>
        {full && <StepBar node={n} />}
      </button>
      {full && (
        <span className={d.nf}>
          {owner ? (
            <button type="button" className={d.owner} onClick={() => props.onOwner(owner.agent)}>{owner.agent} · {tr(ROLE[owner.role] ?? owner.role)}</button>
          ) : <span>{tr("未派")}</span>}
          <span className={d.act}>{props.act || step}</span>
          {n.since !== null && n.phase === "active" && <span className={d.dwell}>{fmtDuration(Math.max(0, props.now - n.since), tr)}</span>}
        </span>
      )}
      {mark?.added && <span className={d.badge}><Icon name="plus" size={11} /></span>}
      {mark?.changed && <span className={d.dotChanged} />}
    </>
  );
}
