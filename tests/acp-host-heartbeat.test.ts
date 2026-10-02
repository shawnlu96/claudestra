import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostHeartbeat, UPDATE_GAP_MS } from "../src/lib/acp/host-heartbeat.ts";
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
