/** PROPEVID1 中心提案摘要：自动批准结果事件（本机台账）事后核对用，自动批准与交还人工共用这一份。
 * 只取中心提案已有字段，过外发闸同款脱敏；URL、本机绝对路径换成占位，不推送、不发通知。
 */
import { redactForPeer } from "./dispatch-redact.js";
import { proposedVersion } from "./shared-ledger-contract-v2-feature-proposals.js";
import type { ProposalRecord } from "./shared-ledger-feature-proposals.js";

/** 单节点最多记几条 fileGlobs；整份最多几条（超出只记省略数） */
const SUMMARY_GLOBS_PER_NODE = 10;
const SUMMARY_GLOBS_TOTAL = 60;
/** 节点最多列几个（中心上限 200；超出只记省略数） */
const SUMMARY_NODES = 60;

interface SummaryNode { key: string; fileGlobs: string[]; globsOmitted: number }
export interface ProposalSummary {
  title: string;
  kind: "new" | "revise";
  /** 修订才有：featureId 与 from→to 版本 */
  featureId?: string; fromVersion?: number; toVersion?: number;
  nodeCount: number;
  nodes: SummaryNode[];
  nodesOmitted: number;
  /** 所有节点被省略的 glob 合计（含未列出节点的） */
  globsOmitted: number;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const LOCAL_ABS = /(?:^|(?<=[\s"'`(]))(?:\/(?:Users|home|private|tmp|var|opt|etc|root|Volumes)\/|~\/|[A-Za-z]:[\\/])\S*/g;
const clean = (s: string, n: number) => {
  const t = redactForPeer(s).text.replace(URL_RE, "[URL]").replace(LOCAL_ABS, "[本机路径]");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function proposalSummary(r: ProposalRecord): ProposalSummary {
  const p = r.proposal, nodes: SummaryNode[] = [];
  let kept = 0, globsOmitted = 0;
  for (const [i, n] of p.nodes.entries()) {
    const room = i < SUMMARY_NODES ? Math.max(0, Math.min(SUMMARY_GLOBS_PER_NODE, SUMMARY_GLOBS_TOTAL - kept)) : 0;
    const fileGlobs = n.fileGlobs.slice(0, room).map(g => clean(g, 500));
    kept += fileGlobs.length;
    globsOmitted += n.fileGlobs.length - fileGlobs.length;
    if (i < SUMMARY_NODES) nodes.push({ key: clean(n.key, 200), fileGlobs, globsOmitted: n.fileGlobs.length - fileGlobs.length });
  }
  const kind = p.kind === "revise"
    ? { kind: "revise" as const, featureId: clean(p.featureId, 200), fromVersion: p.baseVersion, toVersion: proposedVersion(p) }
    : { kind: "new" as const };
  return { title: clean(p.title, 200), ...kind, nodeCount: p.nodes.length, nodes, nodesOmitted: Math.max(0, p.nodes.length - SUMMARY_NODES), globsOmitted };
}

/** 结果事件正文末尾的一段 */
export const summarySuffix = (s: ProposalSummary) => ` · ${s.title} · ${s.nodeCount} 个节点`;
