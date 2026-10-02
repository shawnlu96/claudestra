import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostHeartbeat, UPDATE_GAP_MS } from "../src/lib/acp/host-heartbeat.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { readActivity, stuckSince, type ActivityRecord } from "../src/lib/agent-supervisor-activity.ts";

// 宿主回合心跳（i28-S1b）：写端节流与容错，以及与监护读端（readActivity / stuckSince）的端到端对接

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "acp-heartbeat-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(opts: { agent?: string; dir?: string; write?: (p: string, r: ActivityRecord) => void } = {}) {
  let t = 1_000_000;
  let sessionId = "sess-1";
  const writes: ActivityRecord[] = [];
  const logs: string[] = [];
  const dir = opts.dir ?? tmp();
  const beat = new HostHeartbeat(() => ({ agent: opts.agent ?? "worker-a", sessionId }), (m) => logs.push(m), {
    dir, now: () => t, write: opts.write ?? ((_p, r) => void writes.push({ ...r })),
  });
  return { beat, writes, logs, dir, at: () => t, tick: (ms: number) => void (t += ms), setSession: (s: string) => void (sessionId = s) };
}

describe("宿主回合心跳：写端", () => {
  test("回合开始立即写 busy=true、turnAt=开始时刻；随后的 update 推进 updateAt", () => {
    const h = make();
    h.beat.turn();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ v: 1, agent: "worker-a", sessionId: "sess-1", hostPid: process.pid, busy: true, turnAt: h.at(), updateAt: h.at(), writtenAt: h.at() });
    const start = h.at();
    h.tick(UPDATE_GAP_MS);
    h.beat.update();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]).toMatchObject({ busy: true, turnAt: start, updateAt: start + UPDATE_GAP_MS });
  });

  test("短时间内连发多条 update：写盘次数受节流上限约束（每 UPDATE_GAP_MS 至多一次）", () => {
    const h = make();
    h.beat.turn();
    for (let i = 0; i < 1_000; i++) {
      h.tick(100); // 100s 内 1000 条
      h.beat.update();
    }
    const elapsed = 1_000 * 100;
    expect(h.writes.length).toBeLessThanOrEqual(1 + Math.ceil(elapsed / UPDATE_GAP_MS));
    expect(h.writes.length).toBeGreaterThan(1);
    // 相邻两次写盘至少隔 UPDATE_GAP_MS（busy 变化的写除外）
    for (let i = 1; i < h.writes.length; i++) expect(h.writes[i]!.writtenAt - h.writes[i - 1]!.writtenAt).toBeGreaterThanOrEqual(UPDATE_GAP_MS);
    expect(UPDATE_GAP_MS).toBeLessThanOrEqual(5 * 60_000 / 10); // 明显小于监护 stuckMin 的下限（5 分钟）
  });

  test.each(["Stop", "StopFailure"])("回合以 %s 结束：立即写 busy=false（不受节流）", () => {
    const h = make();
    h.beat.turn();
    h.tick(10);
    h.beat.update(); // 被节流
    h.tick(10);
    h.beat.end(); // host.ts 在 reportStop（Stop / StopFailure 同一入口）里调
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]).toMatchObject({ busy: false, updateAt: h.at() - 10 });
  });

  test("收尾时还有排着的槽（适配器自发的一轮在跑）：仍算 busy", () => {
    const h = make();
    h.beat.turn();
    h.tick(UPDATE_GAP_MS);
    h.beat.end(true);
    expect(h.writes.at(-1)).toMatchObject({ busy: true });
  });

  test("目录不可写 / 写盘抛错：调用照常返回，只记一次日志；恢复后再记一次", () => {
    const blocker = join(tmp(), "not-a-dir");
    writeFileSync(blocker, "x");
    // 真写盘：父路径是个文件，mkdir 必失败
    const realLogs: string[] = [];
    const real = new HostHeartbeat(() => ({ agent: "worker-a", sessionId: "s" }), (m) => realLogs.push(m), { dir: join(blocker, "acp-activity") });
    expect(() => { real.turn(); real.update(); real.end(); }).not.toThrow();
    expect(realLogs.filter((l) => l.includes("回合心跳写不进去"))).toHaveLength(1);

    let broken = true;
    const logs: string[] = [];
    const b = new HostHeartbeat(() => ({ agent: "worker-a", sessionId: "s" }), (m) => logs.push(m), {
      write: () => { if (broken) throw new Error("EROFS"); },
    });
    expect(() => { b.turn(); b.end(); b.turn(); }).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("EROFS");
    broken = false;
    b.end();
    expect(logs.at(-1)).toContain("恢复");
    // 日志出口本身坏了也不抛
    const c = new HostHeartbeat(() => ({ agent: "worker-a", sessionId: "s" }), () => { throw new Error("log down"); }, { write: () => { throw new Error("disk"); } });
    expect(() => c.turn()).not.toThrow();
  });

  test.each(["a/b", "..", ".", "../etc", "a\\b", "bad\nname", "nul\0x", "esc\x1b", ""])("不安全的 agent 名 %p：不写文件", (agent) => {
    const dir = tmp();
    const logs: string[] = [];
    const beat = new HostHeartbeat(() => ({ agent, sessionId: "s" }), (m) => logs.push(m), { dir });
    beat.turn();
    beat.end();
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, "..", "etc.json"))).toBe(false);
    expect(logs[0]).toContain("不安全");
  });
});

