/**
 * Chat Guard 运行时（docs/design-chat-guard.md）：deliverToLocal 第一行调 guardInbound——一次 Jev、多探针，
 * 判「拦」就进隔离区（guard-quarantine.json，PersistedMap，bridge 重启不丢），发 chat_guard 事件给 web、推送给 owner，
 * 对投递方返回 outcome.note="guarded"（与 "queued" 同一形状，send_to_agent 据此告诉发送方）。放行 = 原信封打 meta.guard="released"
 * 走 deliverToLocal 原路（跳过守门，ts / messageId / threadId 不变）。Jev 没配 / 挂了 → fail-open（照投 + 记日志）。
 * 每次判定（拦或不拦）追加 guard-log.jsonl；pending 超过 24 h 自动 dropped。规则本体在 lib/chat-guard.ts。
 */
import { appendFileSync } from "node:fs";
import { readConfig } from "../lib/config-store.js";
import { jevAsk, JevError } from "../lib/jev.js";
import { statePath } from "../lib/paths.js";
import {
  buildGuardState, DEFAULT_THRESHOLDS, guardQuestions, judgeGuard, previewText, shouldGuard, trustOf,
  type GuardDecision, type GuardSubject, type GuardThresholds,
} from "../lib/chat-guard.js";
import { emitEvent } from "./event-bus.js";
import { PersistedMap } from "./persisted-map.js";
import { pushOwnerNotice } from "./push/init.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";

export interface QuarantineItem {
  id: string;
  agent: string;
  env: Envelope;
  to: LocalEndpoint;
  subject: GuardSubject;
  decision: GuardDecision;
  at: string;
  status: "pending" | "released" | "dropped";
  actedAt?: string;
  actedBy?: string;
}
const isItem = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as QuarantineItem).id === "string" && !!(v as QuarantineItem).env;
const QUARANTINE_PATH = statePath("guard-quarantine.json");
const LOG_PATH = statePath("guard-log.jsonl");
const QUARANTINE_TTL_MS = 24 * 3_600_000;

