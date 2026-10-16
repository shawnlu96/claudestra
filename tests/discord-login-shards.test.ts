// DNF-1 r4 P2-2：@discordjs/ws 内部结构（strategy.shards / shard.internalConnect）变了时，destroy 告警并退回原行为，不抛错。
import { afterEach, expect, spyOn, test } from "bun:test";
import { SimpleShardingStrategy } from "discord.js";
import { createShardReaper } from "../src/bridge/discord-login-shards.ts";

const manager = { options: { rest: { options: { makeRequest: () => {} } } } } as never;
const internals = (s: SimpleShardingStrategy) => s as unknown as { shards: unknown };
let restore: (() => void)[] = [];
afterEach(() => { for (const r of restore) r(); restore = []; });

function spyWarn() {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  restore.push(() => warn.mockRestore());
  return warn;
}
const warnedChanged = (warn: ReturnType<typeof spyWarn>) => warn.mock.calls.some(([m]) => String(m).includes("@discordjs/ws 内部结构变了"));

test("shard 没有 internalConnect：告警，照常销毁", async () => {
  const warn = spyWarn();
  const s = createShardReaper().buildStrategy(manager);
  let destroyed = 0;
  (internals(s).shards as Map<number, unknown>).set(0, { destroy: async () => { destroyed++; } });
  await s.destroy();
  expect(destroyed).toBe(1);
  expect(warnedChanged(warn)).toBe(true);
});

test("拿不到 shards：告警，退回父类 destroy", async () => {
  const warn = spyWarn();
  const parent = spyOn(SimpleShardingStrategy.prototype, "destroy").mockResolvedValue(undefined);
  restore.push(() => parent.mockRestore());
  const s = createShardReaper().buildStrategy(manager);
  internals(s).shards = undefined;
  await s.destroy();
  expect(parent).toHaveBeenCalledTimes(1);
  expect(warnedChanged(warn)).toBe(true);
});

test("结构正常：不告警，被销毁的 shard 不再自重连", async () => {
  const warn = spyWarn();
  const s = createShardReaper().buildStrategy(manager);
  let reconnects = 0;
  const shard = { destroy: async () => {}, internalConnect: async () => { reconnects++; } };
  (internals(s).shards as Map<number, unknown>).set(0, shard);
  await s.destroy();
  await shard.internalConnect();
  expect(reconnects).toBe(0);
  expect(warnedChanged(warn)).toBe(false);
});
