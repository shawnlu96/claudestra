/**
 * 假 guild 跑 bridge/discord-api.ts 的建频道 / 移频道接线（i28-N5）：不连 Discord。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { Client, Guild } from "discord.js";
import { createChannelInGuild, discordMoveChannel, setAllowlistProvider, setBotUserId } from "../src/bridge/discord-api.js";

const FULL = "Invalid Form Body\nparent_id[CHANNEL_PARENT_MAX_CHANNELS]: Maximum number of channels in category reached (50)";

interface FakeChan {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  setName(name: string): Promise<FakeChan>;
  setParent(id: string, opts: unknown): Promise<FakeChan>;
}

function fakeGuild() {
  const cache = new Map<string, FakeChan>();
  const createCalls: any[] = [];
  const setParentCalls: Array<{ id: string; parent: string; opts: unknown }> = [];
  /** 按调用序号注入失败：返回 Error 就抛 */
  let failCreate: (opts: any, n: number) => Error | null = () => null;
  let failParent: (parent: string, n: number) => Error | null = () => null;
  let seq = 0;
  const add = (name: string, type: number, parentId: string | null = null): FakeChan => {
    const ch: FakeChan = {
      id: `id${++seq}`,
      name,
      type,
      parentId,
      async setName(n) { ch.name = n; return ch; },
      async setParent(p, opts) {
        setParentCalls.push({ id: ch.id, parent: p, opts });
        const err = failParent(p, setParentCalls.length);
        if (err) throw err;
        ch.parentId = p;
        return ch;
      },
    };
    cache.set(ch.id, ch);
    return ch;
  };
  const fill = (parentId: string, n: number) => { for (let i = 0; i < n; i++) add(`f${i}`, 0, parentId); };
  const guild = {
    roles: { everyone: { id: "everyone" } },
    channels: {
      cache,
      async create(opts: any) {
        createCalls.push(opts);
        const err = failCreate(opts, createCalls.length);
        if (err) throw err;
        return add(opts.name, opts.type ?? 0, opts.parent ?? null);
      },
    },
  };
  const discord = { channels: { fetch: async (id: string) => cache.get(id) ?? null } };
  return {
    guild: guild as unknown as Guild,
    discord: discord as unknown as Client,
    cache,
    createCalls,
    setParentCalls,
    add,
    fill,
    onCreate(fn: typeof failCreate) { failCreate = fn; },
    onParent(fn: typeof failParent) { failParent = fn; },
    textCreates: () => createCalls.filter((c) => c.type !== 4),
    catCreates: () => createCalls.filter((c) => c.type === 4).map((c) => c.name),
  };
}

beforeEach(() => {
  setBotUserId("bot");
  setAllowlistProvider(() => ["u1"]);
});

