/** PROPINBOX1 接线（纯函数在 lib/center-proposal-inbox.ts）：每 5 分钟对绑定了团队项目的本机项目拉中心提案（owner:self person 凭据），
 * pending_approval 的（别人提的、本人提的都算，UXINBOX1）→ owner「待你处理」授权卡；提案已不待批 / 换了新 rev → 撤旧卡。
 * 开卡前核审批权（PROPRESULT1）：本人在该中心项目不是 owner → 不开卡、撤已开的；成员表读失败 → 这一轮不开不撤。
 * 答复钩子（ask-entry.ts commitNoticing）：本卡 + bind 校验 + owner 本人答 → forwardDecision 一次，不自动重试；
 * conflict 重拉一次，仍待批就按新 rev 开新卡。凭据缺失 / 中心不可达只记一行日志（只有错误码），下轮再试。
 * 照 shared-ledger-join-offer.ts 的写法：source=system 的 authorize 卡、bind + paramsHash、ownerAnswered。
 * PROPAUTO1（开关 centerProposalAutoApprove）：核过审批权、建卡之前先分类（lib/center-proposal-auto.ts）；on 档非安全类抢执行占位后
 * 由系统直接 decide（同一凭据 / 请求体 / rev / 摘要），不建卡、不推送，只写台账事件；安全类照旧出卡并写原因。observe 只记样本，off 逐字旧路径。
 */
import type { Database } from "bun:sqlite";
import { instanceIdSync } from "../lib/instance-id.js";
import { instanceKeySync } from "../lib/instance-key.js";
import { closeAsk, getAsk, listAsks, MASTER_PROJECT, patchAsk, type Ask } from "../lib/ledger-asks.js";
import { isPersonalProject } from "../lib/lend-policy.js";
import { STATE_DIR } from "../lib/paths.js";
import { SharedLedgerClient } from "../lib/shared-ledger-client.js";
import { SharedLedgerRemoteError, SharedLedgerUnavailable } from "../lib/shared-ledger-client-transport.js";
import { parseV2ProjectsRequest, parseV2ProjectsResponse } from "../lib/shared-ledger-contract-v2-projects.js";
import { readSharedLedgerBindings } from "../lib/shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential } from "../lib/shared-ledger-mode.js";
import { readSharedLedgerProjects } from "../lib/shared-ledger-project-link.js";
import { sharedLedgerBindingLocalId } from "../lib/shared-ledger-project-link-target.js";
import {
  forwardDecision, listCenterProposals, PROPOSAL_DEFAULT_TTL_MS, type ProposalRuntime,
} from "../lib/shared-ledger-feature-proposals-store.js";
import type { FeatureProposalScope, ProposalList, ProposalRecord } from "../lib/shared-ledger-feature-proposals.js";
import type { ProposalDecision } from "../lib/shared-ledger-contract-v2-feature-proposals.js";
import { FeatureProposalRejected, FeatureProposalUnsupported } from "../lib/shared-ledger-feature-proposals.js";
import type { RecoveryMode } from "../lib/recovery-policy.js";
import { classifyProposal, reasonText, type AutoReason, type AutoHit } from "../lib/center-proposal-auto.js";
import {
  autoApproveMode, claimExec, execKey, execState, MAX_AUTO_ATTEMPTS, observeAutoApprove, recordExecResult, RETRY_AFTER_MS, type ExecIdentity,
} from "../lib/center-proposal-auto-exec.js";
import {
  canApprove, cardParams, cardHitEvidence, decisionBody, decisionResultText, decisionSettled, handoffText, inboxCard, inboxDedupKey, inboxErrorCode, isDecisionConflict,
  NOT_APPROVER_REASON, paramsOf, pendingApproval, PROPOSAL_INBOX_CREATOR, PROPOSAL_RESULT_CREATOR, proposalTitleOf, resultAnswer, resultCard,
  verifiedAnswer, type InboxMember, type InboxParams, type ResultMeta,
} from "../lib/center-proposal-inbox.js";
import { askDb, askReadDb, asksDeps, createAsk, publishAsk, sendCalm, type CreateAskInput } from "./asks.js";
import { newMessageId, newThreadId } from "./router.js";

const PROPOSAL_INBOX_INTERVAL_MS = 5 * 60_000;

