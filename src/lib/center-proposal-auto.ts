/** 中心提案自动批：路径保护与文本词表只补判 owner；修订按新的全量节点判。 */
import { redactForPeer } from "./dispatch-redact.js";
import { globDetails, repoFiles } from "./center-proposal-auto-surface.js";
import type { ProposalRecord } from "./shared-ledger-feature-proposals.js";
import { globProtectionMode, observeGlobProtection, type GlobProtectionContext } from "./proposal-glob-protection.js";
export { globHits, PATTERN_PROBES } from "./center-proposal-auto-surface.js";

export type AutoReason =
  | "nodes_empty" | "glob_empty" | "glob_invalid" | "glob_outside_roots" | "glob_wide"
  | "glob_unresolved" | "glob_security_surface" | "glob_permission_gate" | "glob_data_schema" | "text_sensitive_word"
  /** 执行阶段改出 owner 卡的两种（不是分类结论）：3 次结果都不明 / 中心明确拒绝 */
  | "auto_unconfirmed" | "auto_center_refused";
export interface AutoHit { reason: AutoReason; source: string; path: string }
export interface AutoHitEvidence { hits: AutoHit[]; hitsOmitted: number }
export interface AutoVerdict { route: "auto" | "owner"; reasons: AutoReason[]; hits: AutoHit[] }

const REASON_TEXT: Record<AutoReason, string> = {
  nodes_empty: "提案没有节点",
  glob_empty: "有节点没写文件范围",
  glob_invalid: "文件范围格式不对",
  glob_outside_roots: "文件范围不在 src/ tests/ docs/ web/ scripts/ 下",
  glob_wide: "文件范围太宽，覆盖到受保护的文件",
  glob_unresolved: "文件范围的通配符看不清是否盖到受保护的文件",
  glob_security_surface: "改动安全敏感目录或文件",
  glob_permission_gate: "改动权限闸文件",
  glob_data_schema: "涉及删数据、迁移或 schema",
  text_sensitive_word: "标题 / 说明里提到安全、权限或数据相关的词",
  auto_unconfirmed: "自动批准没有确认结果",
  auto_center_refused: "中心拒绝了自动批准",
};
/** 卡上那一行的中文（code = 中心拒绝时的固定错误码） */
export function reasonText(reasons: readonly AutoReason[], code?: string, hits: readonly AutoHit[] = []): string {
  const summary = reasons.map(r => r === "auto_center_refused" && code ? `${REASON_TEXT[r]}（错误码 ${code}）` : REASON_TEXT[r]).join("；");
  if (!hits.length) return summary;
  const evidence = hitEvidence(hits);
  const labels: Partial<Record<AutoReason, string>> = {
    glob_permission_gate: "鉴权 / 权限闸", glob_security_surface: "安全保护", glob_data_schema: "数据迁移 / schema",
  };
  const lines = evidence.hits.map(h => h.path ? `改到 ${h.path}（${labels[h.reason] ?? REASON_TEXT[h.reason]}）（范围：${h.source}）`
    : `${REASON_TEXT[h.reason]}（${h.source || "空范围"}）`);
  return [summary, ...lines, ...(evidence.hitsOmitted ? [`另 ${evidence.hitsOmitted} 条`] : [])].join("\n");
}

/** 外显明细统一脱敏并限十条，卡片与占位事件使用同一证据。 */
export function hitEvidence(hits: readonly AutoHit[]): AutoHitEvidence {
  const clean = (s: string) => redactForPeer(s).text.slice(0, 500);
  return { hits: hits.slice(0, 10).map(h => ({ reason: h.reason, source: clean(h.source), path: clean(h.path) })), hitsOmitted: Math.max(0, hits.length - 10) };
}

/** 固定词表（大小写不敏感）：只补判 owner */
const SENSITIVE_WORDS = [
  "安全", "权限", "鉴权", "授权", "凭据", "密钥", "令牌", "加密", "签名", "删除数据", "删库", "清库", "迁移", "schema", "表结构",
  "auth", "credential", "secret", "token", "password", "permission", "encrypt", "signature", "migration", "drop table",
];
const ORDER: readonly AutoReason[] = [
  "nodes_empty", "glob_empty", "glob_invalid", "glob_outside_roots", "glob_wide", "glob_unresolved",
  "glob_security_surface", "glob_permission_gate", "glob_data_schema", "text_sensitive_word",
];

/** 同一提案及文件快照得到同一结论；reasons 按固定顺序去重，hits 保留每条命中来源。 */
export function classifyProposal(r: ProposalRecord, files: readonly string[] | null = repoFiles(), ctx?: GlobProtectionContext): AutoVerdict {
  const p = r.proposal, hits: AutoHit[] = [], baseline: AutoHit[] = [], proposed: AutoHit[] = [], mode = globProtectionMode(ctx);
  const add = (reason: AutoReason, source = "", path = "") => hits.push({ reason, source, path });
  const textHits = (s: string | null | undefined) => {
    for (const word of SENSITIVE_WORDS) if (s?.toLowerCase().includes(word)) add("text_sensitive_word", word);
  };
  if (!p.nodes.length) add("nodes_empty");
  for (const n of p.nodes) {
    if (!n.fileGlobs.length) add("glob_empty", n.key);
    for (const g of n.fileGlobs) {
      const old = globDetails(g, files), next = mode === "off" ? old : globDetails(g, files, "on");
      baseline.push(...old); proposed.push(...next); hits.push(...(mode === "on" ? next : old));
    }
    textHits(n.oneLine);
  }
  for (const s of [p.title, p.description, p.ownerWords]) textHits(s);
  if (mode === "observe" && ctx) observeGlobProtection(ctx, r, baseline, proposed, hitEvidence);
  const reasons = ORDER.filter(x => hits.some(h => h.reason === x));
  return { route: reasons.length ? "owner" : "auto", reasons, hits };
}
