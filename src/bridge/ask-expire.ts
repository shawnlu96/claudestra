/**
 * 「待你处理」到期（每分钟扫一次，asks.ts initAsks 起的计时器）。一律先记 expired、发 SSE（推送订阅者据此给 assignee / owner 推）；之后按来源：
 * - agent 发的 reply 类：通知发起方「没人批，按未批准处理」（没人点 ≠ 同意），发起方不在按 answerTarget 改投；
 * - 指派事项（assigned）：给该任务（同一项目里的）的 PM 一条固定模板「<任务号> 指派给 <assignee> 的事项已过期」（T28 §2.5 第 7 行）——不抢占、
 *   每条只发一次（expired 只会结一次）；PM 不在线就不投、不改投大总管，在线但这一下没投进去的照 sendCalm 进押后队列等它空下来；PM 据此 ask-reopen 或改派；
 * - 其余人 / 系统发起的：只有 SSE。
 * 扫完再看过期的要不要再提示一次（lib/ask-recovery.ts）：策略 port 没接上（等 CFG）时是 observe，只记一次日志、不开卡；
 * 开出的卡发 SSE / 告诉发起方按台账里的 remindNotice 待办来，没发完的（批里别条出错、重启）下一分钟补；补发同样要策略 on、没暂停、owner 活跃，
 * 不满足就留着待办等（off / observe / 没证据时不推、不告诉发起方 owner 在线）。
 */
import { isHumanNodeAsk } from "../lib/human-node.js";
import { t } from "../lib/i18n.js";
import { markReminderNoticed, noticeBlocker, pendingReminderNotices, sweepReminders, type ReminderPorts } from "../lib/ask-recovery.js";
import { closeAsk, dueAsks, hasAsksTable, type Ask } from "../lib/ledger-asks.js";
import { isCurrentAssignment } from "../lib/ledger-human.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { getTask } from "../lib/ledger-store.js";
import { sweepAskDefaults } from "../lib/order-ask-default.js";
import { answersGoToAgent, answerTarget, askDbIfExists, asksDeps, hhmm, ownerPresence, publishAsk, registry, sendCalm } from "./asks.js";
import { tellAsker } from "./ask-default-tell.js";
import { sendLedgerNotice } from "./team-router.js";

/** 刚结成 expired 的一条（sweep 或作答时才发现到点）：发 SSE，再按来源通知 */
export async function noticeExpired(a: Ask): Promise<void> {
  publishAsk(a);
  if (a.kind === "assigned") return noticeAssignedExpired(a);
  if (a.source !== "reply" || !answersGoToAgent(a) || !asksDeps()) return;
  const to = await answerTarget(a);
  // 发起方和派发者都不在、只能落到大总管的不发：被 kill 的 agent 留下的一堆过期 ask 不该刷大总管
  if (to.redirected === "master") return;
  const got = a.answer?.labels.length ? t(`其中已答：${a.answer.labels.join("；")}；没答的部分`, `Answered so far: ${a.answer.labels.join("; ")}; the rest`) : "";
  const whose = to.redirected ? t(`${a.fromAgent}（已不在，改投给你）`, `${a.fromAgent} (gone — redirected to you)`) : t("你", "Your");
  const text = t(
    `[⌛ ${whose} ${hhmm(a.createdAt)} 发的「待你处理」（${a.id}）：${a.title} —— 到期没人处理。${got}按未批准处理，不要当成同意。还需要就重新问。]`,
    `[⌛ ${whose} ${hhmm(a.createdAt)} ask (${a.id}): ${a.title} expired. ${got} treat as NOT approved. Ask again if still needed.]`,
  );
  await sendCalm({ kind: "bridge", label: "ask-expire" }, to, "notification", text, a.id, "bridge_synth");
}

/** 指派事项过期 → 该任务的 PM。模板固定，不带 ask 里的任何自由文本；human 节点开的、已不是任务眼下那条的（改派、交付过、重开过）不发 */
async function noticeAssignedExpired(a: Ask): Promise<void> {
  const db = askDbIfExists();
  if (!db || !a.taskId) return;
  if (isHumanNodeAsk(a) && !isCurrentAssignment(db, a)) return console.log(`指派事项 ${a.id} 过期时已不是 ${a.taskId} 眼下的指派，不通知 PM`);
  const text = t(`[⌛ ${a.taskId} 指派给 ${a.assignee} 的事项已过期（${a.id}）]`, `[⌛ ${a.taskId}: the item assigned to ${a.assignee} expired (${a.id})]`);
  await notifyTaskPm(getTask(db, a.taskId), a.project, text, a.id, "ask-expire");
}

/**
 * 给任务的 PM（台账 task.pm，存的是去掉 agent- 前缀的名字）发一条不抢占的固定模板：指派过期、人工交付的结果（bridge/human-node.ts）共用。
 * PM 不在线就不投、不改投大总管；在线但这一下没投进去的照 sendCalm 进押后队列等它空下来
 */
