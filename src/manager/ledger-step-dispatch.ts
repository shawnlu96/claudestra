/**
 * 统一派单（T48，docs/team/collab-model.md §4）：
 *   dispatch <T> --step <步骤> --to <执行者> [--kind agent|peer]  派人（task_steps）→ 生成步骤单 → 记 dispatch 事件与投递行 → 当场投一次
 *   dispatch-sweep                                                bridge 每分钟调：失败退避重发、认回执、送达 15 分钟没回执提醒 PM
 *   dispatch-log <T>                                              这张卡的派单、送达、回执
 *   team-set --peer-pm <peer>=<agent> [--concurrency N]           对方项目 PM 的目录（lib/ledger-peer-pms.ts）
 * 通道：本机 agent 走 bridge 的 route_to_agent（同 send_to_agent）；<x>@<peer> 只发给目录里登记的对方项目 PM（POST 对方 messages）。
 * tests/ledger-step-dispatch.test.ts。
 */
import { buildDispatchOrder, isDispatchStep, DISPATCHABLE_STEPS } from "../lib/dispatch-order.js";
import {
  ackEvent, getDispatch, insertDispatch, listDispatches, markDispatch, noteAttempt, sweepAction, type DispatchRow,
} from "../lib/ledger-dispatch-log.js";
import { applyPeerPm } from "../lib/ledger-peer-pms.js";
import { strictPolicy } from "../lib/ledger-handler.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "../lib/ledger-stages.js";
import { stepPeer } from "../lib/ledger-steps.js";
import { assignStep } from "../lib/ledger-steps-write.js";
import { getEventByDedup, getMeta, getTask, LedgerError, listEvents } from "../lib/ledger-store.js";
import { appendEvent, setPeerPms } from "../lib/ledger-write.js";
import { reviewPolicy } from "../lib/review-pack.js";
import { readTextSoft, specPathFor } from "../lib/task-spec.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import { kindOf } from "./ledger-step-cmds.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 投递一张单子：ok = 对方 bridge / 本机 bridge 收下了（不等于执行者看了，那是回执） */
export type DispatchSend = (row: Pick<DispatchRow, "channel" | "target" | "seq" | "round">, text: string) => Promise<{ ok: boolean; error?: string }>;

/** 一张单子的稳定发送标识（派单编号 + 轮次）：重发不变，接收端按它只投一次（lib/delivery-dedup.ts） */
export const sendKeyOf = (row: Pick<DispatchRow, "seq" | "round">): string => `dispatch:D${row.seq}:r${row.round}`;

/** 本机执行者的名字不能带 @、不能以 peer: 开头：那是别的实例的写法，必须走 --kind peer（先脱敏、只发对方项目 PM） */
const isRemoteSpelling = (executor: string): boolean => executor.includes("@") || executor.startsWith("peer:");

/** 规则类写入（提醒 note）的记账身份，同 escalate --auto */
const RULE_ACTOR = "bridge-rule";

