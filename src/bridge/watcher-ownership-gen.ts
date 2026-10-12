/**
 * 观察器归属的真源是「频道 × 安装代次」，不是 agent 名：rename 后名字会变，同一频道同一会话仍是同一条流。
 * 每次开始安装 / 按频道停止都换代；跨 await（stat、数行）回来代次已变的旧调用不得再装资源、写 map。
 * 纯状态，不 import 任何 watcher（jsonl-watcher / bg-activity-watcher 都从这里取，tests/jsonl-audit-owner*.test.ts）。
 */

export interface InstallToken { channelId: string; gen: number }

export class InstallGenerations {
  private gen = new Map<string, number>();
  /** 频道上在途（还没装完）的安装是谁发起的：stopWatching(名字) 据此取消它 */
  private inflight = new Map<string, string>();

  begin(channelId: string, agentName: string): InstallToken {
    const gen = (this.gen.get(channelId) ?? 0) + 1;
    this.gen.set(channelId, gen);
    this.inflight.set(channelId, agentName);
    return { channelId, gen };
  }

  live(t: InstallToken): boolean {
    return this.gen.get(t.channelId) === t.gen;
  }

  /** 装完 / 放弃：只清自己这一代的在途记录，新代的不动 */
  done(t: InstallToken): void {
    if (this.live(t)) this.inflight.delete(t.channelId);
  }

  /** 换代：在途的旧安装回来后自己放弃。返回此前是否有在途安装 */
  cancel(channelId: string): boolean {
    const had = this.inflight.delete(channelId);
    this.gen.set(channelId, (this.gen.get(channelId) ?? 0) + 1);
    return had;
  }

  cancelAgent(agentName: string): void {
    for (const [ch, name] of [...this.inflight]) if (name === agentName) this.cancel(ch);
  }
}

/** 可信登记（manager list / registry）里的一条归属：名字 ↔ 频道 ↔ 会话 */
export interface OwnerRef { name: string; channelId: string; sessionId: string }

/** 只认三项俱全、且在册活跃的条目；缺任何一项就不拿它去迁名字（不迁到猜测名） */
export function trustedOwners(agents: readonly unknown[]): OwnerRef[] {
  const out: OwnerRef[] = [];
  for (const a of agents as Array<Record<string, unknown>>) {
    if (!a || (a.status !== undefined && a.status !== "active")) continue;
    const { name, channelId, sessionId } = a;
    if (typeof name === "string" && name && typeof channelId === "string" && channelId && typeof sessionId === "string" && sessionId) {
      out.push({ name, channelId, sessionId });
    }
  }
  return out;
}

/** 同频道同会话的条目改挂可信名字（bg 活动缓存用）；会话对不上的不动——那是另一代，由安装路径换代。返回改了几条 */
export function relabelOwned(items: Iterable<{ agentName: string; ownerChatId: string; sessionId: string }>, owners: readonly OwnerRef[]): number {
  let n = 0;
  for (const it of items) {
    const o = owners.find((x) => x.channelId === it.ownerChatId && x.sessionId === it.sessionId);
    if (o && o.name !== it.agentName) [it.agentName, n] = [o.name, n + 1];
  }
  return n;
}
