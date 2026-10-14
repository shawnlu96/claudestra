import { describe, expect, test } from "bun:test";
import { LauncherSockGuard, type SockGuardPorts } from "../src/lib/launcher-sock-guard.ts";
import type { SockHealMode, SockProbe, TmuxServerProc } from "../src/lib/tmux-sock-probe.ts";

const SERVER: TmuxServerProc = { pid: 795, ppid: 1, command: "tmux -S /fake.sock new-session" };
const pr = (state: SockProbe["state"], o: Partial<SockProbe> = {}): SockProbe =>
  ({ state, why: state, code: state === "exists" ? 0 : 1, stderr: "", ms: 3, sock: "present", inode: 42, refused: false, servers: null, ...o });
const refused = (servers: TmuxServerProc[] = [SERVER]) => pr("unknown", { why: "连接被拒", refused: true, servers });

function rig(o: { probes?: SockProbe[]; servers?: TmuxServerProc[] | null; mode?: SockHealMode; active?: number } = {}) {
  const queue = [...(o.probes ?? [])];
  const s = {
    clock: 0, sleeps: [] as number[], usr1: [] as number[], logs: [] as string[], alerts: [] as string[], busyCalls: 0,
    servers: o.servers === undefined ? [] : o.servers, mode: o.mode ?? "observe", active: o.active ?? 20, probes: 0,
    push: (...p: SockProbe[]) => queue.push(...p),
  };
  const ports: SockGuardPorts = {
    probe: async () => { s.probes++; const p = queue.shift(); if (!p) throw new Error("没有预置的探测结果"); return p; },
    servers: async () => s.servers,
    healMode: async () => s.mode,
    usr1: (pid) => { s.usr1.push(pid); },
    activeCount: async () => s.active,
    busy: async () => { s.busyCalls++; return []; },
    sleep: async (ms) => { s.sleeps.push(ms); },
    now: () => s.clock,
    log: (m) => { s.logs.push(m); },
    alert: async (t) => { s.alerts.push(t); },
  };
  return { s, g: new LauncherSockGuard(ports) };
}

describe("launcher 只在连续确认 absent 时新建 [验收线 2]", () => {
  test("一次 unknown 不新建（改前一次 false 就新建）", async () => {
    const { s, g } = rig({ probes: [pr("unknown", { why: "查询超时", code: 137 })] });
    expect(await g.check()).toBe("hold");
    expect(s.probes).toBe(1);
  });

  test("absent 1–2 次后恢复 exists：不新建", async () => {
    const { g } = rig({ probes: [pr("absent"), pr("absent"), pr("exists")] });
    expect(await g.check()).toBe("exists");
  });

  test("absent 后跟 unknown：不新建", async () => {
    const { g } = rig({ probes: [pr("absent"), pr("unknown")] });
    expect(await g.check()).toBe("hold");
  });

  test("连续 3 次 absent、间隔 2 秒才新建", async () => {
    const { s, g } = rig({ probes: [pr("absent"), pr("absent"), pr("absent")] });
    expect(await g.check()).toBe("start");
    expect(s.sleeps).toEqual([2000, 2000]);
  });

  test("new-session 前查到同路径服务进程：不新建并告警；查不了也不建；没有才建", async () => {
    const a = rig({ servers: [SERVER] });
    expect(await a.g.claimCreate()).toBe(false);
    expect(a.s.alerts.join()).toContain("795");
    expect(await rig({ servers: null }).g.claimCreate()).toBe(false);
    expect(await rig({ servers: [] }).g.claimCreate()).toBe(true);
  });

  test("探测抛错 → hold，不让主循环退出", async () => {
    const { g } = rig({ probes: [] });
    expect(await g.check()).toBe("hold");
  });
});

