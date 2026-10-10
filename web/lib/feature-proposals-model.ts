import type { ProposalInput, ProposalNode, Reply } from "./feature-proposals-api";

/** 提案人看到的状态。「已发布」只来自中心 state=published；202 或带 cachedState 的答复一律是「待同步」，不能当成功 */
export type ProposerKind = "pending_approval" | "approved" | "pending_sync" | "published" | "rejected" | "expired" | "conflict"
  | "forbidden" | "unsupported" | "invalid" | "unbound" | "unknown";
export interface ProposerStatus { kind: ProposerKind; cachedState?: "pending_approval" | "approved"; featureId?: string; version?: number | null }
export interface ProposalEntry { operationId: string | null; title: string; status: ProposerStatus; expiresAt: number | null }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const id = (v: unknown) => typeof v === "string" && ID.test(v) ? v : null;
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max ? v : null;
const int = (v: unknown) => Number.isSafeInteger(v) ? v as number : null;
const obj = (v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const cachedOf = (v: unknown) => v === "pending_approval" || v === "approved" ? { cachedState: v } as const : {};

/** 固定文案键：页面只显示这些，不显示中心 / bridge 的原文 */
export const PROPOSER_TEXT: Record<ProposerKind, string> = {
  pending_approval: "已提交，待项目 owner 批准", approved: "已批准，待中心发布", pending_sync: "待同步，结果未确认",
  published: "已发布", rejected: "已驳回", expired: "已过期", conflict: "冲突：内容与中心不一致，请改后重新提交",
  forbidden: "本机设备无权操作团队提案（403）", unsupported: "中心不支持提案协议（502）", invalid: "提案内容不符合要求",
  unbound: "本机未绑定该团队项目", unknown: "结果未确认",
};

/** POST 提案 / GET operations/{op} 的答复 → 状态（规则同 bridge 的 proposalOutcome） */
export function replyStatus(r: Reply): ProposerStatus {
  const b = r.body;
  if (r.status === 202 || b.cachedState !== undefined) return { kind: "pending_sync", ...cachedOf(b.cachedState) };
  if (r.status === 200 && b.ok === true) {
    if (b.state === "published") {
      const featureId = id(b.centerFeatureId);
      return featureId ? { kind: "published", featureId, version: int(b.version) } : { kind: "unknown" };
    }
    return b.state === "pending_approval" || b.state === "approved" ? { kind: b.state } : { kind: "unknown" };
  }
  const end = r.status === 409 ? /^proposal_(rejected|expired|conflict)$/.exec(String(b.code)) : null;
  if (end) return { kind: end[1] as ProposerKind };
  if (r.status === 409 || r.status === 404) return { kind: "unbound" };
  return { kind: r.status === 403 ? "forbidden" : r.status === 502 ? "unsupported" : r.status === 400 ? "invalid" : "unknown" };
}

function operation(v: unknown) {
  const o = obj(v), operationId = id(o?.operationId), title = str(o?.title, 300);
  return o && operationId && title !== null ? { o, operationId, title, expiresAt: int(o.expiresAt) } : null;
}
export function replyEntry(r: Reply, title: string): ProposalEntry {
  const op = operation(r.body.operation);
  return { operationId: op?.operationId ?? null, title: op?.title ?? title, status: replyStatus(r), expiresAt: op?.expiresAt ?? null };
}

/** 本机记录（GET 列表的 view）→ 状态：只有 published 带中心 featureId；有 issue 或还没同步上的都是待同步 */
export function recordStatus(o: Record<string, unknown>): ProposerStatus {
  const state = o.state, issue = o.issue;
  if (state === "published") {
    const featureId = id(o.featureId);
    return featureId ? { kind: "published", featureId, version: int(o.version) } : { kind: "pending_sync" };
  }
  if (state === "rejected" || state === "expired" || state === "conflict") return { kind: state };
  const unsynced = state !== "pending_approval" && state !== "approved";
  if (unsynced && (issue === "forbidden" || issue === "no_credential")) return { kind: "forbidden" };
  if (unsynced && issue === "unsupported") return { kind: "unsupported" };
  if (unsynced || issue !== null) return { kind: "pending_sync", ...cachedOf(state) };
  return { kind: state };
}
/** 只留当前团队项目的记录，新的在前 */
export function parseOperations(r: Reply, project: string): ProposalEntry[] | null {
  if (r.status !== 200 || !Array.isArray(r.body.operations)) return null;
  const at = (op: NonNullable<ReturnType<typeof operation>>) => int(op.o.createdAt) ?? 0;
  return r.body.operations.map(operation).filter((op): op is NonNullable<typeof op> => op !== null && op.o.projectId === project)
    .sort((a, b) => at(b) - at(a))
    .map(op => ({ operationId: op.operationId, title: op.title, status: recordStatus(op.o), expiresAt: op.expiresAt }));
}

export interface ReviewCard {
  proposalId: string; proposalRev: number; proposalDigest: string; state: "pending_approval" | "conflict" | "expired";
  drift: boolean; title: string; description: string; nodes: { key: string; oneLine: string }[]; version: number | null;
  expiresAt: number; proposer: { type: "person" | "service"; code: string | null };
}
const REVIEW_STATES = new Set(["pending_approval", "conflict", "expired"]);
function card(v: unknown): ReviewCard | null {
  const p = obj(v), who = obj(p?.proposer);
  if (!p || !who || (who.type !== "person" && who.type !== "service") || !REVIEW_STATES.has(String(p.state))) return null;
  const proposalId = id(p.proposalId), proposalRev = int(p.proposalRev), digest = str(p.proposalDigest, 256), expiresAt = int(p.expiresAt);
  const title = str(p.title, 300), description = str(p.description, 16_000);
  if (!proposalId || !proposalRev || !digest || expiresAt === null || title === null || description === null || !Array.isArray(p.nodes)) return null;
  const nodes = p.nodes.map(obj).map(n => n && id(n.key) && str(n.oneLine, 2_000) !== null ? { key: n.key as string, oneLine: n.oneLine as string } : null);
  if (nodes.some(n => n === null)) return null;
  // 只取审批要用的字段；即使答复里多带了 personId / instanceId 也不进 React
  return { proposalId, proposalRev, proposalDigest: digest, state: p.state as ReviewCard["state"], drift: p.drift === true || p.state === "conflict",
    title, description, nodes: nodes as ReviewCard["nodes"], version: int(p.version), expiresAt,
    proposer: { type: who.type, code: str(who.code, 64) || null } };
}
export function parseReview(r: Reply): ReviewCard[] | null {
  return r.status === 200 && Array.isArray(r.body.proposals) ? r.body.proposals.map(card).filter((c): c is ReviewCard => c !== null) : null;
}
/** 过期只在轮询 / 回调里按传进来的 now 算，render 不读时钟 */
export const cardExpired = (c: ReviewCard, now: number) => c.state === "expired" || c.expiresAt <= now;
export function canDecide(c: ReviewCard, role: string | null, now: number, unconfirmed: readonly string[]): boolean {
  return role === "owner" && c.state === "pending_approval" && !c.drift && !cardExpired(c, now) && !unconfirmed.includes(c.proposalId);
}

export const splitList = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
/** 表单 → 提交体：只有 title / description / ownerWords / nodes 四个键；节点代号唯一、描述与文件范围非空、依赖必须存在 */
export function proposalInput(title: string, description: string, ownerWords: string, nodes: ProposalNode[]): ProposalInput | null {
  const keys = nodes.map(n => n.key.trim());
  const clean = nodes.map((n, i) => ({ key: keys[i]!, oneLine: n.oneLine.trim(), deps: n.deps.map(d => d.trim()).filter(Boolean),
    fileGlobs: n.fileGlobs.map(g => g.trim()).filter(Boolean), estimate: n.estimate.trim() }));
  const ok = title.trim() && clean.length && new Set(keys).size === keys.length
    && clean.every(n => ID.test(n.key) && n.oneLine && n.fileGlobs.length && n.deps.every(d => d !== n.key && keys.includes(d)));
  if (!ok) return null;
  return { title: title.trim(), description, ...(ownerWords.trim() ? { ownerWords: ownerWords.trim() } : {}), nodes: clean };
}
