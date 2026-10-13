/** PROPINBOX1 的纯函数部分（接线 / 定时在 bridge/center-proposal-inbox.ts）：中心待批的成员提案 → owner「待你处理」的授权卡，
 * 点「批准 / 驳回」由系统用 owner:self 的 person 凭据转发给中心（仍算 owner 本人批）。
 * 卡上只放审批要看的：提案人、标题、新建 / 修订、节点、说明前 300 字（过外发闸同款脱敏 redactForPeer）、到期；中心原文 / 凭据不进卡、不进日志。
 */
import { bindHash } from "./ask-bind.js";
import { redactForPeer } from "./dispatch-redact.js";
import { MASTER_PROJECT, ownerAnswered, type Ask, type AskBind, type NewAsk } from "./ledger-asks.js";
import { SharedLedgerUnavailable } from "./shared-ledger-client-transport.js";
import { FEATURE_PROPOSAL_SCHEMA_VERSION, type ProposalDecision } from "./shared-ledger-contract-v2-feature-proposals.js";
import { FeatureProposalRejected, FeatureProposalUnsupported, type ProposalList, type ProposalRecord } from "./shared-ledger-feature-proposals.js";

/** 卡的 createdBy，也是算 bind 哈希用的「agent」（系统卡没有 fromAgent） */
export const PROPOSAL_INBOX_CREATOR = "system:center-proposal-inbox";
const PROPOSAL_INBOX_ACTION = "center_proposal_decision";
export const APPROVE_BUTTON = "cp_approve";
export const REJECT_BUTTON = "cp_reject";
const MAX_NODES_SHOWN = 10;
const DESCRIPTION_CHARS = 300;
/** 驳回必须带非空 reason（parseProposalDecision）：固定文字，不带卡上内容 */
const REJECT_REASON = "项目 owner 在「待你处理」驳回";

export interface InboxParams { localProjectId: string; proposalId: string; proposalRev: number; proposalDigest: string }
export type InboxDecision = "approve" | "reject";

/** 中心仍 pending_approval 的全收：本人提的（含本人 PM 用 owner:self 的 service 凭据提的）也要 owner 点一次批准（UXINBOX1） */
export function pendingApproval(list: ProposalList): ProposalRecord[] {
  return list.proposals.filter(p => p.operation.state === "pending_approval");
}

const OTHERS_TITLE = "成员提案待批：", OWN_TITLE = "提案待你批准：";
/** 授权卡标题 → 提案标题（两种前缀都认；结果文字 / 结果卡用） */
export const proposalTitleOf = (cardTitle: string) => cardTitle.replace(/^(?:成员提案待批|提案待你批准)：/, "");
/** 提案人行：本人提的不写 personId（service 凭据 = 经本人 PM 提的）；别人提的照旧 */
function proposerLine(r: ProposalRecord, own: boolean): string {
  const via = r.proposer.type === "service";
  if (own) return `提案人：你本人${via ? "（经你的 PM）" : ""}`;
  return `提案人：${r.proposer.personId ? `成员 ${r.proposer.personId}` : "未知成员"}${via ? "（经其 PM）" : ""}`;
}

export const paramsOf = (localProjectId: string, r: ProposalRecord): InboxParams =>
  ({ localProjectId, proposalId: r.proposalId, proposalRev: r.proposalRev, proposalDigest: r.operation.proposalDigest });
const bindOf = (p: InboxParams): Omit<AskBind, "paramsHash"> => ({ action: PROPOSAL_INBOX_ACTION, approve: [APPROVE_BUTTON], params: { ...p } });
/** 同一提案同一 rev（同摘要）只开一张：撞上已有的（开着或已答）返回那张 */
const inboxDedupKey = (p: InboxParams) => `center-proposal:${p.localProjectId}:${p.proposalId}:${p.proposalRev}:${p.proposalDigest.slice(0, 16)}`;
/** 卡上的 proposalId 键：新 rev 取代旧卡由 bridge 撤旧卡（系统卡没有 fromAgent，ledger 的 askKey 取代不生效） */
const inboxAskKey = (proposalId: string) => `center-proposal:${proposalId}`;

