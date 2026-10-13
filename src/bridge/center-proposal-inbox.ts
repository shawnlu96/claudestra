/** PROPINBOX1 接线（纯函数在 lib/center-proposal-inbox.ts）：每 5 分钟对绑定了团队项目的本机项目拉中心提案（owner:self person 凭据），
 * 他人提的 pending_approval → owner「待你处理」授权卡；提案已不待批 / 换了新 rev → 撤旧卡。
 * 答复钩子（ask-entry.ts commitNoticing）：本卡 + bind 校验 + owner 本人答 → forwardDecision 一次，不自动重试；
 * conflict 重拉一次，仍待批就按新 rev 开新卡。凭据缺失 / 中心不可达只记一行日志（只有错误码），下轮再试。
 * 照 shared-ledger-join-offer.ts 的写法：source=system 的 authorize 卡、bind + paramsHash、ownerAnswered。
 */
import { closeAsk, getAsk, listAsks, MASTER_PROJECT, patchAsk, type Ask } from "../lib/ledger-asks.js";
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
  cardParams, decisionBody, decisionResultText, decisionSettled, inboxCard, inboxErrorCode, isDecisionConflict, othersPending, paramsOf,
  PROPOSAL_INBOX_CREATOR, resultCard, verifiedAnswer, type InboxParams,
} from "../lib/center-proposal-inbox.js";
import { askDb, askReadDb, asksDeps, createAsk, publishAsk, type CreateAskInput } from "./asks.js";
import { newMessageId, newThreadId } from "./router.js";

const PROPOSAL_INBOX_INTERVAL_MS = 5 * 60_000;

interface InboxProject { localProjectId: string; scope: FeatureProposalScope }
export interface InformCard { askId: string; title: string; resultCard: boolean }
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
  /** 执行结果回给 owner：写回原卡（网页可见）+ 投控制频道；resultCard 为真才另开结果卡进「待你处理」（办成了的不开） */
  inform: (text: string, card: InformCard) => Promise<void>;
  log: (line: string) => void;
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

/** 一个项目的一轮：开缺的卡，撤不再待批 / 已被新 rev 取代的卡 */
function reconcile(project: InboxProject, snapshot: ProposalRecord[], d: ProposalInboxDeps): Ask[] {
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
  for (const r of want.values()) {
    if (r.proposal.expiresAt <= d.now()) continue;
    try { opened.push(d.openAsk(inboxCard(project.localProjectId, r) as CreateAskInput)); } // dedupKey：同一 rev 再轮询返回已有那张
    catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 为 ${r.proposalId} rev ${r.proposalRev} 开卡失败：${(e as Error).name}`); }
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
  catch (e) { return d.log(`[proposal-inbox] 团队项目绑定不可读（${(e as Error).name}），下轮再试`); }
  for (const project of projects) await serial(project.localProjectId, async () => {
    const pending = await pull(project, d);
    if (!pending) return;
    try { reconcile(project, pending, d); }
    catch (e) { d.log(`[proposal-inbox] ${project.localProjectId} 开 / 撤卡失败：${(e as Error).name}`); }
  });
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
    if (p) await d.inform(decisionResultText(title, p, { kind: "invalid" }), { askId: a.id, title, resultCard: true })
      .catch((e: Error) => d.log(`[proposal-inbox] 通知 owner 失败：${e.name}`));
    return;
  }
  const { decision, params } = ok;
  // 绑定状态读不出（文件坏 / 解析失败）和真的没绑定分开报：前者记错误名、结果给 binding_state_unreadable
  let project: InboxProject | undefined, unreadable = false;
  try { project = d.projects().find(x => x.localProjectId === params.localProjectId); }
  catch (e) { unreadable = true; d.log(`[proposal-inbox] 卡 ${a.id} 执行前读团队项目绑定失败：${(e as Error).name}`); }
  // 只有办成了（done 且中心已是 published / approved / rejected）才不开结果卡；报错、conflict、别的状态都要 owner 再看一眼
  let text: string, resultCard = true;
  if (!project) text = decisionResultText(title, params, { kind: "error", code: unreadable ? "binding_state_unreadable" : "project_not_bound" });
  else {
    try {
      const record = await d.decide(project.scope, params.proposalId, decisionBody(params, decision));
      text = decisionResultText(title, params, { kind: "done", record, decision });
      resultCard = !decisionSettled(record);
    } catch (e) {
      text = isDecisionConflict(e) ? await afterConflict(project, title, params, d)
        : decisionResultText(title, params, { kind: "error", code: inboxErrorCode(e) });
    }
  }
  d.log(`[proposal-inbox] 卡 ${a.id}（${params.proposalId} rev ${params.proposalRev}）已执行 ${decision}`);
  await d.inform(text, { askId: a.id, title, resultCard }).catch((e: Error) => d.log(`[proposal-inbox] 通知 owner 失败：${e.name}`));
}

/** conflict：重拉一次；该提案仍待批就按新 rev 开新卡（同时撤这个项目里过时的卡） */
function afterConflict(project: InboxProject, title: string, params: InboxParams, d: ProposalInboxDeps): Promise<string> {
  return serial(project.localProjectId, () => refetchAfterConflict(project, title, params, d));
}
async function refetchAfterConflict(project: InboxProject, title: string, params: InboxParams, d: ProposalInboxDeps): Promise<string> {
  let pending: ProposalRecord[];
  try { pending = othersPending(await d.list(project.scope)); }
  catch (e) { return decisionResultText(title, params, { kind: "conflict", fresh: null, refetchError: inboxErrorCode(e) }); }
  const fresh = pending.find(r => r.proposalId === params.proposalId) ?? null;
  // 重拉到的还是同一 rev / 摘要：dedupKey 会撞回这张已答的卡，不算重开
  if (fresh && paramsKey(paramsOf(project.localProjectId, fresh)) === paramsKey(params)) return decisionResultText(title, params, { kind: "error", code: "conflict" });
  let opened: Ask[] = [];
  try { opened = reconcile(project, pending, d); }
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
  if (card.resultCard) createAsk(resultCard(card.askId, card.title, text) as CreateAskInput);
  const d = asksDeps();
  if (!d) return;
  const meta = { messageId: newMessageId("ask"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId() };
  const r = await d.deliver({ from: { kind: "bridge", label: "proposal-inbox" }, to: { kind: "user", userId: "", channelId: d.controlChannelId },
    intent: "notification", content: text, meta });
  if (r.outcome.kind !== "sent") console.warn(`[proposal-inbox] 控制频道通知未送达：${r.outcome.kind}（结果已${card.resultCard ? "进「待你处理」" : "记在原卡"}）`);
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
  inform: informOwner,
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
