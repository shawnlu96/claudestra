/**
 * Chat Guard 运行时（docs/design-chat-guard.md）：deliverToLocal 第一行调 guardInbound——一次 Jev、多探针，
 * 判「拦」就进隔离区（guard-quarantine.json，PersistedMap，bridge 重启不丢），发 chat_guard 事件给 manage 设备、推送给 owner，
 * 对投递方返回 outcome.note="guarded"。放行 = 原信封打 meta.guard="released" 走 deliverToLocal 原路（跳过守门，ts / messageId 不变）。
 * Jev 没配 → 不生效；Jev 挂了 → fail-open（照投 + 记日志）；超长的不送 Jev，直接隔离。规则本体在 lib/chat-guard.ts。
 * 投递中（排队 + 判定 + 投出去之前）/ 隔离中 / 放行中的消息都还没送到 agent（guardUnseenIds / guardUnseenFrom）：回合结算与回复认领都跳过。
 */
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { CONFIG_PATH, readConfig } from "../lib/config-store.js";
import { jevAsk, jevConfigured, JevError } from "../lib/jev.js";
import { statePath } from "../lib/paths.js";
import { readRegistryAgents } from "../lib/registry.js";
import { tmuxSendLine } from "../lib/tmux-helper.js";
import {
  buildGuardState, DEFAULT_THRESHOLDS, guardQuestions, judgeGuard, OVERSIZE_DECISION, overBudget, previewText, RECENT_MAX_CHARS, shouldGuard, trustOf,
  type GuardDecision, type GuardSubject, type GuardThresholds,
} from "../lib/chat-guard.js";
import { emitEvent } from "./event-bus.js";
import { routeProbeFor, type RouteProbe } from "./inbound-route.js";
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
/** 放行 / 丢弃后的记录留这么久（历史视图靠它给消息打标），最多 MAX_DONE 条，正文只留 DONE_TEXT_CHARS 字 */
const RETAIN_DONE_MS = 30 * 24 * 3_600_000;
export const MAX_DONE = 500;
const DONE_TEXT_CHARS = 2000;
/** 待放行最多这么多条、正文合计这么多字：再多最早的按 overflow 丢弃，攻击者刷不爆隔离区 */
export const MAX_PENDING = 200;
export const MAX_PENDING_CHARS = 2_000_000;
/** 单条正文超过这么多字连隔离区都不进（存不起、也没人会逐字看完）：直接按 too_large 丢弃 */
export const MAX_ITEM_CHARS = 200_000;
/** 日志超过这么大就转成 .1（只留一份旧的） */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SWEEP_EVERY_MS = 10 * 60_000;

interface Deps {
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  deliverLocal: (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;
  ask: typeof jevAsk;
  /** Jev 配了 key 没有：没配就整个不生效（设计如此，不能因为超长判定而先拦） */
  configured: () => Promise<boolean>;
  store: PersistedMap<QuarantineItem>;
  logPath: string | null;
  now: () => number;
  /** 目标会话开了 Chat Guard 就返回它的 registry 名，没开 = null。按 channelId 认：Discord 入站的 to 不带 agentName */
  guardAgent: (to: { agentName?: string; channelId: string }) => Promise<string | null>;
  /** 丢弃（人工 / 超时 / 溢出）之后：结掉挂在这条消息上的回程、告诉发送方没送到（bridge/guard-dropped.ts） */
  onDropped: (item: QuarantineItem) => void;
  /** 放行投递成功之后：补回过期 / 重启丢掉的回程登记、重置送达计时（bridge/guard-dropped.ts） */
  onReleased: (item: QuarantineItem) => void;
  /** 入站路由要问的话（目标忙、开关没关）：并进这一次 Jev，不另发（bridge/inbound-route.ts） */
  routeProbe: typeof routeProbeFor;
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
  configured: jevConfigured,
  store: new PersistedMap<QuarantineItem>(QUARANTINE_PATH, "守门隔离区", isItem, ["ws", "discordMsg"], FILE_MODE),
  logPath: GUARD_LOG_PATH,
  now: () => Date.now(),
  guardAgent: async (to) => pickGuardAgent(await readRegistryAgents(), to),
  onDropped: () => {},
  onReleased: () => {},
  routeProbe: routeProbeFor,
};

/** 早先版本建的文件是 0644：启动时收紧一次（之后的写入都带 0600）。文件不在 / 改不了只记日志 */
export function tightenGuardFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (existsSync(p) && (statSync(p).mode & 0o077) !== 0) chmodSync(p, FILE_MODE);
    } catch (e) {
      console.error(`⚠️ 守门：收紧 ${p} 权限失败: ${(e as Error).message}`);
    }
  }
}

