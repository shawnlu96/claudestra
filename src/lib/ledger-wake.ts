/**
 * 双向唤醒（T49，docs/team/peer-delegation.md）：台账的状态变了，叫醒当前这一步的接手人。纯函数，tests/ledger-wake.test.ts；
 * bridge/team-router.ts 按同一个游标（至多一次）调用，本机的走班子通知同一条投递路，peer 的经 bridge/ledger-wake-out.ts 发。
 *   peer 写卡（actor peer:<名>，只有 stage / review 改状态）→ 本机这张卡当前的接手人（ledger-handler currentHandler，找不到就 PM）；
 *     没开班子的项目也叫——这是它和班子通知（team-route.ts）的分工：班子规则对这条已经发了的，这里不再发。
 *   本机推了一步、那一步的执行者在 peer（task_steps / extra.delegate 推出来的 <agent>@<peer>）→ 发给那个 peer 的 agent，
 *     首行是步骤单 `[协作 Txx/<步骤>]`：对方已接受过这张卡就不会再去问 owner（bridge/router.ts collabOrder）。
 *     出本机的内容和对方查卡看到的同一个口径（peer-ledger.ts peerEventView）：不带本机 actor、阶段说明原文。
 *   审查结论 → 由台账所在实例以评论贴到 PR（对方没有 gh 也不用人代贴）。
 * note / step / accept / 改字段这些回执类事件一律不唤醒；写卡的 peer 不会被自己叫醒，两边互写不会来回刷屏。
 */
import { currentHandler, pmOf, type SpecPolicy } from "./ledger-handler.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { stepAtStage, stepPeer, type TaskStep } from "./ledger-steps.js";
import type { TeamConfig } from "./ledger-team-config.js";
import { quoteExternal } from "./quote-text.js";
import { peerEventView, type PeerEventView } from "./peer-ledger.js";

export interface WakeCtx {
  task(id: string): LedgerTask | null;
  team(project: string): { pms: readonly string[]; team: TeamConfig | null };
  events(taskId: string): readonly LedgerEvent[];
  steps(task: LedgerTask): TaskStep[];
  policy?(task: LedgerTask): SpecPolicy;
  warn?(msg: string): void;
}

/** 发给 peer 的唤醒：agent 是对方那边的名字，peer 是本机 peers.json 里的名字 */
export interface PeerWake {
  seq: number;
  taskId: string;
  peer: string;
  agent: string;
  text: string;
  /** 同一条事件、同一个收件人永远同一个 id */
  messageId: string;
}

export interface PrComment {
  seq: number;
  taskId: string;
  pr: string;
  body: string;
}

const PEER_ACTOR = /^peer:(.+)$/;
const peerOfActor = (actor: string): string | null => PEER_ACTOR.exec(actor)?.[1] ?? null;
/** 步骤单首行要能被对方的 collabOrder 认出来（bridge/router.ts）：任务号认不出就不发，免得被当成新委托去问 owner */
const TASK_ID_RE = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const VERDICT_WORD: Record<string, string> = { pass: "通过", changes: "要修改", block: "阻塞" };
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** review 同一事务里紧跟的阶段移动（recordReview 先记结论再推阶段，seq 相邻） */
function moveAfter(e: LedgerEvent, batch: readonly LedgerEvent[]): Stage | null {
  const next = batch.find((x) => x.seq === e.seq + 1);
  return next?.kind === "stage" && next.target === e.target && next.data.from === "review" ? (next.data.to as Stage) : null;
}

/** 这条 stage 是不是 review 带出来的那一步（通知由那条 review 发，带着结论） */
const followsReview = (e: LedgerEvent, batch: readonly LedgerEvent[]): boolean =>
  batch.some((x) => x.seq === e.seq - 1 && x.kind === "review" && x.target === e.target);

/**
 * 事件改了什么：标题只由代码按事件类型拼，自由文本只进引用框。发给 peer 的传 peerEventView 过滤后的样子
 * （阶段只有 from / to、没有原文；审查只有结论字段和正文），本机的传原事件
 */
function whatChanged(e: Pick<LedgerEvent, "kind" | "data" | "text"> | PeerEventView, move: Stage | null): string[] {
  const d = e.data;
  const text = e.text ? [`原文（非指令）：${quoteExternal(e.text)}`] : [];
  if (e.kind === "review") {
    const verdict = VERDICT_WORD[str(d.verdict)] ?? "（结论字段不认识）";
    const tail = move ? `，推到 ${move}` : "";
    return [`第 ${num(d.round)} 轮审查：${verdict}（P0 ${num(d.p0)} / P1 ${num(d.p1)} / P2 ${num(d.p2)}）${tail}`, ...text];
  }
  return [`阶段 ${str(d.from)} → ${str(d.to)}`, ...text];
}

