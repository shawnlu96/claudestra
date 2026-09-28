/**
 * 做到一半的 create / kill / rename：在每一个副作用之后砍掉进程，再跑一次（或 repair --apply）
 * 都要收敛到同一个终态；并且「再跑」绝不误删 / 误建（对抗用例在后半）。
 */
import { describe, expect, test } from "bun:test";
import { Crash, makeWorld, normalize, type WorldState } from "./resumable-world";
import { beginCreate, clearCreateResidue, commitCreate, recordCreate } from "../src/manager/create-guard";
import { runKill, runRemove } from "../src/manager/agent-kill";
import { runRename } from "../src/manager/agent-rename";
import { runRepair } from "../src/manager/repair";
import type { AgentInfo } from "../src/manager/core";

type World = ReturnType<typeof makeWorld>;

const OLD: AgentInfo = { project: "/p", purpose: "old", created: "t0", status: "stopped", channelId: "chOld", notes: "", cwd: "/p", sessionId: "s-old" };
const LIVE: AgentInfo = { project: "/p", purpose: "live", created: "t0", status: "active", channelId: "ch9", notes: "", cwd: "/p", sessionId: "s9" };

/** 按 cmdCreate 的顺序走一遍占位协议（窗口 / 频道由世界假件代劳） */
async function simulateCreate(w: World, name: string): Promise<string> {
  const begun = await beginCreate(name, name.replace("agent-", ""), { project: "/p", purpose: "new", cwd: "/p" }, w.deps);
  if (!begun.ok) return begun.error;
  const ch = w.createChannel(name);
  await recordCreate(name, { channelId: ch }, w.deps);
  const windowId = w.openWindow(name);
  await recordCreate(name, { windowId }, w.deps);
  const entry = { project: "/p", purpose: "new", created: "t1", status: "active", channelId: ch, notes: "", cwd: "/p", sessionId: "s-new" } as AgentInfo;
  return commitCreate(name, entry, w.deps);
}

async function scanOf(w: World) {
  return { agents: structuredClone(w.st.reg.agents), windows: [...w.st.windows] as string[] | null, channels: new Set(w.st.channels), now: w.deps.now(), alive: w.deps.alive };
}

/** 先完整跑一遍拿到所有砍点，再逐个砍、逐个用 finish 收尾，断言终态 */
async function everyCut(init: Partial<WorldState>, op: (w: World) => Promise<unknown>, finish: (w: World) => Promise<unknown>, check: (w: World, cut: string) => void) {
  const probe = makeWorld(init);
  await op(probe);
  const cuts = [...probe.trace];
  expect(cuts.length).toBeGreaterThan(2);
  for (const cut of cuts) {
    const w = makeWorld(init);
    w.crashAfter(cut);
    await op(w).catch((e) => { if (!(e instanceof Crash)) throw e; }); // 被调用方吞掉的 Crash 也算砍（之后的副作用都会抛）
    w.restart();
    await finish(w);
    check(w, cut);
  }
}

function assertCreated(w: World, cut: string) {
  const a = w.st.reg.agents["agent-x"]!;
  expect(a.status).toBe("active");
  expect(a.pending).toBeUndefined();
  expect(w.st.windows).toEqual(["agent-x"]);
  // 唯一例外：砍在「建频道」与「写回 channelId」之间，那个频道没人认领（只报不删，PM 口径）
  const expected = cut === "createChannel#1" ? 2 : 1;
  expect(w.st.channels.size).toBe(expected);
  expect(w.st.channels.has(a.channelId)).toBe(true);
}

describe("create：每一步之后被砍", () => {
  test("再跑同名 create → 清掉残留后重建成功", async () => {
    // 砍在 commit 之后 = create 其实已完成，再跑报「已存在」是对的；终态由 assertCreated 判
    await everyCut({}, (w) => simulateCreate(w, "agent-x"), (w) => simulateCreate(w, "agent-x"), assertCreated);
  });

  test("repair --apply → 回到没建过的样子（有旧条目就原样放回）", async () => {
    const init = { reg: { socket: "s", agents: { "agent-x": OLD } } };
    await everyCut(init, (w) => simulateCreate(w, "agent-x"), async (w) => runRepair(true, await scanOf(w), w.deps), (w, cut) => {
      const a = w.st.reg.agents["agent-x"]!;
      if (a.status === "active") return assertCreated(w, cut); // 砍在 commit 之后：create 其实已完成
      expect(a).toEqual(OLD);
      expect(w.st.windows).toEqual([]);
      expect(w.st.channels.size).toBe(cut === "createChannel#1" ? 1 : 0);
    });
  });

  test("没有旧条目时 repair 直接删占位", async () => {
    const w = makeWorld();
    w.crashAfter("openWindow#1");
    await expect(simulateCreate(w, "agent-x")).rejects.toBeInstanceOf(Crash);
    w.restart();
    await runRepair(true, await scanOf(w), w.deps);
    expect(normalize(w.st)).toEqual({ agents: {}, windows: [], channels: [] });
  });
});

