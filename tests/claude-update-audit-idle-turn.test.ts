/**
 * hardening-CCIDLE1 第 2 轮审查反例（last-read-race 残留）：身份不变、同一会话在最后一次读取期间开了新回合。
 * 开回合 = 画面转忙 + 会话记录（jsonl）追加；复核开头和动手前一刻同步读会话记录的「回合代际」（mark），变了就跳过。
 * - manager：第三次（最后一次）windows() 内开回合；第二次 activity() 先取到空闲快照、返回前才开回合；
 * - master：最后一次 masterRun() 内开回合；
 * - 稳定空闲照样一次放行，延后的 master 下一轮空闲补一次 /exit，不重装。
 * 合成端口，不碰真 tmux / registry / bridge / 会话文件。
 */
import { describe, expect, test } from "bun:test";
import { idleSkip, type Activity, type IdlePorts } from "../src/manager/restart-idle.js";
import { continueWave, startUpdateWave, type PendingWave, type WavePorts } from "../src/lib/claude-update-restart.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✻ Thinking… (3s · esc to interrupt)", CC_IDLE].join("\n");
const WANT = JSON.stringify({ sessionId: "session-a", windows: ["@7"] });

/** 一个 agent：会话、窗口始终不变；startTurn() = 回合开始（画面转忙、会话记录追加一行） */
function agentWorld() {
  const st = { busy: false, bytes: 1000, windowsReads: 0, activityReads: 0, markReads: 0 };
  const startTurn = () => { st.busy = true; st.bytes += 300; };
  const hooks = { windows: (_n: number) => {}, activity: (_n: number) => {} };
  const p: IdlePorts = {
    session: () => "session-a",
    windows: async () => { hooks.windows(++st.windowsReads); return ["@7"]; },
    activity: async () => {
      const snap: Activity = st.busy ? "busy" : "idle"; // 先抓屏
      hooks.activity(++st.activityReads); // 抓完、返回前
      return snap;
    },
    mark: () => (++st.markReads, `${st.bytes}`),
  };
  return { st, p, hooks, startTurn };
}

describe("[验收线 2] manager 复核：最后一次读取期间同一会话开了回合也跳过", () => {
  test("第三次（最后一次）windows() 内开回合，会话 / 窗口不变 → 跳过", async () => {
    const w = agentWorld();
    w.hooks.windows = (n) => { if (n === 3) w.startTurn(); };
    const r = await idleSkip("agent-a", WANT, w.p);
    expect(w.st.windowsReads).toBe(3);
    expect(w.st.busy).toBe(true);
    expect(r?.skipped).toContain("开了新回合");
  });

  test("第二次 activity() 取到空闲快照后、返回前开回合（过时读）→ 跳过", async () => {
    const w = agentWorld();
    w.hooks.activity = (n) => { if (n === 2) w.startTurn(); };
    const r = await idleSkip("agent-a", WANT, w.p);
    expect(w.st.busy).toBe(true);
    expect(r?.skipped).toContain("开了新回合");
  });

  test("任一次 windows() / activity() 内开回合都跳过", async () => {
    for (const [at, reads] of [["windows", 3], ["activity", 2]] as const) {
      for (let n = 1; n <= reads; n++) {
        const w = agentWorld();
        w.hooks[at] = (k) => { if (k === n) w.startTurn(); };
        expect(await idleSkip("agent-a", WANT, w.p)).not.toBeNull();
      }
    }
  });

  test("稳定空闲 → 放行；会话记录读在复核首尾各一次", async () => {
    const w = agentWorld();
    expect(await idleSkip("agent-a", WANT, w.p)).toBeNull();
    expect(w.st.markReads).toBe(2);
  });

  test("没有会话记录（mark 恒为空，如 registry 里 active 却没窗口的）→ 不因此跳过", async () => {
    const w = agentWorld();
    w.p.mark = () => "";
    expect(await idleSkip("agent-a", JSON.stringify({ sessionId: "session-a", windows: [] }), { ...w.p, windows: async () => [] })).toBeNull();
  });
});

/** 只有 master 的升级世界：身份始终不变，startTurn() = master 开回合（画面转忙、会话记录追加） */
function masterWorld() {
  const st = { busy: false, bytes: 5000, keys: [] as string[], runReads: 0, installs: 0, pending: null as PendingWave | null };
  const startTurn = () => { st.busy = true; st.bytes += 300; };
  const hooks = { run: (_n: number) => {} };
  const out = (o: unknown) => ({ ok: true, out: JSON.stringify(o) });
  const ports: WavePorts = {
    masterWindow: "master:0",
    mention: "<@owner>",
    session: "master",
    async manager(args) {
      if (args[0] === "list") return out({ agents: [] });
      throw new Error(`unexpected manager ${args.join(" ")}`);
    },
    async tmux(args) {
      if (args[0] === "list-windows") return "master\t@0";
      if (args[0] === "display-message") return "100";
      if (args[0] === "capture-pane") return st.busy ? CC_BUSY : CC_IDLE;
      if (args[0] === "send-keys") { st.keys.push(args.join(" ")); return ""; }
      throw new Error(`unexpected tmux ${args.join(" ")}`);
    },
    masterRun: async () => { hooks.run(++st.runReads); return "master-a@500"; },
    masterMark: (run) => (run === "master-a@500" ? `${st.bytes}` : ""),
    async registry() { return []; },
    async busy() { return []; },
    async install() { st.installs++; return "2.1.300"; },
    readPending: () => st.pending,
    writePending: (p) => { st.pending = p; },
    async notify() {},
    log() {},
    lease() {},
    now: () => 1_000,
  };
  return { st, hooks, ports, startTurn };
}

describe("[验收线 1][验收线 2] master：最后一次身份读取期间开了回合，不打 /exit", () => {
  test("第 4 次 masterRun()（含拍身份那次，即退出前最后一次）内开回合 → 不发 /exit，master 延后", async () => {
    const w = masterWorld();
    w.hooks.run = (n) => { if (n === 4) w.startTurn(); };
    const r = await startUpdateWave(w.ports);
    expect(w.st.runReads).toBe(4);
    expect(w.st.busy).toBe(true);
    expect(w.st.keys).toEqual([]);
    expect(r.kind === "wave" && r.deferred).toEqual(["master"]);
    expect(w.st.pending?.master).toBe("100");
  });

  test("延后的 master 下一轮空闲 → 正好补一次 /exit，不重装", async () => {
    const w = masterWorld();
    w.hooks.run = (n) => { if (n === 4) w.startTurn(); };
    await startUpdateWave(w.ports);
    w.st.busy = false; // 回合结束
    w.hooks.run = () => {};
    const r = await continueWave(w.ports, "2.1.300");
    expect(w.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
    expect(r?.kind === "wave" && r.restarted).toEqual(["master"]);
    expect(w.st.pending).toBeNull();
    expect(w.st.installs).toBe(1);
  });

  test("稳定空闲 → 一次 /exit", async () => {
    const w = masterWorld();
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
  });
});
