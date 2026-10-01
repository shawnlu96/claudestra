"use client";
/**
 * 进度图（中区「进度」标签；手机同一个组件）：每个 agent 一行，PM 在前（行怎么合见 dag-progress.ts）。
 * 行首状态点 + 名字 + 此刻动作；右边每项活一枚卡片（feature 标题 · 节点 key · 步骤和轮次 · 已用时长），点了跳到子 DAG 那个节点；
 * 不在任何 feature 图里的活是灰卡（卡号 · 阶段），点开任务详情。不画时间轴、不画往来线（那是「团队」标签的事）。
 * 跳转过来时滚到那一行并闪一次。
 */
import { useEffect, useRef } from "react";
import { fmtDuration, type Tr } from "../collab-model";
import type { ProgressRow } from "./dag-progress";
import { STAGE_NAME } from "../collab-detail-model";
import type { Stage } from "../collab-model";
import { stepWord } from "./dag-node";
import { slotOfStep } from "./dag-steps";
import type { FeatureCard, WorkItem } from "./dag-types";
import d from "./dag.module.css";

const stepLabel = (w: Pick<WorkItem, "step" | "round">, tr: Tr): string => {
  const slot = slotOfStep(w.step);
  return slot ? stepWord(slot, w.round ?? 0, tr) : w.step ?? "";
};

function Row(props: {
  r: ProgressRow; features: ReadonlyMap<string, FeatureCard>; act: string; now: number; flash: number | null;
  onWork: (w: WorkItem) => void; onTask: (taskId: string) => void; tr: Tr;
}) {
  const { r, now, tr } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.flash) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [props.flash]);
  return (
    <div ref={ref} className={`${d.prow} ${props.flash ? d.prowFlash : ""}`}>
      <div className={d.phead}>
        <span className={d.pname}>
          <span className={`${d.sdot} ${d[`s_${r.state}`] ?? ""}`} />
          {r.pm && <span className={d.pm}>PM</span>}
          <span>{r.agent}</span>
        </span>
        <span className={d.pact}>{props.act || (r.work.length || r.offGraph.length || r.state !== "idle" ? "" : tr("空闲"))}</span>
      </div>
      <div className={d.cards}>
        {r.work.map((w) => (
          <button key={`${w.featureId}/${w.nodeKey}/${w.role}`} type="button" className={d.wcard} onClick={() => props.onWork(w)}>
            <span className={d.wt}>{props.features.get(w.featureId)?.title ?? w.featureId}</span>
            <span className={d.wm}>
              <span>{w.nodeKey}</span>
              <span>{stepLabel(w, tr)}</span>
              <span>{fmtDuration(Math.max(0, now - w.since), tr)}</span>
            </span>
          </button>
        ))}
        {r.offGraph.map((o) => (
          <button key={`${o.taskId}/${o.role}`} type="button" className={`${d.wcard} ${d.ocard}`} onClick={() => props.onTask(o.taskId)}>
            <span className={d.wt}>{o.taskId}</span>
            <span className={d.wm}><span>{tr(STAGE_NAME[o.stage as Stage] ?? o.stage)}</span><span>{fmtDuration(Math.max(0, now - o.since), tr)}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProgressView(props: {
  rows: readonly ProgressRow[];
  features: readonly FeatureCard[];
  actOf: (agent: string) => string;
  now: number;
  /** 正在闪的那一行：{ agent, seq }，seq 每次跳转 +1 */
  flash: { id: string; seq: number } | null;
  onWork: (w: WorkItem) => void;
  onTask: (taskId: string) => void;
  tr: Tr;
}) {
  const features = new Map(props.features.map((f) => [f.id, f]));
  return (
    <div className={d.prog}>
      {props.rows.map((r) => {
        const flash = props.flash?.id === `row:${r.agent}` ? props.flash.seq : null;
        return <Row key={`${r.agent}#${flash ?? 0}`} r={r} features={features} act={props.actOf(r.agent)} now={props.now} flash={flash}
          onWork={props.onWork} onTask={props.onTask} tr={props.tr} />;
      })}
    </div>
  );
}