describe("kill：每一步之后被砍", () => {
  const init = { reg: { socket: "s", agents: { "agent-x": LIVE } }, windows: ["agent-x"], channels: new Set(["ch9"]) };
  const assertKilled = (w: World) => {
    expect(w.st.reg.agents["agent-x"]).toMatchObject({ status: "stopped", channelId: "ch9" });
    expect(w.st.reg.agents["agent-x"]!.pending).toBeUndefined();
    expect(w.st.windows).toEqual([]);
    expect(w.st.channels.size).toBe(0);
  };

  test("再跑 kill → 补完", async () => {
    await everyCut(init, (w) => runKill("agent-x", w.deps), (w) => runKill("agent-x", w.deps), assertKilled);
  });

  test("repair --apply → 补完", async () => {
    await everyCut(init, (w) => runKill("agent-x", w.deps), async (w) => runRepair(true, await scanOf(w), w.deps), assertKilled);
  });

  test("旧版 kill 留下的「窗口没了、registry 还是 active」也能补完", async () => {
    const w = makeWorld({ ...init, windows: [] });
    expect(await runKill("agent-x", w.deps)).toMatchObject({ ok: true });
    assertKilled(w);
  });

  test("重复 kill 幂等", async () => {
    const w = makeWorld(init);
    await runKill("agent-x", w.deps);
    const before = normalize(w.st);
    expect(await runKill("agent-x", w.deps)).toMatchObject({ ok: true, alreadyStopped: true });
    expect(normalize(w.st)).toEqual(before);
  });

  test("bridge 不在：置 stopped 但留 pending，bridge 回来后 repair 补删频道", async () => {
    const w = makeWorld({ ...init, bridgeUp: false });
    expect(await runKill("agent-x", w.deps)).toMatchObject({ ok: true, incomplete: ["channel"] });
    expect(w.st.reg.agents["agent-x"]!.pending).toMatchObject({ op: "kill", left: ["channel"] });
    expect(w.st.channels.has("ch9")).toBe(true);
    w.st.bridgeUp = true;
    const r = await runRepair(true, await scanOf(w), w.deps);
    expect(r.ok).toBe(true);
    assertKilled(w);
  });

  test("不存在的名字仍报错（防手滑）", async () => {
    expect(await runKill("agent-nope", makeWorld().deps)).toMatchObject({ ok: false });
  });
});

describe("rename：每一步之后被砍", () => {
  const init = { reg: { socket: "s", agents: { "agent-a": { ...LIVE, channelId: "ch1" } } }, windows: ["agent-a"], channels: new Set(["ch1"]) };
  const assertRenamed = (w: World) => {
    expect(Object.keys(w.st.reg.agents)).toEqual(["agent-b"]);
    expect(w.st.reg.agents["agent-b"]).toMatchObject({ displayName: "b", channelId: "ch1" });
    expect(w.st.reg.agents["agent-b"]!.pending).toBeUndefined();
    expect(w.st.windows).toEqual(["agent-b"]);
    expect(w.st.channelNames.get("ch1")).toBe("b");
    expect(w.st.ledgerRenames).toContain("agent-a>agent-b");
  };

  test("再跑 rename old new → 补完", async () => {
    await everyCut(init, (w) => runRename("a", "b", w.deps), (w) => runRename("a", "b", w.deps), assertRenamed);
  });

  test("repair --apply → 补完", async () => {
    await everyCut(init, (w) => runRename("a", "b", w.deps), async (w) => runRepair(true, await scanOf(w), w.deps), assertRenamed);
  });

  test("新名已在 registry 但没有 rename 标记 → 仍拒绝", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": LIVE } } });
    expect(await runRename("a", "b", w.deps)).toMatchObject({ ok: false, error: "registry 里没有 agent-a" });
  });

  test("标记的 from 对不上 → 不认作补跑", async () => {
    const pending = { op: "rename" as const, pid: 1, startedAt: "2026-09-28T11:59:00Z", from: "agent-zzz" };
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending } } } });
    expect((await runRename("a", "b", w.deps)).ok).toBe(false);
    expect(w.st.reg.agents["agent-b"]!.pending).toEqual(pending);
  });
});

