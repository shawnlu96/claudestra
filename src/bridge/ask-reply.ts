/**
 * agent 的 reply → 「待你处理」（docs 13 §4.3）。bridge.ts 的 ws reply 处理只调 deliverReplyWithAsk 这一个：
 * - 隐式（三期）：带选项、发给 owner 的自动建 ask（kind=decide、blocking 未知）；
 * - 显式（四期）：reply 带 `ask` 字段（lib/ask-bind.ts 校验）。声明了就建，哪怕没有按钮；kind=inform 不建 ask、这条回复不推送；
 *   authorize 带绑定（参数哈希回给 agent，执行前 ledger ask-check）；同一个 agent 同一个 key 再问，旧的 superseded。
 *   带绑定的挂 bind 里写明的任务（i28-ASKID1），不挂发起方当前在做的卡。
 * `ask` 字段不合格整条 reply 退回给 agent（Delivery dropped + 原因），不猜、不静默丢。建 ask 出错不挡回复本身。
 */
import { bindHash, bindTaskTarget, missingApprove, parseReplyAsk, type ReplyAsk } from "../lib/ask-bind.js";
import { withBindSummary, withBindSummaryText } from "../lib/ask-bind-render.js";
import { draftFromReply, type AskRow, type ReplyAskDraft } from "../lib/ask-options.js";
import { closeAsk, getAsk, openAskFull, patchAsk, supersedeOlder, type Ask, type NewAsk } from "../lib/ledger-asks.js";
import { getTask } from "../lib/ledger-store.js";
import { markdownToPlain } from "../lib/plain-text.js";
import { askDb, askReadDb, parentExtra, publishAsk, taskOf, toOwner, whoIs, type Who } from "./asks.js";
import { cancelSharedAsk, openSharedAsk, sharedAskError, supersedeSharedAsks } from "./shared-ledger-v2-asks.js";
import { copyOutboundToInbox } from "./local-api/media-refresh.js";
import type { Delivery, Envelope } from "./router.js";

/** 知会类回复的 threadId：推送派发器据此不推（push/init.ts 接 isQuietReply）。只记最近的，10 分钟后忘掉 */
const quiet = new Map<string, number>();
const QUIET_TTL_MS = 10 * 60_000;

export function isQuietReply(threadId: unknown): boolean {
  const at = typeof threadId === "string" ? quiet.get(threadId) : undefined;
  return at !== undefined && Date.now() - at < QUIET_TTL_MS;
}

function markQuiet(threadId: string): void {
  const now = Date.now();
  for (const [k, at] of quiet) if (now - at >= QUIET_TTL_MS) quiet.delete(k);
  quiet.set(threadId, now);
}

