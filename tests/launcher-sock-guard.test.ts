import { describe, expect, test } from "bun:test";
import { LauncherSockGuard, type CreateMark, type SockGuardPorts } from "../src/lib/launcher-sock-guard.ts";
import type { SockHealMode, SockProbe, TmuxServerProc } from "../src/lib/tmux-sock-probe.ts";

const SERVER: TmuxServerProc = { pid: 795, ppid: 1, command: "tmux -S /fake.sock new-session" };
const pr = (state: SockProbe["state"], o: Partial<SockProbe> = {}): SockProbe =>
  ({ state, why: state, code: state === "exists" ? 0 : 1, stderr: "", ms: 3, sock: "present", inode: 42, refused: false, servers: null, stale: false, ...o });
const refused = (servers: TmuxServerProc[] = [SERVER]) => pr("unknown", { why: "连接被拒", refused: true, servers });

const dead = (names: string[], alive = 0) => [...names.map((name) => ({ name, status: "dead" })), ...Array.from({ length: alive }, (_, i) => ({ name: `live-${i}`, status: "active" }))];

function rig(o: { probes?: SockProbe[]; servers?: TmuxServerProc[] | null; mode?: SockHealMode; active?: number; mark?: CreateMark | null } = {}) {
  const queue = [...(o.probes ?? [])];
  const s = {
    clock: 0, sleeps: [] as number[], usr1: [] as number[], logs: [] as string[], alerts: [] as string[], busyCalls: 0,
    servers: o.servers === undefined ? [] : o.servers, inode: 42 as number | null, mode: o.mode ?? "observe", active: o.active ?? 20, probes: 0,
    push: (...p: SockProbe[]) => queue.push(...p),
    mark: o.mark as CreateMark | undefined | null, saved: [] as CreateMark[], saveFail: false,
  };
  const ports: SockGuardPorts = {
    probe: async () => { s.probes++; const p = queue.shift(); if (!p) throw new Error("没有预置的探测结果"); return p; },
    servers: async () => s.servers,
    inode: () => s.inode,
    healMode: async () => s.mode,
    usr1: (pid) => { s.usr1.push(pid); },
    activeCount: async () => s.active,
    busy: async () => { s.busyCalls++; return []; },
    sleep: async (ms) => { s.sleeps.push(ms); },
    now: () => s.clock,
    log: (m) => { s.logs.push(m); },
    alert: async (t) => { s.alerts.push(t); },
    loadMark: () => s.mark,
    saveMark: (m) => {
      if (s.saveFail) throw new Error("EACCES: permission denied");
      s.saved.push(structuredClone(m)); s.mark = structuredClone(m);
    },
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
    expect(await g.restoreMode("periodic")).toBe("skip");
    expect((await g.busy("master:0")).length).toBe(1);
    expect(s.busyCalls).toBe(0);
  });

  test("还没探测过也冻结", async () => {
    expect(await rig().g.restoreMode("boot")).toBe("skip");
  });

  test("10 分钟内新建过 master：冻结；过了 10 分钟恢复", async () => {
    const { s, g } = rig({ servers: [], probes: [pr("absent"), pr("absent"), pr("absent"), pr("exists"), pr("exists")] });
    expect(await g.check()).toBe("start");
    expect(await g.claimCreate()).toBe(true);
    await g.check();
    expect(g.frozen()).toContain("10 分钟");
    expect(await g.restoreMode("boot")).toBe("skip"); // 没走 created()：不算确认新建
    s.clock += 10 * 60_000;
    await g.check();
    expect(g.frozen()).toBeNull();
    expect(await g.busy("master:0")).toEqual([]);
    expect(s.busyCalls).toBe(1);
  });

  test("dead 达到阈值那轮不复活并告警，连续 3 轮再告一次；低于阈值照旧", async () => {
    const { s, g } = rig({ active: 15 });
    const names = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    expect(await g.massDead(dead(names, 5))).toBe(true);
    expect(s.alerts.length).toBe(1);
    expect(s.alerts[0]).toContain("agent-0");
    expect(await g.massDead(dead(names, 5))).toBe(true);
    expect(s.alerts.length).toBe(1);
    expect(await g.massDead(dead(names, 5))).toBe(true);
    expect(s.alerts.length).toBe(2);
    expect(await g.massDead(dead(names.slice(0, 9), 6))).toBe(false);
    expect(await rig({ active: 25 }).g.massDead(dead(names, 15))).toBe(false); // 没超过一半
  });

  test("阈值按 manager list 里全部 dead 数（恢复闸过滤之前）：12/20 dead 即使只剩 9 个可恢复也不复活", async () => {
    const { g } = rig({ active: 20 });
    const list = dead(Array.from({ length: 12 }, (_, i) => `agent-${i}`), 8);
    expect(await g.massDead(list)).toBe(true);
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

async function confirmedRig(o: { stale?: boolean; active?: number } = {}) {
  const r = rig({ servers: [SERVER], active: o.active ?? 20,
    probes: [pr("absent", { stale: o.stale ?? false }), pr("absent"), pr("absent"), pr("exists"), pr("exists")] });
  r.s.servers = [];
  expect(await r.g.check()).toBe("start");
  expect(await r.g.claimCreate()).toBe(true);
  r.s.servers = [SERVER]; // new-session 起来的新服务
  await r.g.created();
  return r;
}

describe("确认新建后照常恢复 [验收线 4]", () => {
  const names = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
  test("pid、inode 一致：dead 恢复不冻结、不受阈值限制，发一条说明；自动升级仍冻结 10 分钟", async () => {
    const { s, g } = await confirmedRig();
    expect(await g.restoreMode("boot")).toBe("confirmed");
    expect(await g.massDead(dead(names), "confirmed")).toBe(false);
    await g.noteRestore(9, "confirmed"); // 过滤后真要 restart 的个数
    await g.noteRestore(9, "confirmed");
    expect(s.alerts.filter((a) => a.includes("确认新建后恢复 9 个")).length).toBe(1);
    expect((await g.busy("master:0")).length).toBe(1);
    expect(s.busyCalls).toBe(0);
  });
  test("pid 变了：回到冻结；过了 10 分钟按阈值不复活并告警", async () => {
    const { s, g } = await confirmedRig();
    s.servers = [{ ...SERVER, pid: 900 }];
    expect(await g.restoreMode("periodic")).toBe("skip");
    s.clock += 10 * 60_000;
    await g.check();
    const mode = await g.restoreMode("periodic");
    expect(mode).toBe("normal");
    expect(await g.massDead(dead(names), mode)).toBe(true);
  });
  test("inode 变了 / 查不出：不算确认", async () => {
    const a = await confirmedRig();
    a.s.inode = 43;
    expect(await a.g.restoreMode("boot")).toBe("skip");
    const b = await confirmedRig();
    b.s.inode = null;
    expect(await b.g.restoreMode("boot")).toBe("skip");
  });
  test("新建后核不出（服务两个）：不算确认", async () => {
    const r = rig({ servers: [], probes: [pr("absent"), pr("absent"), pr("absent"), pr("exists")] });
    await r.g.check();
    await r.g.claimCreate();
    r.s.servers = [SERVER, { ...SERVER, pid: 796 }];
    await r.g.created();
    expect(await r.g.restoreMode("boot")).toBe("skip");
  });
  test("没经过 check 判 start 就调 created：不记", async () => {
    const r = rig({ probes: [pr("exists")] });
    await r.g.created();
    expect(r.s.probes).toBe(0);
  });
});

describe("残留套接字连续确认后新建 [验收线 2]", () => {
  test("3 次残留 absent → start；新建后记一行残留套接字说明，算确认新建", async () => {
    const r = rig({ servers: [], probes: [pr("absent", { stale: true }), pr("absent", { stale: true }), pr("absent", { stale: true }), pr("exists")] });
    expect(await r.g.check()).toBe("start");
    expect(await r.g.claimCreate()).toBe(true);
    r.s.servers = [SERVER];
    await r.g.created();
    expect(r.s.alerts.some((a) => a.includes("残留套接字：无服务进程、无持有者，已新建"))).toBe(true);
    expect(await r.g.restoreMode("boot")).toBe("confirmed");
  });
  test("残留只出现 1–2 次（之后 lsof 查不了 = unknown）：不新建", async () => {
    const r = rig({ probes: [pr("absent", { stale: true }), pr("absent", { stale: true }), pr("unknown", { why: "lsof 查不了" })] });
    expect(await r.g.check()).toBe("hold");
  });
});

describe("续波入口也受冻结 [验收线 4]", () => {
  test("刚新建过 master：waveHold 挡住（continueWave 不走 busy）；10 分钟后放行；探测不是 exists 也挡", async () => {
    const { s, g } = rig({ servers: [], probes: [pr("absent"), pr("absent"), pr("absent"), pr("exists"), pr("exists"), pr("unknown")] });
    await g.check();
    await g.claimCreate();
    await g.check();
    expect(g.waveHold()).toBe(true);
    expect(s.logs.some((l) => l.includes("续波暂停"))).toBe(true);
    s.clock += 10 * 60_000;
    await g.check();
    expect(g.waveHold()).toBe(false);
    await g.check();
    expect(g.waveHold()).toBe(true);
  });
});

describe("新建冻结跨 launcher 重启 [验收线 4]", () => {
  test("实例 A 新建后落盘；重启后的实例 B 首检 exists 仍冻结，10 分钟后解除", async () => {
    const a = rig({ servers: [], probes: [pr("absent"), pr("absent"), pr("absent")] });
    await a.g.check();
    await a.g.claimCreate();
    expect(a.s.mark?.createdAt).toBe(0);
    const b = rig({ mark: a.s.mark, probes: [pr("exists"), pr("exists")] });
    b.s.clock = 60_000;
    await b.g.check();
    expect(b.g.frozen()).toContain("10 分钟");
    expect(b.g.waveHold()).toBe(true);
    expect(await b.g.restoreMode("boot")).toBe("skip");
    b.s.clock = 10 * 60_000;
    await b.g.check();
    expect(b.g.frozen()).toBeNull();
  });

  test("确认新建的 pid、inode 也落盘：重启后对得上照样 confirmed，对不上作废并落盘", async () => {
    const a = await confirmedRig();
    expect(a.s.mark?.confirmed).toEqual({ pid: 795, inode: 42 });
    const b = rig({ mark: a.s.mark, servers: [SERVER], probes: [pr("exists")] });
    await b.g.check();
    expect(await b.g.restoreMode("boot")).toBe("confirmed");
    b.s.inode = 43;
    expect(await b.g.restoreMode("boot")).toBe("skip");
    expect(b.s.mark?.confirmed).toBeNull();
  });

  test("记录读坏了：按刚新建冻结 10 分钟；没有记录不冻结", async () => {
    const bad = rig({ mark: null, probes: [pr("exists")] });
    await bad.g.check();
    expect(bad.g.frozen()).toContain("10 分钟");
    const none = rig({ probes: [pr("exists")] });
    await none.g.check();
    expect(none.g.frozen()).toBeNull();
    expect(none.s.saved).toEqual([]);
  });

  test("新建记录写不了：claimCreate 不放行（不 new-session），告警；重启后不会无冻结地放过", async () => {
    for (const mark of [undefined, { createdAt: -60 * 60_000, confirmed: null }]) {
      const a = rig({ servers: [], mark, probes: [pr("absent"), pr("absent"), pr("absent")] });
      a.s.saveFail = true;
      expect(await a.g.check()).toBe("start");
      expect(await a.g.claimCreate()).toBe(false);
      expect(a.s.alerts.join()).toContain("EACCES");
      expect(a.s.mark).toEqual(mark);
      a.s.saveFail = false;
      expect(await a.g.claimCreate()).toBe(true);
      expect(a.s.mark?.createdAt).toBe(0);
    }
  });
});
