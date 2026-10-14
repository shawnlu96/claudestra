import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_PATH } from "../src/lib/paths.ts";
import { setLang } from "../src/lib/config-store.ts";
import {
  WATCHDOG_LIMITS as L, initialWatchdogState, runWatchdogRound,
  type ProbeResult, type WatchdogDeps, type WatchdogMode, type WatchdogState,
} from "../src/lib/bridge-watchdog.ts";
import { captureBridgeDiag, readSideMode, type DiagIo, type SideMode } from "../src/lib/bridge-watchdog-diag.ts";
import { sendBridgeOob, type OobEvent, type OobIo } from "../src/lib/bridge-watchdog-oob.ts";

const T0 = 1_000_000_000_000;
const OK: ProbeResult = { ok: true, relay: { enabled: false, connected: false, state: null, retryAt: null } };
const FAIL: ProbeResult = { ok: false, error: "timeout" };
const GRACE = Math.ceil(L.graceMs / 15_000) + 1;
const ok = (n: number) => Array<ProbeResult>(n).fill(OK);
const fail = (n: number) => Array<ProbeResult>(n).fill(FAIL);

/** 假依赖：probes 按轮消费（用完重复最后一个），events 记抓现场 / 带外通知 / 重启的先后 */
function harness(opts: { mode?: WatchdogMode; probes: ProbeResult[]; diag?: WatchdogDeps["captureDiag"] | null; restart?: WatchdogDeps["restart"] }) {
  let now = T0;
  let probed = 0;
  const events: string[] = [];
  const oob: OobEvent[] = [];
  const calls = { log: [] as string[], notify: [] as string[] };
  const deps: WatchdogDeps = {
    mode: () => opts.mode ?? "on",
    deployRunning: () => false,
    bridgePid: async () => 100,
    probe: async () => opts.probes[Math.min(probed++, opts.probes.length - 1)]!,
    restart: async (pid) => (events.push("restart"), opts.restart ? opts.restart(pid) : "restarted"),
    log: (l) => void calls.log.push(l),
    notify: async (t) => void calls.notify.push(t),
    now: () => now,
    captureDiag: opts.diag === null ? undefined : async (pid) => (events.push("diag"), opts.diag ? opts.diag(pid) : "bridge-stuck-20010909T014640Z"),
    oob: async (ev) => { events.push(`oob:${ev.kind}`); oob.push(ev); },
    diagBudgetMs: 30,
  };
  let state: WatchdogState = initialWatchdogState();
  const rounds = async (n: number) => {
    for (let i = 0; i < n; i++) {
      state = (await runWatchdogRound(state, deps)).state;
      now += 15_000;
    }
  };
  return { deps, events, oob, calls, rounds, get state() { return state; } };
}

