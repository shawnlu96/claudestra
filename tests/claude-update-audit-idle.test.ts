/**
 * hardening-CCIDLE1：Claude Code 自动升级的重启波在动作时重核空闲身份，忙者延后（审计 A15-05）。
 * launcher 以前只在升级前读一次 busyAgentWindows，长安装 / 体检 await 之后直接金丝雀 + 无条件 `manager restart` + 给 master 打 /exit，
 * 期间开始的正常回合被打断。这里用合成的 manager / tmux 端口（不碰真 tmux、真 registry）：fake manager 认 `restart --idle-only`
 * 时按 agent 此刻的忙闲 / 会话 / 窗口复核（与 src/manager/restart-idle.ts 同一套前提），无条件 restart 一律照做。
 * keys = 真的发出去的退出 / 重启键。
 */
import { describe, expect, test } from "bun:test";
import { continueWave, startUpdateWave, type PendingWave, type WavePorts } from "../src/lib/claude-update-restart.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✶ Processing… (2m 12s · ↓ 7.8k tokens)", "", CC_IDLE].join("\n");

interface FakeAgent { name: string; sessionId: string; window: string; busy: boolean; failStart?: boolean }

function world(names: string[]) {
  const agents: FakeAgent[] = names.map((n, i) => ({ name: n, sessionId: `s-${n}`, window: `@${i + 1}`, busy: false }));
  const st = {
    keys: [] as string[],
    busyReads: 0,
    installs: 0,
    notices: [] as string[],
    pending: null as PendingWave | null,
    master: { pid: "100", busy: false },
    duringInstall: (() => {}) as () => void,
    /** fake manager 的身份 / 活动读取期间插一手（模拟最后一次读取时换会话、开回合） */
    duringRecheck: (() => {}) as (name: string) => void,
    /** master 第 n 次活动读取时插一手 */
    duringMasterRead: (() => {}) as (n: number) => void,
    now: 1_000,
  };
  const find = (n: string) => agents.find((a) => a.name === n);
  let masterReads = 0;
  const out = (o: unknown) => ({ ok: true, out: JSON.stringify(o) });
  const ports: WavePorts = {
    masterWindow: "master:0",
    mention: "<@owner>",
    session: "master",
    async manager(args) {
      if (args[0] === "list") return out({ agents: agents.map((a) => ({ name: a.name, status: "active", runtime: "claude-code" })) });
      if (args[0] !== "restart") throw new Error(`unexpected manager ${args.join(" ")}`);
      const dd = args.indexOf("--");
      const io = args.indexOf("--idle-only");
      if (io >= 0) {
        const want = JSON.parse(args[io + 1]) as { sessionId: string; windows: string[] };
        const name = args[dd + 1];
        const a = find(name)!;
        st.busyReads++;
        const same = () => a.sessionId === want.sessionId && JSON.stringify([a.window]) === JSON.stringify(want.windows);
        const before = same() && !a.busy;
        st.duringRecheck(name);
        if (!before || !same() || a.busy) return out({ ok: false, results: [{ name, ok: false, skipped: "忙或身份变了", error: "已跳过" }] });
        st.keys.push(`restart:${name}`);
        return a.failStart
          ? out({ ok: false, results: [{ name, ok: false, error: "启动超时" }] })
          : out({ ok: true, results: [{ name, ok: true }] });
      }
      const targets = dd >= 0 ? [args[dd + 1]] : args[1] ? [args[1]] : agents.map((a) => a.name);
      const results = targets.map((n) => (st.keys.push(`restart:${n}`), { name: n, ok: !find(n)?.failStart }));
      return out({ ok: results.every((r) => r.ok), results });
    },
    async tmux(args) {
      if (args[0] === "list-windows") return agents.map((a) => `${a.name}\t${a.window}`).concat(["master\t@0"]).join("\n");
      if (args[0] === "display-message") return st.master.pid;
      if (args[0] === "capture-pane") {
        st.duringMasterRead(++masterReads);
        return st.master.busy ? CC_BUSY : CC_IDLE;
      }
      if (args[0] === "send-keys") { st.keys.push("exit:master"); return ""; }
      throw new Error(`unexpected tmux ${args.join(" ")}`);
    },
    async registry() { return agents.map((a) => ({ name: a.name, status: "active", sessionId: a.sessionId })); },
    async busy() {
      st.busyReads++;
      return [...(st.master.busy ? ["master"] : []), ...agents.filter((a) => a.busy).map((a) => a.name)];
    },
    async install() { st.installs++; st.duringInstall(); return "2.1.300"; },
    readPending: () => st.pending,
    writePending: (p) => { st.pending = p; },
    async notify(zh) { st.notices.push(zh); },
    log() {},
    lease() {},
    now: () => st.now,
  };
  return { agents, st, ports, find };
}