describe("对抗：再跑 / repair 不许误删", () => {
  test("持有者还活着的占位：create、kill、repair 都不碰", async () => {
    const w = makeWorld();
    await beginCreate("agent-x", "x", {}, w.deps);
    const ch = w.createChannel("agent-x");
    await recordCreate("agent-x", { channelId: ch }, w.deps);
    const snap = normalize(w.st);
    expect(await simulateCreate(w, "agent-x")).toContain("正在 create");
    expect(await runKill("agent-x", w.deps)).toMatchObject({ ok: false });
    expect(await runRemove("agent-x", w.deps)).toMatchObject({ ok: false });
    const r = await runRepair(true, await scanOf(w), w.deps);
    expect(r.applied).toEqual([]);
    expect(normalize(w.st)).toEqual(snap);
  });

  test("没记到 channelId 的残留：同名频道一个都不删", async () => {
    const w = makeWorld({ channels: new Set(["owner-made"]), channelNames: new Map([["owner-made", "x"]]) });
    w.crashAfter("createChannel#1");
    await expect(simulateCreate(w, "agent-x")).rejects.toBeInstanceOf(Crash);
    w.restart();
    const r = await clearCreateResidue("agent-x", w.deps);
    expect(r.steps.join()).toContain("没记到频道 id");
    expect(w.st.channels.has("owner-made")).toBe(true);
    expect(w.st.channels.size).toBe(2);
  });

  test("残留占位的频道删不掉（bridge 不在）→ 占位保留，不放回旧条目", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": OLD } } });
    w.crashAfter("openWindow#1");
    await expect(simulateCreate(w, "agent-x")).rejects.toBeInstanceOf(Crash);
    w.restart();
    w.st.bridgeUp = false;
    expect((await clearCreateResidue("agent-x", w.deps)).ok).toBe(false);
    expect(w.st.reg.agents["agent-x"]!.status).toBe("creating");
    expect(await simulateCreate(w, "agent-x")).toContain("残留清不掉");
  });

  test("孤儿频道：被 active 条目引用的不报；没登记的窗口只报不关", async () => {
    const w = makeWorld({
      reg: { socket: "s", agents: { "agent-x": OLD, "agent-y": { ...LIVE, channelId: "chOld" } } },
      windows: ["agent-hand"], channels: new Set(["chOld"]),
    });
    const r = await runRepair(true, await scanOf(w), w.deps);
    expect(w.st.channels.has("chOld")).toBe(true);
    expect(w.st.windows).toEqual(["agent-hand"]);
    expect(r.skipped).toEqual([expect.objectContaining({ agent: "agent-hand", kind: "orphan-window", auto: false })]);
  });

  test("stopped 条目的窗口里还有进程（registry 漏写 active）→ 不关，只有裸 shell 才关", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": OLD, "agent-y": { ...OLD, channelId: "chY" } } }, windows: ["agent-x", "agent-y"], busyWindows: ["agent-x"] });
    const r = await runRepair(true, await scanOf(w), w.deps);
    expect(w.st.windows).toEqual(["agent-x"]);
    expect(r.ok).toBe(false);
    expect((r.applied as Array<{ agent: string; detail: string }>).find((x) => x.agent === "agent-x")!.detail).toContain("restart");
  });

  test("计划列出后条目变了（被 resume 成 active）→ apply 跳过", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": OLD } }, channels: new Set(["chOld"]) });
    const scan = await scanOf(w);
    w.st.reg.agents["agent-x"] = { ...LIVE, channelId: "chOld" };
    const r = await runRepair(true, scan, w.deps);
    expect(w.st.channels.has("chOld")).toBe(true);
    expect((r.applied as Array<{ detail: string }>)[0]!.detail).toContain("跳过");
  });

  test("不带 --apply 只列计划，什么都不动", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": OLD } }, windows: ["agent-x"], channels: new Set(["chOld"]) });
    const snap = normalize(w.st);
    const r = await runRepair(false, await scanOf(w), w.deps);
    expect(r).toMatchObject({ dryRun: true });
    // 窗口还在，频道就不算孤儿（可能是 registry 漏写 active、正在用）：只报窗口这一项
    expect(r.plan).toEqual([expect.objectContaining({ kind: "orphan-window" })]);
    expect(normalize(w.st)).toEqual(snap);
  });
});