describe("on 档：先抓现场再重启，每个卡住事件一次", () => {
  test("第一次判卡住：抓现场 → 带外通知 → 重启；同一事件后续判定不再抓、不再发", async () => {
    const h = harness({ probes: [...ok(GRACE), FAIL] });
    await h.rounds(GRACE + 4);
    expect(h.events).toEqual(["diag", "oob:stuck", "restart"]);
    expect(h.oob[0]).toMatchObject({ kind: "stuck", reason: "api", watchdogMode: "on", diagDir: "bridge-stuck-20010909T014640Z" });
    expect(h.oob[0]!.lastOkAt).toBe(T0 + (GRACE - 1) * 15_000);
    await h.rounds(4 * 20); // 一直没恢复：冷却、再重启，都属于同一事件
    expect(h.events.filter((e) => e === "diag").length).toBe(1);
    expect(h.events.filter((e) => e.startsWith("oob")).length).toBe(1);
    expect(h.events.filter((e) => e === "restart").length).toBeGreaterThan(1);
  });

  test("恢复发一条；恢复后再卡住是新事件，重新抓、重新发", async () => {
    const h = harness({ probes: [...ok(GRACE), ...fail(8), ...ok(3), ...fail(4), OK] });
    await h.rounds(GRACE + 8 + 3);
    expect(h.events.filter((e) => e !== "restart")).toEqual(["diag", "oob:stuck", "oob:recovered"]);
    expect(h.oob[1]).toMatchObject({ kind: "recovered", reason: "api", diagDir: "bridge-stuck-20010909T014640Z", startedAt: h.oob[0]!.startedAt });
    expect(h.state.episode).toBeNull();
    await h.rounds(4 + 3);
    expect(h.events.filter((e) => e !== "restart")).toEqual(["diag", "oob:stuck", "oob:recovered", "diag", "oob:stuck", "oob:recovered"]);
  });

  test("抓现场抛错：重启照常，记一行日志，通知里现场为空", async () => {
    const h = harness({ probes: [...ok(GRACE), FAIL], diag: async () => { throw new Error("sample boom"); } });
    await h.rounds(GRACE + 4);
    expect(h.events).toEqual(["diag", "oob:stuck", "restart"]);
    expect(h.oob[0]!.diagDir).toBeNull();
    expect(h.calls.log.some((l) => l.includes("sample boom"))).toBe(true);
    expect(h.calls.notify[0]).toContain("已自动重启");
  });

  test("抓现场挂住不返回：到时限就照常重启，同一事件不重抓", async () => {
    const h = harness({ probes: [...ok(GRACE), FAIL], diag: () => new Promise<string | null>(() => {}) });
    await h.rounds(GRACE + 4);
    expect(h.events).toEqual(["diag", "oob:stuck", "restart"]);
    expect(h.calls.log.some((l) => l.includes("抓现场超过"))).toBe(true);
    await h.rounds(8);
    expect(h.events.filter((e) => e === "diag").length).toBe(1);
  });

  test("带外通知抛错不挡重启和原有通知", async () => {
    const h = harness({ probes: [...ok(GRACE), FAIL] });
    h.deps.oob = async () => { throw new Error("oob boom"); };
    await h.rounds(GRACE + 4);
    expect(h.events).toEqual(["diag", "restart"]);
    expect(h.calls.notify.length).toBe(1);
    expect(h.calls.log.some((l) => l.includes("oob boom"))).toBe(true);
  });

  test("重启因部署 / 换进程被让掉：现场已在重启前抓，事件保留，恢复时照发", async () => {
    for (const r of ["deploying", "pid-changed"] as const) {
      const h = harness({ probes: [...ok(GRACE), ...fail(4), OK], restart: async () => r });
      await h.rounds(GRACE + 4);
      expect(h.events).toEqual(["diag", "oob:stuck", "restart"]);
      expect(h.state.episode?.diagDir).toBe("bridge-stuck-20010909T014640Z");
      await h.rounds(2);
      expect(h.events.at(-1)).toBe("oob:recovered");
    }
  });

  test("中继卡住的事件：接口通但中继没连上不算恢复，连上才发恢复", async () => {
    const down: ProbeResult = { ok: true, relay: { enabled: true, connected: false, state: "offline", retryAt: null } };
    const up: ProbeResult = { ok: true, relay: { enabled: true, connected: true, state: "online", retryAt: null } };
    const stuckRounds = L.relayStuckMs / 15_000 + 1;
    const h = harness({ probes: [...Array<ProbeResult>(stuckRounds + 6).fill(down), up] });
    await h.rounds(stuckRounds + 6);
    expect(h.events.filter((e) => e !== "restart")).toEqual(["diag", "oob:stuck"]);
    expect(h.oob[0]!.reason).toBe("relay");
    await h.rounds(2);
    expect(h.events.filter((e) => e !== "restart")).toEqual(["diag", "oob:stuck", "oob:recovered"]);
  });
});

describe("看门狗 observe / off 与缺省依赖", () => {
  test("看门狗 observe：第一次判卡住抓一次、发一条，之后每次判定都不重复；不重启", async () => {
    const h = harness({ mode: "observe", probes: [...ok(GRACE), ...fail(4 * 10), OK] });
    await h.rounds(GRACE + 4 * 10);
    expect(h.events).toEqual(["diag", "oob:stuck"]);
    expect(h.oob[0]!.watchdogMode).toBe("observe");
    await h.rounds(2);
    expect(h.events).toEqual(["diag", "oob:stuck", "oob:recovered"]);
  });

  test("看门狗 off：不探测，也不抓、不发", async () => {
    const h = harness({ mode: "off", probes: [FAIL] });
    await h.rounds(40);
    expect(h.events).toEqual([]);
  });

  test("没注入 captureDiag / oob（BWD1 的依赖）：行为不变", async () => {
    const h = harness({ probes: [...ok(GRACE), FAIL], diag: null });
    h.deps.oob = undefined;
    await h.rounds(GRACE + 4);
    expect(h.events).toEqual(["restart"]);
    expect(h.calls.notify.length).toBe(1);
  });
});

