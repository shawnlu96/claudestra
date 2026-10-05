/**
 * Chat Guard 运行时（docs/design-chat-guard.md）：deliverToLocal 第一行调 guardInbound——一次 Jev、多探针，
 * 判「拦」就进隔离区（guard-quarantine.json，PersistedMap，bridge 重启不丢），发 chat_guard 事件给 manage 设备、推送给 owner，
 * 对投递方返回 outcome.note="guarded"。放行 = 原信封打 meta.guard="released" 走 deliverToLocal 原路（跳过守门，ts / messageId 不变）。
 * Jev 没配 / 挂了 → fail-open（照投 + 记日志）；超长的不送 Jev，直接隔离。规则本体在 lib/chat-guard.ts。
 * 隔离中的消息对回合结算等同「押后」（quarantinedIds / quarantinedFrom）：别的回合的话不能当成它的答复。
 */
import { appendFileSync, chmodSync, renameSync, statSync } from "node:fs";
import { readConfig } from "../lib/config-store.js";
import { jevAsk, JevError } from "../lib/jev.js";
import { statePath } from "../lib/paths.js";
import { readRegistryAgents } from "../lib/registry.js";
import {
  buildGuardState, DEFAULT_THRESHOLDS, guardQuestions, judgeGuard, OVERSIZE_DECISION, overBudget, previewText, shouldGuard, trustOf,
  type GuardDecision, type GuardSubject, type GuardThresholds,
} from "../lib/chat-guard.js";
import { emitEvent } from "./event-bus.js";
import { PersistedMap } from "./persisted-map.js";
import { pushOwnerNotice } from "./push/init.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";

export interface QuarantineItem {
  id: string;
  /** 不带 agent- 前缀（web 用这个形式）；regName 是 registry 名，事件顶层 agent 用它（流按它过滤，与其它事件一致） */
  agent: string;
  regName?: string;
  env: Envelope;
  to: LocalEndpoint;
  subject: GuardSubject;
  decision: GuardDecision;
  at: string;
  /** releasing = 已认领、正在投递：并发的放行 / 丢弃 / 清扫都不能再动它 */
  status: "pending" | "releasing" | "released" | "dropped";
  actedAt?: string;
  actedBy?: string;
}
const isItem = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as QuarantineItem).id === "string" && !!(v as QuarantineItem).env;
const QUARANTINE_PATH = statePath("guard-quarantine.json");
/** 每次 Jev 判定一行（含失败降级）+ 放行 / 丢弃一行；设置页「调用记录」读它（local-api/jev-log.ts） */
export const GUARD_LOG_PATH = statePath("guard-log.jsonl");
/** 隔离区与日志含消息原文：只给本人读 */
const FILE_MODE = 0o600;
const QUARANTINE_TTL_MS = 24 * 3_600_000;
/** 放行 / 丢弃后的记录留这么久（历史视图靠它给消息打标），之后删 */
const RETAIN_DONE_MS = 30 * 24 * 3_600_000;
/** 待放行最多这么多条：再多最早的按 overflow 丢弃，攻击者刷不爆隔离区 */
export const MAX_PENDING = 200;
/** 日志超过这么大就转成 .1（只留一份旧的） */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SWEEP_EVERY_MS = 10 * 60_000;