interface InboxProject { localProjectId: string; scope: FeatureProposalScope }
/** meta：结果卡上记的提案号 / rev / 固定错误码（「交给大总管」用） */
export interface InformCard { askId: string; title: string; resultCard: boolean; meta?: ResultMeta }
export interface ProposalInboxDeps {
  now: () => number;
  /** 绑定了团队项目的本机项目（个人项目除外）；读不到抛错 */
  projects: () => InboxProject[];
  list: (scope: FeatureProposalScope) => Promise<ProposalList & { selfPersonId: string }>;
  /** 这个中心项目的成员表（GET /v1/projects/:id/members）；读不到 / 形状不对抛错 */
  members: (scope: FeatureProposalScope) => Promise<readonly InboxMember[]>;
  decide: (scope: FeatureProposalScope, proposalId: string, decision: ProposalDecision) => Promise<ProposalRecord>;
  openAsk: (input: CreateAskInput) => Ask;
  /** 本模块开的、还开着的卡 */
  openCards: () => Ask[];
  closeAsk: (id: string, reason: string) => void;
  /** 执行结果回给 owner：写回原卡（网页可见）+ 投控制频道；resultCard 为真才另开结果卡进「待你处理」（办成了的不开） */
  inform: (text: string, card: InformCard) => Promise<void>;
  /** 结果卡「交给大总管」：固定格式的一段经系统通知通道发给 master */
  handoff: (text: string, askId: string) => Promise<void>;
  log: (line: string) => void;
  /** PROPAUTO1 自动批准；不给 = 逐字旧路径（同 off） */
  auto?: AutoApproveDeps;
}
interface AutoApproveDeps {
  /** centerProposalAutoApprove 的档位（按本机项目） */
  mode: (localProjectId: string) => RecoveryMode;
  /** 执行占位 / 结果事件 / observe 样本写的台账 */
  db: () => Database;
  /** 这一版本有没有人工卡（任何状态：open / answered / 已撤都算） */
  hasCard: (dedupKey: string) => boolean;
  /** 分类时核的仓库现有文件；不给 = 本仓 git ls-files（读不到 → 带通配的 glob 判 owner） */
  files?: () => readonly string[] | null;
}

const paramsKey = (p: InboxParams) => `${p.localProjectId}\0${p.proposalId}\0${p.proposalRev}\0${p.proposalDigest}`;
const projectOf = (a: Ask) => cardParams(a)?.localProjectId;

/** 同一项目的拉取 + 开 / 撤卡串行做：定时轮询和 conflict 重拉交错时，迟到的旧快照不能撤掉刚按新 rev 开的卡 */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined); // 错误已经通过返回的 run 交给调用方处理，这里只是让链尾不卡住后面排队的任务
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

/** 一轮拉到的待批提案 + 本机 owner 在中心的 personId（卡上区分「本人提的」）；all = 这一轮拉到的全部（补记自动批准结果用） */
interface Pending { records: ProposalRecord[]; self: string; all: ProposalRecord[] }
const pendingOf = (list: ProposalList & { selfPersonId: string }): Pending => ({ records: pendingApproval(list), self: list.selfPersonId, all: list.proposals });

/** 自动批准对一条待批提案的安排（按 paramsKey）：skip = 不建卡（已自动批 / 在等结果）；reason = 照旧建卡，卡上写原因；都没有 = 原样建卡 */
interface Plan { skip?: true; reason?: string; hits?: AutoHit[] }