interface Deps {
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  deliverLocal: (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;
  ask: typeof jevAsk;
  store: PersistedMap<QuarantineItem>;
  logPath: string | null;
  now: () => number;
}
let deps: Deps = {
  client: () => undefined,
  deliverLocal: async (env) => ({ envelope: env, outcome: { kind: "error", error: new Error("chat guard not wired") } }),
  ask: jevAsk,
  store: new PersistedMap<QuarantineItem>(QUARANTINE_PATH, "守门隔离区", isItem, ["ws", "discordMsg"]),
  logPath: LOG_PATH,
  now: () => Date.now(),
};
/** bridge.ts 启动时注入 clients / deliverToLocal；单测注入假 ask、内存 store */
export function configureChatGuard(d: Partial<Deps>): void {
  deps = { ...deps, ...d };
}

/** 同一发送方最近两条原话（防分步套取）；进程内即可，重启丢了也只是少一点上下文 */
const recent = new Map<string, string[]>();
const senderKey = (env: Envelope): string => {
  const f = env.from as { kind: string; tokenId?: string; userId?: string; agentName?: string; channelId?: string };
  return `${f.kind}:${f.tokenId ?? f.userId ?? f.agentName ?? f.channelId ?? "?"}`;
};
/** web 侧的 agent 名不带 agent- 前缀；事件的顶层 agent 仍用 registry 名（与其它事件一致，流过滤按它） */
const bare = (name: string): string => name.replace(/^agent-/, "");
const senderName = (env: Envelope): string => {
  const f = env.from as { kind: string; name?: string; username?: string; agentName?: string; tokenId?: string };
  return f.name ?? f.username ?? f.agentName ?? f.tokenId ?? f.kind;
};

function log(entry: Record<string, unknown>): void {
  if (!deps.logPath) return;
  try {
    appendFileSync(deps.logPath, `${JSON.stringify({ ts: new Date(deps.now()).toISOString(), ...entry })}\n`);
  } catch (e) {
    console.error(`⚠️ 守门日志写不进 ${deps.logPath}: ${(e as Error).message}`);
  }
}

let notConfiguredWarned = false;
async function thresholds(): Promise<{ mode: "off" | "on"; t: GuardThresholds }> {
  const cfg = (await readConfig()).chatGuard;
  const blockAt = typeof cfg?.blockAt === "number" ? cfg.blockAt : DEFAULT_THRESHOLDS.blockAt;
  return { mode: cfg?.mode === "off" ? "off" : "on", t: { blockAt, flagAt: Math.min(DEFAULT_THRESHOLDS.flagAt, blockAt) } };
}

/** null = 放行（照常投递）；返回 Delivery = 已隔离，调用方直接把它当结果 */
export async function guardInbound(env: Envelope, to: LocalEndpoint): Promise<Delivery | null> {
  const { mode, t } = await thresholds();
  if (mode === "off") return null;
  if (!shouldGuard({ fromKind: env.from.kind, triggerKind: env.meta.triggerKind, released: env.meta.guard === "released", content: env.content })) return null;
  const evAgent = to.agentName || to.channelId;
  const agent = bare(evAgent);
  const key = senderKey(env);
  const subject: GuardSubject = {
    text: env.content,
    attachments: env.meta.attachments?.map((p) => p.split("/").pop() ?? p),
    sender: { kind: env.from.kind, name: senderName(env), trust: trustOf(env.from as { kind: string; tokenId?: string }, env.meta.triggerKind) },
    target: { agent },
    recent: recent.get(key),
  };
  const questions = guardQuestions(subject);
  let decision: GuardDecision;
  let ms = 0;
  let tokens = 0;
  try {
    const r = await deps.ask(buildGuardState(subject), questions, { timeoutMs: 8000, retries: 1 });
    decision = judgeGuard(r.answers as Record<string, unknown>, subject, t);
    ms = r.latencyMs;
    tokens = r.usage.input_tokens;
  } catch (e) {
    // fail-open：守门是减速带与审计，不是边界；Jev 不可用不能把 owner 自己锁在外面
    if (e instanceof JevError && e.code === "not_configured") {
      if (!notConfiguredWarned) console.log("🛡 守门：未配置 Jev key，入站消息不做判定（设置 → 连接与集成 → Jev）");
      notConfiguredWarned = true;
      return null;
    }
    console.error(`⚠️ 守门：Jev 判定失败，照常投递: ${(e as Error).message}`);
    log({ id: env.meta.messageId, agent, sender: subject.sender, verdict: "error", error: (e as Error).message });
    return null;
  }
  recent.set(key, [...(recent.get(key) ?? []), env.content].slice(-2));
  log({ id: env.meta.messageId, agent, sender: subject.sender, verdict: decision.verdict, hits: decision.hits, ms, tokens });
  if (decision.verdict !== "block") return null;
  const item: QuarantineItem = { id: env.meta.messageId, agent, env, to, subject, decision, at: new Date(deps.now()).toISOString(), status: "pending" };
  deps.store.set(item.id, item);
  sweepQuarantine();
  const top = decision.hits.find((h) => h.verdict === "block");
  const preview = previewText(env.content);
  console.log(`🛡 守门拦下一条给 ${agent} 的消息（${top?.id} ${top?.score?.toFixed(2)}）：来自 ${subject.sender.name}`);
  emitEvent({
    agent: evAgent, chatId: to.channelId, type: "chat_guard",
    data: { action: "quarantined", id: item.id, agent, from: subject.sender.name, trust: subject.sender.trust, text: preview, probe: top?.id, score: top?.score, at: item.at },
  });
  pushOwnerNotice(`⛔ 守门拦下一条给 ${agent} 的消息`, `来自 ${subject.sender.name}（${top?.id} ${top?.score?.toFixed(2)}）：${preview}`);
  return { envelope: env, outcome: { kind: "sent", note: "guarded" } };
}

export function listQuarantine(agent?: string): QuarantineItem[] {
  sweepQuarantine();
  return [...deps.store.values()].filter((i) => i.status === "pending" && (!agent || bare(i.agent) === bare(agent))).sort((a, b) => a.at.localeCompare(b.at));
}

/** 超过 24 h 没人处理的自动丢弃（发送方早已不等了；留着只会误放） */
function sweepQuarantine(): void {
  const cutoff = deps.now() - QUARANTINE_TTL_MS;
  for (const item of deps.store.values()) {
    if (item.status === "pending" && Date.parse(item.at) < cutoff) finish(item, "dropped", "timeout");
  }
}

function finish(item: QuarantineItem, status: "released" | "dropped", by: string): void {
  deps.store.set(item.id, { ...item, status, actedAt: new Date(deps.now()).toISOString(), actedBy: by });
  log({ id: item.id, agent: item.agent, action: status, by });
  emitEvent({ agent: item.to.agentName || item.to.channelId, chatId: item.to.channelId, type: "chat_guard", data: { action: status, id: item.id, agent: bare(item.agent), by } });
}

export async function releaseQuarantined(id: string, by: string): Promise<{ ok: boolean; error?: string }> {
  const item = deps.store.get(id);
  if (!item || item.status !== "pending") return { ok: false, error: "not pending" };
  const c = deps.client(item.to.channelId);
  if (!c) return { ok: false, error: "agent offline; try again when it is running" };
  const env: Envelope = { ...item.env, meta: { ...item.env.meta, guard: "released" } };
  const r = await deps.deliverLocal(env, { ...item.to, ws: c.ws, cwd: c.cwd });
  if (r.outcome.kind === "error") return { ok: false, error: r.outcome.error.message };
  if (r.outcome.kind === "dropped") return { ok: false, error: r.outcome.reason };
  finish(item, "released", by);
  return { ok: true };
}

export function dropQuarantined(id: string, by: string): { ok: boolean; error?: string } {
  const item = deps.store.get(id);
  if (!item || item.status !== "pending") return { ok: false, error: "not pending" };
  finish(item, "dropped", by);
  return { ok: true };
}
