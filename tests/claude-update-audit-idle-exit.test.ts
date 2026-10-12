/**
 * hardening-CCIDLE1 第 5 轮审查反例：
 * - pre-exit-await：idleSkip 放行后，gracefulExit 首个 C-c 之前还要 await 查窗口 id 记账；这段时间里开的回合也要挡下（src/manager/restart-idle-exit.ts）；
 * - last-read-race：最后一次异步身份读取返回过时快照——agent 窗口 @7 → @8、master 的 Claude old@500 → new@501——都不能把退出键发到新目标上
 *   （agent 退出绑定已核窗口 id；master 发 /exit 前同步核这一代 Claude，src/lib/claude-update-restart-live.ts）。
 * 用真的 gracefulExitWindow / acpExitPrelude，窗口与发键全是假的；临时目录里的合成进程登记；不碰真 tmux / registry / bridge。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gracefulExitWindow } from "../src/lib/runtimes/graceful-exit.js";
import { acpExitPrelude } from "../src/lib/runtimes/acp-control.js";
import type { ManagedRuntimeAdapter, WindowOps } from "../src/lib/runtimes/types.js";
import { idleSkip, type IdlePorts } from "../src/manager/restart-idle.js";
import { idleGracefulExit, type ExitKeyIO, type IdleExitDeps } from "../src/manager/restart-idle-exit.js";
import { startUpdateWave, continueWave, type PendingWave, type WavePorts } from "../src/lib/claude-update-restart.js";
import { ccRunLive } from "../src/lib/claude-update-restart-live.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const SHELL = "he@mac ~ $";
const WANT = JSON.stringify({ sessionId: "s-1", windows: ["@7"] });
const CC = { exitCommand: "/exit" } as unknown as ManagedRuntimeAdapter;

/** 假 agent：events 记下真的发出去的键与插进来的回合；mark = 会话记录代际（开回合就变） */
function agentWorld() {
  const st = { events: [] as string[], mark: 1, windows: ["@7"], live: new Set(["@7"]), exited: false };
  const hooks = { prepare: (_target: string) => {} };
  const startTurn = (why: string) => { st.mark++; st.events.push(why); };
  const ports: IdlePorts = {
    session: () => "s-1",
    windows: async () => st.windows,
    activity: async () => "idle",
    mark: () => String(st.mark),
  };
  const io: ExitKeyIO = {
    async prepare(target) {
      await Bun.sleep(1); // 查窗口 id 的 list-panes
      hooks.prepare(target);
      if (!st.live.has(target)) throw new Error(`can't find window: ${target}`);
      return (text = "") => void st.events.push(`note:${target}:${text}`);
    },
    async send(args) {
      st.events.push(`sent:${args.join(" ")}`);
      if (args.includes("C-c") || args.includes("Enter")) st.exited = true;
    },
  };
  /** 假窗口：同 tmuxWindowOps，sendKey 先 await 记账再发（审查给出的真实调用链） */
  const ops = (_name: string, target: string): WindowOps => ({
    name: "agent-a",
    target,
    capture: async () => (st.exited ? SHELL : CC_IDLE),
    sendLine: async (t) => void (await io.send(["line", target, t])),
    sendLiteral: async (t) => { (await io.prepare(target))(t); await io.send(["send-keys", "-t", target, "-l", "--", t]); },
    sendKey: async (k) => { (await io.prepare(target))(); await io.send(["send-keys", "-t", target, k]); },
    sendEscape: async () => void (await io.send(["send-keys", "-t", target, "Escape"])),
    getOption: async () => null,
    setOption: async () => true,
    childPids: async () => [4242],
    sleep: async () => {},
  });
  const deps = (raw = WANT): IdleExitDeps => ({ gate: (prepare) => idleSkip("agent-a", raw, ports, prepare), io, ops, exit: gracefulExitWindow });
  return { st, hooks, ports, io, ops, deps, startTurn };
}

const sent = (events: string[]) => events.filter((e) => e.startsWith("sent:"));