/** 一个项目的一轮：开缺的卡，撤不再待批 / 已被新 rev 取代的卡 */
function reconcile(project: InboxProject, { records: snapshot, self }: Pending, d: ProposalInboxDeps, plan: ReadonlyMap<string, Plan> = new Map()): Ask[] {
  const cards = d.openCards().filter(c => projectOf(c) === project.localProjectId);
  // 单调保护：快照里的 rev 比已开卡的旧 = 迟到的快照，这条提案这一轮不动（不撤新卡、不开旧卡）
  const cardRev = new Map<string, number>();
  for (const c of cards) { const p = cardParams(c); if (p) cardRev.set(p.proposalId, Math.max(cardRev.get(p.proposalId) ?? 0, p.proposalRev)); }
  const stale = new Set(snapshot.filter(r => r.proposalRev < (cardRev.get(r.proposalId) ?? 0)).map(r => r.proposalId));
  const pending = snapshot.filter(r => !stale.has(r.proposalId));
  const want = new Map(pending.map(r => [paramsKey(paramsOf(project.localProjectId, r)), r]));
  for (const a of cards) {
    const p = cardParams(a);
    if (p && (want.has(paramsKey(p)) || stale.has(p.proposalId))) continue;
    const newer = p && pending.some(r => r.proposalId === p.proposalId);
    d.closeAsk(a.id, newer ? "superseded by a newer proposal rev" : "proposal no longer pending");
  }
  // 逐张开：一张开卡失败只记一行，不影响别的提案，也不丢已开成功的那些（conflict 结果按返回卡说话）
  const opened: Ask[] = [];
  for (const [key, r] of want) {
    if (r.proposal.expiresAt <= d.now() || plan.get(key)?.skip) continue;
    // dedupKey：同一 rev 再轮询返回已有那张。
    try { opened.push(d.openAsk(inboxCard(project.localProjectId, r, self, plan.get(key)?.reason, plan.get(key)?.hits) as CreateAskInput)); }
    catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 为 ${r.proposalId} rev ${r.proposalRev} 开卡失败：${(e as Error).name}`); }
  }
  return opened;
}

/** 每个项目上一次的审批权状态（owner / not_owner / error:<错误名>）：变了才记一行日志，不在每轮轮询里重复记。按 deps 分开存（测试各用各的） */
const approverStates = new WeakMap<ProposalInboxDeps, Map<string, string>>();
function noteApprover(project: InboxProject, state: string, line: string, d: ProposalInboxDeps): void {
  const states = approverStates.get(d) ?? new Map<string, string>();
  approverStates.set(d, states);
  if ((states.get(project.localProjectId) ?? "owner") !== state) d.log(line);
  states.set(project.localProjectId, state);
}

/** 只给固定错误名：中心原文、传输错误文字可能带凭据或 URL */
const membersErrorName = (e: unknown) => e instanceof SharedLedgerRemoteError ? `http_${e.status}`
  : e instanceof SharedLedgerUnavailable ? "center_unavailable" : e instanceof TypeError ? "members_shape" : "request_failed";

/**
 * 核审批权后再开 / 撤卡（PROPRESULT1）：有待批的才读成员表（每轮每项目至多一次）。本人是 owner → reconcile；
 * 不是 owner / 表里没有本人 → 不开卡，本项目开着的卡全撤；读失败 → 不开不撤，下一轮再试。返回这一轮开出（或撞回）的卡。
 */
async function gatedReconcile(project: InboxProject, pending: Pending, d: ProposalInboxDeps): Promise<Ask[]> {
  const id = project.localProjectId;
  const mode = d.auto?.mode(id) ?? "off";
  if (d.auto && mode !== "off") backfillResults(project, pending, d, d.auto);
  if (pending.records.length) {
    let approver: boolean;
    try { approver = canApprove(await d.members(project.scope), pending.self); }
    catch (e) {
      const name = membersErrorName(e);
      noteApprover(project, `error:${name}`, `[proposal-inbox] ${id} 读成员表失败：${name}，这一轮不开卡、不撤卡，下轮再试`, d);
      return [];
    }
    if (!approver) {
      noteApprover(project, "not_owner", `[proposal-inbox] ${id} ${NOT_APPROVER_REASON}：不开提案审批卡，已开的撤掉`, d);
      for (const a of d.openCards()) if (projectOf(a) === id) d.closeAsk(a.id, NOT_APPROVER_REASON);
      return [];
    }
    noteApprover(project, "owner", `[proposal-inbox] ${id} 本人是该项目 owner：恢复开提案审批卡`, d);
  }
  return reconcile(project, pending, d, d.auto && mode !== "off" ? await autoRoute(project, pending, mode, d, d.auto) : undefined);
}

const identityOf = (project: InboxProject, params: InboxParams): ExecIdentity =>
  ({ localProjectId: project.localProjectId, centerProject: project.scope.projectId, params });
const SKIP: Plan = { skip: true };

/** 上一轮自动发出、结果不明的：中心已不是待批 → 补记结果事件（中心当前状态），不再发。失败只记一行 */
function backfillResults(project: InboxProject, pending: Pending, d: ProposalInboxDeps, a: AutoApproveDeps): void {
  try {
    const db = a.db();
    for (const r of pending.all) {
      if (r.operation.state === "pending_approval") continue;
      const ident = identityOf(project, paramsOf(project.localProjectId, r)), s = execState(db, execKey(ident.centerProject, ident.params));
      if (s.result || !s.claims.some(c => c.lane === "auto")) continue;
      recordExecResult(db, ident, { outcome: "settled", centerState: r.operation.state, reasons: [] }, d.now());
      d.log(`[proposal-inbox] ${project.localProjectId} ${r.proposalId} rev ${r.proposalRev} 自动批准结果补记：中心 ${r.operation.state}`);
    }
  } catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 补记自动批准结果失败：${(e as Error).name}`); }
}

