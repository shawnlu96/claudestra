/**
 * hardening-CCIDLE1 第 6 轮审查反例：
 * - last-read-race：最后一次 windows() 返回旧快照（@7 已换成 @8），真实 programInputNoter 吞掉 list-panes 错误、照样「准备好」，
 *   退出返回 false 进 manager 的强杀 / kill-window / new-window。现在发键准备严格按 id 查已核窗口，首个键严格发：都转成跳过；
 * - live-turn-race：master 收尾的 masterLive（同步 ps）期间别的进程开回合，曾在最后一次代际之后、看不到。现在代际最后核。
 * agent 段用真的 tmuxWindowOps / programInputNoter / tmuxRawStrict / gracefulExitWindow，只拦截 Bun.spawn 假装 tmux（不碰真 tmux）；
 * master 段用真的 startUpdateWave / ccRunLive / transcriptMark，临时目录里的合成进程登记与会话记录。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gracefulExitWindow } from "../src/lib/runtimes/graceful-exit.js";
import { tmuxWindowOps } from "../src/lib/runtimes/window-ops.js";
import type { ManagedRuntimeAdapter } from "../src/lib/runtimes/types.js";
import { idleSkip, type IdlePorts } from "../src/manager/restart-idle.js";
import { idleGracefulExit, LIVE_EXIT_IO, strictExitPrepare } from "../src/manager/restart-idle-exit.js";
import { startUpdateWave, transcriptMark, type PendingWave, type WavePorts } from "../src/lib/claude-update-restart.js";
import { ccRunLive } from "../src/lib/claude-update-restart-live.js";

const RULE = "─".repeat(52);
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const SHELL = "he@mac ~ $";
const WANT = JSON.stringify({ sessionId: "s-1", windows: ["@7"] });
const CC = { exitCommand: "/exit" } as unknown as ManagedRuntimeAdapter;

const realSpawn = Bun.spawn;
afterEach(() => { (Bun as { spawn: unknown }).spawn = realSpawn; });

/** 拦截全部 Bun.spawn 当假 tmux：live = 此刻真在的窗口 id；对不在的窗口 exit 1（同真 tmux） */
function fakeTmux(live: Set<string>) {
  const calls: string[] = [];
  let exited = false;
  const stream = (s: string) => new Response(s).body!;
  (Bun as { spawn: unknown }).spawn = (argv: string[]) => {
    const i = argv.indexOf("-S");
    const args = i >= 0 ? argv.slice(i + 2) : argv;
    calls.push(args.join(" "));
    const t = args[args.indexOf("-t") + 1] ?? "";
    let out = "", err = "", code = 0;
    if (!live.has(t)) { err = `can't find window: ${t}`; code = 1; }
    else if (args[0] === "list-panes") out = `${t}\n`;
    else if (args[0] === "capture-pane") out = exited ? SHELL : CC_IDLE;
    else if (args[0] === "send-keys" && (args.includes("Enter") || args.includes("C-d"))) exited = true;
    return { stdout: stream(out), stderr: stream(err), exited: Promise.resolve(code), kill() {} };
  };
  return calls;
}

function agentGate(onWindowsRead: (n: number) => void) {
  let reads = 0;
  let windows = ["@7"];
  const ports: IdlePorts = {
    session: () => "s-1",
    windows: async () => { const snap = [...windows]; onWindowsRead(++reads); return snap; }, // 先拍快照，期间才换窗口，返回旧值
    activity: async () => "idle",
    mark: () => "10:1",
  };
  return { ports, swap: (w: string[]) => { windows = w; } };
}

const quickOps = (name: string, target: string) => ({ ...tmuxWindowOps(name, target), sleep: async () => {} });
const sends = (calls: string[]) => calls.filter((c) => c.startsWith("send-keys"));

