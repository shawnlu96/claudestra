/**
 * agent→agent 消息的押后队列（目标在回合中就不 ws.send，等 Stop / 压缩结束 / 每分钟扫描再投；为什么要押见 bridge.ts
 * heldLocalMsgs 的注释）。这里管三件事，别的仍在 bridge.ts：
 *   1. 落盘：~/.claude-orchestrator/held-messages.json，bridge 重启不丢（ws 不落盘，投递时按 channelId 取最新连接）
 *   2. 不按时间丢：押满 30 分钟只告诉发送方一声「还在排队」，消息留着等目标这一轮结束；押满 24 小时才放弃并通知——
 *      Autopilot 让一轮能跑一两个小时，以前 30 分钟就扔会让同事的回复全丢（2026-09-28 codex 的 10 条复核就是这么没的）
 *   3. 投出之后才出队：投递中途崩溃，重启后会再投一次（至少一次；收件方看 message_id 去重）；每个频道只有一个投递者
 */
import type { Envelope, LocalEndpoint } from "./router.js";
import { HELD_MESSAGES_PATH } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { emitHeldToWeb } from "./held-web.js";
import { isOwnerSource } from "../lib/delegate-marker.js";
import { ownedHeldItems } from "./pm-held-transfer.js";
import { heldIdleBatches, heldIdleScopeKey, isInternalIdleNotice, validHeldIdleScope, type HeldIdleBatch, type HeldIdleScope } from "../lib/held-idle-batch.js";

export interface HeldIdleControl {
  mode: "on" | "observe" | "off";
  /** Resolve from authenticated routing/registry state. Undefined means no proof; labels and body text confer no permission. */
  scope: (item: HeldItem) => HeldIdleScope | undefined;
  /** Recheck session, project permission, quota, compaction and stopped notices at the point of use. Busy alone is allowed for inbox reads. */
  canTake: (item: HeldItem, scope: HeldIdleScope) => boolean;
  /** Supply the existing real-delivery callback (e.g. team notice provenance); called once per acknowledged message. */
  delivered: (channelId: string, env: Envelope) => void;
}

export interface HeldItem {
  env: Envelope;
  to: LocalEndpoint;
  heldAt: number;
  /** 已经告诉过发送方「还在排队」的时刻 */
  notifiedAt?: number;
  /** 被 check_inbox 领走、还没确认（bridge/inbox.ts）：租约内 Stop 不再投，过期后照常投 */
  lease?: { batchId: string; at: number; idleScope?: HeldIdleScope };
  /** Successful web mirror for this inbox batch; separate from the authority/ownership lease. */
  inboxMirrorBatch?: string;
  /** 为什么押：额度闸（bridge/quota-wall.ts）押的不老化（撞周额度一押就是一两天），出闸时由恢复流程按序补投 */
  reason?: "quota_wall";
}

/** check_inbox 领走后多久没确认就重新投递（按普通消息在回合结束时送达，message_id 不变） */
export const INBOX_LEASE_MS = 15 * 60_000;
export const leaseActive = (i: HeldItem, now = Date.now()): boolean => !!i.lease && now - i.lease.at < INBOX_LEASE_MS;

/**
 * 押在 target 队里、它还没看到的消息各是谁发的（回程簿判「请求送到它手上没有」用，lib/held-pac.ts）。
 * check_inbox 领走的算看到了，哪怕还没 ack——否则 agent 读完就答，答复会被当成「请求还押着」而不算数（codex 2026-09-28 复核）。
 */
export function unseenFrom(q: HeldQueue, target: string): { fromKind: string; fromChannelId?: string; messageId?: string }[] | undefined {
  return q.get(target)?.filter((i) => !i.lease).map((i) => ({
    fromKind: i.env.from.kind, fromChannelId: i.env.from.kind === "local" ? i.env.from.channelId : undefined, messageId: i.env.meta.messageId,
  }));
}

/**
 * 押后条目的来源类别（check_inbox 能领哪些、谁排批首，reply 结果的押后提醒按它数）：卡片答复（ask_answer）、owner 本人、
 * peer、本机 agent；其余（bridge 通知、guest）是 other——check_inbox 不领，留给 Stop / 扫描按原规则投（班子通知要走送达回调）
 */