const clean = (s: string) => redactForPeer(s).text;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** owner 卡的内容（CreateAskInput 同形，createdBy 固定）；selfPersonId = 本机 owner 在中心的 personId，提案人是他本人时换标题和提案人行 */
export function inboxCard(localProjectId: string, r: ProposalRecord, selfPersonId = ""): NewAsk & { source: "system"; createdBy: string } {
  const p = r.proposal, params = paramsOf(localProjectId, r), bind = bindOf(params);
  const own = !!selfPersonId && r.proposer.personId === selfPersonId;
  const kind = p.kind === "revise" ? `修订（${p.featureId} v${p.baseVersion} → v${p.baseVersion + 1}）` : "新建 feature";
  const nodes = p.nodes.slice(0, MAX_NODES_SHOWN).map(n => `  - ${clip(clean(n.oneLine || n.key), 120)}`);
  if (p.nodes.length > MAX_NODES_SHOWN) nodes.push(`  - …另 ${p.nodes.length - MAX_NODES_SHOWN} 个`);
  // 先对全文脱敏再截断：先截会切掉识别敏感数据要用的后文（PEM 结束标记、跨边界的邮箱等）
  const desc = clip(clean(p.description), DESCRIPTION_CHARS);
  const context = [
    proposerLine(r, own),
    `项目：${localProjectId}`,
    `类型：${kind}`,
    `节点：${p.nodes.length} 个`,
    ...nodes,
    ...(desc ? [`说明：${desc}`] : []),
    `到期：${when(p.expiresAt)}`,
    "点「批准」由系统用你的凭据去中心批准（算你本人批）。",
  ].join("\n");
  return {
    source: "system", createdBy: PROPOSAL_INBOX_CREATOR, kind: "authorize", project: MASTER_PROJECT,
    title: clip(`${own ? OWN_TITLE : OTHERS_TITLE}${clean(p.title)}`, 200), context,
    options: [{ type: "buttons", buttons: [
      { id: APPROVE_BUTTON, label: "批准", style: "success" }, { id: REJECT_BUTTON, label: "驳回", style: "danger" }] }],
    allowText: false, blocking: true, expiresAt: p.expiresAt, askKey: inboxAskKey(r.proposalId), dedupKey: inboxDedupKey(params),
    bind: { ...bind, paramsHash: bindHash(bind, PROPOSAL_INBOX_CREATOR) },
    extra: { centerProposal: { ...params } },
  };
}

/** 执行结果卡的 createdBy：和授权卡分开，轮询收卡 / 答复钩子都不碰它 */
const PROPOSAL_RESULT_CREATOR = "system:center-proposal-inbox-result";

