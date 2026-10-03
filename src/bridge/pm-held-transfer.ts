/**
 * PM 切换后押后消息的转交（bridge/local-api/project-pm-delivery.ts 写标记、bridge/held-flush.ts 交归属）：
 * 旧 PM A 队里的一封转给当班 PM B，B 忙时进了 B 队——这之后 A 队那条就不再是可投递归属，否则每次扫描 A 都把它再转给 B、
 * 抬头一层层叠（tests/project-pm-held-transfer.test.ts）。
 * 抬头只认信封上 bridge 自己记下的转交记录（和 to 并列、随押后队列落盘），不认正文里长得像的字；原正文逐字保留。
 * 不放进 meta：meta 是消息本身的元数据，转交后要原样保留（tests/pm-role.test.ts intact reply metadata）。
 */
import type { Delivery, DeliveryOutcome, Envelope } from "./router.js";
import type { HeldItem, HeldQueue } from "./held-queue.js";
import { isOwnerSource } from "../lib/delegate-marker.js";

/** Trust the entry-point source, never body text; forwarded messages and peer replies still follow the PM role. */
export function isHumanDirect(env: Envelope): boolean {
  return isOwnerSource(env.from) && !env.meta.forwarded && env.meta.triggerKind !== "peer_http";
}

/** 记在 env.pmTransfer：转给了哪个频道、正文前加的抬头原样（legacy = 旧版转交过，抬头已在正文里但没有记录，不再加） */
interface PmTransfer { from: string; to: string; header: string; legacy?: true }
type Transferred = Envelope & { pmTransfer?: PmTransfer };

const pmTransferOf = (env: Envelope): PmTransfer | undefined => (env as Transferred).pmTransfer;

/** 抬头之下的原正文：只剥标记里记的那一行抬头，正文本身哪怕以同样的字开头也不动 */
function bodyOf(env: Envelope): string {
  const t = pmTransferOf(env);
  return t && t.header && env.content.startsWith(`${t.header}\n`) ? env.content.slice(t.header.length + 1) : env.content;
}

/**
 * 给转交的信封换上（不是叠上）这一次的抬头并记标记。addressed = 这次投递的原收件频道（押后条目的 item.to）：
 * 信封的收件方已不是它、又没有标记 = 旧版代码转交过（抬头已在正文里），只补标记不再加字
 */
export function markPmTransfer(env: Envelope, addressed: string, target: string, header: string): void {
  const t = env as Transferred;
  // 记成 legacy 的一直按 legacy：正文里那层旧抬头没有可信记录，不剥也不再叠（报错重试、重启读回、再换一任 PM 都一样）
  if (t.pmTransfer?.legacy || (!t.pmTransfer && env.to.kind === "local" && env.to.channelId !== addressed)) {
    t.pmTransfer = { from: addressed, to: target, header: "", legacy: true };
    return;
  }
  env.content = `${header}\n${bodyOf(env)}`;
  t.pmTransfer = { from: addressed, to: target, header };
}

/**
 * 这一封不转交、投给原收件人（人类直聊、前任自己的回程）：之前被转过（押后重投、旧版原地改过 env.to）就把收件方改回来——
 * 目标忙时 deliverToLocal 按 env.to 押队，不改回去就押进了新 PM 的队。记录过的抬头一并摘掉（只摘记录里那一行）；
 * legacy 的抬头在正文里、没有可信记录，正文不动、标记留着，免得以后再转时又叠一层
 */
export function undoPmTransfer(env: Envelope, to: Envelope["to"]): void {
  if (env.to.kind !== "local" || to.kind !== "local" || env.to.channelId === to.channelId) return;
  const t = env as Transferred;
  if (t.pmTransfer && !t.pmTransfer.legacy) {
    env.content = bodyOf(env);
    delete t.pmTransfer;
  }
  env.to = to;
}

/** 转交没能送到、也没进新 PM 的队（新 PM 离线等）：flush 按报错处理，原条目留在旧队等下次，不当成已投出摘掉 */
const retryable = new WeakSet<DeliveryOutcome>();
export function retryLater(d: Delivery): Delivery {
  retryable.add(d.outcome);
  return d;
}
export const shouldRetry = (d: Delivery): boolean => retryable.has(d.outcome);

/** 这次投递把 channelId 队里的这一条转进了新 PM 的押后队列（同一封已在那边排着）：旧队的归属可以交出去了 */
export function handedOver(held: HeldQueue, channelId: string, item: HeldItem, r: Delivery): boolean {
  const to = r.envelope.to, t = pmTransferOf(item.env);
  if (r.envelope !== item.env || to.kind !== "local" || to.channelId === channelId || t?.to !== to.channelId) return false;
  return !!held.get(to.channelId)?.some((i) => i.env === item.env);
}