describe("宿主回合心跳 → 监护读端（端到端，临时目录、真写盘）", () => {
  test("写出的文件 readActivity 读得出；update 持续时不判卡住，停住超过 stuckMs 返回最后动静的时刻；/clear 换会话后旧 id 查不到", () => {
    const dir = tmp();
    let t = 5_000_000;
    let sid = "sess-old";
    const beat = new HostHeartbeat(() => ({ agent: "worker-e2e", sessionId: sid }), () => {}, { dir, now: () => t });
    const stuckMs = 5 * 60_000;

    beat.turn();
    const r0 = readActivity("worker-e2e", dir);
    expect(r0).toMatchObject({ v: 1, agent: "worker-e2e", sessionId: "sess-old", busy: true, turnAt: t, hostPid: process.pid });

    // 动静不断：一直推进 20 分钟，每 10s 一条 update，任何时刻都不判卡住
    for (let i = 0; i < 120; i++) {
      t += 10_000;
      beat.update();
      expect(stuckSince(readActivity("worker-e2e", dir), "sess-old", t, stuckMs)).toBeNull();
    }
    // 停住：落盘的 updateAt 最多比实际旧一个节流间隔
    const last = readActivity("worker-e2e", dir)!.updateAt;
    expect(t - last).toBeLessThan(UPDATE_GAP_MS);
    expect(stuckSince(readActivity("worker-e2e", dir), "sess-old", last + stuckMs - 1, stuckMs)).toBeNull();
    expect(stuckSince(readActivity("worker-e2e", dir), "sess-old", t + stuckMs, stuckMs)).toBe(last);

    // 回合收尾：busy=false，不判卡住
    beat.end();
    expect(stuckSince(readActivity("worker-e2e", dir), "sess-old", t + 10 * stuckMs, stuckMs)).toBeNull();

    // /clear 换会话：之后写的是新 sessionId；新会话的回合停住时，拿旧 id 查不到卡住
    sid = "sess-new";
    t += 1_000;
    beat.turn();
    const rec = readActivity("worker-e2e", dir)!;
    expect(rec.sessionId).toBe("sess-new");
    expect(stuckSince(rec, "sess-old", t + 10 * stuckMs, stuckMs)).toBeNull();
    expect(stuckSince(rec, "sess-new", t + stuckMs, stuckMs)).toBe(t);
  });
});