describe("createChannelInGuild", () => {
  test("零溢出金样本：分类没满 → 不建分类、进 base，参数与改前一致", async () => {
    const g = fakeGuild();
    const base = g.add("proj", 4);
    g.fill(base.id, 49);
    const id = await createChannelInGuild(g.guild, "agent-x", "proj");
    expect(g.catCreates()).toEqual([]);
    expect(g.createCalls).toHaveLength(1);
    const c = g.createCalls[0];
    expect(Object.keys(c).sort()).toEqual(["name", "parent", "permissionOverwrites", "topic"]);
    expect(c.name).toBe("agent-x");
    expect(c.parent).toBe(base.id);
    expect(c.topic).toBe("Claude Code agent channel");
    expect(g.cache.get(id)?.parentId).toBe(base.id);
  });

  test("分类不存在 → 建 base（跟改前一样）", async () => {
    const g = fakeGuild();
    await createChannelInGuild(g.guild, "agent-x", "proj");
    expect(g.catCreates()).toEqual(["proj"]);
  });

  test("不传分类名 → parent 为空、不碰分类", async () => {
    const g = fakeGuild();
    await createChannelInGuild(g.guild, "agent-x");
    expect(g.createCalls).toHaveLength(1);
    expect(g.createCalls[0].parent).toBeUndefined();
  });

  test("base 满 → 建 proj 2 并放进去，权限覆盖与 base 里完全相同", async () => {
    const g = fakeGuild();
    const base = g.add("proj", 4);
    await createChannelInGuild(g.guild, "in-base", "proj");
    g.fill(base.id, 49);
    await createChannelInGuild(g.guild, "in-overflow", "proj");
    expect(g.catCreates()).toEqual(["proj 2"]);
    const [a, b] = g.textCreates();
    const p2 = [...g.cache.values()].find((c) => c.name === "proj 2")!;
    expect(a.parent).toBe(base.id);
    expect(b.parent).toBe(p2.id);
    expect(b.permissionOverwrites).toEqual(a.permissionOverwrites);
    expect(b.permissionOverwrites[0]).toEqual({ id: "everyone", deny: expect.any(Array) });
  });

  test("缓存过时撞上限 → 只重选一次，进 proj 2；覆盖不丢", async () => {
    const g = fakeGuild();
    const base = g.add("proj", 4);
    g.onCreate((o) => (o.type !== 4 && o.parent === base.id ? new Error(FULL) : null));
    const id = await createChannelInGuild(g.guild, "agent-x", "proj");
    const texts = g.textCreates();
    expect(texts).toHaveLength(2);
    expect(texts[0].permissionOverwrites).toBeDefined();
    expect(texts[1].permissionOverwrites).toEqual(texts[0].permissionOverwrites);
    expect(g.catCreates()).toEqual(["proj 2"]);
    expect(g.cache.get(id)?.parentId).not.toBe(base.id);
  });

  test("第二次还撞 → 抛 Discord 原错误，建频道只调两次", async () => {
    const g = fakeGuild();
    g.add("proj", 4);
    const errs: Error[] = [];
    g.onCreate((o) => {
      if (o.type === 4) return null;
      const e = new Error(FULL);
      errs.push(e);
      return e;
    });
    const err = await createChannelInGuild(g.guild, "agent-x", "proj").catch((e) => e);
    expect(err).toBe(errs[1]);
    expect(g.textCreates()).toHaveLength(2);
  });

  test("权限位被拒(50013) → 仍按原逻辑退回无覆盖创建，不换分类", async () => {
    const g = fakeGuild();
    const base = g.add("proj", 4);
    g.onCreate((o) => (o.permissionOverwrites ? new Error("Missing Permissions") : null));
    await createChannelInGuild(g.guild, "agent-x", "proj");
    const texts = g.textCreates();
    expect(texts).toHaveLength(2);
    expect(texts[1].permissionOverwrites).toBeUndefined();
    expect(texts[1].parent).toBe(base.id);
    expect(g.catCreates()).toEqual([]);
  });
});

describe("discordMoveChannel", () => {
  test("目标分类满 → 移进溢出分类，lockPermissions:false 不变", async () => {
    const g = fakeGuild();
    const base = g.add("proj", 4);
    g.fill(base.id, 50);
    const ch = g.add("agent-x", 0, null);
    await discordMoveChannel(g.discord, g.guild, ch.id, "proj");
    expect(g.catCreates()).toEqual(["proj 2"]);
    expect(g.setParentCalls).toHaveLength(1);
    expect(g.setParentCalls[0].opts).toEqual({ lockPermissions: false });
    expect(ch.parentId).not.toBe(base.id);
  });

  test("没满 → 进 base、不建分类；已在 base 里（算上自己正好 50）不被挤出去", async () => {
    const g = fakeGuild();
    const base = g.add("proj", 4);
    g.fill(base.id, 49);
    const ch = g.add("agent-x", 0, base.id);
    await discordMoveChannel(g.discord, g.guild, ch.id, "proj");
    expect(g.catCreates()).toEqual([]);
    expect(g.setParentCalls[0].parent).toBe(base.id);
  });

  test("setParent 撞上限 → 重选一次；再撞抛原错误", async () => {
    const g = fakeGuild();
    g.add("proj", 4);
    const ch = g.add("agent-x", 0, null);
    g.onParent((_p, n) => (n === 1 ? new Error(FULL) : null));
    await discordMoveChannel(g.discord, g.guild, ch.id, "proj");
    expect(g.setParentCalls).toHaveLength(2);
    expect(g.catCreates()).toEqual(["proj 2"]);

    const g2 = fakeGuild();
    g2.add("proj", 4);
    const ch2 = g2.add("agent-y", 0, null);
    const errs: Error[] = [];
    g2.onParent(() => { const e = new Error(FULL); errs.push(e); return e; });
    const err = await discordMoveChannel(g2.discord, g2.guild, ch2.id, "proj").catch((e) => e);
    expect(err).toBe(errs[1]);
    expect(g2.setParentCalls).toHaveLength(2);
  });

  test("改名：旧名 + 溢出分类一起改名，不另建", async () => {
    const g = fakeGuild();
    const old = g.add("old", 4);
    const old3 = g.add("old 3", 4);
    g.fill(old.id, 50);
    const ch = g.add("agent-x", 0, old3.id);
    await discordMoveChannel(g.discord, g.guild, ch.id, "new", "old");
    expect(old.name).toBe("new");
    expect(old3.name).toBe("new 3");
    expect(g.catCreates()).toEqual([]);
    expect(ch.parentId).toBe(old3.id);
  });
});
