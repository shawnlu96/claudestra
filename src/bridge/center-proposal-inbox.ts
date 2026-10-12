/** PROPINBOX1 接线（纯函数在 lib/center-proposal-inbox.ts）：每 5 分钟对绑定了团队项目的本机项目拉中心提案（owner:self person 凭据），
 * 他人提的 pending_approval → owner「待你处理」授权卡；提案已不待批 / 换了新 rev → 撤旧卡。
 * 答复钩子（ask-entry.ts commitNoticing）：本卡 + bind 校验 + owner 本人答 → forwardDecision 一次，不自动重试；
 * conflict 重拉一次，仍待批就按新 rev 开新卡。凭据缺失 / 中心不可达只记一行日志（只有错误码），下轮再试。
 * 照 shared-ledger-join-offer.ts 的写法：source=system 的 authorize 卡、bind + paramsHash、ownerAnswered。
 */
import { closeAsk, getAsk, listAsks, MASTER_PROJECT, type Ask } from "../lib/ledger-asks.js";
import { isPersonalProject } from "../lib/lend-policy.js";
import { STATE_DIR } from "../lib/paths.js";
import { readSharedLedgerBindings } from "../lib/shared-ledger-gate-bindings.js";
import { readSharedLedgerProjects } from "../lib/shared-ledger-project-link.js";
import { sharedLedgerBindingLocalId } from "../lib/shared-ledger-project-link-target.js";
import {
  forwardDecision, listCenterProposals, PROPOSAL_DEFAULT_TTL_MS, type ProposalRuntime,
} from "../lib/shared-ledger-feature-proposals-store.js";
import type { FeatureProposalScope, ProposalList, ProposalRecord } from "../lib/shared-ledger-feature-proposals.js";
import type { ProposalDecision } from "../lib/shared-ledger-contract-v2-feature-proposals.js";
import {
  cardParams, decisionBody, decisionResultText, inboxCard, inboxErrorCode, isDecisionConflict, othersPending, paramsOf,
  PROPOSAL_INBOX_CREATOR, verifiedAnswer, type InboxParams,
} from "../lib/center-proposal-inbox.js";
import { askDb, askReadDb, asksDeps, createAsk, publishAsk, type CreateAskInput } from "./asks.js";
import { newMessageId, newThreadId } from "./router.js";

export const PROPOSAL_INBOX_INTERVAL_MS = 5 * 60_000;

export interface InboxProject { localProjectId: string; scope: FeatureProposalScope }
export interface ProposalInboxDeps {
  now: () => number;
  /** 绑定了团队项目的本机项目（个人项目除外）；读不到抛错 */
  projects: () => InboxProject[];
  list: (scope: FeatureProposalScope) => Promise<ProposalList & { selfPersonId: string }>;
  decide: (scope: FeatureProposalScope, proposalId: string, decision: ProposalDecision) => Promise<ProposalRecord>;
  openAsk: (input: CreateAskInput) => Ask;
  /** 本模块开的、还开着的卡 */
  openCards: () => Ask[];
  closeAsk: (id: string, reason: string) => void;
  inform: (text: string) => Promise<void>;
  log: (line: string) => void;
}

const paramsKey = (p: InboxParams) => `${p.localProjectId}\0${p.proposalId}\0${p.proposalRev}\0${p.proposalDigest}`;
const projectOf = (a: Ask) => cardParams(a)?.localProjectId;

/** 一个项目的一轮：开缺的卡，撤不再待批 / 已被新 rev 取代的卡 */
function reconcile(project: InboxProject, pending: ProposalRecord[], d: ProposalInboxDeps): Ask[] {
  const want = new Map(pending.map(r => [paramsKey(paramsOf(project.localProjectId, r)), r]));
  for (const a of d.openCards().filter(c => projectOf(c) === project.localProjectId)) {
    const p = cardParams(a);
    if (p && want.has(paramsKey(p))) continue;
    const newer = p && pending.some(r => r.proposalId === p.proposalId);
    d.closeAsk(a.id, newer ? "superseded by a newer proposal rev" : "proposal no longer pending");
  }
  const opened: Ask[] = [];
  for (const r of want.values()) {
    if (r.proposal.expiresAt <= d.now()) continue;
    opened.push(d.openAsk(inboxCard(project.localProjectId, r) as CreateAskInput)); // dedupKey：同一 rev 再轮询返回已有那张
  }
  return opened;
}

