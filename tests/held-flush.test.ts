/**
 * bridge/held-flush.ts：押后队列投递的交错场景（codex 2026-09-28 复核要求的集成测试）——
 * 投到一半目标又忙只留原条、计时不变、不 touch；await 期间被别处摘掉的不投；租约内不投；忙时只投人类消息；
 * 不在线 / 压缩中 / 别人正在投都不动；投递报错留着下次再投。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { clearOpenedBy, dropHeldOnKill, flushHeld, onHeldDelivered, type FlushDeps } from "../src/bridge/held-flush.js";
import { ageHeld, HELD_GIVE_UP_MS, HELD_NOTIFY_MS, HeldQueue, INBOX_LEASE_MS, type HeldItem } from "../src/bridge/held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";

beforeEach(() => clearOpenedBy());

const ws = { tag: "target-ws" } as never;
const item = (content: string, from: "local" | "user" = "local", heldAt = 1000): HeldItem => ({
  env: {
    from: from === "local" ? { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws } : { kind: "user", userId: "u1", username: "owner" },
    to: { kind: "local", agentName: "agent-me", channelId: "c-me", ws },
    intent: "request", content,
    meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-09-28T00:00:00Z", threadId: `thr-${content}` },
  } as Envelope,
  to: { kind: "local", agentName: "agent-me", channelId: "c-me", ws } as LocalEndpoint,
  heldAt,
});
const sent = (env: Envelope, note?: string): Delivery => ({ envelope: env, outcome: { kind: "sent", ...(note ? { note } : {}) } });

function harness(items: HeldItem[], over: Partial<FlushDeps> = {}) {
  const held = new HeldQueue(null);
  held.set("c-me", items);
  const delivered: string[] = [];
  const touched: string[] = [];
  const deps: FlushDeps = {
    held,
    compacting: () => false,
    working: async () => false,
    isHumanRequest: (env) => env.from.kind === "user",
    client: () => ({ ws }),
    deliver: async (env) => {
      delivered.push(String(env.content));
      return sent(env);
    },
    touch: (c) => touched.push(c),
    ...over,
  };
  return { held, deps, delivered, touched, contents: () => (held.get("c-me") ?? []).map((i) => String(i.env.content)) };
}

describe("flushHeld", () => {
  test("空闲：逐条投、每条先 touch 再出队", async () => {
    const h = harness([item("a"), item("b")]);
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["a", "b"]);
    expect(h.touched).toEqual(["c-me", "c-me"]);
    expect(h.contents()).toEqual([]);
  });

  test("投完第一条目标又忙：第二条原条目留着、heldAt 不变、不 touch、不重复入队", async () => {
    const h = harness([item("a"), item("b", "local", 1234)]);
    let n = 0;
    h.deps.deliver = async (env) => {
      if (n++ === 0) return sent(env);
      h.held.holdEnv(env); // 和 deliverToLocal 见目标在忙时一样，把同一封再押一次
      return sent(env, "queued");
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.touched).toEqual(["c-me"]);
    const q = h.held.get("c-me")!;
    expect(q.map((i) => i.env.content)).toEqual(["b"]);
    expect(q[0].heldAt).toBe(1234);
  });

  test("await 期间被别处摘掉（24 小时放弃 / kill 清理）的不再投", async () => {
    const h = harness([item("a"), item("b")]);
    h.deps.deliver = async (env) => {
      h.delivered.push(String(env.content));
      const b = h.held.get("c-me")!.find((i) => i.env.content === "b")!;
      h.held.remove("c-me", b); // 投 a 的同时，别处把 b 摘了
      return sent(env);
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["a"]);
    expect(h.contents()).toEqual([]);
  });

  test("投递途中（deliver 自己的 await 里）这条被摘掉：守卫返回 false，deliverToLocal 据此既不发也不押回", async () => {
    const h = harness([item("a")]);
    let guardSaw: boolean | undefined;
    h.deps.deliver = async (env, _to, stillWanted) => {
      expect(stillWanted?.()).toBe(true); // 进来时还在
      h.held.remove("c-me", h.held.get("c-me")![0]); // 模拟 await 期间 kill 清理
      guardSaw = stillWanted?.();
      return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } };
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(guardSaw).toBe(false);
    expect(h.touched).toEqual([]);
    expect(h.contents()).toEqual([]);
  });

  test("check_inbox 租约内的不投，过期的照投", async () => {
    const now = Date.now();
    const leased = { ...item("leased"), lease: { batchId: "inbox_x", at: now } };
    const expired = { ...item("expired"), lease: { batchId: "inbox_y", at: now - INBOX_LEASE_MS - 1 } };
    const h = harness([leased, expired, item("plain")]);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["expired", "plain"]);
    expect(h.contents()).toEqual(["leased"]);
  });

  test("目标在回合中：只投人类消息，agent 消息留着", async () => {
    const h = harness([item("agent-msg"), item("human-msg", "user")], { working: async () => true });
    await flushHeld(h.deps, "c-me", "compact_end");
    expect(h.delivered).toEqual(["human-msg"]);
    expect(h.contents()).toEqual(["agent-msg"]);
  });

  test("额度闸里的频道：目标空闲也只投人类消息，agent 消息不投（不会每分钟投一次再被押回来）", async () => {
    const h = harness([item("agent-msg"), item("human-msg", "user")], { walled: async () => true });
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["human-msg"]);
    expect(h.contents()).toEqual(["agent-msg"]);
  });

  test("闸前因「回合中」押下的（或别的路径押的、不带 reason）闸内一律改记成额度闸：不老化、算进排队数、出闸补投（T24 r1 P1-1）", async () => {
    const h = harness([item("busy-held", "local", 1000), item("human", "user", 1000)], { walled: async () => true, working: async () => true });
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.held.get("c-me")!.map((i) => [i.env.content, i.reason])).toEqual([["busy-held", "quota_wall"]]);
    expect(h.held.wallCount()).toEqual({ human: 0, agent: 1 });
    expect(ageHeld(h.held, 1000 + HELD_GIVE_UP_MS + 1)).toEqual([]); // 32 小时的墙也不丢
    expect(h.held.releaseWall(5000)).toBe(1);
    expect(h.held.get("c-me")![0]).toMatchObject({ heldAt: 5000 });
  });

  test("目标一直在压缩：也先改记成额度闸再返回，闸开超过 24 小时也不会出闸后立刻被放弃（T24 r2 P2-8）", async () => {
    const h = harness([item("agent-msg", "local", 1000)], { walled: async () => true, compacting: () => true });
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.held.wallCount()).toEqual({ human: 0, agent: 1 });
    expect(h.delivered).toEqual([]);
  });

  test("闸开着时整体不老化：30 分钟提醒是直接 ws.send 给发送方的，会唤醒一个注定撞墙的回合", () => {
    const h = harness([item("to-codex", "local", 1000)]);
    expect(ageHeld(h.held, 1000 + HELD_NOTIFY_MS + 1, true)).toEqual([]);
    expect(h.held.get("c-me")![0].notifiedAt).toBeUndefined(); // 出闸后照常提醒
    expect(ageHeld(h.held, 1000 + HELD_NOTIFY_MS + 1)).toHaveLength(1);
  });

  test("不在线 / 压缩中 / 别人正在投：一条都不动", async () => {
    const offline = harness([item("a")], { client: () => undefined });
    await flushHeld(offline.deps, "c-me", "stop");
    const compacting = harness([item("a")], { compacting: () => true });
    await flushHeld(compacting.deps, "c-me", "stop");
    const claimed = harness([item("a")]);
    claimed.held.claim("c-me");
    await flushHeld(claimed.deps, "c-me", "stop");
    for (const h of [offline, compacting, claimed]) {
      expect(h.delivered).toEqual([]);
      expect(h.contents()).toEqual(["a"]);
    }
  });

  test("真正送达才调 onHeldDelivered（押回 queued 的不算）", async () => {
    const seen: string[] = [];
    onHeldDelivered((c, env) => void seen.push(`${c}:${String(env.content)}`));
    const h = harness([item("a"), item("b")]);
    let n = 0;
    h.deps.deliver = async (env) => (n++ === 0 ? sent(env) : sent(env, "queued"));
    await flushHeld(h.deps, "c-me", "stop");
    expect(seen).toEqual(["c-me:a"]);
  });

  test("送达日志带来源和 messageId：班子通知记 bridge:ledger，能和 team-router 的 📮 行对上", async () => {
    const ledger = item("n");
    ledger.env = { ...ledger.env, from: { kind: "bridge", label: "ledger" }, meta: { ...ledger.env.meta, messageId: "ledger-12-agent-me" } };
    const h = harness([item("a"), ledger]);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await flushHeld(h.deps, "c-me", "stop");
    } finally {
      console.log = orig;
    }
    expect(logs).toEqual(["▶️ 押后消息投递(stop): agent-codex → agent-me（m-a）", "▶️ 押后消息投递(stop): bridge:ledger → agent-me（ledger-12-agent-me）"]);
  });

  test("投递报错：留在队里、不 touch，后面的照投；结束后释放频道锁", async () => {
    const h = harness([item("bad"), item("good")]);
    h.deps.deliver = async (env) => {
      if (env.content === "bad") return { envelope: env, outcome: { kind: "error", error: new Error("ws closed") } };
      h.delivered.push(String(env.content));
      return sent(env);
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["good"]);
    expect(h.touched).toEqual(["c-me"]);
    expect(h.contents()).toEqual(["bad"]);
    expect(h.held.claim("c-me")).toBe(true);
  });
});

describe("叫停和押后（Workflow 复核 wf2）", () => {
  test("classify-merge-1：押在叫停之前、叫停之后才投的（忙时作答的 ask 答复、agent 请求）加抬头；叫停之后才押的不加", async () => {
    const answer = item("[✅ owner 回复了你 10:00 的「待你处理」]\n选择：部署", "user", 1_000);
    const later = item("停之后发的", "local", 3_000);
    const h = harness([answer, later], { stoppedAt: () => 2_000 });
    const notes: (string | undefined)[] = [];
    h.deps.deliver = async (env) => (notes.push(env.meta.interruptNote), sent(env));
    await flushHeld(h.deps, "c-me", "stop");
    expect(notes[0]).toContain("这条是叫停之前");
    expect(notes[0]).toContain("先别照做，问用户还要不要");
    expect(notes[1]).toBeUndefined();
  });

  test("没叫停过 / bridge 自己的通知：不加", async () => {
    const bridgeNote = item("收尾提醒", "local", 1_000);
    bridgeNote.env.from = { kind: "bridge", label: "turn-cuts" };
    const plain = item("a", "local", 1_000);
    await flushHeld(harness([plain], { stoppedAt: (c) => (c === "other" ? 2_000 : undefined) }).deps, "c-me", "stop");
    await flushHeld(harness([bridgeNote], { stoppedAt: () => 2_000 }).deps, "c-me", "stop");
    expect(plain.env.meta.interruptNote).toBeUndefined();
    expect(bridgeNote.env.meta.interruptNote).toBeUndefined();
  });

  test("classify-merge-8：agent 被 kill，押给它的全丢掉，每条都交给善后（ask 答复放回「待你处理」由 asks.ts 做）", async () => {
    const h = harness([item("a"), item("b")]);
    const got: string[] = [];
    dropHeldOnKill(h.held, "c-me", async (env) => void got.push(String(env.content)));
    expect(h.contents()).toEqual([]);
    expect(got).toEqual(["a", "b"]);
    dropHeldOnKill(h.held, "c-me", async () => { throw new Error("不该再调"); });
  });
});

describe("撞墙等待时押着的人发消息：窗口一动就补投（T24 wf3 delivery-hold-4）", () => {
  const mk = (from: Envelope["from"], cid: string, id: string): Envelope => ({
    from, to: { kind: "local", channelId: cid, agentName: "agent-t" }, intent: "request", content: "停",
    meta: { messageId: id, triggerKind: "api_user", ts: "", threadId: "" },
  }) as unknown as Envelope;
  test("队里有人发的：马上 flush，同一频道 5 秒内只一次；只有 agent 消息的不触发", async () => {
    const { flushHumanSoon } = await import("../src/bridge/quota-wall-wiring.js");
    const held = new HeldQueue(null);
    const flushed: string[] = [];
    const b = { held, flush: async (cid: string) => void flushed.push(cid) } as unknown as Parameters<typeof flushHumanSoon>[0];
    held.holdEnv(mk({ kind: "api", tokenId: "tok-o", name: "owner", owner: true }, "wf3-h", "m1"));
    held.holdEnv(mk({ kind: "local", channelId: "c-pm", agentName: "agent-pm", ws: {} as never }, "wf3-a", "m2"));
    flushHumanSoon(b, "wf3-h", 10_000);
    flushHumanSoon(b, "wf3-h", 12_000);
    flushHumanSoon(b, "wf3-a", 12_000);
    flushHumanSoon(b, "wf3-h", 16_000);
    expect(flushed).toEqual(["wf3-h", "wf3-h"]);
  });
});

describe("押着的人类消息一轮只投一个发送人（adv3 P2-1 升 P1：出闸成批补投跨 principal 串话）", () => {
  const api = (content: string, tokenId: string, owner = false): HeldItem => {
    const i = item(content);
    return { ...i, env: { ...i.env, from: { kind: "api", tokenId, name: tokenId, ...(owner ? { owner: true as const } : {}) } } as Envelope };
  };
  const humanApi = { isHumanRequest: (env: Envelope) => env.from.kind === "user" || (env.from.kind === "api" && !env.from.peer), settled: async () => true };

  test("审查员复现 1：倒计时上押着 owner1、owner2、guest，画面空闲后补投：owner 两条进一轮，guest 等这一轮结束（中途的扫描 / 活动触发也不塞）", async () => {
    let working = false;
    const h = harness([api("owner1", "owner:self", true), api("owner2", "owner:self", true), api("guest", "tok-g")], { ...humanApi, working: async () => working });
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["owner1", "owner2"]);
    working = true;
    await flushHeld(h.deps, "c-me", "wall_activity");
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.contents()).toEqual(["guest"]);
    working = false; // owner 那一轮 Stop
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["owner1", "owner2", "guest"]);
  });

  test("审查员复现 2：CC 到点自己续跑的那一轮（不是补投开的）：guest 不塞进去，等它结束；owner 的照常进（抢占）", async () => {
    const h = harness([api("guest", "tok-g")], { ...humanApi, working: async () => true });
    await flushHeld(h.deps, "c-me", "wall_activity");
    expect(h.delivered).toEqual([]);
    const o = harness([api("owner", "owner:self", true)], { ...humanApi, working: async () => true });
    await flushHeld(o.deps, "c-me", "wall_activity");
    expect(o.delivered).toEqual(["owner"]);
  });

  test("按到达顺序：guest 先到先开一轮，后到的 owner 等 guest 那一轮结束；agent 请求开的一轮也不混进 guest", async () => {
    let working = false;
    const h = harness([api("guest", "tok-g"), api("owner", "owner:self", true)], { ...humanApi, working: async () => working });
    await flushHeld(h.deps, "c-me", "quota_wall");
    expect(h.delivered).toEqual(["guest"]);
    working = true;
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.contents()).toEqual(["owner"]);
    const pm = harness([item("pm-request"), api("guest", "tok-g")], humanApi);
    await flushHeld(pm.deps, "c-me", "stop");
    expect(pm.delivered).toEqual(["pm-request"]);
    expect(pm.contents()).toEqual(["guest"]);
  });

  test("判成空闲但画面还在变（CC 流式出正文时没有 spinner、事件态还是 done）：guest 的等画面静下来；owner 的不用等", async () => {
    let still = false;
    const h = harness([api("guest", "tok-g")], { ...humanApi, settled: async () => still });
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual([]);
    still = true;
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["guest"]);
    const o = harness([api("owner", "owner:self", true)], { ...humanApi, settled: async () => false });
    await flushHeld(o.deps, "c-me", "sweep");
    expect(o.delivered).toEqual(["owner"]);
  });

  test("出闸补投：不同 peer 的请求各开一轮，本机 agent 的也不和 peer 混（T24 审查 P1-1）", async () => {
    const peer = (content: string, name: string): HeldItem => {
      const i = api(content, `tok-${name}`);
      return { ...i, env: { ...i.env, from: { ...i.env.from, peer: name } } as Envelope };
    };
    const h = harness([peer("peerA-q", "a"), peer("peerB-q", "b")], humanApi);
    await flushHeld(h.deps, "c-me", "quota_wall");
    expect(h.delivered).toEqual(["peerA-q"]);
    const m = harness([item("pm-internal"), peer("peerA-q", "a")], humanApi);
    await flushHeld(m.deps, "c-me", "quota_wall");
    expect(m.delivered).toEqual(["pm-internal"]);
    const same = harness([peer("q1", "a"), peer("q2", "a")], humanApi);
    await flushHeld(same.deps, "c-me", "quota_wall");
    expect(same.delivered).toEqual(["q1", "q2"]); // 同一个 peer 连着的照旧一轮
  });

  test("遗留的补投记录：那一轮 Stop 后开了别的一轮（owner 直接开 / CC 自己续跑），guest 押着的不塞进去（T24 审查 P2-1）", async () => {
    let working = false;
    let turn: number | undefined = 5;
    const h = harness([api("g1", "tok-g")], { ...humanApi, working: async () => working, turnAt: () => turn });
    await flushHeld(h.deps, "c-me", "stop"); // g1 开了第 5 轮；那一轮 Stop 时队列已空，flush 提前返回，记录留着
    h.held.set("c-me", [api("g2", "tok-g")]);
    [working, turn] = [true, 9]; // owner 直接开了第 9 轮
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.contents()).toEqual(["g2"]);
    turn = 5; // 对照：还是 g1 开的那一轮 → 同一个人的接着进
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.contents()).toEqual([]);
  });

  test("只有 agent 消息的一趟照旧一起投（不涉及人，行为不变）", async () => {
    const other = item("b");
    const h = harness([item("a"), { ...other, env: { ...other.env, from: { kind: "local", agentName: "agent-pm", channelId: "c-pm", ws } } as Envelope }], humanApi);
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["a", "b"]);
  });
});