describe("[验收线 2] pre-exit-await：复核放行后、首个 C-c 之前的发键准备期间开回合 → 跳过，不发键", () => {
  test("旧路径（先红）：复核放行后直接 gracefulExit，准备期间开的回合被 C-c 打断", async () => {
    const w = agentWorld();
    expect(await idleSkip("agent-a", WANT, w.ports)).toBeNull();
    w.hooks.prepare = () => w.startTurn("turn-started-during-key-preparation");
    w.st.live.add("agent-a"); // 旧路径按名字发键
    await gracefulExitWindow(w.ops("agent-a", "agent-a"), CC);
    expect(w.st.events.indexOf("turn-started-during-key-preparation")).toBeLessThan(w.st.events.indexOf("sent:send-keys -t agent-a C-c"));
  });

  test("新路径：准备期间开回合 → skipped（开了新回合），一个键都不发", async () => {
    const w = agentWorld();
    w.hooks.prepare = () => w.startTurn("turn-started-during-key-preparation");
    const r = await idleGracefulExit("agent-a", "@7", WANT, CC, w.deps());
    expect(typeof r === "object" && r.skipped).toContain("开了新回合");
    expect(sent(w.st.events)).toEqual([]);
  });

  test("稳定空闲：准备完、复核过就发，C-c 落在已核窗口 @7 上，后续动作照常", async () => {
    const w = agentWorld();
    expect(await idleGracefulExit("agent-a", "@7", WANT, CC, w.deps())).toBe(true);
    expect(sent(w.st.events)[0]).toBe("sent:send-keys -t @7 C-c");
    expect(w.st.events.slice(0, 2)).toEqual(["note:@7:", "sent:send-keys -t @7 C-c"]); // 记账与发键之间不隔准备
  });

  test("ACP：查子进程（随后同步 SIGTERM）之前过闸；拒绝后 catch 吞掉也不改发 C-c", async () => {
    const w = agentWorld();
    const killed: number[] = [];
    const acp = { exitCommand: "/exit", exitPrelude: (win: WindowOps) => acpExitPrelude(win, (pid) => void killed.push(pid)) } as unknown as ManagedRuntimeAdapter;
    const base = w.ops;
    const deps = { ...w.deps(), ops: (n: string, t: string) => ({ ...base(n, t), childPids: async () => (w.startTurn("turn-during-childPids"), [4242]) }) };
    const r = await idleGracefulExit("agent-a", "@7", WANT, acp, deps);
    expect(typeof r === "object" && r.skipped).toContain("开了新回合");
    expect(killed).toEqual([]);
    expect(sent(w.st.events)).toEqual([]);
  });

  test("首个动作是 Esc（Codex 只在画面在跑时才按）→ 不像空闲，跳过", async () => {
    const w = agentWorld();
    const codex = { exitCommand: "/quit", exitPrelude: async (win: WindowOps) => (await win.sendEscape(), "continue" as const) } as unknown as ManagedRuntimeAdapter;
    const r = await idleGracefulExit("agent-a", "@7", WANT, codex, w.deps());
    expect(typeof r === "object" && r.skipped).toContain("按 Esc");
    expect(sent(w.st.events)).toEqual([]);
  });
});

describe("[验收线 2] last-read-race（agent）：最后一次窗口读取返回过时快照，键也落不到新窗口", () => {
  test("第三次 windows() 拍下 @7、期间换成 @8、返回旧快照 → 退出绑定 @7，按 id 准备时查不到就跳过，@8 没收到任何键", async () => {
    const w = agentWorld();
    let reads = 0;
    w.ports.windows = async () => {
      const snap = [...w.st.windows];
      if (++reads === 3) { w.st.windows = ["@8"]; w.st.live = new Set(["@8"]); }
      return snap;
    };
    const r = await idleGracefulExit("agent-a", "@7", WANT, CC, w.deps());
    expect(typeof r === "object" && r.skipped).toContain("复核读失败");
    expect(w.st.events.filter((e) => e.includes("@8"))).toEqual([]);
    expect(sent(w.st.events)).toEqual([]);
  });

  test("要退出的窗口不是拍身份时那一个 → 跳过，不碰窗口", async () => {
    const w = agentWorld();
    const r = await idleGracefulExit("agent-a", "@8", WANT, CC, w.deps());
    expect(typeof r === "object" && r.skipped).toContain("不是拍身份时那一个");
    expect(w.st.events).toEqual([]);
  });
});