export async function notifyTaskPm(task: LedgerTask | null, project: string, text: string, askId: string, label: string): Promise<void> {
  const d = asksDeps();
  const pm = task?.project === project ? task.pm : null; // 手填了别的项目的任务号：不发给那边的 PM
  if (!d || !pm) return;
  const reg = (await registry()).find((r) => (r.name === pm || r.name === `agent-${pm}`) && r.status === "active" && r.channelId);
  if (!reg?.channelId || !d.clients.has(reg.channelId)) return console.log(`指派事项 ${askId} 的通知：PM ${pm} 不在线，不投`);
  await sendCalm({ kind: "bridge", label }, { channelId: reg.channelId, agentName: reg.name }, "notification", text, askId, "bridge_synth");
}

/** 到期的一律 expired；库还不存在就什么都不做（不建库） */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const db = askDbIfExists();
  if (!db || !hasAsksTable(db)) return 0;
  await sweepAskDefaults(db, now, { publish: publishAsk, notify: (to, text, messageId) => sendLedgerNotice({ to, text, messageId }), tell: tellAsker }); // 不抛
  const due = dueAsks(db, now);
  for (const a0 of due) {
    const a = closeAsk(db, a0.id, "expired", "", now);
    if (a) await noticeExpired(a);
  }
  await remindAfterSweep(db, now);
  return due.length;
}

/** 默认 port：owner 在不在只认网页心跳 / 人类动作（bridge 重启后是 away → 等）；发起方在不在只认它此刻连着；策略缺 = observe */
const DEFAULT_PORTS: ReminderPorts = {
  ownerActive: () => (ownerPresence.state() === "active" ? { active: true, evidence: "web heartbeat / owner action" } : { active: false, evidence: "presence away" }),
  askerLive: (a) => !!a.fromChannelId && !!asksDeps()?.clients.has(a.fromChannelId),
};
let reminderPorts: ReminderPorts = DEFAULT_PORTS;
const observed = new Set<string>();
/** 通知待办被闸住的日志每条每个理由只记一次（off / observe 时每分钟都会过一遍） */
const held = new Set<string>();

/** 组合接线（CFG 的 recoveryPolicy 等）与单测换 port；undefined 还原默认 */
export function setAskReminderPorts(p: Partial<ReminderPorts> | undefined): void {
  reminderPorts = p ? { ...DEFAULT_PORTS, ...p } : DEFAULT_PORTS;
  observed.clear();
  held.clear();
}

let reminding: Promise<void> | null = null;

/** 同一进程里上一轮还没跑完（port 慢）就不叠一轮，免得同一条待办通知发两遍 */
function remindAfterSweep(db: Parameters<typeof sweepReminders>[0], now: number): Promise<void> {
  reminding ??= runReminders(db, now).finally(() => (reminding = null));
  return reminding;
}

async function runReminders(db: Parameters<typeof sweepReminders>[0], now: number): Promise<void> {
  const res = await sweepReminders(db, reminderPorts, now).catch((e: Error) => (console.error(`⚠️ 过期再提示扫描失败（下一分钟再扫）: ${e.message}`), []));
  for (const r of res) {
    if (r.result === "observe" && !observed.has(r.id)) {
      observed.add(r.id);
      console.log(`[askReminder observe] ${r.id} 满足再提示条件（${r.evidence}），observe 模式不开卡`);
    }
  }
  // 这一轮开出的和以前没发完的一起：台账里的待办才算数，「卡已存在」不等于「通知已发」；补发也过闸，不满足就留着等
  for (const n of pendingReminderNotices(db)) {
    try {
      const why = await noticeBlocker(n, reminderPorts, now);
      if (why) {
        if (!held.has(`${n.id}:${why}`)) console.log(`[askReminder] ${n.id} 的通知待办先不发（${why}），卡已在收件箱，满足了再补`);
        held.add(`${n.id}:${why}`);
        continue;
      }
      publishAsk(n);
      await noticeReminded(n, String(n.extra.recoveryOf));
      markReminderNoticed(db, n.id, now);
    } catch (e) {
      console.error(`⚠️ 再提示通知没发完（${n.id}，卡已开，下一分钟补）: ${(e as Error).message}`);
    }
  }
}

/** 告诉发起方：原卡仍按未批准，新卡是新 id（授权类新 hash），答复照常回给它；落到大总管的不发（同 noticeExpired） */
async function noticeReminded(r: Ask, origId: string): Promise<void> {
  if (!answersGoToAgent(r) || !asksDeps()) return;
  const to = await answerTarget(r);
  if (to.redirected === "master") return;
  const check = r.bind ? t(`；执行前对新 id 跑 ask-check，旧 id 永远不算批准`, `; run ask-check against the new id before executing — the old id never counts as approved`) : "";
  const text = t(
    `[🔁 ${origId}「${r.title}」已过期、按未批准处理；owner 在线，已按原内容再提示一次：新卡 ${r.id}${check}。答复照常回给你，别重复执行。]`,
    `[🔁 ${origId} "${r.title}" expired and stays NOT approved; the owner is active, so it was re-asked once as ${r.id}${check}. The answer comes back as usual — do not execute twice.]`,
  );
  await sendCalm({ kind: "bridge", label: "ask-remind" }, to, "notification", text, r.id, "bridge_synth");
}
