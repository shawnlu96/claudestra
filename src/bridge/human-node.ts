/**
 * human 节点在 bridge 这边（docs 10-ledger「附：v3.2 例外」）：
 * - 定时扫台账：进入 build / fix 的 human 任务按 askPlanFor 开一条 assigned ask（dedupKey 撞上 = 这一次开过了）；已不是任务眼下那条的撤成 cancelled；
 * - 作答：记答案之前认人、判门，不算数整笔不记（AskRejected）；「完成」和答案同一事务写交付、推 review，「做不了」要写原因、只结 ask；
 *   落库后给 task.pm 发固定模板，开了班子的「完成」由班子路由通知，这里不发（同一件事只发一次）。
 * 开 / 撤 ask、给 PM 投递经依赖注入（initHumanNode 接「待你处理」的实现）。人写的说明只进台账 data，发给 agent 的只有任务号和结果。
 */
import type { Database } from "bun:sqlite";
import { setAskAssigneesOf } from "../lib/ask-access.js";
import { HUMAN_NODE_CREATOR, isHumanNodeAsk, pmNotice, resultOfChoices, type AskPlan, type HumanResult } from "../lib/human-node.js";
import { t } from "../lib/i18n.js";
import { closeAsk } from "../lib/ledger-asks.js";
import { checkHumanCant, HUMAN_ATTS_MAX, humanDeliver, isCurrentAssignment, pendingAssignments, projectHasTeam, staleAssignments, type HumanDeliverInput } from "../lib/ledger-human.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { getTask, LedgerError } from "../lib/ledger-store.js";
import { attsUsableBy, refAttsFromAsk } from "../lib/talk-atts.js";
import { isGuestPrincipal, OWNER_PRINCIPAL, personAliases, personIdOf } from "../lib/talk-people.js";
import { memberKey } from "../lib/talk-rooms.js";
import { notifyTaskPm } from "./ask-expire.js";
import { askDb, askDbIfExists, AskRejected, createAsk, publishAsk, setOnAssignedAnswer, setPrepareAssigned } from "./asks.js";
import { meOf, selfFp, talkDb, talkPrincipals } from "./talk.js";

const TICK_MS = 5000;
const STALE = "指派已过时：任务改派、离开了 build / fix 或 PM 重开了指派";

/** 用得到的 ask / 作答字段（与「待你处理」的 Ask / AskAnswer 结构兼容） */
export interface AssignedAsk {
  id: string;
  project: string;
  taskId: string | null;
  kind: string;
  createdBy: string | null;
  dedupKey: string | null;
}
export interface AssignedAnswer {
  choices: string[];
  text: string;
  principal: string;
  atts?: { kind: string; ref: string }[];
}

/** 作答的人：actor 是规范 person id，persons 是名下全部别名，keys 是成员键（判附件能不能用） */
interface Answerer {
  actor: string;
  persons: string[];
  isOwner: boolean;
  keys: string[];
}

export interface HumanNodeDeps {
  /** 台账写连接（「待你处理」那条）；库还不存在 → null */
  db: () => Database | null;
  /** 开一条 assigned ask：dedupKey 撞上返回已有的，不重复推送 */
  openAsk: (task: LedgerTask, plan: AskPlan) => void;
  /** 撤掉一条过时的指派（cancelled，发 SSE 让网页收起来）；已不是 open 的不动 */
  cancelAsk: (askId: string, reason: string) => void;
  /** 给 task.pm 发一条不抢占的通知：PM 不在线就不投、不转投大总管 */
  notifyPm: (task: LedgerTask, text: string, askId: string) => Promise<void>;
  /** 作答的 principal → 人；默认按 talk 的 people 表解析 */
  answerer?: (principal: string) => Promise<Answerer | null>;
}