/** 核过审批权后、建卡前：逐条分类。observe 只记「本会自动批」样本；on 档非安全类且这一版本没有人工卡 → autoApprove。出错照旧出卡 */
async function autoRoute(project: InboxProject, pending: Pending, mode: RecoveryMode, d: ProposalInboxDeps, a: AutoApproveDeps): Promise<Map<string, Plan>> {
  const plan = new Map<string, Plan>(), id = project.localProjectId;
  for (const r of pending.records) {
    if (r.proposal.expiresAt <= d.now()) continue;
    const params = paramsOf(id, r), verdict = a.files ? classifyProposal(r, a.files()) : classifyProposal(r);
    try {
      if (mode === "observe") {
        if (verdict.route === "auto") observeAutoApprove(a.db(), identityOf(project, params), d.now());
        continue;
      }
      if (verdict.route === "owner") plan.set(paramsKey(params), { reason: reasonText(verdict.reasons, undefined, verdict.hits), hits: verdict.hits });
      else if (!a.hasCard(inboxDedupKey(params))) plan.set(paramsKey(params), await autoApprove(project, r, identityOf(project, params), d, a));
    } catch (e) { d.log(`[proposal-inbox] ${id} 自动批准 ${r.proposalId} rev ${r.proposalRev} 出错：${(e as Error).name}，照旧出卡`); }
  }
  return plan;
}

/**
 * 一条非安全类提案的自动批准：先抢执行占位，抢到才 decide（和人工路径同一个 d.decide + decisionBody，不伪造 owner 答复）。
 * 成功写结果事件；409 记 conflict，下一轮按新快照重判；中心明确拒绝 → 交回人工出卡带错误码；结果不明 → 占位留着，
 * 满 10 分钟仍待批才再发，同一 rev 最多 3 次，第 3 次仍不明交回人工。
 */
async function autoApprove(project: InboxProject, r: ProposalRecord, ident: ExecIdentity, d: ProposalInboxDeps, a: AutoApproveDeps): Promise<Plan> {
  const db = a.db(), now = d.now(), s = execState(db, execKey(ident.centerProject, ident.params));
  const tag = `[proposal-inbox] ${project.localProjectId} ${r.proposalId} rev ${r.proposalRev}`;
  const handover = (reasons: AutoReason[], code?: string): Plan => {
    recordExecResult(db, ident, { outcome: "handover", reasons, ...(code ? { code } : {}) }, d.now());
    d.log(`${tag} 自动批准交回 owner：${reasons.join(",")}${code ? `（${code}）` : ""}`);
    return { reason: reasonText(reasons, code) };
  };
  if (s.result) {
    if (s.result.outcome === "handover") return { reason: reasonText(s.result.reasons, s.result.code) };
    // conflict 之后同一 rev 还待批（中心不该这样）：不再自动发，交给 owner
    return s.result.outcome === "conflict" ? { reason: reasonText(["auto_unconfirmed"]) } : SKIP;
  }
  if (s.claims.some(c => c.lane === "owner")) return {};
  const tries = s.claims.length;
  if (tries && now - Math.max(...s.claims.map(c => c.at)) < RETRY_AFTER_MS) return SKIP;
  if (tries >= MAX_AUTO_ATTEMPTS) return handover(["auto_unconfirmed"]);
  if (!claimExec(db, ident, "auto", now, tries + 1)) return SKIP;
  try {
    const record = await d.decide(project.scope, r.proposalId, decisionBody(ident.params, "approve"));
    recordExecResult(db, ident, { outcome: "approved", centerState: record.operation.state, reasons: [] }, d.now());
    d.log(`${tag} 已自动批准（中心 ${record.operation.state}）`);
    return SKIP;
  } catch (e) {
    const code = inboxErrorCode(e);
    if (isDecisionConflict(e)) {
      recordExecResult(db, ident, { outcome: "conflict", code, reasons: [] }, d.now());
      d.log(`${tag} 自动批准遇到 conflict，下一轮按新快照重新分类`);
      return SKIP;
    }
    if (e instanceof FeatureProposalRejected || e instanceof FeatureProposalUnsupported) return handover(["auto_center_refused"], code);
    if (tries + 1 >= MAX_AUTO_ATTEMPTS) return handover(["auto_unconfirmed"], code);
    d.log(`${tag} 自动批准第 ${tries + 1} 次结果不明：${code}，占位保留`);
    return SKIP;
  }
}

