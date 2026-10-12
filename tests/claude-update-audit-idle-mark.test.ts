/**
 * hardening-CCIDLE1 第 3 轮审查反例（last-read-race / identity-race）：回合代际读不出 ≠ 没变。
 * mark / masterMark 接真 transcriptMark：会话记录路径不在（首尾都读不出）时，有窗口的目标与 master 一律跳过 / 延后；
 * 记录在、稳定空闲照样一次放行；没窗口的已死目标不要求代际。只用临时目录与合成端口，不碰真 tmux / registry / bridge。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { idleSkip, type Activity, type IdlePorts } from "../src/manager/restart-idle.js";
import { continueWave, startUpdateWave, transcriptMark, type PendingWave, type WavePorts } from "../src/lib/claude-update-restart.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✻ Thinking… (3s · esc to interrupt)", CC_IDLE].join("\n");
const WANT = JSON.stringify({ sessionId: "session-a", windows: ["@7"] });
const dir = mkdtempSync(join(tmpdir(), "ccidle-mark-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 一个 agent，会话 / 窗口不变；startTurn() = 画面转忙 + 会话记录追加（文件在的话） */
function agentWorld(path: string) {
  const st = { busy: false, windowsReads: 0, activityReads: 0 };
  const startTurn = () => { st.busy = true; if (existsSync(path)) appendFileSync(path, "{\"turn\":1}\n"); }; // 记录不在就只转忙
  const hooks = { windows: (_n: number) => {}, activity: (_n: number) => {} };
  const p: IdlePorts = {
    session: () => "session-a",
    windows: async () => { hooks.windows(++st.windowsReads); return ["@7"]; },
    activity: async () => {
      const snap: Activity = st.busy ? "busy" : "idle";
      hooks.activity(++st.activityReads);
      return snap;
    },
    mark: () => transcriptMark(path),
  };
  return { st, p, hooks, startTurn };
}

describe("[验收线 2] transcriptMark：读不出是 null，不是空串", () => {
  test("没路径 / 文件不在 = null；文件在 = 大小:修改时间", () => {
    const f = join(dir, "present.jsonl");
    writeFileSync(f, "x\n");
    expect(transcriptMark(null)).toBeNull();
    expect(transcriptMark(join(dir, "missing.jsonl"))).toBeNull();
    expect(transcriptMark(f)).toMatch(/^2:/);
  });
});

describe("[验收线 2] manager 复核：有窗口而回合代际读不出 → 跳过", () => {
  const missing = join(dir, "no-such.jsonl");

  test("第三次 windows() 内开回合（记录不在）→ 跳过", async () => {
    const w = agentWorld(missing);
    w.hooks.windows = (n) => { if (n === 3) w.startTurn(); };
    const r = await idleSkip("agent-a", WANT, w.p);
    expect(w.st.busy).toBe(true);
    expect(r?.skipped).toContain("回合代际读不出");
  });

  test("第二次 activity() 取到空闲快照后开回合（记录不在）→ 跳过", async () => {
    const w = agentWorld(missing);
    w.hooks.activity = (n) => { if (n === 2) w.startTurn(); };
    expect((await idleSkip("agent-a", WANT, w.p))?.skipped).toContain("回合代际读不出");
  });

  test("记录不在、全程空闲也跳过（没有可靠代际）", async () => {
    expect((await idleSkip("agent-a", WANT, agentWorld(missing).p))?.skipped).toContain("回合代际读不出");
  });

  test("首读成功、末读失败（记录被挪走）→ 跳过", async () => {
    const f = join(dir, "moved.jsonl");
    writeFileSync(f, "x\n");
    const w = agentWorld(f);
    w.hooks.windows = (n) => { if (n === 3) rmSync(f); };
    expect((await idleSkip("agent-a", WANT, w.p))?.skipped).toContain("回合代际读不出");
  });

  test("对照：记录在、第三次 windows() 内开回合 → 按新回合跳过；稳定空闲 → 放行", async () => {
    const f = join(dir, "agent-a.jsonl");
    writeFileSync(f, "{\"turn\":0}\n");
    const w = agentWorld(f);
    w.hooks.windows = (n) => { if (n === 3) w.startTurn(); };
    expect((await idleSkip("agent-a", WANT, w.p))?.skipped).toContain("开了新回合");
    const g = join(dir, "agent-b.jsonl");
    writeFileSync(g, "{\"turn\":0}\n");
    expect(await idleSkip("agent-a", WANT, agentWorld(g).p)).toBeNull();
  });

  test("没窗口的已死目标：记录不在也放行", async () => {
    const w = agentWorld(missing);
    const dead = JSON.stringify({ sessionId: "session-a", windows: [] });
    expect(await idleSkip("agent-a", dead, { ...w.p, windows: async () => [] })).toBeNull();
  });
});

/** 只有 master 的升级世界：masterMark 接真 transcriptMark(path) */
function masterWorld(path: string) {
  const st = { busy: false, keys: [] as string[], runReads: 0, installs: 0, pending: null as PendingWave | null };
  const startTurn = () => { st.busy = true; if (existsSync(path)) appendFileSync(path, "{\"turn\":1}\n"); }; // 记录不在就只转忙
  const hooks = { run: (_n: number) => {} };
  const ports: WavePorts = {
    masterWindow: "master:0",
    mention: "<@owner>",
    session: "master",
    async manager(args) {
      if (args[0] === "list") return { ok: true, out: JSON.stringify({ agents: [] }) };
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
    masterMark: () => transcriptMark(path),
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

describe("[验收线 1][验收线 2] master：回合代际读不出 → 不打 /exit，延后", () => {
  test("第 4 次 masterRun() 内开回合（记录不在）→ 不发 /exit，deferred=[master]", async () => {
    const w = masterWorld(join(dir, "no-master.jsonl"));
    w.hooks.run = (n) => { if (n === 4) w.startTurn(); };
    const r = await startUpdateWave(w.ports);
    expect(w.st.busy).toBe(true);
    expect(w.st.keys).toEqual([]);
    expect(r.kind === "wave" && r.restarted).toEqual([]);
    expect(r.kind === "wave" && r.deferred).toEqual(["master"]);
    expect(w.st.pending?.master).toBe("100");
  });

  test("记录出现后下一轮空闲 → 正好补一次 /exit，不重装", async () => {
    const f = join(dir, "master-late.jsonl");
    const w = masterWorld(f);
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    writeFileSync(f, "{\"turn\":0}\n");
    const r = await continueWave(w.ports, "2.1.300");
    expect(w.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
    expect(r?.kind === "wave" && r.restarted).toEqual(["master"]);
    expect(w.st.installs).toBe(1);
  });

  test("对照：记录在、第 4 次 masterRun() 内开回合 → 跳过；稳定空闲 → 一次 /exit", async () => {
    const f = join(dir, "master.jsonl");
    writeFileSync(f, "{\"turn\":0}\n");
    const w = masterWorld(f);
    w.hooks.run = (n) => { if (n === 4) w.startTurn(); };
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    const g = join(dir, "master-b.jsonl");
    writeFileSync(g, "{\"turn\":0}\n");
    const v = masterWorld(g);
    await startUpdateWave(v.ports);
    expect(v.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
  });
});
