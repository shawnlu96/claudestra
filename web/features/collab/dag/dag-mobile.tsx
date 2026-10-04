"use client";
/**
 * 手机（窄屏）的子 DAG：没有画布。按 feature 分节，默认展开同样受 MAX_OPEN 限制（展开第 9 个挤掉最久没动静的那个）；
 * 节内按拓扑序列节点卡（dag-node.tsx 同一个卡），done 收成「✓N」可展开。跳转过来时滚到那张卡并闪一次。
 * 版本对比走属性页（整屏）+ 底部抽屉，这里只放版本按钮。可点的东西都不小于 44×44（dag.module.css 的 .mnode / .mfh / .mdone）。
 */
import { useEffect, useRef } from "react";
import type { Tr } from "../collab-model";
import { Icon } from "../collab-icons";
import { Counts } from "./dag-canvas";
import { nodeId, topoOrder } from "./dag-layout";
import { NodeBody, nodeClass, type NodeLook } from "./dag-node";
import type { BoardNode, FeatureCard } from "./dag-types";
import d from "./dag.module.css";

type LookM = (f: FeatureCard, n: BoardNode) => Omit<NodeLook, "node" | "kind" | "mark">;

function Card({ f, n, look, onNode, onOwner, tr }: { f: FeatureCard; n: BoardNode; look: LookM; onNode: (f: string, k: string) => void; onOwner: (a: string) => void; tr: Tr }) {
  const l = look(f, n);
  const kind = n.phase === "active" || n.missing ? "full" : "mini";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (l.flash) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [l.flash]);
  return (
    <div ref={ref} className={`${nodeClass({ ...l, node: n, kind, mark: null })} ${d.mnode} ${l.flash ? d.flash : ""}`}>
      <NodeBody {...l} node={n} kind={kind} mark={null} onPick={() => onNode(f.id, n.key)} onOwner={onOwner} tr={tr} />
    </div>
  );
}

export function MobileDag(props: {
  features: readonly FeatureCard[];
  open: readonly string[];
  doneOpen: ReadonlySet<string>;
  look: LookM;
  onFeature: (id: string) => void;
  onFold: (id: string) => void;
  onVersions: (id: string) => void;
  onNode: (featureId: string, key: string) => void;
  onOwner: (agent: string) => void;
  tr: Tr;
}) {
  const { tr } = props;
  return (
    <div className={d.mlist}>
      {props.features.map((f) => {
        const isOpen = props.open.includes(f.id);
        const ordered = topoOrder(f.nodes);
        const live = ordered.filter((n) => n.phase !== "done");
        const done = ordered.filter((n) => n.phase === "done");
        const card = (n: BoardNode) => <Card key={`${nodeId(f.id, n.key)}#${props.look(f, n).flash ?? 0}`} f={f} n={n} look={props.look} onNode={props.onNode} onOwner={props.onOwner} tr={tr} />;
        return (
          <section key={f.id} className={d.mfeat}>
            <div className={d.mfh}>
              <button type="button" className={d.mft} aria-expanded={isOpen} onClick={() => props.onFeature(f.id)}>
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} />
                <span className={d.mftT}>{f.title || f.id}</span>
                <Counts f={f} />
              </button>
              <button type="button" className={d.vbtn} onClick={() => props.onVersions(f.id)}>
                v{f.currentVersion}{f.pending && <span className={d.pend} />}
              </button>
            </div>
            {isOpen && live.map(card)}
            {isOpen && done.length > 0 && (props.doneOpen.has(f.id) ? done.map(card) : (
              <button type="button" className={`${d.doneBtn} ${d.mdone}`} onClick={() => props.onFold(f.id)}><Icon name="check" size={12} />{f.counts.done}</button>
            ))}
            {isOpen && done.length > 0 && props.doneOpen.has(f.id) && (
              <button type="button" className={`${d.doneBtn} ${d.mdone}`} onClick={() => props.onFold(f.id)}><Icon name="chevronUp" size={14} /></button>
            )}
          </section>
        );
      })}
    </div>
  );
}