describe("接上真模块：observe / off 档与 token", () => {
  const TOKEN = "FAKE-TOKEN.bwd2-e2e.do-not-leak-9876543210";

  function wired(diagMode: SideMode, oobMode: SideMode, discord: boolean) {
    const baseDir = mkdtempSync(join(tmpdir(), "bwd2-ep-"));
    const h = harness({ probes: [...ok(GRACE), ...fail(12), OK] });
    const out = { exec: [] as string[][], fetch: [] as { url: string; init: RequestInit }[] };
    const exec = async (cmd: string[]) => (out.exec.push(cmd), { ok: true as const, out: "" });
    const diagIo: DiagIo = { mode: () => diagMode, platform: "darwin", baseDir, exec, log: h.deps.log, now: h.deps.now };
    const oobIo: OobIo = {
      mode: () => oobMode, platform: "darwin", exec, log: h.deps.log, hostname: () => "box.internal.example.com",
      discord: () => (discord ? { token: TOKEN, channelId: "42" } : { token: "", channelId: "" }),
      fetch: async (url, init) => (out.fetch.push({ url, init }), { ok: true, status: 200 }),
    };
    h.deps.captureDiag = (pid) => captureBridgeDiag(pid, diagIo);
    h.deps.oob = (ev) => sendBridgeOob(ev, oobIo);
    return { h, out, baseDir };
  }

  test("两键 observe：整个事件只各记一次「本会抓」「本会发」（恢复再记一次本会发），不调任何外部命令", async () => {
    const { h, out, baseDir } = wired("observe", "observe", true);
    try {
      await h.rounds(GRACE + 12 + 2);
      expect(out.exec.length).toBe(0);
      expect(out.fetch.length).toBe(0);
      expect(h.calls.log.filter((l) => l.includes("本会抓")).length).toBe(1);
      expect(h.calls.log.filter((l) => l.includes("本会发")).length).toBe(2);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("两键 off：完全不调，重启照常", async () => {
    const { h, out, baseDir } = wired("off", "off", true);
    try {
      await h.rounds(GRACE + 12 + 2);
      expect(out.exec.length + out.fetch.length).toBe(0);
      expect(h.calls.log.some((l) => l.includes("现场") || l.includes("带外通知"))).toBe(false);
      expect(h.events).toContain("restart");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("两键 on：开始、恢复各发一条 REST；日志、通知、命令参数、请求体里都没有 token", async () => {
    const { h, out, baseDir } = wired("on", "on", true);
    try {
      await h.rounds(GRACE + 12 + 2);
      expect(out.fetch.length).toBe(2);
      const bodies = out.fetch.map((f) => String(f.init.body));
      expect(bodies[0]).toContain("bridge 卡住");
      expect(bodies[0]).toMatch(/bridge-stuck-\d{8}T\d{6}Z/);
      expect(bodies[1]).toContain("恢复正常");
      const everything = [...h.calls.log, ...h.calls.notify, ...out.exec.flat(), ...bodies, ...out.fetch.map((f) => f.url)].join("\n");
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain("internal.example.com");
      expect((out.fetch[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("没有 Discord 配置：开始、恢复各发一条系统通知", async () => {
    const { h, out, baseDir } = wired("off", "on", false);
    try {
      await h.rounds(GRACE + 12 + 2);
      expect(out.fetch.length).toBe(0);
      expect(out.exec.map((c) => c[0])).toEqual(["osascript", "osascript"]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("两个新键持久", () => {
  test("set*（读改写）之后保持；不写 / 坏值按 on", async () => {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    try {
      for (const mode of ["off", "observe", "on"] as const) {
        writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh", bridgeWatchdogDiag: mode, bridgeWatchdogOob: mode }));
        await setLang("en");
        const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        expect([saved.bridgeWatchdogDiag, saved.bridgeWatchdogOob]).toEqual([mode, mode]);
        expect([readSideMode("bridgeWatchdogDiag"), readSideMode("bridgeWatchdogOob")]).toEqual([mode, mode]);
      }
      writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh", bridgeWatchdogOob: "loud" }));
      await setLang("en");
      expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).bridgeWatchdogDiag).toBeUndefined();
      expect([readSideMode("bridgeWatchdogDiag"), readSideMode("bridgeWatchdogOob")]).toEqual(["on", "on"]);
    } finally {
      rmSync(CONFIG_PATH, { force: true });
    }
  });
});
