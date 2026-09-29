/**
 * 「待你处理」到期（每分钟扫一次，asks.ts initAsks 起的计时器）。一律先记 expired、发 SSE（推送订阅者据此给 assignee / owner 推）；之后按来源：
 * - agent 发的 reply 类：通知发起方「没人批，按未批准处理」（没人点 ≠ 同意），发起方不在按 answerTarget 改投；
 * - 指派事项（assigned）：给该任务（同一项目里的）的 PM 一条固定模板「<任务号> 指派给 <assignee> 的事项已过期」（T28 §2.5 第 7 行）——不抢占、
 *   每条只发一次（expired 只会结一次）；PM 不在线就不投、不改投大总管，在线但这一下没投进去的照 sendCalm 进押后队列等它空下来；PM 据此 ask-reopen 或改派；
 * - 其余人 / 系统发起的：只有 SSE。
 */
import { t } from "../lib/i18n.js";
import { closeAsk, dueAsks, hasAsksTable, type Ask } from "../lib/ledger-asks.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { getTask } from "../lib/ledger-store.js";
import { answersGoToAgent, answerTarget, askDbIfExists, asksDeps, hhmm, publishAsk, registry, sendCalm } from "./asks.js";

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

/** 指派事项过期 → 该任务的 PM。模板固定，不带 ask 里的任何自由文本 */
async function noticeAssignedExpired(a: Ask): Promise<void> {
  const db = askDbIfExists();
  if (!db || !a.taskId) return;
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
  const due = dueAsks(db, now);
  for (const a0 of due) {
    const a = closeAsk(db, a0.id, "expired", "", now);
    if (a) await noticeExpired(a);
  }
  return due.length;
}
