/** PROPEVID1 中心提案摘要：自动批准结果事件（本机台账）事后核对用，自动批准与交还人工共用这一份。
 * 只取中心提案已有字段，过外发闸同款脱敏；URL、本机绝对路径换成占位，不推送、不发通知。
 */
import { redactForPeer } from "./dispatch-redact.js";
import { proposedVersion } from "./shared-ledger-contract-v2-feature-proposals.js";
import type { ProposalRecord } from "./shared-ledger-feature-proposals.js";

/** 单节点最多记几条 fileGlobs；整份最多几条（超出只记省略数） */
const SUMMARY_GLOBS_PER_NODE = 10;
const SUMMARY_GLOBS_TOTAL = 60;

interface SummaryNode { key: string; fileGlobs: string[]; globsOmitted: number }
export interface ProposalSummary {
  title: string;
  kind: "new" | "revise";
  /** 修订才有：featureId 与 from→to 版本 */
  featureId?: string; fromVersion?: number; toVersion?: number;
  nodeCount: number;
  /** 每个节点都列 key（中心上限 200 个）；glob 超额的节点 fileGlobs 为空、记省略数 */
  nodes: SummaryNode[];
  /** 所有节点被省略的 glob 合计 */
  globsOmitted: number;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** 本机绝对路径（前面不是 ASCII 路径字符）；宁可多遮：
 * 开头、空白、中英文标点 / 符号后的 /任意非空段（含中文段、根下单文件）；
 * 字母（如汉字）后紧跟的 /，多段、ASCII 开头或带点的段才算（「新建/修订」「和/或」不遮）；
 * 再加 ~/ 与 ~user/、盘符、UNC */
const LOCAL_ABS = new RegExp(String.raw`(?<![A-Za-z0-9._~\-/\\*?\]})!])(?:` + [
  String.raw`(?<=^|[\s\p{P}\p{S}])\/[^\s/]`,
  String.raw`(?<=[\p{L}\p{N}\p{M}])\/(?:[^\s/]*\/|[A-Za-z0-9._@+-]|[^\s/]*\.)`,
  String.raw`~[A-Za-z0-9._-]*\/`, String.raw`[A-Za-z]:[\\/]`, String.raw`\\\\[^\s\\]+\\`,
].join("|") + String.raw`)\S*`, "gu");
const clean = (s: string, n: number) => {
  const t = redactForPeer(s).text.replace(URL_RE, "[URL]").replace(LOCAL_ABS, "[本机路径]");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function proposalSummary(r: ProposalRecord): ProposalSummary {
  const p = r.proposal, nodes: SummaryNode[] = [];
  let kept = 0, globsOmitted = 0;
  for (const n of p.nodes) {
    const room = Math.max(0, Math.min(SUMMARY_GLOBS_PER_NODE, SUMMARY_GLOBS_TOTAL - kept));
    const fileGlobs = n.fileGlobs.slice(0, room).map(g => clean(g, 500));
    kept += fileGlobs.length;
    globsOmitted += n.fileGlobs.length - fileGlobs.length;
    nodes.push({ key: clean(n.key, 200), fileGlobs, globsOmitted: n.fileGlobs.length - fileGlobs.length });
  }
  const kind = p.kind === "revise"
    ? { kind: "revise" as const, featureId: clean(p.featureId, 200), fromVersion: p.baseVersion, toVersion: proposedVersion(p) }
    : { kind: "new" as const };
  return { title: clean(p.title, 200), ...kind, nodeCount: p.nodes.length, nodes, globsOmitted };
}

/** 结果事件正文末尾的一段 */
export const summarySuffix = (s: ProposalSummary) => ` · ${s.title} · ${s.nodeCount} 个节点`;