describe("tmuxSockHeal [验收线 3]", () => {
  test("on + 恰好一个同路径服务：只对它发 USR1，之后 exists 记恢复，不新建", async () => {
    const { s, g } = rig({ mode: "on", probes: [refused(), pr("exists")] });
    expect(await g.check()).toBe("hold");
    expect(s.usr1).toEqual([795]);
    expect(s.sleeps).toEqual([2000]);
    expect(s.alerts.some((a) => a.includes("795") && a.includes("恢复"))).toBe(true);
  });

  test("on 发过仍不通：告警停手，下一轮不再发", async () => {
    const { s, g } = rig({ mode: "on", probes: [refused(), refused(), refused()] });
    expect(await g.check()).toBe("hold");
    expect(await g.check()).toBe("hold");
    expect(s.usr1).toEqual([795]);
    expect(s.alerts.filter((a) => a.includes("仍")).length).toBe(1);
  });

  test("两个以上同路径服务：任何档都不发", async () => {
    for (const mode of ["on", "observe", "off"] as const) {
      const { s, g } = rig({ mode, probes: [refused([SERVER, { ...SERVER, pid: 796 }])] });
      expect(await g.check()).toBe("hold");
      expect(s.usr1).toEqual([]);
      expect(s.alerts.length).toBe(1);
    }
  });

  test("observe：只记录、同 pid 一小时一条，不发、不新建", async () => {
    const { s, g } = rig({ mode: "observe", probes: [refused(), refused(), refused()] });
    const said = () => s.logs.filter((l) => l.includes("本会对 pid 795")).length;
    expect(await g.check()).toBe("hold");
    s.clock += 30 * 60_000;
    await g.check();
    expect(said()).toBe(1);
    s.clock += 31 * 60_000;
    await g.check();
    expect(said()).toBe(2);
    expect(s.usr1).toEqual([]);
  });

  test("off：只告警", async () => {
    const { s, g } = rig({ mode: "off", probes: [refused()] });
    expect(await g.check()).toBe("hold");
    expect(s.usr1).toEqual([]);
    expect(s.alerts.length).toBe(1);
  });
});

describe("冻结与大量 dead [验收线 4]", () => {
  test("probe 不是 exists：dead 恢复和自动升级都不跑（升级按有人在忙）", async () => {
    const { s, g } = rig({ probes: [pr("unknown")] });
    await g.check();
    expect(g.skipRestore("periodic")).toBe(true);
    expect((await g.busy("master:0")).length).toBe(1);
    expect(s.busyCalls).toBe(0);
  });

  test("还没探测过也冻结", () => {
    expect(rig().g.skipRestore("boot")).toBe(true);
  });

  test("10 分钟内新建过 master：冻结；过了 10 分钟恢复", async () => {
    const { s, g } = rig({ servers: [], probes: [pr("absent"), pr("absent"), pr("absent"), pr("exists"), pr("exists")] });
    expect(await g.check()).toBe("start");
    expect(await g.claimCreate()).toBe(true);
    await g.check();
    expect(g.frozen()).toContain("10 分钟");
    expect(g.skipRestore("boot")).toBe(true);
    s.clock += 10 * 60_000;
    await g.check();
    expect(g.frozen()).toBeNull();
    expect(await g.busy("master:0")).toEqual([]);
    expect(s.busyCalls).toBe(1);
  });

  test("dead 达到阈值那轮不复活并告警，连续 3 轮再告一次；低于阈值照旧", async () => {
    const { s, g } = rig({ active: 15 });
    const names = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    expect(await g.massDead(names)).toBe(true);
    expect(s.alerts.length).toBe(1);
    expect(s.alerts[0]).toContain("agent-0");
    expect(await g.massDead(names)).toBe(true);
    expect(s.alerts.length).toBe(1);
    expect(await g.massDead(names)).toBe(true);
    expect(s.alerts.length).toBe(2);
    expect(await g.massDead(names.slice(0, 9))).toBe(false);
    expect(await rig({ active: 25 }).g.massDead(names)).toBe(false); // 没超过一半
  });
});

describe("留痕", () => {
  test("exists ↔ 非 exists 变化记一行：服务 pid、inode、三态、code", async () => {
    const { s, g } = rig({ probes: [pr("exists"), pr("exists"), refused()] });
    await g.check();
    await g.check();
    await g.check();
    const lines = s.logs.filter((l) => l.startsWith("🧷 tmux 探测") && l.includes("→"));
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("exists → unknown");
    expect(lines[1]).toContain("pid 795");
    expect(lines[1]).toContain("inode 42");
    expect(lines[1]).toContain("code 1");
  });
});