// 审查 S1B-R1-01：steering 另起的一轮不走 prompt 也不走 onSelfTurn，心跳也得开。真的 AcpHost + AcpSession + AcpTurnLoop，
// 只换掉 RPC 线路（内存）、/hook 和心跳的时钟 / 写盘出口
describe("宿主回合心跳：steering 另起的一轮", () => {
  async function rig() {
    let releaseHook!: (v: unknown) => void;
    const firstHook = new Promise((r) => (releaseHook = r));
    let hooks = 0;
    const host: any = new AcpHost({ agentName: "probe", sessionId: "sid", env: {}, runtime: { id: "probe" } } as any, {
      startProxy: () => ({ url: "fake" }), makeLink: () => ({}), log: () => {},
      postHook: async () => (++hooks === 1 ? firstHook : {}),
    } as any);
    const writes: ActivityRecord[] = [];
    let t = 1_000_000;
    host.beat.opts.write = (_p: string, r: ActivityRecord) => void writes.push({ ...r });
    host.beat.opts.now = () => t;
    const sent: any[] = [];
    let data!: (chunk: string) => void;
    let selfTurns = 0;
    const session = new AcpSession({ write: (l: string) => void sent.push(JSON.parse(l)), onData: (cb: any) => void (data = cb), onClose: () => {}, close: () => {} } as any, {
      onUpdate: () => host.beat.update(), onPermission: async () => null, log: () => {},
      onSelfTurn: (done) => (selfTurns++, host.beat.turn(), host.loop.track(done)),
    });
    session.sessionId = "sid";
    session.steering = true;
    host.session = session;
    const raw = (msg: object) => data(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const status = (type: string) => raw({ method: "session/update", params: { sessionId: "sid", update: { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type } } } } } });
    const reply = (method: string, result: unknown) => raw({ id: sent.findLast((x) => x.method === method).id, result });
    const thought = () => raw({ method: "session/update", params: { sessionId: "sid", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } });
    // 第一轮跑完，Stop hook 挂着（loop.pumping 仍为 true），心跳已写 busy=false
    await host.loop.submit("first");
    await Bun.sleep(0);
    status("active");
    status("idle");
    reply("session/prompt", { stopReason: "end_turn" });
    await Bun.sleep(0);
    expect(writes.at(-1)).toMatchObject({ busy: false, turnAt: 1_000_000 });
    return { host, session, writes, status, reply, thought, releaseHook, selfTurns: () => selfTurns, tick: (ms: number) => void (t += ms), at: () => t };
  }

  test.each(["回包先于 active", "active 先于回包"])("上一轮 Stop hook 期间插话、适配器另起一轮（%s）：心跳开且只开一次，停住后判得出卡住", async (order) => {
    const h = await rig();
    h.tick(5_000);
    const startAt = h.at();
    const n = h.writes.length;
    const steering = h.host.loop.submit("during Stop hook");
    if (order === "回包先于 active") {
      h.reply("_session/steering", { outcome: "startedNewTurn" });
      h.status("active");
    } else {
      h.status("active"); // 当自发回合交给宿主（onSelfTurn 开心跳），steer 按 injected 收
      h.reply("_session/steering", { outcome: "startedNewTurn" });
    }
    expect(await steering).toBe("steer");
    h.releaseHook({});
    await Bun.sleep(0);
    expect(h.writes.slice(n)).toEqual([expect.objectContaining({ busy: true, turnAt: startAt, updateAt: startAt })]); // 开一轮、只开一次
    expect(h.selfTurns()).toBe(order === "回包先于 active" ? 0 : 1);
    expect(h.host.loop.busy).toBe(true);

    h.tick(UPDATE_GAP_MS);
    h.thought();
    const rec = h.writes.at(-1)!;
    expect(rec).toMatchObject({ busy: true, turnAt: startAt, updateAt: h.at() });
    expect(stuckSince(rec, "sid", h.at() + 600_000, 300_000)).toBe(h.at());

    h.status("idle");
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(h.writes.at(-1)).toMatchObject({ busy: false, turnAt: startAt });
  });

  test("steering 插进在跑的回合（injected）：不算新一轮，turnAt 不动", async () => {
    const h = await rig();
    h.releaseHook({});
    await Bun.sleep(0);
    await h.host.loop.submit("second");
    await Bun.sleep(0);
    const startAt = h.writes.at(-1)!.turnAt;
    const n = h.writes.length;
    h.tick(1_000);
    const steering = h.host.loop.submit("插一句");
    h.reply("_session/steering", { outcome: "injected" });
    expect(await steering).toBe("steer");
    expect(h.writes.length).toBe(n);
    expect(h.writes.at(-1)).toMatchObject({ busy: true, turnAt: startAt });
  });
});
