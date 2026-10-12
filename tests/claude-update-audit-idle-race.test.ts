/**
 * hardening-CCIDLE1 第 1 轮审查反例（last-read-race / master-session）：
 * - manager 侧复核在第二次 windows() / activity() 读取期间换会话或窗口，仍要跳过（收尾再读窗口 + 会话）；
 * - master 在第二次画面读取期间换进程，仍不打 /exit；
 * - master 的 Claude 是常驻 shell 里的普通命令：同一 pane pid 下换了会话 / 重开 Claude，也不打 /exit。
 * 合成端口，不碰真 tmux / registry / bridge。
 */
import { describe, expect, test } from "bun:test";
import { idleSkip, type Activity, type IdlePorts } from "../src/manager/restart-idle.js";
import { startUpdateWave, continueWave, type PendingWave, type WavePorts } from "../src/lib/claude-update-restart.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const WANT = JSON.stringify({ sessionId: "session-old", windows: ["@7"] });

function idlePorts() {
  const st = { session: "session-old", windows: ["@7"], activity: "idle" as Activity, windowsReads: 0, activityReads: 0 };
  const hooks = { windows: (_n: number) => {}, activity: (_n: number) => {} };
  const p: IdlePorts = {
    session: () => st.session,
    windows: async () => { hooks.windows(++st.windowsReads); return ["@7"]; },
    activity: async () => { hooks.activity(++st.activityReads); return "idle"; },
  };
  return { st, p, hooks };
}

describe("[验收线 2] manager 复核：最后一次异步读取期间换身份也跳过", () => {
  test("第二次 windows() 内换会话（窗口、活动照旧）→ 跳过", async () => {
    const f = idlePorts();
    f.hooks.windows = (n) => { if (n === 2) f.st.session = "session-new"; };
    expect((await idleSkip("agent-a", WANT, f.p))?.skipped).toContain("会话换了");
  });

  test("第二次 activity() 内换会话 → 跳过", async () => {
    const f = idlePorts();
    f.hooks.activity = (n) => { if (n === 2) f.st.session = "session-new"; };
    expect((await idleSkip("agent-a", WANT, f.p))?.skipped).toContain("会话换了");
  });

  test("第二次 activity() 内换窗口（会话不变）→ 跳过", async () => {
    const f = idlePorts();
    f.p.windows = async () => (++f.st.windowsReads, f.st.windows);
    f.hooks.activity = (n) => { if (n === 2) f.st.windows = ["@8"]; };
    expect((await idleSkip("agent-a", WANT, f.p))?.skipped).toContain("窗口换了");
  });

  test("稳定空闲照样放行", async () => {
    expect(await idleSkip("agent-a", WANT, idlePorts().p)).toBeNull();
  });
});

/** 只有 master 的升级世界：pane pid 是常驻 shell，run = 窗口里那一代 Claude（会话@进程） */
function masterWorld() {
  const st = { pid: "100", run: "master-old@500", keys: [] as string[], captures: 0, pending: null as PendingWave | null };
  const hooks = { capture: (_n: number) => {}, install: () => {} };
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
      if (args[0] === "display-message") return st.pid;
      if (args[0] === "capture-pane") { hooks.capture(++st.captures); return CC_IDLE; }
      if (args[0] === "send-keys") { st.keys.push(args.join(" ")); return ""; }
      throw new Error(`unexpected tmux ${args.join(" ")}`);
    },
    masterRun: async () => st.run,
    async registry() { return []; },
    async busy() { return []; },
    async install() { hooks.install(); return "2.1.300"; },
    readPending: () => st.pending,
    writePending: (p) => { st.pending = p; },
    async notify() {},
    log() {},
    lease() {},
    now: () => 1_000,
  };
  return { st, hooks, ports };
}

describe("[验收线 2] master：按 pane pid + 这一代 Claude 认身份，最后一次读取期间变了也不打 /exit", () => {
  test("第二次 capture-pane 内 pane pid 100 → 200（画面空闲）→ 不发 /exit，master 延后", async () => {
    const w = masterWorld();
    w.hooks.capture = (n) => { if (n === 2) w.st.pid = "200"; };
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    expect(r.kind === "wave" && r.deferred).toEqual(["master"]);
    expect(w.st.pending?.master).toBe("100");
  });

  test("第二次 capture-pane 内同一 shell 换了 Claude 会话 → 不发 /exit", async () => {
    const w = masterWorld();
    w.hooks.capture = (n) => { if (n === 2) w.st.run = "master-new@501"; };
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
  });

  test("安装期间同一 shell 里换了 master 会话（pane pid、窗口、空闲画面都不变）→ 不发 /exit，留 pending", async () => {
    const w = masterWorld();
    w.hooks.install = () => { w.st.run = "master-new@500"; };
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    expect(r.kind === "wave" && r.restarted).toEqual([]);
    expect(w.st.pending?.masterRun).toBe("master-old@500");
    // 下一轮：身份仍对不上，照样不动
    await continueWave(w.ports, "2.1.300");
    expect(w.st.keys).toEqual([]);
  });

  test("拍身份时 master 的 Claude 读不出 → 说不准，延后不发 /exit", async () => {
    const w = masterWorld();
    w.st.run = "";
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    expect(w.st.pending?.master).toBe("100");
  });

  test("master 身份稳定、画面空闲 → 正好一次 /exit，pending 清空", async () => {
    const w = masterWorld();
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
    expect(r.kind === "wave" && r.restarted).toEqual(["master"]);
    expect(w.st.pending).toBeNull();
  });
});