/** 扫一遍：先撤过时的，再开该有的，返回新开的条数。opened 记本进程开过的 key，免得每轮都去撞库；重启后第一轮撞库拿回已有的，没有副作用 */
export function assignTick(d: HumanNodeDeps, opened: Set<string>): number {
  const db = d.db();
  if (!db) return 0;
  const due = pendingAssignments(db);
  for (const a of staleAssignments(db, due)) {
    try {
      d.cancelAsk(a.id, STALE);
    } catch (e) {
      console.error(`⚠️ 撤过时的指派 ${a.id} 失败（下一轮重试）: ${(e as Error).message}`);
    }
  }
  let n = 0;
  for (const { task, plan } of due) {
    if (opened.has(plan.dedupKey)) continue;
    try {
      d.openAsk(task, plan);
      opened.add(plan.dedupKey);
      n++;
    } catch (e) {
      console.error(`⚠️ 给 ${task.id} 开指派 ask 失败（下一轮重试）: ${(e as Error).message}`);
    }
  }
  return n;
}

/** 起定时扫描；返回停止函数 */
export function startHumanNode(d: HumanNodeDeps): () => void {
  const opened = new Set<string>();
  const tick = () => {
    try {
      assignTick(d, opened);
    } catch (e) {
      console.error(`⚠️ human 节点扫描失败: ${(e as Error).message}`);
    }
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.(); // 不单独撑住进程：bridge 有别的常驻句柄
  return () => clearInterval(timer);
}

/** 网页凭据按 talk 的 people 表认人；Discord 上能点按钮的只有 ALLOWED_USER_IDS，按 owner 算 */
async function answererFromTalk(principal: string): Promise<Answerer | null> {
  const fp = selfFp();
  if (!fp) return null;
  if (principal.startsWith("discord:")) {
    const persons = personAliases(talkDb(), personIdOf(OWNER_PRINCIPAL));
    return { actor: persons[0], persons, isOwner: true, keys: [memberKey(fp, OWNER_PRINCIPAL)] };
  }
  const p = (await talkPrincipals()).principals.find((x) => x.id === principal);
  const me = p ? meOf(p) : null;
  return me ? { actor: me.personId, persons: personAliases(talkDb(), me.personId), isOwner: me.isOwner, keys: me.keys } : null;
}

/**
 * 作答附的图：只收 talk 附件库里作答人自己能用的（上传者本人 / 所在房间），挂到这条 ask 上，看得见 ask 的人才看得见图。
 * 「待你处理」收 20 张，交付上限 9 张：多出的截掉，不整笔拒。引用在记答案之前挂上：那一笔若回滚，图也只挂在这条 ask 上，能看见的还是那几个人
 */
function linkAtts(ask: AssignedAsk, who: Answerer, atts: AssignedAnswer["atts"]): string[] {
  const shas = [...new Set((atts ?? []).filter((a) => a.kind === "talk").map((a) => a.ref))];
  const db = talkDb();
  const ok = shas.filter((sha) => attsUsableBy(db, [sha], who.keys, () => false)).slice(0, HUMAN_ATTS_MAX);
  if (ok.length < shas.length) console.log(`指派事项 ${ask.id} 的作答带了 ${shas.length - ok.length} 张用不了或超出 ${HUMAN_ATTS_MAX} 张的图，已略过`);
  refAttsFromAsk(db, ok, ask.id);
  return ok;
}

/** 拒这次作答（整笔不记）：网页收到 status 与这句话，Discord 上悄悄告诉点的人 */
const reject = (status: AskRejected["status"], code: string, zh: string, en: string) => new AskRejected(status, code, t(zh, en));

/**
 * 记答案之前（asks.ts setPrepareAssigned）：不是 human 节点开的返回 undefined（照「待你处理」的老规矩只记账）；不算数抛 AskRejected——
 * 过时的顺手撤掉；算数返回在记答案的同一事务里写台账的函数，它抛错答案一起回滚：不会出现「回了 202、台账没动」。
 */
export async function prepareAssignedAnswer(d: HumanNodeDeps, ask: AssignedAsk, answer: AssignedAnswer): Promise<(() => void) | undefined> {
  if (!isHumanNodeAsk(ask)) return undefined;
  const db = d.db();
  const result = resultOfChoices(answer.choices);
  if (!db || !ask.taskId) throw reject(503, "ledger_unavailable", "台账库还没准备好，这次没记下，稍后再试", "Ledger not ready; nothing recorded, try again later");
  if (!result) throw reject(400, "assign_choice", "点「完成」或「做不了」", "Pick Done or Can't do it");
  if (result === "cant" && !answer.text.trim()) throw reject(400, "reason_required", "做不了要写一下原因", "Say why it can't be done");
  if (!isCurrentAssignment(db, ask)) {
    d.cancelAsk(ask.id, STALE);
    throw reject(409, "assign_stale", "这条指派已过时（任务改派、离开了 build / fix 或重开了指派），已撤下", "This assignment is out of date and was withdrawn");
  }
  const who = await (d.answerer ?? answererFromTalk)(answer.principal);
  if (!who) throw reject(503, "answerer_unknown", "认不出作答人（本机 Chat 的身份没取到），这次没记下，稍后再试", "Couldn't tell who answered; nothing recorded, try again later");
  const input: HumanDeliverInput = { taskId: ask.taskId, askId: ask.id, ask, answerer: who, note: answer.text, atts: linkAtts(ask, who, answer.atts) };
  return () => writeAnswer(db, who.actor, input, result);
}

/** 和答案同一事务：「完成」写交付并推 review，「做不了」再判一次门（期间被推了阶段 / 改派就不认）；门不过抛 AskRejected */
function writeAnswer(db: Database, actor: string, input: HumanDeliverInput, result: HumanResult): void {
  try {
    if (result === "done") return void humanDeliver(db, actor, input);
    const c = checkHumanCant(db, actor, input);
    if (!c.gate.ok) throw new LedgerError(c.gate.code, c.gate.reason);
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    const status = e.code === "forbidden" ? 403 : e.code === "invalid" ? 400 : 409;
    throw new AskRejected(status, `assign_${e.code}`, e.message);
  }
}

/** 答案落库之后（onAssignedAnswer）：给 task.pm 发固定模板，开了班子的「完成」由班子路由通知、这里不发。ask 只结案一次，这里也只跑一次 */
export async function noticeAssignedAnswer(d: HumanNodeDeps, ask: AssignedAsk, answer: AssignedAnswer): Promise<boolean> {
  const db = d.db();
  const result = resultOfChoices(answer.choices);
  const task = db && ask.taskId && isHumanNodeAsk(ask) ? getTask(db, ask.taskId) : null;
  if (!db || !result || !task || task.project !== ask.project) return false;
  if (result === "done" && projectHasTeam(db, task.project)) return false;
  await d.notifyPm(task, pmNotice(task, result), ask.id);
  return true;
}

/** 凭据算作哪些 assignee：本机 guest → 名下全部 person id（合并过的设备都看得见、答得了指给这个人的 ask）；其余只认本人 */
function assigneesOfPrincipal(principalId: string): string[] {
  const self = personIdOf(principalId);
  if (!isGuestPrincipal(principalId)) return [self];
  try {
    return personAliases(talkDb(), self);
  } catch (e) {
    console.error(`⚠️ 读 talk 的 people 表失败，指派只认这台设备本身: ${(e as Error).message}`);
    return [self];
  }
}

/** 接进 bridge（ask-entry.ts initAskWiring 调一次）：开 ask 走 createAsk（dedupKey 撞上返回已有的），作答走 prepare / onAssignedAnswer 两个钩子，通知走 notifyTaskPm */
export function initHumanNode(): () => void {
  setAskAssigneesOf(assigneesOfPrincipal);
  const deps: HumanNodeDeps = {
    db: askDbIfExists,
    openAsk: (task, p) =>
      void createAsk({
        source: "system", createdBy: HUMAN_NODE_CREATOR, kind: "assigned", project: task.project, taskId: task.id, title: p.title, context: p.context,
        options: p.options, allowText: true, assignee: p.assignee, dedupKey: p.dedupKey, blocking: true,
      }),
    cancelAsk: (id, reason) => {
      const a = closeAsk(askDb(), id, "cancelled", reason);
      if (a) publishAsk(a);
    },
    notifyPm: (task, text, askId) => notifyTaskPm(task, task.project, text, askId, "human-node"),
  };
  setPrepareAssigned((a, answer) => prepareAssignedAnswer(deps, a, answer));
  setOnAssignedAnswer(async (a, answer) => void (await noticeAssignedAnswer(deps, a, answer)));
  return startHumanNode(deps);
}
