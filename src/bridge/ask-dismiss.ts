/**
 * 「待你处理」卡上的删除（T61）：POST /ledger/:project/asks/:id/dismiss，只给 owner 本人的全权设备（和开 ask 同一道门）。
 * - 开着的 agent 发起的（reply）：撤销，记「owner 删掉，未作答」（extra.dismissed），告诉发起方没作答；authorize 一并说按未批准处理
 *   ——ledger ask-check 对非 answered 的一律判不批准，撤了天然就是不批准；
 * - 开着的运行时弹框（AUQ / 权限 / Codex）：只收起，绝不往终端发键；这条带指纹，弹框还在时重启也不再冒出来（ask-runtime.ts）；
 * - 开着的指派 / 人 / 系统发起的：撤销；指派事项告诉该任务的 PM；
 * - 已结案的：从列表隐藏（extra.hidden），台账记录不动。
 * 单测 tests/ask-dismiss.test.ts。
 */
import { canSeeAsk } from "../lib/ask-access.js";
import { canReadLedger } from "../lib/devices.js";
import { t } from "../lib/i18n.js";
import { closeAsk, getAsk, patchAsk, type Ask } from "../lib/ledger-asks.js";
import { getTask } from "../lib/ledger-store.js";
import { isOwnerPrincipal, type Principal } from "../lib/principals.js";
import { apiJson, forbidden } from "./api-respond.js";
import { notifyTaskPm } from "./ask-expire.js";
import { answersGoToAgent, answerTarget, askDb, asksDeps, hhmm, publishAsk, sendCalm } from "./asks.js";

import { cancelSharedAsk, readSharedAsk, sharedAskError } from "./shared-ledger-v2-asks.js";
const DISMISS_REASON = t("owner 删掉，未作答", "deleted by the owner, unanswered");

export async function dismissFromCard(project: string, id: string, p: Principal): Promise<Response> {
  if (!isOwnerPrincipal(p) || !canReadLedger(p)) return forbidden("only the owner (full-access device) can delete an ask");
  const db = askDb();
  let a = getAsk(db, id);
  if (!a || a.project !== project || !canSeeAsk(p, a)) return apiJson(404, { ok: false, error: `ask "${id}" not found in "${project}"` });
  try { a = await readSharedAsk(a, p.id); } catch (e) {
    const error = sharedAskError(e); if (error) return apiJson(error.status, { ok: false, ...error }); throw e;
  }
  const mark = { by: p.id, at: Date.now() };
  if (a.state !== "open") {
    patchAsk(db, id, { extra: { hidden: mark } });
    const out = { ...getAsk(db, id)!, state: a.state, answer: a.answer };
    publishAsk(out);
    return apiJson(200, { ok: true, ask: out });
  }
  let shared: Ask | null;
  try { shared = await cancelSharedAsk(a, DISMISS_REASON, p.id); } catch (e) {
    const error = sharedAskError(e); if (error) return apiJson(error.status, { ok: false, ...error }); throw e;
  }
  if (shared) patchAsk(db, id, { extra: { dismissed: mark } });
  const out = shared ?? closeAsk(db, id, "cancelled", DISMISS_REASON, mark.at, { dismissed: mark });
  if (!out) return apiJson(409, { ok: false, code: "ask_closed", error: t("这件刚结案了", "Just closed") });
  publishAsk(out);
  await noticeDismissed(out).catch((e) => console.error(`⚠️ 删卡通知发起方失败（${id}，卡已撤）: ${(e as Error).message}`));
  return apiJson(200, { ok: true, ask: out });
}

/**
 * 撤掉之后：去掉 Discord 原消息的按钮；agent 发起的告诉发起方（落到大总管的不发，和过期同一个规矩）；指派告诉任务 PM。
 * 改 Discord 是展示层，失败（原消息删了、没权限、连不上）只记日志，不能挡住告诉发起方（tests/ask-dismiss.test.ts）
 */
async function noticeDismissed(a: Ask): Promise<void> {
  const d = asksDeps();
  if (a.discordMessageIds.length) {
    try {
      await d?.editDiscord?.(a, t("已删除，未作答", "Deleted, unanswered"));
    } catch (e) {
      console.error(`⚠️ 删卡后改 Discord 原消息失败（${a.id}，通知照发）: ${(e as Error).message}`);
    }
  }
  if (a.kind === "assigned") {
    if (!a.taskId) return;
    const text = t(`[🗑 ${a.taskId} 指派给 ${a.assignee} 的事项被 owner 删掉了（${a.id}）]`, `[🗑 ${a.taskId}: the item assigned to ${a.assignee} was deleted by the owner (${a.id})]`);
    return notifyTaskPm(getTask(askDb(), a.taskId), a.project, text, a.id, "ask-dismiss");
  }
  if (a.source !== "reply" || !answersGoToAgent(a) || !d) return;
  const to = await answerTarget(a);
  if (to.redirected === "master") return;
  const whose = to.redirected ? t(`${a.fromAgent}（已不在，改投给你）`, `${a.fromAgent} (gone — redirected to you)`) : t("你", "Your");
  const denied = a.kind === "authorize" ? t("按未批准处理，不要当成同意。", "Treat as NOT approved. ") : "";
  const text = t(
    `[🗑 owner 删掉了${whose} ${hhmm(a.createdAt)} 发的「待你处理」（${a.id}）：${a.title} —— 没作答。${denied}还需要就重新问。]`,
    `[🗑 The owner deleted ${whose} ${hhmm(a.createdAt)} ask (${a.id}): ${a.title} — unanswered. ${denied}Ask again if still needed.]`,
  );
  await sendCalm({ kind: "bridge", label: "ask-dismiss" }, to, "notification", text, a.id, "bridge_synth");
}