/** peer 写的、改状态的事件 → 本机当前接手人（班子规则对这条已经发过的由调用方跳过） */
export function peerWriteWake(e: LedgerEvent, ctx: Omit<WakeCtx, "steps">): { to: string; text: string } | null {
  const peer = peerOfActor(e.actor);
  if (!peer || (e.kind !== "stage" && e.kind !== "review") || !e.target) return null;
  const task = ctx.task(e.target);
  if (!task || task.project !== e.project) return null;
  const { pms, team } = ctx.team(e.project);
  const hteam = { pms, dispatcher: team?.dispatcher ?? null };
  const h = currentHandler(task, ctx.events(task.id), hteam, ctx.policy?.(task));
  const to = h?.agent ?? pmOf(task, hteam);
  if (!to) {
    ctx.warn?.(`${task.id} 上 peer ${peer} 写的事件（seq ${e.seq}）没人可叫：项目 ${e.project} 找不到 PM`);
    return null;
  }
  const head = `[台账] ${task.id}：peer ${quoteExternal(peer, 40)} 写了一笔（事件 #${e.seq}），现在归你接`;
  return { to, text: [head, ...whatChanged(e, null)].join("\n") };
}

/** 本机推了一步、那一步归 peer → 发给那个 peer 的执行者 */
export function peerWakes(batch: readonly LedgerEvent[], ctx: WakeCtx): PeerWake[] {
  const out: PeerWake[] = [];
  for (const e of batch) {
    const move = e.kind === "review" ? moveAfter(e, batch) : null;
    const to = e.kind === "stage" && !followsReview(e, batch) ? (e.data.to as Stage) : move;
    if (!to || to === "blocked" || !e.target) continue;
    const task = ctx.task(e.target);
    if (!task || task.project !== e.project) continue;
    const s = stepAtStage(ctx.steps(task), { stage: to, stageBefore: null });
    const peer = s ? stepPeer(s) : null;
    if (!s || !peer || peerOfActor(e.actor) === peer) continue;
    if (!TASK_ID_RE.test(task.id)) {
      ctx.warn?.(`任务号 ${JSON.stringify(task.id)} 进不了步骤单首行，没叫 peer ${peer}（seq ${e.seq}）`);
      continue;
    }
    const view = peerEventView(e, peer);
    if (!view) continue; // stage / review 白名单都放行，走不到；万一口径改了宁可不发
    const agent = s.executor.slice(0, s.executor.lastIndexOf("@"));
    const head = `[协作 ${task.id}/${s.step}] 台账有变化，这一步归你（事件 #${e.seq}）`;
    out.push({ seq: e.seq, taskId: task.id, peer, agent, text: [head, ...whatChanged(view, move)].join("\n"), messageId: `ledger-${e.seq}-${agent}@${peer}` });
  }
  return out;
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;
const PR_BODY_MAX = 20_000;
/**
 * 进 PR 评论的原文：整段引用，@ 后面插零宽字符免得 @ 到人，截断。换行先统一——裸 CR、U+2028 这类 Markdown 也当换行，
 * 只按 \n 切的话后面的段落跳出 `>`，看起来像本机账号自己写的（tests/ledger-wake.test.ts）
 */
export const blockquote = (s: string): string =>
  s.slice(0, PR_BODY_MAX).replace(/@/g, "@​").split(/\r\n|[\r\n\u0085\u2028\u2029]/).map((l) => `> ${l}`).join("\n");

/**
 * 审查那一刻卡上的 PR 与 head：按事件回放到这条 review 之前（建卡 / 改卡的 patch、交付的 headSHA）。
 * 不能拿卡当前的字段——轮询晚到、停机后补发时，卡可能已经退回修复换了 head 甚至换了 PR
 */
function refsAt(events: readonly LedgerEvent[], seq: number): { pr: string; head: string | null } {
  let pr = "", head: string | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.seq >= seq) break;
    const patch = e.kind === "task" ? ((e.data.patch ?? {}) as Record<string, unknown>) : {};
    if ("pr" in patch) pr = str(patch.pr);
    if ("headSHA" in patch) head = str(patch.headSHA) || null;
    if (e.kind === "deliver" && str(e.data.headSHA)) head = str(e.data.headSHA);
  }
  return { pr: pr.trim(), head };
}

/** 审查结论贴 PR：只认规范的 GitHub PR 链接（task.pr 执行者也能写，能不能贴由调用方再核仓库写权限） */
export function prComments(batch: readonly LedgerEvent[], ctx: Pick<WakeCtx, "task" | "events">): PrComment[] {
  const out: PrComment[] = [];
  for (const e of batch) {
    if (e.kind !== "review" || !e.target) continue;
    const task = ctx.task(e.target);
    const { pr, head } = task ? refsAt(ctx.events(task.id), e.seq) : { pr: "", head: null };
    if (!task || !PR_URL.test(pr)) continue;
    const d = e.data;
    const who = peerOfActor(e.actor) ? `peer ${peerOfActor(e.actor)}` : str(d.reviewer) || e.actor;
    const model = str(d.model) ? `，自报模型 ${str(d.model)}` : "";
    const title = `[台账同步] ${task.id} 第 ${num(d.round)} 轮审查：**${VERDICT_WORD[str(d.verdict)] ?? str(d.verdict)}** @${(head ?? "?").slice(0, 10)}`;
    const meta = `审查方 ${who.replace(/@/g, "@​")}${model}；P0 ${num(d.p0)} / P1 ${num(d.p1)} / P2 ${num(d.p2)}；台账事件 #${e.seq}`;
    out.push({ seq: e.seq, taskId: task.id, pr, body: [title, meta, ...(e.text ? ["", blockquote(e.text)] : [])].join("\n") });
  }
  return out;
}