const sameLetter = (a: Envelope, b: Envelope): boolean => {
  const who = (e: Envelope) => (e.from.kind === "local" ? `local:${e.from.channelId}` : e.from.kind === "api" ? `api:${e.from.tokenId}`
    : e.from.kind === "user" ? `user:${e.from.userId}` : `${e.from.kind}:${e.from.label ?? ""}`);
  return a.meta.messageId === b.meta.messageId && a.meta.threadId === b.meta.threadId && a.meta.ts === b.meta.ts
    && a.intent === b.intent && who(a) === who(b);
};

/**
 * 存量：旧版代码（或交接途中崩溃）留下的 A/B 双队——A 队条目的信封已转给 B（env.to=B），B 队也押着同一封。
 * B 队有对应的一条（同一对象，或重启后读回的同一封：messageId / thread / ts / intent / 发送方都相同）：角色通知摘 A，人类直聊摘 B。
 * 一条对一条配对，同一 messageId 的两次合法点击各配各的。B 队没有对应的不摘：按新规则再转一次（不再加抬头），成功即交出。
 * 任何一个频道 flush 之前都把所有频道对一遍（不只扫到的这个）：B 先投掉自己那份之后 A 再扫就找不到 twin 了，
 * 只扫 A 的话结果随扫描先后变（B 先投 → A 那份又转给 B 一次）。返回原目标无法证明、须保留待诊断的直聊条目。
 */
export function adoptStrandedTransfers(held: HeldQueue): Set<HeldItem> {
  const unresolved = unresolvedDirectTransfers(held);
  for (const channelId of [...held.keys()]) adoptIn(held, channelId, unresolved);
  return unresolved;
}

/** Inbox reads, acknowledgements and reply tallies must use the same ownership recovery as flush, including leased entries. */
export function ownedHeldItems(held: HeldQueue, channelId: string): HeldItem[] {
  const unresolved = adoptStrandedTransfers(held);
  // A stranded role copy still needs flush's authorized handoff; an old inbox must not consume or ack it before that succeeds.
  return (held.get(channelId) ?? []).filter((item) => !unresolved.has(item)
    && (isHumanDirect(item.env) || item.env.to.kind !== "local" || item.env.to.channelId === channelId));
}

/** Missing / conflicting original queue addresses are not recoverable from body headers. Never fabricate a deleted original. */
function unresolvedDirectTransfers(held: HeldQueue): Set<HeldItem> {
  const rows = [...held.entries()].flatMap(([channelId, q]) => q.map((item) => ({ channelId, item })));
  const unresolved = new Set<HeldItem>();
  for (const { item } of rows) {
    const to = item.env.to, t = pmTransferOf(item.env);
    if (!isHumanDirect(item.env) || to.kind !== "local" || unresolved.has(item)) continue;
    if (item.to.channelId === to.channelId && (!t || t.from === to.channelId)) continue;
    const copies = rows.filter((r) => isHumanDirect(r.item.env) && sameLetter(r.item.env, item.env));
    const origins = new Set(copies.filter((r) => r.item.to.channelId === r.channelId && r.item.env.to.kind === "local"
      && r.item.to.channelId !== r.item.env.to.channelId).map((r) => r.channelId));
    if (origins.size === 1) continue;
    for (const r of copies) unresolved.add(r.item);
    console.warn(`[pm-held] direct chat ${item.env.meta.messageId}: original recipient unresolved; keeping queued copies`);
  }
  return unresolved;
}

function adoptIn(held: HeldQueue, channelId: string, unresolved: Set<HeldItem>): void {
  const q = held.get(channelId) ?? [];
  const used = new Set<HeldItem>(), drop = new Set<HeldItem>();
  // 先配同一对象（进程内的同一封），再配读回后字段相同的：配对结果不随队内顺序变
  for (const match of [(a: Envelope, b: Envelope) => a === b, sameLetter]) {
    for (const item of q) {
      const to = item.env.to;
      if (unresolved.has(item) || drop.has(item) || item.to.channelId !== channelId || to.kind !== "local" || to.channelId === channelId) continue;
      const twin = (held.get(to.channelId) ?? []).find((i) => !used.has(i) && !unresolved.has(i) && i.to.channelId === to.channelId
        && isHumanDirect(i.env) === isHumanDirect(item.env) && match(i.env, item.env));
      if (!twin) continue;
      used.add(twin);
      if (isHumanDirect(item.env)) {
        // Keep the existing item (including its age / lease); never recreate a deleted owner message or ask.
        // remove persists the whole map after undo, so restart observes both changes together.
        undoPmTransfer(item.env, item.to);
        held.remove(to.channelId, twin);
        continue;
      }
      drop.add(item);
    }
  }
  if (!drop.size) return;
  held.set(channelId, (held.get(channelId) ?? []).filter((i) => !drop.has(i)));
  for (const i of drop) console.log(`♻️ 押后存量：${i.env.meta.messageId} 已在 ${(i.env.to as { channelId: string }).channelId} 队里，摘掉 ${channelId} 的重复归属`);
}