/** 拉一个项目；失败只记一行（错误码，不含凭据 / 中心原文）→ null，这个项目的卡这一轮不动 */
async function pull(project: InboxProject, d: ProposalInboxDeps): Promise<Pending | null> {
  try { return pendingOf(await d.list(project.scope)); }
  catch (e) {
    d.log(`[proposal-inbox] ${project.localProjectId} 拉取中心提案失败：${inboxErrorCode(e)}，下轮再试`);
    return null;
  }
}

/** 定时一轮：每个绑定项目拉一次，开 / 撤卡。不抛错 */
export async function pollCenterProposals(d: ProposalInboxDeps = liveDeps): Promise<void> {
  let projects: InboxProject[];
  try { projects = d.projects(); }
  catch (e) { return d.log(`[proposal-inbox] 团队项目绑定不可读（${(e as Error).name}），下轮再试`); }
  for (const project of projects) await serial(project.localProjectId, async () => {
    const pending = await pull(project, d);
    if (!pending) return;
    try { await gatedReconcile(project, pending, d); }
    catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 开 / 撤卡失败：${(e as Error).name}`); }
  });
}

/** 本进程里已经处理过的卡（转发只做一次，不自动重试） */
const handled = new Set<string>();
/** 答复钩子（ask-entry.ts commitNoticing）：不是本模块的卡立即返回；每张卡只执行一次 */
export async function onCenterProposalAnswered(a: Ask, d: ProposalInboxDeps = liveDeps): Promise<void> {
  const ours = a.createdBy === PROPOSAL_INBOX_CREATOR || a.createdBy === PROPOSAL_RESULT_CREATOR;
  if (!ours || a.state !== "answered" || handled.has(a.id)) return;
  handled.add(a.id);
  await (a.createdBy === PROPOSAL_RESULT_CREATOR ? resultAnswered(a, d) : execute(a, d));
}

/** 结果卡的答复（作答已把卡收成 answered）：「知道了」不做别的；「交给大总管」发固定格式的一段给 master。不是 owner 本人答的不生效 */
async function resultAnswered(a: Ask, d: ProposalInboxDeps): Promise<void> {
  const picked = resultAnswer(a);
  if (!picked) return d.log(`[proposal-inbox] 结果卡 ${a.id} 的答复不生效（非 owner 本人或选项不符）`);
  if (picked === "ack") return;
  try {
    await d.handoff(handoffText(a), a.id);
    d.log(`[proposal-inbox] 结果卡 ${a.id} 已交给大总管`);
  } catch (e) { d.log(`[proposal-inbox] 结果卡 ${a.id} 交给大总管失败：${(e as Error).name}`); }
}

async function execute(a: Ask, d: ProposalInboxDeps): Promise<void> {
  const title = proposalTitleOf(a.title);
  const ok = verifiedAnswer(a);
  if (!ok) {
    const p = cardParams(a);
    d.log(`[proposal-inbox] 卡 ${a.id} 的答复未执行（非 owner 本人或参数不符）`);
    if (p) await d.inform(decisionResultText(title, p, { kind: "invalid" }),
      { askId: a.id, title, resultCard: true, meta: { proposalId: p.proposalId, proposalRev: p.proposalRev, code: "not_executed" } })
      .catch((e: Error) => d.log(`[proposal-inbox] 通知 owner 失败：${e.name}`));
    return;
  }
  const { decision, params } = ok;
  // 绑定状态读不出（文件坏 / 解析失败）和真的没绑定分开报：前者记错误名、结果给 binding_state_unreadable
  let project: InboxProject | undefined, unreadable = false;
  try { project = d.projects().find(x => x.localProjectId === params.localProjectId); }
  catch (e) { unreadable = true; d.log(`[proposal-inbox] 卡 ${a.id} 执行前读团队项目绑定失败：${(e as Error).name}`); }
  // 只有办成了（done 且中心已是 published / approved / rejected）才不开结果卡；报错、conflict、别的状态都要 owner 再看一眼
  // 日志按真实结果写（PROPRESULT1）：办成「已执行」，报错「执行…失败：<错误码>」，conflict「conflict，已重拉」；code 也记到结果卡上
  let text: string, resultCard = true, code: string, outcome: string;
  const failed = (c: string) => { code = c; outcome = `执行 ${decision} 失败：${c}`; return decisionResultText(title, params, { kind: "error", code: c }); };
  const held = project ? claimForOwner(project, params, d, a) : "ok";
  if (!project) text = failed(unreadable ? "binding_state_unreadable" : "project_not_bound");
  else if (held === "error") text = failed("exec_claim_failed");
  else if (held === "held") {
    text = decisionResultText(title, params, { kind: "claimed" });
    resultCard = false; code = "already_executing"; outcome = "未执行：该版本的执行占位已被占";
  } else {
    try {
      const record = await d.decide(project.scope, params.proposalId, decisionBody(params, decision));
      text = decisionResultText(title, params, { kind: "done", record, decision });
      resultCard = !decisionSettled(record);
      code = "center_state_not_final"; outcome = `已执行 ${decision}`;
    } catch (e) {
      if (isDecisionConflict(e)) { text = await afterConflict(project, title, params, d); code = "conflict"; outcome = "conflict，已重拉"; }
      else text = failed(inboxErrorCode(e));
    }
  }
  d.log(`[proposal-inbox] 卡 ${a.id}（${params.proposalId} rev ${params.proposalRev}）${outcome!}`);
  const meta = { proposalId: params.proposalId, proposalRev: params.proposalRev, code: code! };
  await d.inform(text, { askId: a.id, title, resultCard, meta }).catch((e: Error) => d.log(`[proposal-inbox] 通知 owner 失败：${e.name}`));
}

/** PROPAUTO1：开关 on 时人工答复发 decide 前也抢同一个执行占位；抢不到 = 已在执行（自动批准或另一次答复），不再发。写不进台账 → error，不发 */
function claimForOwner(project: InboxProject, params: InboxParams, d: ProposalInboxDeps, card: Ask): "ok" | "held" | "error" {
  if (!d.auto || d.auto.mode(project.localProjectId) !== "on") return "ok";
  try { return claimExec(d.auto.db(), { ...identityOf(project, params), ...cardHitEvidence(card) }, "owner", d.now()) ? "ok" : "held"; }
  catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} ${params.proposalId} 抢执行占位失败：${(e as Error).name}`); return "error"; }
}

