"use client";
import type { Tr } from "../collab-model";
import { Sec } from "../v4/v4-props";
import v from "../v4/v4.module.css";
import d from "./dag.module.css";
import { unopenedReason, type NodeCard } from "./node-card-model";
import type { BoardNode, FeatureCard } from "./dag-types";

export function NodeCardSection({ card, owner, onOwner, onNode, tr }: {
  card: NodeCard; owner: { agent: string; role: string } | null; onOwner: (agent: string) => void; onNode: (key: string) => void; tr: Tr;
}) {
  const { feature: f, node: n } = card;
  const pr = n.pr && !/^https:\/\//.test(n.pr) ? n.pr : null;
  return (
    <Sec title={tr("所在节点")}>
      <div className={d.nodeFacts}>
        <div className={v.kv}><span className={v.tid}>{n.key}</span> · {n.oneLine}</div>
        <div className={v.muted}>{f.title}</div>
        {owner && <button type="button" className={v.link} onClick={() => onOwner(owner.agent)}>{owner.agent} →</button>}
        {n.deps.length > 0 && <div><span className={v.muted}>{tr("前置")}</span>
          {n.deps.map(key => <button key={key} type="button" className={v.link} onClick={() => onNode(key)}>
            <span className={v.tid}>{key}</span> {f.nodes.find(dep => dep.key === key)?.oneLine ?? ""}
          </button>)}
        </div>}
        {n.estimate && <div className={v.kv}>{tr("粗估")} · {n.estimate}</div>}
        <div><span className={v.muted}>{tr("文件范围")}</span><NodeFiles node={n} /></div>
        {n.branch && <div className={v.kv}>{tr("分支")} · {n.branch}</div>}
        {pr && <div className={v.muted}>{pr}</div>}
      </div>
    </Sec>
  );
}

function NodeFiles({ node }: { node: BoardNode }) {
  return <div className={d.nodeFiles}>
    {node.fileGlobs?.length ? node.fileGlobs.map(file => <div key={file} className={v.kv}>{file}</div>) : <div className={v.muted}>—</div>}
  </div>;
}

/** Only the current unbound node gets new facts; missing cards and comparison ghosts keep their existing page. */
export function PlannedNodeSections({ feature, node, tr }: { feature: FeatureCard; node: BoardNode; tr: Tr }) {
  const reason = unopenedReason(feature, node);
  return <><Sec title={tr("文件范围")}><NodeFiles node={node} /></Sec>
    <Sec title={tr("为什么还没开卡")}><div className={v.kv}>{tr(reason.text, reason.deps ? { deps: reason.deps } : undefined)}</div></Sec></>;
}