let sweeper: ReturnType<typeof setInterval> | null = null;
/** bridge.ts 启动时注入 clients / deliverToLocal / 回程结算，并起定时清扫（过期不能只靠有人打开清单才触发）；单测注入假 ask、内存 store */
export function configureChatGuard(d: Partial<Deps> & { sweepEveryMs?: number }): void {
  const { sweepEveryMs, ...rest } = d;
  deps = { ...deps, ...rest };
  if (sweepEveryMs === 0 || sweeper) return;
  if (sweepEveryMs === undefined && !d.client) return;
  tightenGuardFiles([QUARANTINE_PATH, GUARD_LOG_PATH, `${GUARD_LOG_PATH}.1`, CONFIG_PATH]);
  sweeper = setInterval(sweepQuarantine, sweepEveryMs ?? SWEEP_EVERY_MS);
  sweeper.unref?.();
}

/** 同一发送方最近两条原话（防分步套取），每条截到 RECENT_MAX_CHARS；进程内即可，重启丢了也只是少一点上下文 */
const recent = new Map<string, string[]>();
const senderKey = (env: Envelope): string => {
  const f = env.from as { kind: string; tokenId?: string; userId?: string; agentName?: string; channelId?: string };
  return `${f.kind}:${f.tokenId ?? f.userId ?? f.agentName ?? f.channelId ?? "?"}`;
};
const senderName = (env: Envelope): string => {
  const f = env.from as { kind: string; name?: string; username?: string; agentName?: string; tokenId?: string };
  return f.name ?? f.username ?? f.agentName ?? f.tokenId ?? f.kind;
};

