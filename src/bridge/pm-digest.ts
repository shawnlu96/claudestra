/**
 * 当班 PM 的推送摘要（agents-PMDIG1，docs/architecture/pm-digest.md）：包在 deliverPmLocal 的 send 外面，只看最终收件人是不是项目当班 PM。
 * - on：可合并的不投、进项目摘要队列（落盘）；有立即送的给这位 PM 时把队列摘要放在正文前一起送，真送到才出队；
 *   队列最早一条等满 PM_DIGEST_WINDOW_MS 单独送一条摘要。没真送到（押后 / 离线 / 失败）就把正文还原、条目留队，不吞不重。
 * - observe：照常逐条投（env 原样），只记「本来会合并」；off：不记不排。开关切走后队里剩的照常送出。
 */
import type { Database } from "bun:sqlite";
import { activeProjectPm } from "../lib/pm-role.js";
import { readRegistryAgentsSync, type RegistryAgent } from "../lib/registry.js";
import { classifyPmPush, digestText, PM_DIGEST_WINDOW_MS, type DigestEntry } from "../lib/pm-digest.js";
import { PmDigestStore } from "../lib/pm-digest-store.js";
import { newMessageId, newThreadId, type Delivery, type Envelope, type LocalEndpoint } from "./router.js";

type Send = (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;
type Client = { ws: LocalEndpoint["ws"]; cwd?: string };
/** 摘要块记在信封上（同 pmTransfer）：押后重投 / 重启读回时按记录摘掉旧块重拼，不叠 */
type Digested = Envelope & { pmDigest?: { text: string }; pmTransfer?: { header?: string } };

const PM_DIGEST_LABEL = "pm-digest";
const TICK_MS = 60_000;

export interface PmDigestDeps { store: PmDigestStore; now(): number; agents(): RegistryAgent[] }

/** 正文去掉本模块加的摘要块（转交抬头留着） */
function stripDigest(env: Digested): void {
  const text = env.pmDigest?.text;
  if (text) env.content = env.content.replace(`${text}\n\n`, "").replace(text, "");
  delete env.pmDigest;
}

/** 归类看的正文：去掉转交抬头 */
function bodyOf(env: Digested): string {
  const h = env.pmTransfer?.header;
  return h && env.content.startsWith(`${h}\n`) ? env.content.slice(h.length + 1) : env.content;
}

/** 摘要块插在转交抬头之后、正文之前 */
function attach(env: Digested, text: string): void {
  const h = env.pmTransfer?.header, head = h && env.content.startsWith(`${h}\n`) ? `${h}\n` : "";
  const body = env.content.slice(head.length);
  env.content = `${head}${text}${body ? `\n\n${body}` : ""}`;
  env.pmDigest = { text };
}

const senderOf = (env: Envelope): string | undefined =>
  env.from.kind === "local" ? env.from.agentName : env.from.kind === "bridge" ? env.from.label : env.from.kind === "api" ? env.from.peer ?? env.from.name : undefined;
const reallySent = (d: Delivery): boolean => d.outcome.kind === "sent" && !d.outcome.note && !d.outcome.heldBy;

export class PmDigest {
  /** 已投出、押在 PM 队里的单独摘要（项目 → 押下时刻）：一个窗口内同项目不再起新的 */
  private readonly pending = new Map<string, number>();
  private latest?: { send: Send; db: Database; clients: Map<string, Client> };
  private timer?: ReturnType<typeof setInterval>;

  constructor(readonly deps: PmDigestDeps = { store: new PmDigestStore(), now: Date.now, agents: readRegistryAgentsSync }) {}

  /** deliverPmLocal 每次调用包一层；第一次调用顺带起定时器（bridge 重启后队列靠它按窗口送出） */
  wrap(send: Send, db: Database, project: string, clients: Map<string, Client>, startTimer = true): Send {
    this.latest = { send, db, clients };
    if (startTimer && !this.timer) {
      this.timer = setInterval(() => void this.tick().catch((e) => console.error("[pm-digest] tick", (e as Error).message)), TICK_MS);
      this.timer.unref?.();
    }
    return (env, to) => this.deliver(env as Digested, to, send, db, project);
  }

  private async deliver(env: Digested, to: LocalEndpoint, send: Send, db: Database, project: string): Promise<Delivery> {
    if (!to.agentName || activeProjectPm(db, project) !== to.agentName) return send(env, to);
    const { store, now } = this.deps, mode = store.mode(project), at = now();
    const verdict = classifyPmPush({ fromKind: env.from.kind, sender: senderOf(env), intent: env.intent,
      triggerKind: env.meta.triggerKind, oneShot: !!env.meta.skipInterAgentWatchdog, body: bodyOf(env) });
    const own = env.from.kind === "bridge" && env.from.label === PM_DIGEST_LABEL;
    if (mode !== "off" && !own) {
      const rec = { at, project, send: verdict.send, reason: verdict.reason, source: senderOf(env) ?? env.from.kind, mode,
        ...(verdict.send === "digest" ? { kind: verdict.kind } : {}) };
      if (mode === "on" && verdict.send === "digest") {
        store.record(rec, { id: env.meta.messageId, project, kind: verdict.kind, source: verdict.source,
          ...(verdict.card ? { card: verdict.card } : {}), firstLine: verdict.firstLine, at });
        return { envelope: env, outcome: { kind: "sent", note: "digest" } };
      }
      store.record(rec);
    }
    return this.sendWithDigest(env, to, send, project, own);
  }

  /** 立即送的一封：队里有就把摘要放在前面；真送到才出队，否则正文还原、条目留队 */
  private async sendWithDigest(env: Digested, to: LocalEndpoint, send: Send, project: string, own: boolean): Promise<Delivery> {
    stripDigest(env);
    const queued = this.deps.store.queued(project);
    if (!queued.length) {
      if (own) this.pending.delete(project);
      return own ? { envelope: env, outcome: { kind: "dropped", reason: "摘要队列已空" } } : send(env, to);
    }
    const before = env.content;
    attach(env, digestText(queued));
    const d = await send(env, to);
    if (reallySent(d)) {
      this.deps.store.remove(new Set(queued.map((e) => e.id)), this.deps.now());
      this.pending.delete(project);
      return d;
    }
    env.content = before;
    delete env.pmDigest;
    if (own && d.outcome.kind === "sent") this.pending.set(project, this.deps.now()); // 押在 PM 队里，Stop 后重投时再拼
    return d;
  }

  /** 队列到窗口（或开关已不是 on，剩的立刻送）：给项目当班 PM 单独送一条摘要 */
  async tick(): Promise<void> {
    const ctx = this.latest;
    if (!ctx) return;
    const { store, now } = this.deps, t = now(), projects = new Set(store.read().queue.map((e) => e.project));
    for (const project of projects) {
      const oldest = Math.min(...store.queued(project).map((e) => e.at));
      if (t - (this.pending.get(project) ?? -Infinity) < PM_DIGEST_WINDOW_MS || (store.mode(project) === "on" && t - oldest < PM_DIGEST_WINDOW_MS)) continue;
      const name = activeProjectPm(ctx.db, project);
      const agent = name ? this.deps.agents().find((a) => a.name === name && a.projectId === project) : undefined;
      const client = agent?.channelId ? ctx.clients.get(agent.channelId) : undefined;
      if (!name || !agent?.channelId || !client) continue; // PM 不在线：留队，下一轮再试
      const to: LocalEndpoint = { kind: "local", agentName: name, channelId: agent.channelId, ws: client.ws, cwd: client.cwd };
      const env: Envelope = { from: { kind: "bridge", label: PM_DIGEST_LABEL }, to, intent: "notification", content: "",
        meta: { messageId: newMessageId("pmdigest"), threadId: newThreadId(), ts: new Date(t).toISOString(), triggerKind: "bridge_synth",
          skipInterAgentWatchdog: true, waitForIdle: true } };
      await this.deliver(env as Digested, to, ctx.send, ctx.db, project);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export const pmDigest = new PmDigest();