export type HeldKind = "ask" | "owner" | "peer" | "agent" | "other";
export function heldKindOf(env: Envelope): HeldKind {
  if (env.meta.triggerKind === "ask_answer") return "ask";
  if (isOwnerSource(env.from)) return "owner";
  if (env.from.kind === "api" && env.from.peer) return "peer";
  return env.from.kind === "local" ? "agent" : "other";
}
export const inboxTakeable = (i: HeldItem): boolean => heldKindOf(i.env) !== "other";

/** 各类别押着、check_inbox 还领得到（没在租约里）的条数，只列非零的；没有 = {}（reply 结果据此一字不加） */
export type HeldTally = Partial<Record<Exclude<HeldKind, "other">, number>>;
export function heldTally(items: readonly HeldItem[] | undefined, now = Date.now()): HeldTally {
  const out: HeldTally = {};
  for (const i of items ?? []) {
    const k = heldKindOf(i.env);
    if (k !== "other" && !leaseActive(i, now)) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export const HELD_NOTIFY_MS = 30 * 60_000;
export const HELD_GIVE_UP_MS = 24 * 3_600_000;

const HELD_PATH = HELD_MESSAGES_PATH;
const isQueue = (q: unknown): boolean => Array.isArray(q) && q.every((i) => i && typeof i === "object" && "env" in i && "to" in i);

/** 押后条目的结局：送达 / 押满 24 小时放弃 / 目标被 kill 丢弃。talk 的「丢进工作台」据此同步 drops 的状态（bridge/talk.ts） */
export type HeldOutcome = "delivered" | "gave-up" | "discarded";
const settledListeners = new Set<(env: Envelope, outcome: HeldOutcome) => void>();
export function onHeldSettled(l: (env: Envelope, outcome: HeldOutcome) => void): () => void {
  settledListeners.add(l);
  return () => settledListeners.delete(l);
}
export function notifyHeldSettled(env: Envelope, outcome: HeldOutcome): void {
  if (outcome !== "delivered") emitHeldToWeb(env, "dropped"); // 送达由投递时的 chat_message(in) 报，这里只补作罢
  for (const l of settledListeners) {
    try {
      l(env, outcome);
    } catch (e) {
      console.error(`⚠️ 押后结局的监听出错（不影响押后队列本身）: ${(e as Error).message}`);
    }
  }
}

/** 一个 Map（bridge.ts 原来的用法不变），set / delete 之后同步落盘；path = null 不落盘（单测） */
export class HeldQueue extends PersistedMap<HeldItem[]> {
  constructor(path: string | null = HELD_PATH, private idleControl?: HeldIdleControl) {
    super(path, "押后消息", isQueue);
    for (const [ch, items] of [...this.entries()]) if (!items.length) this.deleteQuiet(ch);
    const n = [...this.values()].reduce((s, q) => s + q.length, 0);
    if (n) console.log(`♻️ 恢复押后消息 ${n} 条（bridge 重启前没投出去的）`);
  }

  /** Explicit, instance-local opt-in; reuse the held store and leases without introducing production configuration. */
  configureIdleBatch(control?: HeldIdleControl): void { this.idleControl = control; }

  private idleScope(item: HeldItem, now = Date.now()): HeldIdleScope | undefined {
    if (!this.idleControl || this.idleControl.mode === "off" || item.reason === "quota_wall" || !isInternalIdleNotice(item)) return undefined;
    try {
      const scope = this.idleControl.scope(item);
      return validHeldIdleScope(item, scope) && (!leaseActive(item, now) || this.inboxAckable(item))
        && this.idleControl.canTake(item, scope) ? scope : undefined;
    } catch (e) {
      console.error(`⚠️ 内部通知权限核对失败，保留原消息: ${String(e)}`);
      return undefined;
    }
  }

  /** Known-but-stale or gated internal sources must not fall through to the legacy agent allowance. */
  idleInboxAllowed(item: HeldItem, now = Date.now()): boolean | undefined {
    if (this.idleControl?.mode !== "on" || !isInternalIdleNotice(item)) return undefined;
    try {
      const scope = this.idleControl.scope(item);
      if (!scope) return leaseActive(item, now) && item.lease?.idleScope ? false : undefined;
      return item.reason !== "quota_wall" && validHeldIdleScope(item, scope) && (!leaseActive(item, now) || this.inboxAckable(item))
        && this.idleControl.canTake(item, scope);
    } catch (e) {
      console.error(`⚠️ 内部通知领取核对失败，保留原消息: ${String(e)}`);
      return false;
    }
  }

  inboxLease(item: HeldItem, batchId: string, at: number): void {
    const scope = this.idleControl?.mode === "on" ? this.idleScope(item, at) : undefined;
    item.lease = { batchId, at, ...(scope ? { idleScope: scope } : {}) };
  }

  /** Ack stays tied to the original authority even after expiry; only acquisition may replace an expired scope. */
  inboxAckable(item: HeldItem): boolean {
    const original = item.lease?.idleScope;
    if (!original) return true;
    try {
      const current = this.idleControl?.scope(item);
      return validHeldIdleScope(item, current) && heldIdleScopeKey(current) === heldIdleScopeKey(original);
    } catch (e) {
      console.error(`⚠️ 内部通知确认权限核对失败，保留原消息: ${String(e)}`);
      return false;
    }
  }

  /** Observe constructs the same candidate batches without acquiring or changing messages. */
  idleBatches(channelId: string, now = Date.now()): HeldIdleBatch<HeldItem>[] {
    return heldIdleBatches((this.get(channelId) ?? []).filter((i) => !leaseActive(i, now)), (i) => this.idleScope(i, now));
  }

  /** Use the same partition in inbox and release construction. Legacy inbox kinds retain their existing path. */
  inboxPartition(items: HeldItem[], now = Date.now()): HeldItem[] {
    if (this.idleControl?.mode !== "on" || !items.length) return items;
    const groups = heldIdleBatches(items, (i) => this.idleScope(i, now));
    const first = groups.find((g) => g.items.includes(items[0]));
    return first ? first.items : items.filter((i) => !groups.some((g) => g.items.includes(i)));
  }

  /** A release adapter owns this existing channel lock through its final send. It must use stillWanted after every await. */
  async withIdleBatch<T>(channelId: string, release: (batch: HeldIdleBatch<HeldItem>, stillWanted: () => boolean) => Promise<T>, now = Date.now()): Promise<T | undefined> {
    if (this.idleControl?.mode !== "on" || !this.claim(channelId)) return undefined;
    try {
      const batch = this.idleBatches(channelId, now)[0];
      if (!batch) return undefined;
      const key = heldIdleScopeKey(batch.scope);
      const wanted = () => this.idleControl?.mode === "on" && batch.items.every((i) => {
        const scope = this.idleScope(i, now);
        return this.get(channelId)?.includes(i) && !leaseActive(i, now) && !!scope && heldIdleScopeKey(scope) === key;
      });
      return await release(batch, wanted);
    } finally { this.release(channelId); }
  }

  /** Ack is the receipt, not lease acquisition. Callback failure cannot justify delivering the same receipt twice. */
  inboxDelivered(channelId: string, item: HeldItem): void {
    notifyHeldSettled(item.env, "delivered");
    if (!item.lease?.idleScope) return;
    try { this.idleControl?.delivered(channelId, item.env); }
    catch (e) { console.error(`⚠️ 内部通知送达回调失败（消息已确认）: ${String(e)}`); }
  }

  override set(channelId: string, items: HeldItem[]): this {
    if (items.length) return super.set(channelId, items);
    this.delete(channelId);
    return this;
  }

  /**
   * 追加一条并落盘，返回这个频道排队的条数。同一封（同一个 env 对象）已在队里就不再加：
   * flush 投到一半目标又忙，deliverToLocal 会把正在投的那条再 hold 一次——原条目留着，首次入队 / 提醒时间不被刷新。
   * 不按 messageId 认：同一条 Discord 消息上的两次按钮点击 messageId 相同，是两封（tests/held-queue.test.ts）。
   * 换新数组不原地 push：flush 遍历的快照不受影响。
   */
  hold(channelId: string, item: HeldItem): number {
    const cur = this.get(channelId) ?? [];
    const same = cur.find((i) => i.env === item.env);
    if (same) {
      // 闸前因「回合中」押着的，闸内再被押回来就改记成额度闸：不再老化、出闸时一起补投
      if (item.reason && !same.reason) {
        same.reason = item.reason;
        this.set(channelId, [...cur]);
      }
      return cur.length;
    }
    const q = [...cur, item];
    this.set(channelId, q);
    emitHeldToWeb(item.env, "queued"); // 只在新入队时报：flush 押回同一封不再报
    return q.length;
  }

  /** 目标被 kill：整个频道的押后消息丢掉，逐条通知结局 */
  discard(channelId: string): boolean {
    for (const i of this.get(channelId) ?? []) notifyHeldSettled(i.env, "discarded");
    return this.delete(channelId);
  }

  /** 已在队里的这一封改过 meta（如停字的已记标记）：整队重写一次盘。hold 认出同一封时不落盘，改动不写回就会在重启后丢 */
  rewrite(env: Envelope): void {
    const ch = (env.to as LocalEndpoint).channelId;
    const q = this.get(ch);
    if (q?.some((i) => i.env === env)) this.set(ch, [...q]);
  }

  /** 放到队首（T63：channel-server 的第二道闸退回的那条，它本该最早送达）；同一封已在队里就不动 */
  holdFirst(env: Envelope): number {
    const to = env.to as LocalEndpoint;
    const cur = this.get(to.channelId) ?? [];
    if (cur.some((i) => i.env === env)) return cur.length;
    const q = [{ env, to, heldAt: Date.now() }, ...cur];
    this.set(to.channelId, q);
    emitHeldToWeb(env, "queued"); // 投出去（网页已见送达）又被退回：重新标排队
    return q.length;
  }

  /** 按信封的收件方押后，入队时间取现在 */
  holdEnv(env: Envelope, reason?: HeldItem["reason"]): number {
    const to = env.to as LocalEndpoint;
    return this.hold(to.channelId, { env, to, heldAt: Date.now(), ...(reason ? { reason } : {}) });
  }

  /**
   * 闸内把这个频道里还押着的非人类消息改记成额度闸（flush 时调）：闸前因「回合中」押下的、caller 不在线时押的推回、
   * asks 的押后都不经过 holdForQuotaWall，不改记的话它们照普通消息老化——30 分钟唤醒撞着墙的发送方，24 小时被丢
   */
  markWall(channelId: string, pick: (i: HeldItem) => boolean): number {
    const q = this.get(channelId) ?? [];
    const hit = q.filter((i) => !i.reason && pick(i));
    for (const i of hit) i.reason = "quota_wall";
    if (hit.length) this.set(channelId, [...q]);
    return hit.length;
  }

  /** 这个频道还押着（没送到 agent 手上）的消息 id：挂在它们上的 API 请求不能被别的回合结掉（bridge/stop-settle.ts takeApiWaiters） */
  ids(channelId: string): Set<string> {
    return new Set((this.get(channelId) ?? []).map((i) => i.env.meta.messageId));
  }

  /** 这个频道押着、check_inbox 领得到的各类条数（bridge 回 reply 结果时带上，lib/reply-ask-schema.ts 写成提醒） */
  stat(channelId: string): HeldTally {
    return heldTally(ownedHeldItems(this, channelId));
  }

  /** 额度闸押着的条数，人发的和 agent / bridge 消息分开数（横幅和进闸通知分开写） */
  wallCount(isHuman: (env: Envelope) => boolean = () => false): { human: number; agent: number } {
    const all = [...this.values()].flat().filter((i) => i.reason === "quota_wall");
    const human = all.filter((i) => isHuman(i.env)).length;
    return { human, agent: all.length - human };
  }

  /** 有额度闸消息（给了 pick = 其中有 pick 命中的）的频道，按各自最早一条的入队时间排（出闸补投的顺序） */
  wallChannels(pick: (i: HeldItem) => boolean = () => true): string[] {
    const first = (q: HeldItem[]) => Math.min(...q.filter((i) => i.reason === "quota_wall").map((i) => i.heldAt));
    return [...this.entries()].filter(([, q]) => q.some((i) => i.reason === "quota_wall" && pick(i))).sort((a, b) => first(a[1]) - first(b[1])).map(([c]) => c);
  }

  /** 出闸：额度闸消息转回普通押后，入队时间重置为 now（否则押了一天的立刻被 24 小时放弃），返回条数 */
  releaseWall(now: number): number {
    let n = 0;
    for (const [ch, q] of [...this.entries()]) {
      if (!q.some((i) => i.reason === "quota_wall")) continue;
      for (const i of q) {
        if (i.reason !== "quota_wall") continue;
        delete i.reason;
        i.heldAt = now;
        n++;
      }
      this.set(ch, [...q]);
    }
    return n;
  }

  /** 投出去之后才摘掉并落盘：投递中途崩溃 / 别处 set 触发整表落盘时，盘上都还有它（至少投一次，收件方看 message_id 去重） */
  remove(channelId: string, item: HeldItem): void {
    this.set(channelId, (this.get(channelId) ?? []).filter((i) => i !== item));
  }

  /** 每个频道同一时刻只允许一个投递者（Stop / 压缩结束 / 每分钟扫描可能撞在一起，否则同一条会投两次）。进程内状态，不落盘 */
  private readonly flushing = new Set<string>();
  claim(channelId: string): boolean {
    if (this.flushing.has(channelId)) return false;
    this.flushing.add(channelId);
    return true;
  }
  release(channelId: string): void {
    this.flushing.delete(channelId);
  }
}

export type HeldNotice = { kind: "still-queued" | "gave-up"; item: HeldItem; channelId: string };

/**
 * 每分钟扫描时调：押满 30 分钟、还没通知过的 → still-queued（只发一次）；押满 24 小时 → 出队并 gave-up。
 * 返回要发给发送方的通知，发不发、怎么发由 bridge 决定（它手里有 clients）。
 */
export function ageHeld(q: HeldQueue, now: number, paused: boolean | ((item: HeldItem) => boolean) = false): HeldNotice[] {
  const out: HeldNotice[] = [];
  // 额度闸开着时发送方是 Claude Code 的停摆（paused）：提醒是直接 ws.send 给发送方的，它也撞着墙，提醒只会唤醒一个注定失败的回合
  if (paused === true) return out;
  for (const [channelId, items] of [...q.entries()]) {
    const keep: HeldItem[] = [];
    let changed = false;
    for (const item of items) {
      if (item.reason === "quota_wall" || (paused && paused(item))) {
        keep.push(item); // 额度闸押的不提醒、不放弃：发送方多半也撞着墙，提醒只会唤醒一个注定失败的回合
        continue;
      }
      if (now - item.heldAt > HELD_GIVE_UP_MS) {
        out.push({ kind: "gave-up", item, channelId });
        notifyHeldSettled(item.env, "gave-up");
        changed = true;
        continue;
      }
      if (now - item.heldAt > HELD_NOTIFY_MS && !item.notifiedAt) {
        item.notifiedAt = now;
        out.push({ kind: "still-queued", item, channelId });
        changed = true;
      }
      keep.push(item);
    }
    if (changed) q.set(channelId, keep);
  }
  return out;
}

/** 通知发送方的话（bridge.ts 包成 system notification 发到发送方的 ws） */
export function heldNoticeText(n: HeldNotice, human?: "owner" | "stranger"): string {
  const who = n.item.to.agentName || n.channelId;
  if (human) {
    const why = human === "owner" ? "它一直不空闲、停在额度菜单 / 自动续跑倒计时上，或不在线" : "对方一直无法接收"; // 额度状态只告诉 owner（canSeeQuota 同口径）
    return `⚠️ [bridge] 你发给 ${who} 的消息排了 24 小时仍没送到（${why}），已放弃，没有发任何键。`
      + `如仍需要请重发。原文：\n${String(n.item.env.content).slice(0, 1500)}`;
  }
  const head = String(n.item.env.content).slice(0, 150);
  return n.kind === "still-queued"
    ? `[⏳ bridge] 你发给 ${who} 的消息已排队 30 分钟：对方一直在一个长回合里，这一轮结束就会送到，不用重发。原文开头: ${head}`
    : `[⚠️ bridge] 你发给 ${who} 的消息排了 24 小时仍没送到（对方一直不空闲或不在线），已放弃。如仍需要，请重发。原文开头: ${head}`;
}

/** 落盘队列里全部信封的 messageId：bridge 重启后核对「占了位却不在队里」的 drops（lib/talk-drops.ts failOrphanHeld） */
export function heldMessageIds(path: string = HELD_PATH): Set<string> {
  const r = readJsonStateSync(path);
  const out = new Set<string>();
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return out;
  for (const q of Object.values(r.data as Record<string, unknown>)) {
    if (isQueue(q)) for (const i of q as HeldItem[]) if (i.env?.meta?.messageId) out.add(i.env.meta.messageId);
  }
  return out;
}

/** 各频道排队中的 agent 消息数（网页侧栏「排队 N 条」）：直接读落盘文件——队列每次变动都同步落盘，不用碰 bridge 的内存 */
export function heldAgentCounts(path: string = HELD_PATH): Record<string, number> {
  const r = readJsonStateSync(path);
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return {};
  const out: Record<string, number> = {};
  for (const [ch, q] of Object.entries(r.data as Record<string, unknown>)) {
    const n = isQueue(q) ? (q as HeldItem[]).filter((i) => i.env?.from?.kind === "local").length : 0;
    if (n) out[ch] = n;
  }
  return out;
}