function log(entry: Record<string, unknown>): void {
  const path = deps.logPath;
  if (!path) return;
  try {
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > LOG_ROTATE_BYTES) {
      tightenGuardFiles([path]); // 转存出去的旧文件也只给本人读
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${JSON.stringify({ ts: new Date(deps.now()).toISOString(), ...entry })}\n`, { mode: FILE_MODE });
  } catch (e) {
    console.error(`⚠️ 守门日志写不进 ${path}: ${(e as Error).message}`);
  }
}

let notConfiguredWarned = false;
/** 守门对这条生效时给出阈值；关着 / Jev 没配 → null（不判、照投） */
async function activeThresholds(): Promise<GuardThresholds | null> {
  const cfg = (await readConfig()).chatGuard;
  if (cfg?.mode === "off") return null;
  if (!(await deps.configured())) {
    if (!notConfiguredWarned) console.log("🛡 守门：未配置 Jev key，入站消息不做判定（设置 → 连接与集成 → Jev）");
    notConfiguredWarned = true;
    return null;
  }
  const blockAt = typeof cfg?.blockAt === "number" ? cfg.blockAt : DEFAULT_THRESHOLDS.blockAt;
  return { blockAt, flagAt: Math.min(DEFAULT_THRESHOLDS.flagAt, blockAt) };
}

/** 判一段文本：超长 → OVERSIZE；Jev 失败 → null（fail-open，记日志）；否则汇总判定 */
async function judge(subject: GuardSubject, t: GuardThresholds, logBase: Record<string, unknown>, route?: RouteProbe | null): Promise<GuardDecision | null> {
  if (overBudget(subject)) {
    log({ ...logBase, verdict: "block", hits: OVERSIZE_DECISION.hits, chars: subject.text.length });
    return OVERSIZE_DECISION;
  }
  try {
    // 路由的 state 键（agent / incoming / queue）和守门的（message / sender / target / recent）不重名，平铺在一起；问题键带 route_ 前缀
    const state = route ? { ...(buildGuardState(subject) as Record<string, unknown>), ...(route.state as Record<string, unknown>) } : buildGuardState(subject);
    const r = await deps.ask(state, { ...guardQuestions(subject), ...route?.questions }, { timeoutMs: 8000, retries: 1 });
    route?.settle(r.answers as Record<string, unknown>, { ms: r.latencyMs, via: "guard" });
    const decision = judgeGuard(r.answers as Record<string, unknown>, subject, t);
    log({ ...logBase, verdict: decision.verdict, hits: decision.hits, ms: r.latencyMs, tokens: r.usage.input_tokens });
    return decision;
  } catch (e) {
    // fail-open：守门是减速带与审计，不是边界；Jev 不可用不能把 owner 自己锁在外面
    console.error(`⚠️ 守门：Jev 判定失败，照常投递: ${(e as Error).message}`);
    route?.settle(null, { error: (e as Error).message, via: "guard" });
    log({ ...logBase, verdict: "error", error: (e as Error).message, ...(e instanceof JevError ? { code: e.code } : {}) });
    return null;
  }
}

/** 正在等 Jev 判定的消息（还没送到 agent，也还没进隔离区）：messageId → 目标频道与来源 */
const judging = new Map<string, { channelId: string; fromKind: string; fromChannelId?: string }>();
const fromChannelOf = (env: Envelope): string | undefined => (env.from.kind === "local" ? env.from.channelId : undefined);
/** 正在投递的（bridge.ts deliverLocalInOrder 从排队起到投完）：排在一条正等 Jev 的消息后面时可能要等十几秒，这段时间它也没到 agent 手上 */
const inflight = new Map<string, { channelId: string; fromKind: string; fromChannelId?: string; n: number }>();
export async function trackGuardInflight<T>(env: Envelope, channelId: string, run: () => Promise<T>): Promise<T> {
  const id = env.meta.messageId;
  const cur = inflight.get(id);
  inflight.set(id, { channelId, fromKind: env.from.kind, fromChannelId: fromChannelOf(env), n: (cur?.n ?? 0) + 1 });
  try {
    return await run();
  } finally {
    const e = inflight.get(id);
    if (e && e.n > 1) e.n--;
    else inflight.delete(id);
  }
}

/** null = 放行（照常投递）；返回 Delivery = 已隔离，调用方直接把它当结果 */
export async function guardInbound(env: Envelope, to: LocalEndpoint): Promise<Delivery | null> {
  if (!shouldGuard({ fromKind: env.from.kind, triggerKind: env.meta.triggerKind, released: env.meta.guard === "released", content: env.content })) return null;
  const id = env.meta.messageId;
  judging.set(id, { channelId: to.channelId, fromKind: env.from.kind, fromChannelId: fromChannelOf(env) }); // 判定期间别的回合结束也不能结它
  try {
    const t = await activeThresholds();
    const regName = t ? await deps.guardAgent(to) : null;
    if (!t || !regName) return null;
    const agent = bare(regName);
    const key = senderKey(env);
    const subject: GuardSubject = {
      text: env.content,
      attachments: env.meta.attachments?.map((p) => p.split("/").pop() ?? p),
      sender: { kind: env.from.kind, name: senderName(env), trust: trustOf(env.from as { kind: string; tokenId?: string }, env.meta.triggerKind) },
      target: { agent },
      recent: recent.get(key),
    };
    const route = await deps.routeProbe(env, to, regName);
    const decision = await judge(subject, t, { id, agent, sender: subject.sender, preview: previewText(env.content, 80) }, route);
    if (!decision) return null;
    recent.set(key, [...(recent.get(key) ?? []), previewText(env.content, RECENT_MAX_CHARS)].slice(-2));
    if (decision.verdict !== "block") return null;
    delete env.meta.inboundRoute; // 隔离到放行可能隔了很久：那时的忙闲早变了，放行后按现有规则投
    quarantine({ id, agent, regName, env, to, subject, decision, at: new Date(deps.now()).toISOString(), status: "pending" });
    return { envelope: env, outcome: { kind: "sent", note: "guarded" } };
  } finally {
    judging.delete(id);
  }
}

/** 老记录没有 regName：退回信封上的名字，再退回频道 id */
const evAgent = (i: QuarantineItem): string => i.regName ?? i.to.agentName ?? i.to.channelId;

/**
 * 事件两路：chat_guard 带预览，只给 manage 设备（待放行卡，全文另从 GET /guard/quarantine 取）；
 * chat_guard_status 不带正文，只发给发件 API 凭据自己（chatId=api:<token>），它的气泡据此变成「已丢弃」/ 消掉标记（ledger-feed.ts sseEventAllow）
 */
function emitGuard(item: QuarantineItem, action: "quarantined" | "released" | "dropped", extra: Record<string, unknown>): void {
  const base = { action, id: item.id, agent: item.agent };
  emitEvent({ agent: evAgent(item), chatId: item.to.channelId, type: "chat_guard", data: { ...base, ...extra } });
  const f = item.env.from as { kind: string; tokenId?: string };
  if (f.kind === "api" && f.tokenId) emitEvent({ agent: evAgent(item), chatId: `api:${f.tokenId}`, type: "chat_guard_status", data: base });
}

function quarantine(item: QuarantineItem): void {
  const tooLarge = sizeOf(item) > MAX_ITEM_CHARS;
  deps.store.set(item.id, tooLarge ? slim(acted(item, "dropped", "too_large")) : item);
  sweepQuarantine();
  const top = item.decision.hits.find((h) => h.verdict === "block");
  const preview = previewText(item.env.content);
  console.log(`🛡 守门拦下一条给 ${item.agent} 的消息（${top?.id} ${top?.score?.toFixed(2) ?? "-"}）：来自 ${item.subject.sender.name}${tooLarge ? "，太大，直接丢弃" : ""}`);
  emitGuard(item, "quarantined", { from: item.subject.sender.name, trust: item.subject.sender.trust, text: preview, probe: top?.id, score: top?.score, at: item.at });
  if (tooLarge) return announce(deps.store.get(item.id)!);
  pushOwnerNotice(`⛔ 守门拦下一条给 ${item.agent} 的消息`, `来自 ${item.subject.sender.name}（${top?.id}）：${preview}`);
}

/** all=false 只回待处理的（pending / 正在放行）；all=true 连 released / dropped 也回（历史视图里的守门记录） */
export function listQuarantine(agent?: string, all = false): QuarantineItem[] {
  sweepQuarantine();
  return [...deps.store.values()]
    .filter((i) => (all || i.status === "pending" || i.status === "releasing") && (!agent || bare(i.agent) === bare(agent)))
    .sort((a, b) => a.at.localeCompare(b.at));
}

type Unseen = { fromKind: string; fromChannelId?: string; messageId: string };
/** 这个频道还没送到 agent 手上的：投递中、判定中、隔离中、放行中（认领了、还没投出去） */
function unseenIn(channelId: string): Unseen[] {
  const out: Unseen[] = [];
  for (const [messageId, j] of [...inflight, ...judging]) {
    if (j.channelId === channelId && !out.some((u) => u.messageId === messageId)) out.push({ fromKind: j.fromKind, fromChannelId: j.fromChannelId, messageId });
  }
  for (const i of deps.store.values()) {
    if ((i.status === "pending" || i.status === "releasing") && i.to.channelId === channelId) out.push({ fromKind: i.env.from.kind, fromChannelId: fromChannelOf(i.env), messageId: i.id });
  }
  return out;
}
/** 挂在这些消息上的 API 请求不能被别的回合结掉（bridge.ts Stop 结算的 held 集合） */
export const guardUnseenIds = (channelId: string): string[] => unseenIn(channelId).map((u) => u.messageId);
/** 同上，给回程簿（send_to_agent 的槽）：形状同 held-queue.ts unseenFrom */
export const guardUnseenFrom = (channelId: string): Unseen[] => unseenIn(channelId);

/** 只有本进程认领过的才算「正在放行」；落盘里留着 releasing、进程里没有 = 上次放行到一半 bridge 退了 */
const releasing = new Set<string>();
const doneAt = (i: QuarantineItem): number => Date.parse(i.actedAt ?? i.at);
const isDone = (i: QuarantineItem): boolean => i.status === "released" || i.status === "dropped";

/** 一条记录里的正文体积：正文 + 卡片答复回显（askEcho 另存了一份） */
const sizeOf = (i: QuarantineItem): number => i.env.content.length + (i.env.meta.askEcho?.echo.length ?? 0) + (i.env.meta.askEcho?.wire?.length ?? 0);
/** pending 里该按 overflow 丢的：条数或正文合计超限时从最早的开始丢 */
function overflowIds(items: QuarantineItem[]): Set<string> {
  const pending = items.filter((i) => i.status === "pending").sort((a, b) => b.at.localeCompare(a.at));
  const out = new Set<string>();
  let chars = 0;
  pending.forEach((i, n) => {
    chars += sizeOf(i);
    if (n >= MAX_PENDING || chars > MAX_PENDING_CHARS) out.add(i.id);
  });
  return out;
}

/** 过期（24 h）/ 溢出的 pending 丢弃，上次没放完的按已放行收尾（至多一次：宁可丢，不重投），终态超期 / 超量删除；一批只落一次盘 */
function sweepQuarantine(): void {
  const now = deps.now();
  const items = [...deps.store.values()];
  const overflow = overflowIds(items);
  const changed: QuarantineItem[] = [];
  for (const i of items) {
    if (i.status === "pending" && (overflow.has(i.id) || Date.parse(i.at) < now - QUARANTINE_TTL_MS)) changed.push(slim(acted(i, "dropped", overflow.has(i.id) ? "overflow" : "timeout")));
    else if (i.status === "releasing" && !releasing.has(i.id)) changed.push(slim(acted(i, "released", "interrupted")));
  }
  // 早先版本存下的终态没截过：补成摘要（不再广播）
  const legacy = items.filter((i) => isDone(i) && !changed.some((c) => c.id === i.id) && sizeOf(i) > DONE_TEXT_CHARS + 1).map(slim);
  const done = [...items.filter((i) => isDone(i) && !changed.some((c) => c.id === i.id)), ...changed].sort((a, b) => doneAt(b) - doneAt(a));
  const deletes = done.filter((i, n) => n >= MAX_DONE || doneAt(i) < now - RETAIN_DONE_MS).map((i) => i.id);
  if (!changed.length && !deletes.length && !legacy.length) return;
  deps.store.update([...changed, ...legacy.filter((i) => !deletes.includes(i.id))].map((i) => [i.id, i]), deletes);
  for (const i of changed) announce(i);
}

const acted = (item: QuarantineItem, status: "released" | "dropped", by: string): QuarantineItem =>
  ({ ...item, status, actedAt: new Date(deps.now()).toISOString(), actedBy: by });
/** 终态只留摘要：历史视图要的是开头和发送方，全文留着只是占地方、多存敏感内容 */
const slim = (i: QuarantineItem): QuarantineItem => ({
  ...i,
  env: { ...i.env, content: previewText(i.env.content, DONE_TEXT_CHARS), meta: { ...i.env.meta, askEcho: undefined } },
  subject: { ...i.subject, text: previewText(i.subject.text, DONE_TEXT_CHARS), recent: undefined },
});

function announce(item: QuarantineItem): void {
  log({ id: item.id, agent: item.agent, action: item.status, by: item.actedBy });
  if (item.status === "released" || item.status === "dropped") emitGuard(item, item.status, { by: item.actedBy });
  if (item.status === "dropped") deps.onDropped(item);
}

function finish(item: QuarantineItem, status: "released" | "dropped", by: string): void {
  const done = slim(acted(item, status, by));
  deps.store.set(done.id, done);
  announce(done);
}

export async function releaseQuarantined(id: string, by: string): Promise<{ ok: boolean; error?: string }> {
  sweepQuarantine(); // 先清过期的：超过 24 h 的不能再放
  const item = deps.store.get(id);
  if (!item || item.status !== "pending") return { ok: false, error: item?.status === "releasing" ? "already releasing" : "not pending" };
  const c = deps.client(item.to.channelId);
  if (!c) return { ok: false, error: "agent offline; try again when it is running" };
  // 在第一个 await 之前认领并落盘：两台设备同时点放行、放行时点丢弃、清扫，都看到它已不是 pending。
  // 认领没落上盘就不投：投了再崩，重启后它还是 pending，会被再放一次
  releasing.add(id);
  if (!deps.store.update([[id, { ...item, status: "releasing", actedAt: new Date(deps.now()).toISOString(), actedBy: by }]])) {
    releasing.delete(id);
    deps.store.update([[id, item]]);
    return { ok: false, error: "could not persist the release claim; nothing was delivered" };
  }
  try {
    const env: Envelope = { ...item.env, meta: { ...item.env.meta, guard: "released" } };
    const r = await deps.deliverLocal(env, { ...item.to, ws: c.ws, cwd: c.cwd }).catch((e: unknown): Delivery => ({ envelope: env, outcome: { kind: "error", error: e as Error } }));
    const error = r.outcome.kind === "error" ? r.outcome.error.message : r.outcome.kind === "dropped" ? r.outcome.reason : null;
    if (error !== null) {
      deps.store.set(id, item); // 没投出去（返回失败或抛异常）：退回 pending，可以再放
      return { ok: false, error };
    }
    // PM 换了人时实际收件的是新 PM：回程补登 / 送达计时都按实际目标走（local-api/project-pm-delivery.ts）
    deps.onReleased(r.envelope.to.kind === "local" ? { ...item, to: r.envelope.to } : item);
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
 * 斜杠命令的参数（网页直通 / Discord 斜杠）同样过守门：内置命令的参数也可能进模型上下文（/goal /plan /btw），一律判。
 * 判「拦」返回拒绝原因；没开 / 没配 / 放行 / Jev 失败 → null。不进隔离区：直通是敲进终端，没有可重投的信封。
 */
export async function guardSlashArgs(agent: { name: string; channelId: string }, args: string, sender: { name: string }): Promise<string | null> {
  if (!args.trim()) return null;
  const t = await activeThresholds();
  const regName = t ? await deps.guardAgent({ agentName: agent.name, channelId: agent.channelId }) : null;
  if (!t || !regName) return null;
  const subject: GuardSubject = { text: args, sender: { kind: "api", name: sender.name, trust: "owner" }, target: { agent: bare(regName) } };
  const decision = await judge(subject, t, { id: `slash-${deps.now()}`, agent: bare(regName), sender: subject.sender, preview: previewText(args, 80), slash: true });
  if (decision?.verdict !== "block") return null;
  const top = decision.hits.find((h) => h.verdict === "block");
  return `Chat Guard 拦下了这条命令的参数（${top?.id ?? "?"}），没有注入。确认无误请在终端里亲手执行。`;
}

/** Discord 斜杠注入：先判参数（同 guardSlashArgs），拦下就抛错，调用方的 catch 把原因回给用户；否则照常敲进窗口 */
export async function guardedSlashSend(agentName: string | null | undefined, channelId: string, win: string, ccText: string, sender: string): Promise<void> {
  const args = ccText.replace(/^\/\S+\s*/, "");
  const refusal = agentName ? await guardSlashArgs({ name: agentName, channelId }, args, { name: sender }) : null;
  if (refusal) throw new Error(refusal);
  await tmuxSendLine(win, ccText);
}