describe("[验收线 2] last-read-race（真实发键准备）：旧窗口已不在 → 跳过，不进强杀 / 重建", () => {
  test("复现：programInputNoter 吞掉 list-panes 错误，不能当窗口存在的证据", async () => {
    // 先红的根因：旧 LIVE_IO.prepare = programInputNoter，旧窗口不在也返回记账函数
    const calls = fakeTmux(new Set(["@8"]));
    const { programInputNoter } = await import("../src/lib/tmux-helper.js");
    await expect(programInputNoter("@7")).resolves.toBeFunction();
    calls.length = 0;
    await expect(strictExitPrepare("@7")).rejects.toThrow("@7");
    expect(sends(calls)).toEqual([]);
  });

  test("第三次 windows() 拍下 @7、实际换成 @8、返回旧快照 → skipped，一个 send-keys 都不发（先红：result=false、8 次发键尝试）", async () => {
    const live = new Set(["@7"]);
    const calls = fakeTmux(live);
    const g = agentGate((n) => { if (n === 3) { g.swap(["@8"]); live.clear(); live.add("@8"); } });
    const r = await idleGracefulExit("agent-a", "@7", WANT, CC, {
      gate: (prepare) => idleSkip("agent-a", WANT, g.ports, prepare), io: LIVE_EXIT_IO, ops: quickOps, exit: gracefulExitWindow,
    });
    expect(typeof r === "object" && r.skipped).toContain("复核读失败");
    expect(sends(calls)).toEqual([]);
  });

  test("准备时还在、发首个键前窗口没了 → 首个键严格发失败 = skipped，不返回 false", async () => {
    const live = new Set(["@7"]);
    const calls = fakeTmux(live);
    const g = agentGate(() => {});
    const r = await idleGracefulExit("agent-a", "@7", WANT, CC, {
      gate: (prepare) => idleSkip("agent-a", WANT, g.ports, async () => { await prepare(); live.clear(); }), io: LIVE_EXIT_IO, ops: quickOps, exit: gracefulExitWindow,
    });
    expect(typeof r === "object" && r.skipped).toContain("首个退出键没发出去");
    expect(sends(calls)).toEqual(["send-keys -t @7 C-c"]); // 只有那一次失败的尝试，之后不再发
  });

  test("对照：窗口一直在 → 真实路径退出成功，键全落在 @7", async () => {
    const calls = fakeTmux(new Set(["@7"]));
    const g = agentGate(() => {});
    const r = await idleGracefulExit("agent-a", "@7", WANT, CC, {
      gate: (prepare) => idleSkip("agent-a", WANT, g.ports, prepare), io: LIVE_EXIT_IO, ops: quickOps, exit: gracefulExitWindow,
    });
    expect(r).toBe(true);
    expect(sends(calls)[0]).toBe("send-keys -t @7 C-c");
    expect(sends(calls).every((c) => c.startsWith("send-keys -t @7 "))).toBe(true);
  });
});

describe("[验收线 2] live-turn-race（master）：最后的同步身份核对期间开回合 → 不打 /exit，延后", () => {
  const LSTART = "Mon Oct 12 03:38:51 2026";
  const RUN = "old-session@500";

  function masterWorld(onLstart: (transcript: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "ccidle-strict-"));
    const transcript = join(dir, "old-session.jsonl");
    writeFileSync(transcript, '{"type":"user"}\n');
    writeFileSync(join(dir, "500.json"), JSON.stringify({ pid: 500, sessionId: "old-session", cwd: "/m", startedAt: Date.parse(LSTART) + 1_000 }));
    const st = { keys: [] as string[], events: [] as string[], pending: null as PendingWave | null };
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
        if (args[0] === "capture-pane") return CC_IDLE;
        if (args[0] === "send-keys") { st.keys.push(args.join(" ")); st.events.push(`sent:${args.join(" ")}`); return ""; }
        throw new Error(`unexpected tmux ${args.join(" ")}`);
      },
      masterRun: async () => RUN,
      masterMark: () => transcriptMark(transcript),
      masterLive: (run) => ccRunLive(run, { dir, alive: () => true, lstart: () => (onLstart(transcript), LSTART) }),
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
    return { st, ports, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("lstart（同步 ps）期间另一进程追加回合 → keys=[]、deferred=[master]、pending 保留（先红：发了 /exit、pending=null）", async () => {
    const w = masterWorld((t) => {
      // 另一个进程在最后身份查询期间写会话记录：真子进程同步追加，launcher 这边被 spawnSync 阻塞着
      Bun.spawnSync([process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(t)}, '{"type":"user","turn":2}\\n')`]);
      w.st.events.push("turn-started-during-final-live-read");
    });
    try {
      const r = await startUpdateWave(w.ports);
      expect(w.st.events).toContain("turn-started-during-final-live-read");
      expect(w.st.keys).toEqual([]);
      expect(r.kind === "wave" && r.restarted).toEqual([]);
      expect(r.kind === "wave" && r.deferred).toEqual(["master"]);
      expect(w.st.pending?.master).toBe("100");
      expect(w.st.pending?.masterRun).toBe(RUN);
    } finally {
      w.cleanup();
    }
  });

  test("对照：身份核对期间没人写 → 正好一次 /exit，pending 清掉", async () => {
    const w = masterWorld(() => {});
    try {
      const r = await startUpdateWave(w.ports);
      expect(w.st.keys).toEqual(["send-keys -t master:0 /exit Enter"]);
      expect(r.kind === "wave" && r.restarted).toEqual(["master"]);
      expect(w.st.pending).toBeNull();
    } finally {
      w.cleanup();
    }
  });
});