/** 显式 ask 没有按钮时也要有标题和背景：和隐式同一个取法（正文首行 / 其余） */
function draftOf(text: string, components: unknown, explicit: boolean): ReplyAskDraft | null {
  const d = draftFromReply(text, components);
  if (d || !explicit) return d;
  const lines = markdownToPlain(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const title = Array.from(lines[0] ?? "待你处理").slice(0, 40).join("");
  return { title, context: lines.slice(1).join("\n").slice(0, 300), options: [], kindHint: null };
}

const optionIds = (rows: AskRow[]) => new Set(rows.flatMap((r) => (r.type === "buttons" ? r.buttons.map((b) => b.id) : [r.id])));

/** 显式字段 → openAsk 的那几列；授权类的 approve 按钮不在选项里 → 错误句 */
function explicitColumns(x: ReplyAsk, draft: ReplyAskDraft, fromAgent: string, now: number): Partial<NewAsk> | string {
  const cols: Partial<NewAsk> = { kind: x.kind === "inform" ? "decide" : x.kind };
  if (x.bind) {
    const missing = missingApprove(x.bind, optionIds(draft.options));
    if (missing.length) return `ask.bind.approve lists button id(s) not in this reply: ${missing.join(", ")}`;
    cols.bind = { ...x.bind, paramsHash: bindHash(x.bind, fromAgent) };
  }
  const key = x.key ?? (x.kind === "authorize" ? x.bind?.action : undefined);
  if (key) cols.askKey = key;
  cols.blocking = x.blocking ?? (x.kind === "authorize" || x.kind === "owner_action" ? true : null);
  if (x.expiresIn) cols.expiresAt = now + x.expiresIn * 1000;
  // 三句背景（docs 13 §4.2）：agent 写了 why / ifIgnored 就用它的，否则取正文
  if (x.why || x.ifIgnored) cols.context = [x.why, x.ifIgnored ? `不处理会怎样：${x.ifIgnored}` : ""].filter(Boolean).join("\n");
  if (cols.bind) cols.context = withBindSummary(cols.bind, cols.context ?? draft.context); // 系统生成的「批准的就是这个」固定在最前（i28-OA1）
  return cols;
}

/**
 * ask 挂哪张卡（i28-ASKID1）：带授权绑定的只认 bind 里写明的任务（bindTaskTarget），不是本项目台账里的卡就拒；没写任务的不挂卡、不猜。
 * 不带绑定的照旧挂发起方当前在做的卡（taskOf）。
 */
function askTaskId(x: ReplyAsk | undefined, who: Who): { taskId: string | null } | { error: string } {
  if (!x?.bind) return { taskId: taskOf(who.name) };
  const t = bindTaskTarget(x.bind);
  if ("error" in t || t.taskId === null) return t;
  const db = askReadDb();
  const task = db ? getTask(db, t.taskId) : null;
  if (!task) return { error: `ask.bind.params names task ${t.taskId}, which is not in this ledger` };
  if (task.project !== who.project) return { error: `task ${t.taskId} belongs to project ${task.project}, not ${who.project} — authorize only tasks of your own project` };
  return t;
}

type Opened = { ask: Ask | null; error?: string };

async function openAskForReply(env: Envelope, chatId: string, fromChannelId: string, raw: unknown): Promise<Opened> {
  let explicit: ReplyAsk | undefined;
  if (raw !== undefined && raw !== null) {
    const p = parseReplyAsk(raw);
    if ("error" in p) return { ask: null, error: p.error };
    explicit = p.ask;
    if (explicit.kind === "inform") {
      markQuiet(env.meta.threadId);
      return { ask: null };
    }
  }
  const draft = draftOf(env.content, env.meta.components, !!explicit);
  if (!draft || !(await toOwner(chatId))) return { ask: null };
  const who = await whoIs(fromChannelId);
  if (!who) return { ask: null };
  const now = Date.now();
  const cols = explicit ? explicitColumns(explicit, draft, who.name, now) : {};
  if (typeof cols === "string") return { ask: null, error: cols };
  const target = askTaskId(explicit, who);
  if ("error" in target) return { ask: null, error: target.error };
  const input: NewAsk = {
    project: who.project, taskId: target.taskId, fromAgent: who.name, fromChannelId, source: "reply", kind: "decide", blocking: null,
    title: draft.title, context: draft.context, body: env.content, options: draft.options, kindHint: draft.kindHint, chatId, threadId: env.meta.threadId,
    ...parentExtra(who), ...cols,
  };
  const shared = await openSharedAsk(input, now);
  if (shared) return { ask: shared };
  const r = openAskFull(askDb(), input, now, { deferSupersede: true });
  publishAsk(r.ask);
  return { ask: r.ask };
}

type CopyFiles = (paths: string[], agent: string) => Promise<{ name: string; attachment: string }[]>;

/**
 * 卡片上列的附件（inbox 里的副本名）：投给网页的 reply 已由 bridge.ts 拷好（sentFiles）；投到 Discord 频道的只上传给 Discord、
 * 不进 inbox，这里补拷一份，卡片才打得开。拷失败的那个跳过（copyOutboundFiles 自己记日志）
 */
async function cardFiles(env: Envelope, agent: string, copy: CopyFiles): Promise<{ name: string; attachment: string }[]> {
  if (env.meta.sentFiles) return env.meta.sentFiles;
  return env.meta.files?.length ? copy(env.meta.files, agent) : [];
}

/**
 * 带选项（或显式 ask）、发给 owner 的先建 ask，askId / 参数哈希进 env.meta（出站事件带给网页，reply 结果回给 agent）；
 * 投递成功补记 Discord 消息 id、作废同 key 的旧 ask；失败把新的撤掉（旧的不动）。
 */
export async function deliverReplyWithAsk(
  env: Envelope, chatId: string, fromChannelId: string, send: (e: Envelope) => Promise<Delivery>, rawAsk?: unknown, copy: CopyFiles = copyOutboundToInbox,
): Promise<Delivery> {
  let a: Ask | null = null;
  try {
    const o = await openAskForReply(env, chatId, fromChannelId, rawAsk);
    if (o.error) return { envelope: env, outcome: { kind: "dropped", reason: `invalid ask field: ${o.error}` } };
    a = o.ask;
  } catch (e) {
    const shared = sharedAskError(e);
    if (shared) {
      if (shared.code === "unavailable") {
        // Preserve the transport outcome so a delivered explanation is not retried as a dropped reply.
        const delivered = await send({ ...env, meta: { ...env.meta, components: undefined, askId: undefined, askHash: undefined } });
        if (delivered.outcome.kind === "sent") {
          return { ...delivered, outcome: { ...delivered.outcome, note: [delivered.outcome.note, "askRefused: unavailable"].filter(Boolean).join("; ") } };
        }
        return delivered;
      }
      return { envelope: env, outcome: { kind: "dropped", reason: shared.code } };
    }
    console.error(`⚠️ reply 自动建 ask 失败（回复照发）: ${(e as Error).message}`);
  }
  if (a) {
    env.meta.askId = a.id;
    if (a.bind) {
      env.meta.askHash = a.bind.paramsHash;
      env.content = withBindSummaryText(a.bind, env.content); // 投出去的那条（owner 点按钮处）最前面也是系统那段（i28-OA1）
    }
  }
  const d = await send(env);
  if (!a) return d;
  try {
    if (d.outcome.kind === "sent") {
      const files = await cardFiles(env, a.fromAgent ?? "?", copy);
      patchAsk(askDb(), a.id, { discordMessageIds: d.outcome.discordMessageIds ?? [], ...(files.length ? { extra: { files } } : {}) });
      const withFiles = files.length ? getAsk(askDb(), a.id) : null;
      if (withFiles) publishAsk(withFiles); // 建的时候推过一次还没有附件：网页收到 ask 事件就刷新，别让它等 30 秒轮询
      if (!(await supersedeSharedAsks(a))) for (const old of supersedeOlder(askDb(), a)) publishAsk(old); // 发出去了才作废同 key 的旧的：发失败时旧的仍有效
    } else {
      const c = await cancelSharedAsk(a, "reply 没发出去") ?? closeAsk(askDb(), a.id, "cancelled", "reply 没发出去");
      if (c) publishAsk(c);
    }
  } catch (e) {
    console.error(`⚠️ 补记 ask ${a.id} 的投递结果失败: ${(e as Error).message}`);
  }
  return d;
}