/** 只有 master 的升级世界：run = 窗口里那一代 Claude；alive = 此刻真在跑的那一代（masterLive 同步核） */
function masterWorld() {
  const st = { run: "old-session@500", alive: "old-session@500", keys: [] as string[], runReads: 0, pending: null as PendingWave | null };
  const hooks = { masterRun: (_n: number) => {} };
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
      if (args[0] === "capture-pane") return CC_IDLE;
      if (args[0] === "send-keys") { st.keys.push(args.join(" ")); return ""; }
      throw new Error(`unexpected tmux ${args.join(" ")}`);
    },
    async masterRun() {
      const snap = st.run; // 先拍快照，期间才换代，最后返回旧值
      hooks.masterRun(++st.runReads);
      return snap;
    },
    masterMark: () => "10:1", // 旧会话记录不变
    masterLive: (run) => run === st.alive,
    async registry() { return []; },
    async busy() { return []; },
    async install() { return "2.1.300"; },
    readPending: () => st.pending,
    writePending: (p) => { st.pending = p; },
    async notify() {},
    log() {},
    lease() {},
    now: () => 1_000,
  };
  return { st, hooks, ports };
}

describe("[验收线 2] last-read-race（master）：最后一次 masterRun() 返回过时快照 → 不打 /exit，延后", () => {
  test("第四次 masterRun() 拍 old@500、期间换成 new@501、返回旧快照 → keys=[]、deferred=[master]、pending 保留", async () => {
    const w = masterWorld();
    w.hooks.masterRun = (n) => { if (n === 4) { w.st.run = "new-session@501"; w.st.alive = "new-session@501"; } };
    const r = await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual([]);
    expect(r.kind === "wave" && r.restarted).toEqual([]);
    expect(r.kind === "wave" && r.deferred).toEqual(["master"]);
    expect(w.st.pending?.masterRun).toBe("old-session@500");
  });

  test("稳定：正好一次 /exit；先延后的下一轮仍对不上就继续不动", async () => {
    const w = masterWorld();
    await startUpdateWave(w.ports);
    expect(w.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
    const v = masterWorld();
    v.st.alive = "new-session@501"; // 已换代：本轮与下一轮都不发
    await startUpdateWave(v.ports);
    await continueWave(v.ports, "2.1.300");
    expect(v.st.keys).toEqual([]);
  });
});

describe("ccRunLive：同步核这一代 Claude（进程在、启动时间对得上、登记还是那个会话）", () => {
  const LSTART = "Mon Oct 12 03:38:51 2026";
  const at = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ccidle-live-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const entry = (sessionId: string) => JSON.stringify({ pid: 500, sessionId, cwd: "/m", startedAt: Date.parse(LSTART) + 1_000 });

  test("对得上 = true；换会话 / 进程没了 / 登记没了 / pid 被复用 / 格式坏 = false", () => at((dir) => {
    const io = (alive = true, lstart = LSTART) => ({ dir, alive: () => alive, lstart: () => lstart });
    writeFileSync(join(dir, "500.json"), entry("old-session"));
    expect(ccRunLive("old-session@500", io())).toBe(true);
    expect(ccRunLive("new-session@500", io())).toBe(false);
    expect(ccRunLive("old-session@500", io(false))).toBe(false);
    expect(ccRunLive("old-session@500", io(true, "Mon Oct 12 09:00:00 2026"))).toBe(false);
    expect(ccRunLive("old-session@501", io())).toBe(false);
    expect(ccRunLive("", io())).toBe(false);
    writeFileSync(join(dir, "500.json"), entry("new-session"));
    expect(ccRunLive("old-session@500", io())).toBe(false);
  }));
});
