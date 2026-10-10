/**
 * 当班 PM 的推送摘要（agents-PMDIG1，docs/architecture/pm-digest.md）：包在 deliverPmLocal 的 send 外面，只看最终收件人是不是项目当班 PM。
 * - on：可合并的不投、进项目摘要队列（落盘）；有立即送的给这位 PM 时把队列摘要放在正文前一起送，真送到才出队；
 *   队列最早一条等满 PM_DIGEST_WINDOW_MS 单独送一条摘要。押后（进 PM 的押后队列，可能经 check_inbox 领走）：摘要留在信封上、
 *   条目记成被这封带走（carriedBy），这封送到 / 收件箱确认时按它实际带着的那份出队，作罢回队；失败 / 离线就把正文还原、条目留队。
 * - observe：照常逐条投（env 原样），只记「本来会合并」；off：不记不排。开关切走后队里剩的照常送出。
 */
import type { Database } from "bun:sqlite";
import { createKeyedSerial } from "../lib/keyed-serial.js";
import { activeProjectPm } from "../lib/pm-role.js";
import { readRegistryAgentsSync, type RegistryAgent } from "../lib/registry.js";
import { classifyPmPush, digestText, PM_DIGEST_LABEL, PM_DIGEST_WINDOW_MS } from "../lib/pm-digest.js";
import { PmDigestStore } from "../lib/pm-digest-store.js";
import { heldMessageIds, onHeldSettled, type HeldOutcome } from "./held-queue.js";
import { ledgerDb } from "./ledger-feed.js";
import { newMessageId, newThreadId, type Delivery, type Envelope, type LocalEndpoint } from "./router.js";