interface Deps {
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  deliverLocal: (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;
  ask: typeof jevAsk;
  store: PersistedMap<QuarantineItem>;
  logPath: string | null;
  now: () => number;
  /** 目标会话开了 Chat Guard 就返回它的 registry 名，没开 = null。按 channelId 认：Discord 入站的 to 不带 agentName */
  guardAgent: (to: { agentName?: string; channelId: string }) => Promise<string | null>;
  /** 丢弃（人工 / 超时 / 溢出）之后：结掉挂在这条消息上的回程、告诉发送方没送到（bridge/guard-dropped.ts） */
  onDropped: (item: QuarantineItem) => void;
}
const bare = (name: string): string => name.replace(/^agent-/, "");
/** 目标会话的 registry 条目：先按 channelId（Discord 入站的 to 只有它），再按名字；开了 chatGuard 才返回名字 */
export function pickGuardAgent(agents: { name: string; channelId?: string; chatGuard?: boolean }[], to: { agentName?: string; channelId: string }): string | null {
  const a = agents.find((x) => x.channelId === to.channelId) ?? (to.agentName ? agents.find((x) => bare(x.name) === bare(to.agentName!)) : undefined);
  return a?.chatGuard === true ? a.name : null;
}
let deps: Deps = {
  client: () => undefined,
  deliverLocal: async (env) => ({ envelope: env, outcome: { kind: "error", error: new Error("chat guard not wired") } }),
  ask: jevAsk,
  store: new PersistedMap<QuarantineItem>(QUARANTINE_PATH, "守门隔离区", isItem, ["ws", "discordMsg"], FILE_MODE),
  logPath: GUARD_LOG_PATH,
  now: () => Date.now(),
  guardAgent: async (to) => pickGuardAgent(await readRegistryAgents(), to),
  onDropped: () => {},
};
let sweeper: ReturnType<typeof setInterval> | null = null;
/** bridge.ts 启动时注入 clients / deliverToLocal / 回程结算，并起定时清扫（过期不能只靠有人打开清单才触发）；单测注入假 ask、内存 store */
export function configureChatGuard(d: Partial<Deps> & { sweepEveryMs?: number }): void {
  const { sweepEveryMs, ...rest } = d;
  deps = { ...deps, ...rest };
  if (sweepEveryMs === 0 || sweeper) return;
  if (sweepEveryMs === undefined && !d.client) return;
  sweeper = setInterval(sweepQuarantine, sweepEveryMs ?? SWEEP_EVERY_MS);
  sweeper.unref?.();
}

/** 同一发送方最近两条原话（防分步套取）；进程内即可，重启丢了也只是少一点上下文 */
const recent = new Map<string, string[]>();
const senderKey = (env: Envelope): string => {
  const f = env.from as { kind: string; tokenId?: string; userId?: string; agentName?: string; channelId?: string };
  return `${f.kind}:${f.tokenId ?? f.userId ?? f.agentName ?? f.channelId ?? "?"}`;
};
const senderName = (env: Envelope): string => {
  const f = env.from as { kind: string; name?: string; username?: string; agentName?: string; tokenId?: string };
  return f.name ?? f.username ?? f.agentName ?? f.tokenId ?? f.kind;
};

let logModeFixed = false;
function log(entry: Record<string, unknown>): void {
  const path = deps.logPath;
  if (!path) return;
  try {
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ ts: new Date(deps.now()).toISOString(), ...entry })}\n`, { mode: FILE_MODE });
    if (!logModeFixed) chmodSync(path, FILE_MODE); // 早先版本建的文件是 0644：收紧一次
    logModeFixed = true;
  } catch (e) {
    console.error(`⚠️ 守门日志写不进 ${path}: ${(e as Error).message}`);
  }
}

let notConfiguredWarned = false;
async function thresholds(): Promise<{ mode: "off" | "on"; t: GuardThresholds }> {
  const cfg = (await readConfig()).chatGuard;
  const blockAt = typeof cfg?.blockAt === "number" ? cfg.blockAt : DEFAULT_THRESHOLDS.blockAt;
  return { mode: cfg?.mode === "off" ? "off" : "on", t: { blockAt, flagAt: Math.min(DEFAULT_THRESHOLDS.flagAt, blockAt) } };
}

/** 判一段文本：超长 → OVERSIZE；Jev 失败 → null（fail-open，未配置只提示一次、其余记日志）；否则汇总判定 */
async function judge(subject: GuardSubject, t: GuardThresholds, logBase: Record<string, unknown>): Promise<GuardDecision | null> {
  if (overBudget(subject)) {
    log({ ...logBase, verdict: "block", hits: OVERSIZE_DECISION.hits, chars: subject.text.length });
    return OVERSIZE_DECISION;
  }
  try {
    const r = await deps.ask(buildGuardState(subject), guardQuestions(subject), { timeoutMs: 8000, retries: 1 });
    const decision = judgeGuard(r.answers as Record<string, unknown>, subject, t);
    log({ ...logBase, verdict: decision.verdict, hits: decision.hits, ms: r.latencyMs, tokens: r.usage.input_tokens });
    return decision;
  } catch (e) {
    // fail-open：守门是减速带与审计，不是边界；Jev 不可用不能把 owner 自己锁在外面
    if (e instanceof JevError && e.code === "not_configured") {
      if (!notConfiguredWarned) console.log("🛡 守门：未配置 Jev key，入站消息不做判定（设置 → 连接与集成 → Jev）");
      notConfiguredWarned = true;
      return null;
    }
    console.error(`⚠️ 守门：Jev 判定失败，照常投递: ${(e as Error).message}`);
    log({ ...logBase, verdict: "error", error: (e as Error).message });
    return null;
  }
}

/** null = 放行（照常投递）；返回 Delivery = 已隔离，调用方直接把它当结果 */
export async function guardInbound(env: Envelope, to: LocalEndpoint): Promise<Delivery | null> {
  const { mode, t } = await thresholds();
  if (mode === "off") return null;
  if (!shouldGuard({ fromKind: env.from.kind, triggerKind: env.meta.triggerKind, released: env.meta.guard === "released", content: env.content })) return null;
  const regName = await deps.guardAgent(to);
  if (!regName) return null;
  const agent = bare(regName);
  const key = senderKey(env);
  const subject: GuardSubject = {
    text: env.content,
    attachments: env.meta.attachments?.map((p) => p.split("/").pop() ?? p),
    sender: { kind: env.from.kind, name: senderName(env), trust: trustOf(env.from as { kind: string; tokenId?: string }, env.meta.triggerKind) },
    target: { agent },
    recent: recent.get(key),
  };
  const decision = await judge(subject, t, { id: env.meta.messageId, agent, sender: subject.sender, preview: previewText(env.content, 80) });
  if (!decision) return null;
  recent.set(key, [...(recent.get(key) ?? []), env.content].slice(-2));
  if (decision.verdict !== "block") return null;
  quarantine({ id: env.meta.messageId, agent, regName, env, to, subject, decision, at: new Date(deps.now()).toISOString(), status: "pending" });
  return { envelope: env, outcome: { kind: "sent", note: "guarded" } };
}

/** 老记录没有 regName：退回信封上的名字，再退回频道 id */
const evAgent = (i: QuarantineItem): string => i.regName ?? i.to.agentName ?? i.to.channelId;

function quarantine(item: QuarantineItem): void {
  deps.store.set(item.id, item);
  sweepQuarantine();
  const top = item.decision.hits.find((h) => h.verdict === "block");
  const preview = previewText(item.env.content);
  const agent = item.agent;
  console.log(`🛡 守门拦下一条给 ${agent} 的消息（${top?.id} ${top?.score?.toFixed(2) ?? "-"}）：来自 ${item.subject.sender.name}`);
  // 只有预览：全文给 manage 设备从 GET /guard/quarantine 取（事件流的过滤见 bridge/ledger-feed.ts sseEventAllow）
  emitEvent({
    agent: evAgent(item), chatId: item.to.channelId, type: "chat_guard",
    data: { action: "quarantined", id: item.id, agent, from: item.subject.sender.name, trust: item.subject.sender.trust, text: preview, probe: top?.id, score: top?.score, at: item.at },
  });
  pushOwnerNotice(`⛔ 守门拦下一条给 ${agent} 的消息`, `来自 ${item.subject.sender.name}（${top?.id}）：${preview}`);
}

/** all=false 只回待处理的（pending / 正在放行）；all=true 连 released / dropped 也回（历史视图里的守门记录） */
export function listQuarantine(agent?: string, all = false): QuarantineItem[] {
  sweepQuarantine();
  return [...deps.store.values()]
    .filter((i) => (all || i.status === "pending" || i.status === "releasing") && (!agent || bare(i.agent) === bare(agent)))
    .sort((a, b) => a.at.localeCompare(b.at));
}

const pendingIn = (channelId: string): QuarantineItem[] => [...deps.store.values()].filter((i) => i.status === "pending" && i.to.channelId === channelId);
/** 这个频道还隔离着、没送到 agent 手上的消息 id：挂在它们上的 API 请求不能被别的回合结掉（bridge.ts Stop 结算） */
export const quarantinedIds = (channelId: string): string[] => pendingIn(channelId).map((i) => i.id);
/** 同上，给回程簿（send_to_agent 的槽）：形状同 held-queue.ts unseenFrom */
export const quarantinedFrom = (channelId: string): { fromKind: string; fromChannelId?: string; messageId: string }[] =>
  pendingIn(channelId).map((i) => ({ fromKind: i.env.from.kind, fromChannelId: i.env.from.kind === "local" ? i.env.from.channelId : undefined, messageId: i.id }));

/** 只有本进程认领过的才算「正在放行」；落盘里留着 releasing、进程里没有 = 上次放行到一半 bridge 退了 */
const releasing = new Set<string>();
const doneAt = (i: QuarantineItem): number => Date.parse(i.actedAt ?? i.at);

/** 过期（24 h）/ 溢出的 pending 丢弃，上次没放完的按已放行收尾（至多一次：宁可丢，不重投），终态超过保留期删除；一批只落一次盘 */
function sweepQuarantine(): void {
  const now = deps.now();
  const items = [...deps.store.values()];
  const pending = items.filter((i) => i.status === "pending").sort((a, b) => a.at.localeCompare(b.at));
  const overflow = new Set(pending.slice(0, Math.max(0, pending.length - MAX_PENDING)).map((i) => i.id));
  const changed: QuarantineItem[] = [];
  const deletes: string[] = [];
  for (const i of items) {
    if (i.status === "pending" && (overflow.has(i.id) || Date.parse(i.at) < now - QUARANTINE_TTL_MS)) changed.push(acted(i, "dropped", overflow.has(i.id) ? "overflow" : "timeout"));
    else if (i.status === "releasing" && !releasing.has(i.id)) changed.push(acted(i, "released", "interrupted"));
    else if ((i.status === "released" || i.status === "dropped") && doneAt(i) < now - RETAIN_DONE_MS) deletes.push(i.id);
  }
  if (!changed.length && !deletes.length) return;
  deps.store.update(changed.map((i) => [i.id, i]), deletes);
  for (const i of changed) announce(i);
}

const acted = (item: QuarantineItem, status: "released" | "dropped", by: string): QuarantineItem =>
  ({ ...item, status, actedAt: new Date(deps.now()).toISOString(), actedBy: by });

function announce(item: QuarantineItem): void {
  log({ id: item.id, agent: bare(item.agent), action: item.status, by: item.actedBy });
  emitEvent({ agent: evAgent(item), chatId: item.to.channelId, type: "chat_guard", data: { action: item.status, id: item.id, agent: bare(item.agent), by: item.actedBy } });
  if (item.status === "dropped") deps.onDropped(item);
}

function finish(item: QuarantineItem, status: "released" | "dropped", by: string): void {
  const done = acted(item, status, by);
  deps.store.set(done.id, done);
  announce(done);
}

export async function releaseQuarantined(id: string, by: string): Promise<{ ok: boolean; error?: string }> {
  sweepQuarantine(); // 先清过期的：超过 24 h 的不能再放
  const item = deps.store.get(id);
  if (!item || item.status !== "pending") return { ok: false, error: item?.status === "releasing" ? "already releasing" : "not pending" };
  const c = deps.client(item.to.channelId);
  if (!c) return { ok: false, error: "agent offline; try again when it is running" };
  // 在第一个 await 之前认领并落盘：两台设备同时点放行、放行时点丢弃、清扫，都看到它已不是 pending
  releasing.add(id);
  deps.store.set(id, { ...item, status: "releasing", actedAt: new Date(deps.now()).toISOString(), actedBy: by });
  try {
    const env: Envelope = { ...item.env, meta: { ...item.env.meta, guard: "released" } };
    const r = await deps.deliverLocal(env, { ...item.to, ws: c.ws, cwd: c.cwd });
    const error = r.outcome.kind === "error" ? r.outcome.error.message : r.outcome.kind === "dropped" ? r.outcome.reason : null;
    if (error !== null) {
      deps.store.set(id, item); // 没投出去：退回 pending，可以再放
      return { ok: false, error };
    }
    finish(item, "released", by);
    return { ok: true };
  } finally {
    releasing.delete(id);
  }
}

export function dropQuarantined(id: string, by: string): { ok: boolean; error?: string } {
  const item = deps.store.get(id);
  if (!item || item.status !== "pending") return { ok: false, error: item?.status === "releasing" ? "already releasing" : "not pending" };
  finish(item, "dropped", by);
  return { ok: true };
}

/**
 * 网页斜杠直通的参数（会进模型上下文）同样过守门：开了守门的会话里判「拦」就拒绝注入，返回拒绝原因；没开 / 放行 / Jev 失败 → null。
 * 不进隔离区：放行只能原样重投信封，而直通是敲进终端，没有可重投的信封（bridge/api-slash.ts）。
 */
export async function guardSlashArgs(agent: { name: string; channelId: string }, args: string, sender: { name: string }): Promise<string | null> {
  const { mode, t } = await thresholds();
  if (mode === "off") return null;
  const regName = await deps.guardAgent({ agentName: agent.name, channelId: agent.channelId });
  if (!regName) return null;
  const subject: GuardSubject = { text: args, sender: { kind: "api", name: sender.name, trust: "owner" }, target: { agent: bare(regName) } };
  const decision = await judge(subject, t, { id: `slash-${deps.now()}`, agent: bare(regName), sender: subject.sender, preview: previewText(args, 80), slash: true });
  if (decision?.verdict !== "block") return null;
  const top = decision.hits.find((h) => h.verdict === "block");
  return `Chat Guard 拦下了这条命令的参数（${top?.id ?? "?"}），没有注入。确认无误请在终端里亲手执行。`;
}