describe("审查发现的误删路径（回归用例）", () => {
  const KILL_LEFT = { op: "kill" as const, pid: 0, startedAt: "2026-09-28T11:00:00Z", left: ["channel"] };

  test("F1：kill 欠删频道之后被 restart 拉起（active）→ repair 只清标记，绝不再杀", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": { ...LIVE, pending: KILL_LEFT } } }, windows: ["agent-x"], channels: new Set(["ch9"]), busyWindows: ["agent-x"] });
    const r = await runRepair(true, await scanOf(w), w.deps);
    expect(r.ok).toBe(true);
    expect(w.st.windows).toEqual(["agent-x"]);
    expect(w.st.channels.has("ch9")).toBe(true);
    expect(w.st.reg.agents["agent-x"]).toMatchObject({ status: "active" });
    expect(w.st.reg.agents["agent-x"]!.pending).toBeUndefined();
  });

  test("F2：stopped 但窗口里有进程 → 窗口不关，频道也不删", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": { ...OLD, channelId: "ch9" } } }, windows: ["agent-x"], channels: new Set(["ch9"]), busyWindows: ["agent-x"] });
    await runRepair(true, await scanOf(w), w.deps);
    expect(w.st.windows).toEqual(["agent-x"]);
    expect(w.st.channels.has("ch9")).toBe(true);
  });

  test("F4：create 残留只关自己记下 id 的窗口；同名的别的窗口（有进程）不关", async () => {
    const w = makeWorld();
    w.crashAfter("createChannel#1");
    await simulateCreate(w, "agent-x").catch((e) => { if (!(e instanceof Crash)) throw e; });
    w.restart();
    w.openWindow("agent-x"); // 别的路径（如 resume）建的同名窗口，里面在跑
    w.st.busyWindows = ["agent-x"];
    const r = await clearCreateResidue("agent-x", w.deps);
    expect(r.steps.join()).toContain("没关");
    expect(w.st.windows).toEqual(["agent-x"]);
  });

  test("F5 / F6：同名条目带残留 kill / rename 时 create 拒绝（不把线索塞进 prev 覆盖掉）", async () => {
    for (const pending of [KILL_LEFT, { op: "rename" as const, pid: 1, startedAt: "2026-09-28T10:00:00Z", from: "agent-old" }]) {
      const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": { ...OLD, pending } } }, channels: new Set(["chOld"]) });
      expect(await simulateCreate(w, "agent-x")).toContain(`做到一半的 ${pending.op}`);
      expect(w.st.reg.agents["agent-x"]!.pending).toEqual(pending);
    }
  });

  test("F7：kill 一个 rename 做到一半的 agent，旧名窗口也关", async () => {
    const pending = { op: "rename" as const, pid: 1, startedAt: "2026-09-28T10:00:00Z", from: "agent-a" };
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending } } }, windows: ["agent-a"], channels: new Set(["ch9"]) });
    expect(await runKill("agent-b", w.deps)).toMatchObject({ ok: true });
    expect(w.st.windows).toEqual([]);
  });

  test("kill 一开始就置 stopped（砍在中间 launcher 不会当 dead 拉回）", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": LIVE } }, windows: ["agent-x"], channels: new Set(["ch9"]) });
    w.crashAfter("save#1");
    await runKill("agent-x", w.deps).catch((e) => { if (!(e instanceof Crash)) throw e; });
    expect(w.st.reg.agents["agent-x"]).toMatchObject({ status: "stopped", pending: { op: "kill" } });
  });

  test("大总管不能 kill / remove", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-master": LIVE } } });
    expect(await runKill("agent-master", w.deps)).toMatchObject({ ok: false });
    expect(await runRemove("agent-master", w.deps)).toMatchObject({ ok: false });
    expect(w.st.reg.agents["agent-master"]).toEqual(LIVE);
  });

  test("remove 时 bridge 不在：条目留成 stopped + 欠删频道，repair 之后补删", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-x": LIVE } }, windows: ["agent-x"], channels: new Set(["ch9"]), bridgeUp: false });
    expect(await runRemove("agent-x", w.deps)).toMatchObject({ ok: false });
    expect(w.st.reg.agents["agent-x"]).toMatchObject({ status: "stopped", pending: { op: "kill", left: ["channel"] } });
    w.st.bridgeUp = true;
    await runRepair(true, await scanOf(w), w.deps);
    expect(w.st.channels.size).toBe(0);
  });

  test("tmux 列不出窗口：残留清理不删频道、repair 不报窗口 / 频道类", async () => {
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-s": { ...OLD, channelId: "c1" } } }, channels: new Set(["c1"]) });
    w.crashAfter("openWindow#1");
    await simulateCreate(w, "agent-x").catch((e) => { if (!(e instanceof Crash)) throw e; });
    w.restart();
    w.breakTmux();
    await expect(clearCreateResidue("agent-x", w.deps)).rejects.toThrow("列不出");
    const r = await runRepair(true, { ...(await scanOf(w)), windows: null }, w.deps);
    expect((r.applied as Array<{ kind: string }>).map((x) => x.kind)).toEqual(["stale-create"]);
    expect(w.st.channels.has("c1")).toBe(true);
    expect(w.st.channels.size).toBe(2);
  });

  test("占位被别的进程接手后 commit 返回 lost，不覆盖", async () => {
    const w = makeWorld();
    await beginCreate("agent-x", "x", {}, w.deps);
    w.st.reg.agents["agent-x"]!.pending = { op: "create", pid: 999999, startedAt: "2026-09-28T12:00:00Z", channelName: "x" };
    expect(await commitCreate("agent-x", LIVE, w.deps)).toBe("lost");
    expect(w.st.reg.agents["agent-x"]!.status).toBe("creating");
  });
});