/** launcher 下一轮：已装好的版本照旧是 2.1.300，只续波、不再安装 */
const nextRound = (w: ReturnType<typeof world>) => continueWave(w.ports, "2.1.300");

describe("[验收线 1] 安装 await 期间开始的回合：不发退出 / 重启键，记 deferred", () => {
  test("普通 agent：安装期间 agent-b 开始回合 → b 无重启键、留在 pending，其余照常", async () => {
    const w = world(["agent-a", "agent-b", "agent-c"]);
    w.st.duringInstall = () => { w.find("agent-b")!.busy = true; };
    const r = await startUpdateWave(w.ports);
    expect(w.st.busyReads).toBeGreaterThan(1); // 旧：busyReads=1 且仍发 restart
    expect(w.st.keys).not.toContain("restart:agent-b");
    expect(w.st.keys).toEqual(["restart:agent-a", "restart:agent-c", "exit:master"]);
    expect(r.kind === "wave" && r.deferred).toEqual(["agent-b"]);
    expect(w.st.pending?.targets.map((t) => t.name)).toEqual(["agent-b"]);
  });

  test("金丝雀：安装期间金丝雀 agent-a 开始回合 → a 不重启，改拿下一个空闲的 CC agent 当金丝雀", async () => {
    const w = world(["agent-a", "agent-b"]);
    w.st.duringInstall = () => { w.find("agent-a")!.busy = true; };
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).not.toContain("restart:agent-a");
    expect(w.st.keys).toEqual(["restart:agent-b", "exit:master"]);
    expect(r.kind === "wave" && r.deferred).toEqual(["agent-a"]);
  });

  test("金丝雀：所有候选都在忙 → 整波延后，没有任何重启 / 退出键", async () => {
    const w = world(["agent-a"]);
    w.st.duringInstall = () => { w.find("agent-a")!.busy = true; };
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    expect(r.kind === "wave" && r.deferred.sort()).toEqual(["agent-a", "master"]);
    expect(w.st.pending?.canaryDone).toBe(false);
    expect(w.st.pending?.master).toBe("100");
  });

  test("master：安装期间 master 开始回合 → 不打 /exit，master 记 pending", async () => {
    const w = world(["agent-a"]);
    w.st.duringInstall = () => { w.st.master.busy = true; };
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual(["restart:agent-a"]);
    expect(r.kind === "wave" && r.deferred).toEqual(["master"]);
    expect(w.st.pending?.master).toBe("100");
    expect(w.st.pending?.targets).toEqual([]);
  });

  test("升级前就有人忙：照旧不安装、不发任何键", async () => {
    const w = world(["agent-a"]);
    w.find("agent-a")!.busy = true;
    expect(await startUpdateWave(w.ports)).toEqual({ kind: "busy", names: ["agent-a"] });
    expect([w.st.installs, w.st.keys.length, w.st.pending]).toEqual([0, 0, null]);
  });
});