async function realSend(row: Pick<DispatchRow, "channel" | "target" | "seq" | "round">, text: string): Promise<{ ok: boolean; error?: string }> {
  const dedup = sendKeyOf(row);
  try {
    if (row.channel === "local") {
      if (isRemoteSpelling(row.target)) return { ok: false, error: `本机通道不收 ${row.target}：别的实例的执行者要走 peer 通道` };
      // 本机专用入口：不像 route_to_agent 那样把 x@peer 转成远程投递（bridge/dispatch-route.ts）
      const { bridgeRequest } = await import("../lib/bridge-client.js");
      await bridgeRequest({ type: "dispatch_to_agent", targetName: row.target, text, dedup });
      return { ok: true };
    }
    const at = row.target.lastIndexOf("@");
    const [agent, peerName] = [row.target.slice(0, at), row.target.slice(at + 1)];
    const { findHttpPeer } = await import("../lib/peers.js");
    const peer = await findHttpPeer(peerName);
    if (!peer?.outToken || !peer.baseUrl) return { ok: false, error: `peer ${peerName} 不存在或握手未完成` };
    const { peerCliFetch } = await import("./relay.js");
    const url = `${peer.baseUrl.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(agent)}/messages`;
    // nonce：重发同一张单子时签名也不同，对方不当重放；dedup：稳定标识，对方按它只投一次（bridge/api-dedup.ts）
    const body = JSON.stringify({ text, wait: 0, nonce: crypto.randomUUID(), dedup });
    const res = await peerCliFetch(url, { method: "POST", headers: { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
    return res.ok ? { ok: true } : { ok: false, error: `对方回 ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

const sendOf = (c: LedgerCli): DispatchSend => c.deps.dispatchSend ?? realSend;

/**
 * 本轮审查报告全文（修 / 审的单子附上，specRev 3）：最近一条 review 事件的正文与结论 md，加上同一审查方在这一轮写的 note——
 * 报告写在 review 事件里还是 note 里、是本机还是 peer 写的都收。这一轮 = 那条 review 之前最近一次交付之后。
 */
function roundReport(events: readonly LedgerEvent[]): string | null {
  const r = events.findLast((e) => e.kind === "review");
  if (!r) return null;
  const since = events.findLast((e) => e.kind === "deliver" && e.seq < r.seq)?.seq ?? 0;
  const d = r.data;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const md = readTextSoft(typeof d.path === "string" && d.path ? d.path : null);
  const notes = events.filter((e) => e.kind === "note" && e.actor === r.actor && e.seq > since).map((e) => e.text);
  const head = `结论：${String(d.verdict ?? "?")}（P0 ${n(d.p0)} / P1 ${n(d.p1)} / P2 ${n(d.p2)}），审查方 ${r.actor}`;
  return [head, r.text, ...(md ? [md] : []), ...notes].filter((s) => s.trim()).join("\n\n");
}

/** 执行者 → 通道与收件人；peer 没登记对方项目 PM 就拒 */
function channelFor(c: LedgerCli, task: LedgerTask, executor: string, kind: "agent" | "peer"): Pick<DispatchRow, "channel" | "target"> {
  if (kind === "agent") return { channel: "local", target: executor };
  const peer = stepPeer({ executor, executorKind: "peer" });
  const pm = peer ? getMeta(c.db, task.project).peerPms[peer] : undefined;
  if (!peer || !pm) throw new LedgerError("invalid", `项目 ${task.project} 没登记 ${peer ?? executor} 的项目 PM：先 ledger team-set --peer-pm ${peer ?? "<peer>"}=<对方 PM 的 agent 名>`);
  return { channel: "peer", target: `${pm.agent}@${peer}` };
}

/**
 * --step 派单的去重键（同 ledger-dispatch-cmds.ts dispatchKey 的思路）：默认「卡 / 步骤 / 执行者 / 轮次」，--dedup 可覆盖。
 * 这一步最近一次派单就是这个键（含改派回来加的 :s 后缀）→ 重复；键用过、但之后改派过别人 → 另起 `:s<上一次 seq>`，算新的一次。
 * 显式 --dedup 用过就是重复（调用方明说是同一次）。在派人之前判，重复时步骤结果一概不动（T48 P2-2）
 */
function stepDispatchKey(c: LedgerCli, events: readonly LedgerEvent[], taskId: string, step: string, to: string, round: number): { key: string } | { duplicate: LedgerEvent } {
  const base = c.p.flags.dedup ?? `step-dispatch:${taskId}:${step}:${to}:r${round}`;
  const last = events.findLast((e) => e.kind === "dispatch" && e.data.step === step);
  if (last?.dedupKey && (last.dedupKey === base || last.dedupKey.startsWith(`${base}:s`))) return { duplicate: last };
  const used = getEventByDedup(c.db, base);
  if (used && c.p.flags.dedup !== undefined) return { duplicate: used };
  return { key: used ? `${base}:s${last?.seq ?? 0}` : base };
}

async function stepDispatch(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  const step = c.p.flags.step ?? "";
  const to = c.p.flags.to ?? "";
  if (!isDispatchStep(step)) throw new LedgerError("invalid", `--step 只能是 ${DISPATCHABLE_STEPS.join(" / ")}（合并部署、核对不出任务单）`);
  if (!to) throw new LedgerError("invalid", "缺 --to <执行者>");
  c.requireManager(task.project, "派单");
  const kind = kindOf(c, to);
  if (kind === "human") throw new LedgerError("invalid", "人不收步骤单：派给 agent 或别的实例");
  if (kind === "agent" && isRemoteSpelling(to)) throw new LedgerError("invalid", `本机执行者不能写成 ${to}：别的实例写 <agent>@<peer> 并带 --kind peer`);
  const route = channelFor(c, task, to, kind);
  const now = c.deps.now();
  const round = intFlag(c.p, "round") ?? task.round;
  let events = listEvents(c.db, { project: task.project, target: task.id });
  // 去重先于派人：同一张卡、同一步、同一个执行者、同一轮重跑，原样返回上一次，不重置步骤结果、不再发
  const key = stepDispatchKey(c, events, task.id, step, to, round);
  if ("duplicate" in key) return { ok: true, duplicate: true, event: key.duplicate, log: getDispatch(c.db, key.duplicate.seq) };
  assignStep(c.db, { actor: c.deps.actor, now }, { taskId: task.id, step, executor: to, executorKind: kind, round });
  events = listEvents(c.db, { project: task.project, target: task.id });
  const peer = kind === "peer" ? stepPeer({ executor: to, executorKind: "peer" }) : null;
  const accepted = !peer || events.some((e) => e.kind === "accept" && e.data.peer === peer);
  const specText = readTextSoft(specPathFor(task, getMeta(c.db, task.project).docsDir));
  const review = step === "review" || step === "final_review";
  // 审查类派单沿用派审事件的字段（reviewer / round / head / policy）：合并门与「下一轮是什么」按最近一条 dispatch 判（ledger-handler.ts）
  const reviewData = review ? { reviewer: step === "final_review" ? "adversarial" : "regular", policy: strictPolicy(reviewPolicy(specText), events) } : {};
  const data = { step, to, channel: route.channel, target: route.target, round, head: task.headSHA, ...reviewData };
  const ev = appendEvent(c.db, { ...c.ctx(), now, dedupKey: key.key }, { project: task.project, target: task.id, kind: "dispatch", text: `派单：${step} → ${to}`, data });
  const order = buildDispatchOrder({
    task: { id: task.id, title: task.title, pr: task.pr, headSHA: task.headSHA }, step, dispatchId: ev.event.seq, round,
    toPeer: route.channel === "peer", accepted, spec: specText, report: step === "fix" || review ? roundReport(events) : null,
  });
  insertDispatch(c.db, { seq: ev.event.seq, taskId: task.id, project: task.project, step, round, executor: to, ...route, text: order.text, createdAt: now });
  const sent = await sendOf(c)({ ...route, seq: ev.event.seq, round }, order.text);
  noteAttempt(c.db, ev.event.seq, c.deps.now(), sent.ok, sent.error ?? null);
  return { ok: true, event: ev.event, delivered: sent.ok, ...(sent.error ? { error: sent.error } : {}), redactions: order.redactions, text: order.text };
}

/** 提醒 PM 的话：只用台账里的字段拼，不带单子正文 */
function reminderText(row: DispatchRow, kind: "remind" | "fail_alert"): string {
  const what = `${row.taskId}/${row.step} → ${row.executor}（派单 D${row.seq}，经 ${row.target}）`;
  return kind === "remind"
    ? `【派单没回执】${what} 送达 15 分钟了，执行者还没在卡上写任何东西：考虑改派（ledger dispatch ${row.taskId} --step ${row.step} --to <别人>）`
    : `【派单送不出去】${what} 已连着失败 ${row.attempts} 次（${row.lastError ?? "原因不明"}），仍在按小时重试：对方离线就考虑改派`;
}

async function sweep(c: LedgerCli): Promise<Result> {
  if (c.deps.actor !== "owner" && c.deps.actor !== "master") throw new LedgerError("forbidden", "dispatch-sweep 只由 bridge 定时调用");
  const notices: { taskId: string; pm: string | null; project: string; text: string }[] = [];
  const counts = { sent: 0, failed: 0, acked: 0, stopped: 0 };
  const all = listDispatches(c.db);
  for (const row of all) {
    const task = getTask(c.db, row.taskId);
    const events = listEvents(c.db, { project: row.project, target: row.taskId });
    const superseded = events.some((e) => e.kind === "dispatch" && e.seq > row.seq && e.data.step === row.step);
    const now = c.deps.now();
    const a = sweepAction(row, now, ackEvent(row, events), superseded, !task || TERMINAL_STAGES.includes(task.stage));
    if (a.kind === "ack") (markDispatch(c.db, row.seq, "ackAt", a.at), counts.acked++);
    else if (a.kind === "stop") (markDispatch(c.db, row.seq, "stoppedAt", now), counts.stopped++);
    else if (a.kind === "send") {
      const r = await sendOf(c)(row, row.text);
      noteAttempt(c.db, row.seq, c.deps.now(), r.ok, r.error ?? null);
      counts[r.ok ? "sent" : "failed"]++;
    } else if (a.kind === "remind" || a.kind === "fail_alert") {
      const text = reminderText(row, a.kind);
      appendEvent(c.db, { actor: RULE_ACTOR, now, dedupKey: `dispatch-${a.kind}:${row.seq}` }, { project: row.project, target: row.taskId, kind: "note", text });
      markDispatch(c.db, row.seq, a.kind === "remind" ? "remindedAt" : "failAlertAt", now);
      notices.push({ taskId: row.taskId, project: row.project, pm: task?.pm ?? getMeta(c.db, row.project).pms[0] ?? null, text });
    }
  }
  return { ok: true, open: all.length, ...counts, notices };
}

function dispatchLog(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const rows = listDispatches(c.db, task.id).map(({ text: _t, ...r }) => r);
  return { ok: true, task: task.id, dispatches: rows };
}

function teamSet(c: LedgerCli): Result {
  const project = c.project();
  c.requireManager(project, "登记对方项目 PM");
  const flag = c.p.flags["peer-pm"];
  if (!flag) throw new LedgerError("invalid", "用法：team-set --peer-pm <peer>=<agent> [--concurrency N]（agent 留空 = 删除）");
  let next;
  try {
    next = applyPeerPm(getMeta(c.db, project).peerPms, flag, intFlag(c.p, "concurrency"));
  } catch (e) {
    throw new LedgerError("invalid", (e as Error).message);
  }
  const r = setPeerPms(c.db, c.ctx(), project, next);
  return { ok: true, project, peerPms: r.row, event: r.event, duplicate: r.duplicate };
}

/** `dispatch` 带 --step 时由这里接（manager/ledger-dispatch-cmds.ts 一行转过来）；不带仍是原来的派审 */
export const stepDispatchOf = (c: LedgerCli): Promise<Result> | null => (c.p.flags.step !== undefined ? stepDispatch(c) : null);

export const STEP_DISPATCH_CMDS: Record<string, CommandSpec> = {
  "dispatch-sweep": { valued: [], usage: "dispatch-sweep（bridge 每分钟调：重发、认回执、超时提醒）", run: sweep },
  "dispatch-log": { valued: ["project"], usage: "dispatch-log <task>（派单、送达、回执）", run: dispatchLog },
  "team-set": { valued: ["project", "peer-pm", "concurrency", "dedup"], usage: "team-set --peer-pm <peer>=<agent> [--concurrency N]（对方项目 PM 的目录）", run: teamSet },
};
