/**
 * human 节点在 bridge 这边（docs 10-ledger「附：v3.2 例外」）：
 * - 定时扫台账：进入 build / fix 的 human 任务按 askPlanFor 开一条 assigned ask（dedupKey 撞上 = 这一轮这次开过了，不重复）；
 * - 指派 ask 被作答：「完成」经 ledger-human.ts 写交付并同事务推 review，「做不了」只结 ask；算数的作答给 task.pm 发固定模板，
 *   开了班子的「完成」由班子路由通知，这里不发（同一件事只发一次）。
 * 开 ask、给 PM 投递由「待你处理」注入，这里不碰 asks 表。人写的说明只进台账 data.note，发给 agent 的只有任务号和结果。
 */
import type { Database } from "bun:sqlite";
import { pmNotice, resultOfChoices, type AskPlan, type HumanResult } from "../lib/human-node.js";
import { checkHumanCant, humanDeliver, pendingAssignments, projectHasTeam, type HumanDeliverInput } from "../lib/ledger-human.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { LedgerError } from "../lib/ledger-store.js";
import { attsUsableBy, refAttsFromAsk } from "../lib/talk-atts.js";
import { OWNER_PRINCIPAL, personAliases, personIdOf } from "../lib/talk-people.js";
import { memberKey } from "../lib/talk-rooms.js";
import { meOf, selfFp, talkDb, talkPrincipals } from "./talk.js";

const TICK_MS = 5000;

/** 用得到的 ask / 作答字段（与「待你处理」的 Ask / AskAnswer 结构兼容） */
export interface AssignedAsk {
  id: string;
  taskId: string | null;
  kind: string;
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
  /** 给 task.pm 发一条不抢占的通知：PM 不在线就不投、不转投大总管 */
  notifyPm: (task: LedgerTask, text: string, askId: string) => Promise<void>;
  /** 作答的 principal → 人；默认按 talk 的 people 表解析 */
  answerer?: (principal: string) => Promise<Answerer | null>;
}

/** 扫一遍，返回这次新开的条数。opened 记本进程开过的 key，免得每轮都去撞库；重启后第一轮撞库拿回已有的，没有副作用 */
export function assignTick(d: HumanNodeDeps, opened: Set<string>): number {
  const db = d.db();
  if (!db) return 0;
  let n = 0;
  for (const { task, plan } of pendingAssignments(db)) {
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

/** 作答附的图：只收 talk 附件库里作答人自己能用的（上传者本人 / 所在房间），挂到这条 ask 上，看得见 ask 的人才看得见图 */
function linkAtts(ask: AssignedAsk, who: Answerer, atts: AssignedAnswer["atts"]): string[] {
  const shas = [...new Set((atts ?? []).filter((a) => a.kind === "talk").map((a) => a.ref))];
  const db = talkDb();
  const ok = shas.filter((sha) => attsUsableBy(db, [sha], who.keys, () => false));
  if (ok.length < shas.length) console.log(`指派事项 ${ask.id} 的作答带了 ${shas.length - ok.length} 张作答人用不了的图，已略过`);
  refAttsFromAsk(db, ok, ask.id);
  return ok;
}

type AnswerOutcome = { ok: true; result: HumanResult; notified: boolean } | { ok: false; error: string };

/** 指派 ask 被作答（「待你处理」在记下答案之后调）：写台账、通知 PM。不算数的作答（过时、不是这个人）只记日志 */
export async function handleAssignedAnswer(d: HumanNodeDeps, ask: AssignedAsk, answer: AssignedAnswer): Promise<AnswerOutcome> {
  const fail = (error: string): AnswerOutcome => {
    console.log(`指派事项 ${ask.id} 的作答没进台账：${error}`);
    return { ok: false, error };
  };
  const result = resultOfChoices(answer.choices);
  const db = d.db();
  if (ask.kind !== "assigned" || !ask.taskId || !result || !db) return fail("不是指派事项，或没点「完成 / 做不了」");
  const who = await (d.answerer ?? answererFromTalk)(answer.principal);
  if (!who) return fail(`认不出作答人 ${answer.principal}`);
  const input: HumanDeliverInput = { taskId: ask.taskId, askId: ask.id, ask, answerer: who, note: answer.text, atts: linkAtts(ask, who, answer.atts) };
  let task: LedgerTask;
  if (result === "done") {
    try {
      const r = humanDeliver(db, who.actor, input);
      if (r.duplicate) return { ok: true, result, notified: false };
      task = r.row;
    } catch (e) {
      if (e instanceof LedgerError) return fail(e.message);
      throw e;
    }
  } else {
    const c = checkHumanCant(db, who.actor, input);
    if (!c.gate.ok || !c.task) return fail(c.gate.ok ? `没有任务 ${ask.taskId}` : c.gate.reason);
    task = c.task;
  }
  if (result === "done" && projectHasTeam(db, task.project)) return { ok: true, result, notified: false };
  await d.notifyPm(task, pmNotice(task, result), ask.id);
  return { ok: true, result, notified: true };
}