/** conflict：重拉一次；该提案仍待批就按新 rev 开新卡（同时撤这个项目里过时的卡） */
function afterConflict(project: InboxProject, title: string, params: InboxParams, d: ProposalInboxDeps): Promise<string> {
  return serial(project.localProjectId, () => refetchAfterConflict(project, title, params, d));
}
async function refetchAfterConflict(project: InboxProject, title: string, params: InboxParams, d: ProposalInboxDeps): Promise<string> {
  let pending: Pending;
  try { pending = pendingOf(await d.list(project.scope)); }
  catch (e) { return decisionResultText(title, params, { kind: "conflict", fresh: null, refetchError: inboxErrorCode(e) }); }
  const fresh = pending.records.find(r => r.proposalId === params.proposalId) ?? null;
  // 重拉到的还是同一 rev / 摘要：dedupKey 会撞回这张已答的卡，不算重开
  if (fresh && paramsKey(paramsOf(project.localProjectId, fresh)) === paramsKey(params)) return decisionResultText(title, params, { kind: "error", code: "conflict" });
  let opened: Ask[] = [];
  try { opened = await gatedReconcile(project, pending, d); }
  catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 开 / 撤卡失败：${(e as Error).name}`); }
  // 按返回卡的真实状态说：dedupKey 可能撞回这一 rev 已答 / 已撤的卡，那就不能说「已开新卡」
  const key = fresh && paramsKey(paramsOf(project.localProjectId, fresh));
  const card = key ? opened.find(a => { const p = cardParams(a); return p && paramsKey(p) === key; }) : undefined;
  return decisionResultText(title, params, { kind: "conflict", fresh, card: card?.state });
}

/** 执行结果回给 owner（liveDeps.inform）：原卡 extra 记结果（网页靠它的 SSE 看到），另投控制频道（Discord）；card.resultCard 为真才在「待你处理」开结果卡 */
export async function informOwner(text: string, card: InformCard): Promise<void> {
  const db = askDb();
  patchAsk(db, card.askId, { extra: { centerProposalResult: text } });
  const answered = getAsk(db, card.askId);
  if (answered) publishAsk(answered);
  if (card.resultCard) createAsk(resultCard(card.askId, card.title, text, card.meta) as CreateAskInput);
  const d = asksDeps();
  if (!d) return;
  const meta = { messageId: newMessageId("ask"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId() };
  const r = await d.deliver({ from: { kind: "bridge", label: "proposal-inbox" }, to: { kind: "user", userId: "", channelId: d.controlChannelId },
    intent: "notification", content: text, meta });
  if (r.outcome.kind !== "sent") console.warn(`[proposal-inbox] 控制频道通知未送达：${r.outcome.kind}（结果已${card.resultCard ? "进「待你处理」" : "记在原卡"}）`);
}

/** 成员表（liveDeps.members）：owner:self 的 person 凭据 + 本机实例密钥，和拉提案同一身份；没有凭据 / 密钥 / 实例换了 → 403（当读失败） */
async function projectMembersOf(scope: FeatureProposalScope): Promise<readonly InboxMember[]> {
  const credential = resolveSharedLedgerCredential("owner:self", "person", scope.centerId, scope.teamId, scope.projectId, "read", STATE_DIR);
  const key = instanceKeySync(STATE_DIR);
  if (!credential || credential.kind !== "person" || !key || credential.instanceId !== instanceIdSync(STATE_DIR)) throw new SharedLedgerRemoteError(403, null);
  const client = new SharedLedgerClient(credential, key, { projectsProtocol: { parseV2ProjectsRequest, parseV2ProjectsResponse } });
  return (await client.projectMembers(scope.projectId)).members;
}

/** 「交给大总管」（liveDeps.handoff）：不抢占的系统通知发到控制频道的 master；不在线进押后队列 */
async function handoffToMaster(text: string, askId: string): Promise<void> {
  const d = asksDeps();
  if (!d) throw new Error("asks 未初始化");
  await sendCalm({ kind: "bridge", label: "proposal-inbox" }, { channelId: d.controlChannelId, agentName: "master" }, "notification", text, askId, "bridge_synth");
}

const runtime = (): ProposalRuntime => ({ stateDir: STATE_DIR, now: Date.now, newOperationId: () => "op-unused", ttlMs: PROPOSAL_DEFAULT_TTL_MS });
const liveDeps: ProposalInboxDeps = {
  now: () => Date.now(),
  projects: () => {
    const locals = readSharedLedgerProjects(STATE_DIR).projects;
    return readSharedLedgerBindings(STATE_DIR).flatMap(b => {
      const localProjectId = sharedLedgerBindingLocalId(b), local = locals.find(p => p.id === localProjectId);
      return local && isPersonalProject(local) ? [] : [{ localProjectId, scope: { centerId: b.centerId, teamId: b.teamId, projectId: b.projectId } }];
    });
  },
  list: scope => listCenterProposals(runtime(), scope),
  members: projectMembersOf,
  decide: (scope, proposalId, decision) => forwardDecision(runtime(), scope, proposalId, decision),
  openAsk: input => createAsk(input),
  openCards: () => {
    const db = askReadDb();
    return db ? listAsks(db, { source: "system", project: MASTER_PROJECT, states: ["open"] }).filter(a => a.createdBy === PROPOSAL_INBOX_CREATOR) : [];
  },
  closeAsk: (id, reason) => {
    const db = askDb();
    if (getAsk(db, id)?.state !== "open") return;
    const a = closeAsk(db, id, "cancelled", reason);
    if (a) publishAsk(a);
  },
  inform: informOwner,
  handoff: handoffToMaster,
  log: line => console.log(line),
  auto: {
    mode: autoApproveMode,
    db: askDb,
    hasCard: key => !!askReadDb()?.query("SELECT 1 FROM asks WHERE dedupKey = ? AND createdBy = ?").get(key, PROPOSAL_INBOX_CREATOR),
  },
};

let timer: ReturnType<typeof setInterval> | null = null;
/** ask-entry.ts initAskWiring 的一行：立刻拉一轮，此后每 5 分钟；重复调用不另起 */
export function initCenterProposalInbox(): void {
  if (timer) return;
  const run = () => void pollCenterProposals().catch(() => console.warn("[proposal-inbox] 轮询失败"));
  timer = setInterval(run, PROPOSAL_INBOX_INTERVAL_MS);
  timer.unref?.();
  run();
}