type Send = (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;
type Client = { ws: LocalEndpoint["ws"]; cwd?: string };
/** 摘要块记在信封上（同 pmTransfer，随押后队列落盘）：ids = 这份摘要带着的条目；押后重投 / 重启读回时按记录摘掉旧块重拼，不叠 */
type Digested = Envelope & { pmDigest?: { text: string; ids?: string[] }; pmTransfer?: { header?: string } };

const TICK_MS = 60_000;

/** heldIds：押后队列盘上还有的 message_id（带走条目的信封不在里面了就把条目放回队） */
export interface PmDigestDeps { store: PmDigestStore; now(): number; agents(): RegistryAgent[]; db(): Database | null; heldIds(): Set<string> }
/** 单独摘要的发送入口：bridge 启动时 initTeamRouter 交来的 router deliver（不带任何押后条目的撤销条件）与连接表 */
export interface PmDigestRouter { clients: Map<string, Client>; deliver(env: Envelope): Promise<Delivery> }
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
function attach(env: Digested, text: string, ids: string[]): void {
  const h = env.pmTransfer?.header, head = h && env.content.startsWith(`${h}\n`) ? `${h}\n` : "";
  const body = env.content.slice(head.length);
  env.content = `${head}${text}${body ? `\n\n${body}` : ""}`;
  env.pmDigest = { text, ids };
}

const senderOf = (env: Envelope): string | undefined =>
  env.from.kind === "local" ? env.from.agentName : env.from.kind === "bridge" ? env.from.label : env.from.kind === "api" ? env.from.peer ?? env.from.name : undefined;
const reallySent = (d: Delivery): boolean => d.outcome.kind === "sent" && !d.outcome.note && !d.outcome.heldBy;
const heldInPmQueue = (d: Delivery): boolean => d.outcome.kind === "sent" && (d.outcome.note === "queued" || !!d.outcome.heldBy);

export class PmDigest {
  /** 已投出、押在 PM 队里的单独摘要（项目 → 押下时刻）：一个窗口内同项目不再起新的 */
  private readonly pending = new Map<string, number>();
  /** 按项目串行：读队列、拼摘要、发送、真送到出队是一个整体，并发的立即送 / 定时摘要不会各带一份 */
  private readonly serial = createKeyedSerial();
  private router?: PmDigestRouter;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private unsettle?: () => void;

  constructor(readonly deps: PmDigestDeps = {
    store: new PmDigestStore(), now: Date.now, agents: readRegistryAgentsSync, db: ledgerDb, heldIds: () => heldMessageIds(),
  }) {}

  /** bridge 启动时调一次（initTeamRouter 里一行）：挂上稳定发送入口并起定时器，重启后队列不靠新流量也按窗口送出 */
  start(router: PmDigestRouter, timer = true): void {
    this.router = router;
    this.unsettle ??= onHeldSettled((env, outcome) => this.settled(env as Digested, outcome));
    if (!timer || this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick().catch((e) => console.error("[pm-digest] tick", (e as Error).message)).finally(() => (this.ticking = false));
    }, TICK_MS);
    this.timer.unref?.();
  }

  /** deliverPmLocal 每次调用包一层 */
  wrap(send: Send, db: Database, project: string): Send {
    return (env, to) => this.deliver(env as Digested, to, send, db, project);
  }

  private async deliver(env: Digested, to: LocalEndpoint, send: Send, db: Database, project: string): Promise<Delivery> {
    if (!to.agentName || activeProjectPm(db, project) !== to.agentName) return this.release(env), send(env, to); // 摘要只给当班 PM
    const own = env.from.kind === "bridge" && env.from.label === PM_DIGEST_LABEL;
    if (!own) {
      try {
        if (this.classify(env, project)) return { envelope: env, outcome: { kind: "sent", note: "digest" } };
      } catch (e) {
        console.error("[pm-digest] 状态写不进，这条照常立即送:", (e as Error).message); // 损坏的状态文件拒写：宁可叫醒，不吞
      }
    }
    return this.serial(project, () => this.sendWithDigest(env, to, send, project, own));
  }

  /** 记归类；on 且可合并就入队并返回 true（不投） */
  private classify(env: Digested, project: string): boolean {
    const { store, now } = this.deps, mode = store.mode(project), at = now();
    if (mode === "off") return false;
    const verdict = classifyPmPush({ fromKind: env.from.kind, sender: senderOf(env), intent: env.intent,
      triggerKind: env.meta.triggerKind, oneShot: !!env.meta.skipInterAgentWatchdog, body: bodyOf(env) });
    const rec = { at, project, send: verdict.send, reason: verdict.reason, source: senderOf(env) ?? env.from.kind, mode,
      ...(verdict.send === "digest" ? { kind: verdict.kind } : {}) };
    if (mode !== "on" || verdict.send !== "digest") return store.record(rec), false;
    store.record(rec, { id: env.meta.messageId, project, kind: verdict.kind, source: verdict.source,
      ...(verdict.card ? { card: verdict.card } : {}), firstLine: verdict.firstLine, at });
    return true;
  }
  /** 信封上这封带着的摘要摘掉、条目回队（重投时重拼 / 改投给了别人） */
  private release(env: Digested): void {
    if (!env.pmDigest) return;
    stripDigest(env);
    try {
      this.deps.store.settle(env.meta.messageId, new Set(), this.deps.now());
    } catch (e) {
      console.error("[pm-digest] 条目回队写不进（状态文件损坏），这封照常投:", (e as Error).message);
    }
  }

  /**
   * 立即送的一封：队里有就把摘要放在前面，投出前先把条目记成被这封带走。真送到出队；押在 PM 队里（盘上就是带摘要的这份，
   * 可能经 check_inbox 领走）就让它带着，等押后队列报结局（settled）；其余没送到的正文还原、条目回队
   */
  private async sendWithDigest(env: Digested, to: LocalEndpoint, send: Send, project: string, own: boolean): Promise<Delivery> {
    const { store, now } = this.deps, id = env.meta.messageId;
    this.release(env);
    const queued = store.queued(project);
    if (!queued.length) {
      if (own) this.pending.delete(project);
      return own ? { envelope: env, outcome: { kind: "dropped", reason: "摘要队列已空" } } : send(env, to);
    }
    const before = env.content, ids = new Set(queued.map((e) => e.id));
    attach(env, digestText(queued), [...ids]);
    store.carry(ids, id, now());
    const d = await send(env, to);
    if (reallySent(d)) {
      store.remove(ids, now());
      this.pending.delete(project);
    } else if (heldInPmQueue(d)) {
      store.carry(ids, id, now()); // 期间 tick 的 reconcile 可能先放回过：押下后盘上已有这封，重记一次
      if (own) this.pending.set(project, now()); // 单独摘要押着：一个窗口内同项目不再起新的
    } else {
      env.content = before;
      delete env.pmDigest;
      store.settle(id, new Set(), now());
    }
    return d;
  }

  /** 押后队列报结局：送到（Stop 重投 / check_inbox 确认）= 收件方看到的就是信封上那份，按它出队；作罢则回队 */
  private settled(env: Digested, outcome: HeldOutcome): void {
    try {
      const { store, now } = this.deps, id = env.meta.messageId;
      if (!store.read().queue.some((e) => e.carriedBy === id)) return;
      store.settle(id, new Set(outcome === "delivered" ? env.pmDigest?.ids ?? [] : []), now());
    } catch (e) {
      console.error("[pm-digest] 押后结局回写失败:", (e as Error).message);
    }
  }

  /** 队列到窗口（或开关已不是 on，剩的立刻送）：经稳定发送入口给项目当班 PM 单独送一条摘要（正文由 wrap 在项目锁里现拼） */
  async tick(): Promise<void> {
    const router = this.router, db = this.deps.db();
    if (!router || !db) return;
    const { store, now } = this.deps, t = now(), live = this.deps.heldIds();
    store.reconcile((id) => live.has(id), t);
    const queue = store.read().queue.filter((e) => !e.carriedBy);
    for (const project of new Set(queue.map((e) => e.project))) {
      const oldest = Math.min(...queue.filter((e) => e.project === project).map((e) => e.at));
      if (t - (this.pending.get(project) ?? -Infinity) < PM_DIGEST_WINDOW_MS || (store.mode(project) === "on" && t - oldest < PM_DIGEST_WINDOW_MS)) continue;
      const name = activeProjectPm(db, project);
      const agent = name ? this.deps.agents().find((a) => a.name === name && a.projectId === project) : undefined;
      const client = agent?.channelId ? router.clients.get(agent.channelId) : undefined;
      if (!name || !agent?.channelId || !client) continue; // PM 不在线：留队，下一轮再试
      const to: LocalEndpoint = { kind: "local", agentName: name, channelId: agent.channelId, ws: client.ws, cwd: client.cwd };
      await router.deliver({ from: { kind: "bridge", label: PM_DIGEST_LABEL }, to, intent: "notification", content: "",
        meta: { messageId: newMessageId("pmdigest"), threadId: newThreadId(), ts: new Date(t).toISOString(), triggerKind: "bridge_synth",
          skipInterAgentWatchdog: true, waitForIdle: true } });
    }
  }

  stop(): void {
    this.unsettle?.();
    this.unsettle = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export const pmDigest = new PmDigest();