describe("[验收线 2] 最后一次读取期间变了也跳过；忙者下一轮空闲再补一次，安装不重复", () => {
  test("最后读取期间换 session → 跳过、留 pending；下一轮按计划身份核不上，仍不重启", async () => {
    const w = world(["agent-a", "agent-b"]);
    w.st.duringRecheck = (n) => { if (n === "agent-b") w.find("agent-b")!.sessionId = "s-new"; };
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual(["restart:agent-a", "exit:master"]);
    w.st.duringRecheck = () => {};
    const r = await nextRound(w);
    expect(w.st.keys).toEqual(["restart:agent-a", "exit:master"]);
    expect(r?.kind === "wave" && r.deferred).toEqual(["agent-b"]);
  });

  test("最后读取期间开回合 → 跳过", async () => {
    const w = world(["agent-a", "agent-b"]);
    w.st.duringRecheck = (n) => { if (n === "agent-b") w.find("agent-b")!.busy = true; };
    await startUpdateWave(w.ports);
    expect(w.st.keys).not.toContain("restart:agent-b");
  });

  test("master 最后一次活动读取期间开回合 / 换进程 → 不打 /exit", async () => {
    for (const flip of [(w: ReturnType<typeof world>) => { w.st.master.busy = true; }, (w: ReturnType<typeof world>) => { w.st.master.pid = "200"; }]) {
      const w = world(["agent-a"]);
      w.st.duringMasterRead = (n) => { if (n === 1) flip(w); };
      await startUpdateWave(w.ports);
      expect(w.st.keys).toEqual(["restart:agent-a"]);
      expect(w.st.pending?.master).toBe("100");
    }
  });

  test("稳定空闲的一次重启；忙者下一轮空闲补一次；再下一轮什么都不发；安装只一次", async () => {
    const w = world(["agent-a", "agent-b", "agent-c"]);
    w.st.duringInstall = () => { w.find("agent-b")!.busy = true; w.st.master.busy = true; };
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual(["restart:agent-a", "restart:agent-c"]);

    // 下一轮仍忙：什么都不发
    expect((await nextRound(w))?.kind).toBe("wave");
    expect(w.st.keys).toEqual(["restart:agent-a", "restart:agent-c"]);

    w.find("agent-b")!.busy = false;
    w.st.master.busy = false;
    const r = await nextRound(w);
    expect(r?.kind === "wave" && r.restarted).toEqual(["agent-b", "master"]);
    expect(w.st.keys).toEqual(["restart:agent-a", "restart:agent-c", "restart:agent-b", "exit:master"]);
    expect(w.st.pending).toBeNull();
    expect(await nextRound(w)).toBeNull();
    expect(w.st.keys.length).toBe(4);
    expect(w.st.installs).toBe(1);
  });

  test("pending 的版本不是当前已装版本（别处换了二进制）→ 丢弃，不续波", async () => {
    const w = world(["agent-a"]);
    w.st.duringInstall = () => { w.find("agent-a")!.busy = true; };
    await startUpdateWave(w.ports);
    w.find("agent-a")!.busy = false;
    expect(await continueWave(w.ports, "2.1.301")).toBeNull();
    expect([w.st.keys, w.st.pending]).toEqual([[], null]);
  });

  test("失败预算同现有金丝雀规则：金丝雀起不来 → 中止其余、告警、不留 pending、下一轮不再试", async () => {
    const w = world(["agent-a", "agent-b"]);
    w.find("agent-a")!.failStart = true;
    const r = await startUpdateWave(w.ports);
    expect(r.kind === "wave" && r.canaryFailed).toBe("agent-a");
    expect(w.st.keys).toEqual(["restart:agent-a"]);
    expect(w.st.notices.some((n) => n.includes("金丝雀"))).toBe(true);
    expect(w.st.pending).toBeNull();
    expect(await nextRound(w)).toBeNull();
  });

  test("金丝雀过后某个 agent 起不来：记失败、不进 pending（不反复重启），其余照常", async () => {
    const w = world(["agent-a", "agent-b", "agent-c"]);
    w.find("agent-b")!.failStart = true;
    const r = await startUpdateWave(w.ports);
    expect(r.kind === "wave" && r.failed).toEqual(["agent-b"]);
    expect(w.st.keys).toEqual(["restart:agent-a", "restart:agent-b", "restart:agent-c", "exit:master"]);
    expect(w.st.pending).toBeNull();
  });

  test("自动波每个目标都走 --idle-only + 固定身份，从不调用无条件 restart / restart-all", async () => {
    const w = world(["agent-a", "agent-b"]);
    const calls: string[][] = [];
    const inner = w.ports.manager;
    w.ports.manager = (args, ms) => (calls.push(args), inner(args, ms));
    await startUpdateWave(w.ports);
    const restarts = calls.filter((a) => a[0] === "restart");
    expect(restarts.length).toBe(2);
    for (const a of restarts) {
      expect(a).toContain("--idle-only");
      expect(a).not.toContain("--include-master");
      const want = JSON.parse(a[a.indexOf("--idle-only") + 1]);
      expect(want).toEqual({ sessionId: `s-${a[a.length - 1]}`, windows: [w.find(a[a.length - 1])!.window] });
    }
  });
});