/** 需要 owner 再看一眼的执行结果进「待你处理」（未执行 / 中心报错 / conflict / 中心状态不是终态；办成了的不开，见 decisionSettled）：每张授权卡一张，无按钮 */
export function resultCard(askId: string, title: string, text: string): NewAsk & { source: "system"; createdBy: string } {
  return {
    source: "system", createdBy: PROPOSAL_RESULT_CREATOR, kind: "owner_action", project: MASTER_PROJECT,
    title: clip(`成员提案处理结果：${clean(title)}`, 200), context: text, options: [], allowText: false, blocking: false,
    dedupKey: `center-proposal-result:${askId}`, extra: { centerProposalResultOf: askId },
  };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** 卡上记的参数（bind.params）：形状不对 → null */
export function cardParams(a: Pick<Ask, "bind">): InboxParams | null {
  const p = a.bind?.params as Partial<InboxParams> | undefined;
  if (!p || typeof p !== "object") return null;
  const { localProjectId, proposalId, proposalRev, proposalDigest } = p;
  if (typeof localProjectId !== "string" || !ID.test(localProjectId) || typeof proposalId !== "string" || !ID.test(proposalId)
    || typeof proposalRev !== "number" || !Number.isSafeInteger(proposalRev) || proposalRev < 1
    || typeof proposalDigest !== "string" || !proposalDigest) return null;
  return { localProjectId, proposalId, proposalRev, proposalDigest };
}

/**
 * 答复能不能执行：是本模块开的卡、已答、owner 本人答（非 guest / peer / 外部）、bind 哈希对得上且参数与开卡时（extra）一致、
 * 只点了「批准」「驳回」之一。返回要执行的决定和参数，否则 null。
 */
export function verifiedAnswer(a: Ask): { decision: InboxDecision; params: InboxParams } | null {
  if (a.createdBy !== PROPOSAL_INBOX_CREATOR || a.state !== "answered" || !ownerAnswered(a.answer) || !a.bind) return null;
  if (a.bind.action !== PROPOSAL_INBOX_ACTION || bindHash(a.bind, PROPOSAL_INBOX_CREATOR) !== a.bind.paramsHash) return null;
  const params = cardParams(a);
  if (!params || bindHash(bindOf(params), PROPOSAL_INBOX_CREATOR) !== a.bind.paramsHash) return null;
  const opened = a.extra.centerProposal as Partial<InboxParams> | undefined;
  if (!opened || opened.localProjectId !== params.localProjectId || opened.proposalId !== params.proposalId
    || opened.proposalRev !== params.proposalRev || opened.proposalDigest !== params.proposalDigest) return null;
  const choices = a.answer?.choices ?? [];
  const yes = choices.includes(`[button:${APPROVE_BUTTON}]`), no = choices.includes(`[button:${REJECT_BUTTON}]`);
  if (yes === no) return null;
  return { decision: yes ? "approve" : "reject", params };
}

export function decisionBody(p: InboxParams, decision: InboxDecision): ProposalDecision {
  return { schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, proposalId: p.proposalId, decision, proposalDigest: p.proposalDigest,
    proposalRev: p.proposalRev, reason: decision === "reject" ? REJECT_REASON : "" };
}

/** 中心回 409 conflict：rev / 摘要变了 */
export const isDecisionConflict = (e: unknown) => e instanceof FeatureProposalRejected && e.status === 409 && e.error?.code === "conflict";
/** 只给固定错误码（日志 / 结果里用）：中心原文、传输错误文字可能带凭据或 URL */
export function inboxErrorCode(e: unknown): string {
  if (e instanceof FeatureProposalUnsupported) return "unsupported";
  if (e instanceof FeatureProposalRejected) return e.error?.code ?? (e.status === 403 ? "forbidden_or_no_credential" : `http_${e.status}`);
  if (e instanceof SharedLedgerUnavailable) return "center_unavailable";
  return "request_failed";
}

/** done 且中心已是这几种终态之一：批准 / 驳回照 owner 的意思办成了，不用再开结果卡（PROPRES1）；其余结果都要 owner 再看一眼 */
const SETTLED_STATES: ReadonlySet<string> = new Set(["published", "approved", "rejected"]);
export const decisionSettled = (r: ProposalRecord) => SETTLED_STATES.has(r.operation.state);

/** 执行后回给 owner 的一条（固定文字 + 提案标识 + 结果） */
export function decisionResultText(title: string, p: InboxParams, out:
  | { kind: "done"; record: ProposalRecord; decision: InboxDecision }
  /** fresh：重拉到的仍待批记录；card：按 fresh 那一 rev 的卡的真实状态（undefined = 没开出卡） */
  | { kind: "conflict"; fresh: ProposalRecord | null; card?: Ask["state"]; refetchError?: string }
  | { kind: "error"; code: string }
  | { kind: "invalid" }): string {
  const head = `成员提案「${clean(title)}」（${p.proposalId} rev ${p.proposalRev}）`;
  if (out.kind === "invalid") return `${head}：未执行（不是 owner 本人答复或卡片参数不符）。`;
  if (out.kind === "error") return `${head}：中心未接受，错误码 ${out.code}；未重试，可在团队页重新处理。`;
  if (out.kind === "conflict") {
    if (out.refetchError) return `${head}：提案已更新（中心回 conflict），重新拉取失败（${out.refetchError}），下一轮会再试。`;
    if (!out.fresh) return `${head}：提案已更新（中心回 conflict），中心已不再待批，未开新卡。`;
    const rev = `新版本 rev ${out.fresh.proposalRev}`;
    if (out.card === "open") return `${head}：提案已更新（中心回 conflict），已按${rev} 开了新卡，请重新批。`;
    if (out.card) return `${head}：提案已更新（中心回 conflict），中心仍待批${rev}，但该版本的卡已收口（${out.card}），未开新卡、未重试；可在团队页处理。`;
    return `${head}：提案已更新（中心回 conflict），中心仍待批${rev}，但未能开出新卡（已到期或开卡失败），未重试；可在团队页处理。`;
  }
  const op = out.record.operation;
  if (op.state === "published") return `${head}：已批准并发布，featureId ${op.featureId} v${op.version}。`;
  if (op.state === "approved") return `${head}：已批准，等中心发布。`;
  if (op.state === "rejected") return `${head}：已驳回。`;
  return `${head}：已提交${out.decision === "approve" ? "批准" : "驳回"}，中心当前状态 ${op.state}。`;
}