/** 拉一个项目；失败只记一行（错误码，不含凭据 / 中心原文）→ null，这个项目的卡这一轮不动 */
async function pull(project: InboxProject, d: ProposalInboxDeps): Promise<ProposalRecord[] | null> {
  try { return othersPending(await d.list(project.scope)); }
  catch (e) {
    d.log(`[proposal-inbox] ${project.localProjectId} 拉取中心提案失败：${inboxErrorCode(e)}，下轮再试`);
    return null;
  }
}

/** 定时一轮：每个绑定项目拉一次，开 / 撤卡。不抛错 */
export async function pollCenterProposals(d: ProposalInboxDeps = liveDeps): Promise<void> {
  let projects: InboxProject[];
  try { projects = d.projects(); }
  catch { return d.log("[proposal-inbox] 团队项目绑定不可读，下轮再试"); }
  for (const project of projects) {
    const pending = await pull(project, d);
    if (!pending) continue;
    try { reconcile(project, pending, d); }
    catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 开 / 撤卡失败：${(e as Error).name}`); }
  }
}

/** 本进程里已经处理过的卡（转发只做一次，不自动重试） */
const handled = new Set<string>();
/** 答复钩子（ask-entry.ts commitNoticing）：不是本模块的卡立即返回；每张卡只执行一次 */
export async function onCenterProposalAnswered(a: Ask, d: ProposalInboxDeps = liveDeps): Promise<void> {
  if (a.createdBy !== PROPOSAL_INBOX_CREATOR || a.state !== "answered" || handled.has(a.id)) return;
  handled.add(a.id);
  await execute(a, d);
}

async function execute(a: Ask, d: ProposalInboxDeps): Promise<void> {
  const title = a.title.replace(/^成员提案待批：/, "");
  const ok = verifiedAnswer(a);
  if (!ok) {
    const p = cardParams(a);
    d.log(`[proposal-inbox] 卡 ${a.id} 的答复未执行（非 owner 本人或参数不符）`);
    if (p) await d.inform(decisionResultText(title, p, { kind: "invalid" })).catch(() => d.log("[proposal-inbox] 通知 owner 失败"));
    return;
  }
  const { decision, params } = ok;
  const project = (() => { try { return d.projects().find(x => x.localProjectId === params.localProjectId); } catch { return undefined; } })();
  let text: string;
  if (!project) text = decisionResultText(title, params, { kind: "error", code: "project_not_bound" });
  else {
    try {
      const record = await d.decide(project.scope, params.proposalId, decisionBody(params, decision));
      text = decisionResultText(title, params, { kind: "done", record, decision });
    } catch (e) {
      text = isDecisionConflict(e) ? await afterConflict(project, title, params, d)
        : decisionResultText(title, params, { kind: "error", code: inboxErrorCode(e) });
    }
  }
  d.log(`[proposal-inbox] 卡 ${a.id}（${params.proposalId} rev ${params.proposalRev}）已执行 ${decision}`);
  await d.inform(text).catch(() => d.log("[proposal-inbox] 通知 owner 失败"));
}

/** conflict：重拉一次；该提案仍待批就按新 rev 开新卡（同时撤这个项目里过时的卡） */
async function afterConflict(project: InboxProject, title: string, params: InboxParams, d: ProposalInboxDeps): Promise<string> {
  let pending: ProposalRecord[];
  try { pending = othersPending(await d.list(project.scope)); }
  catch (e) { return decisionResultText(title, params, { kind: "conflict", reopened: null, refetchError: inboxErrorCode(e) }); }
  const fresh = pending.find(r => r.proposalId === params.proposalId) ?? null;
  // 重拉到的还是同一 rev / 摘要：dedupKey 会撞回这张已答的卡，不算重开
  if (fresh && paramsKey(paramsOf(project.localProjectId, fresh)) === paramsKey(params)) return decisionResultText(title, params, { kind: "error", code: "conflict" });
  try { reconcile(project, pending, d); }
  catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 开 / 撤卡失败：${(e as Error).name}`); }
  return decisionResultText(title, params, { kind: "conflict", reopened: fresh });
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
  inform: async text => {
    const d = asksDeps();
    if (!d) return;
    const meta = { messageId: newMessageId("ask"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId() };
    await d.deliver({ from: { kind: "bridge", label: "proposal-inbox" }, to: { kind: "user", userId: "", channelId: d.controlChannelId }, intent: "notification", content: text, meta });
  },
  log: line => console.log(line),
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
