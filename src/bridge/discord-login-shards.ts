// 让 connector 反复 client.login() 重连时，旧 gateway 会话真的死掉。
// @discordjs/ws 的 shard 断线后先在 Idle 等 500ms 再自重连，这期间 shard.destroy() 直接 return、不取消那次重连；
// 于是每次 login()（connect → updateShardCount → strategy.destroy）都漏一个孤儿 shard，恢复后各自 IDENTIFY，
// 同一次按钮 / slash 被处理 N 次。这里让被 strategy 销毁的 shard 永不再 internalConnect。
// 测试：tests/discord-login-orphan.test.ts
import { SimpleShardingStrategy } from "discord.js";

/** @discordjs/ws 的 WebSocketManager（discord.js 顶层同名导出的是它自己那个，类型不同） */
type WsManager = ConstructorParameters<typeof SimpleShardingStrategy>[0];

interface ReconnectingShard { internalConnect(): Promise<void> }

class FinalDestroyStrategy extends SimpleShardingStrategy {
  override async destroy(options?: Parameters<SimpleShardingStrategy["destroy"]>[0]): Promise<void> {
    // shards 在 d.ts 里是 private；销毁后它就被父类 clear 掉，所以必须在这之前拿到
    const shards = (this as unknown as { shards: Map<number, ReconnectingShard> }).shards;
    for (const shard of shards.values()) shard.internalConnect = async () => {};
    await super.destroy(options);
  }
}

export interface ShardReaper {
  /** 给 new Client({ ws: { buildStrategy } }) */
  buildStrategy(manager: WsManager): SimpleShardingStrategy;
  /**
   * 包住 client.login()：失败时把这次 spawn 的 shard 一并拆掉。discord.js 失败时的 client.destroy() 只生效一次
   * （ws.destroyed 不复位），之后漏下的 shard 会在退避期间自己连上，而 REST token 已被 destroy 清空。
   */
  guard<T>(login: Promise<T>): Promise<T>;
}

export function createShardReaper(): ShardReaper {
  let current: FinalDestroyStrategy | null = null;
  return {
    buildStrategy: (manager) => (current = new FinalDestroyStrategy(manager)),
    guard: (login) => login.catch(async (e: unknown) => {
      await current?.destroy({ reason: "login 失败，拆掉这次的 shard 由 connector 退避后重来" });
      throw e;
    }),
  };
}
