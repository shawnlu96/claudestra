import { describe, expect, test } from "bun:test";
import {
  WATCHDOG_LIMITS as L, decideRound, initialWatchdogState, observeRound, parseLaunchctlPid, parseWatchdogMode, runWatchdogRound,
  type ProbeResult, type RelaySnapshot, type WatchdogDeps, type WatchdogMode, type WatchdogState,
} from "../src/lib/bridge-watchdog.ts";

const MIN = 60_000;
const T0 = 1_000_000_000_000;
const OK: ProbeResult = { ok: true, relay: { enabled: false, connected: false, state: null, retryAt: null } };
const FAIL: ProbeResult = { ok: false, error: "timeout" };
const relay = (r: Partial<RelaySnapshot>): ProbeResult => ({ ok: true, relay: { enabled: true, connected: false, state: "offline", retryAt: null, ...r } });

/** 可编排的假依赖：probes 按轮消费（用完重复最后一个），时钟每轮前进 stepMs */
function harness(opts: { mode?: WatchdogMode; probes?: ProbeResult[]; pid?: () => number | null; deploy?: () => boolean; stepMs?: number; start?: number }) {
  let now = opts.start ?? T0;
  const calls = { probe: 0, restart: 0, notify: [] as string[], log: [] as string[] };
  const probes = opts.probes ?? [OK];
  const deps: WatchdogDeps = {
    mode: () => opts.mode ?? "on",
    deployRunning: () => opts.deploy?.() ?? false,
    bridgePid: async () => (opts.pid ? opts.pid() : 100),
    probe: async () => probes[Math.min(calls.probe++, probes.length - 1)]!,
    restart: async () => void calls.restart++,
    log: (l) => void calls.log.push(l),
    notify: async (t) => void calls.notify.push(t),
    now: () => now,
  };
  let state: WatchdogState = initialWatchdogState();
  const actions: string[] = [];
  const round = async () => {
    const r = await runWatchdogRound(state, deps);
    state = r.state;
    actions.push(r.action);
    now += opts.stepMs ?? 15_000;
    return r.action;
  };
  const rounds = async (n: number) => { for (let i = 0; i < n; i++) await round(); };
  return { deps, calls, actions, round, rounds, get state() { return state; }, set now(v: number) { now = v; }, get now() { return now; } };
}

/** 过启动宽限：先成功探测撑过 2 分钟 */
const GRACE_ROUNDS = Math.ceil(L.graceMs / 15_000) + 1;

describe("本机接口判据", () => {
  test("连续 3 次失败不重启，第 4 次重启", async () => {
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL] });
    await h.rounds(GRACE_ROUNDS + 3);
    expect(h.calls.restart).toBe(0);
    await h.round();
    expect(h.calls.restart).toBe(1);
    expect(h.calls.notify[0]).toContain("已自动重启");
    expect(h.calls.notify[0]).toContain("最后一次正常");
  });

  test("中间有一次成功就清零", async () => {
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL, FAIL, FAIL, OK, FAIL, FAIL, FAIL, OK] });
    await h.rounds(GRACE_ROUNDS + 8);
    expect(h.calls.restart).toBe(0);
  });

  test("启动宽限内不判", async () => {
    const h = harness({ probes: [FAIL], stepMs: 15_000 });
    await h.rounds(Math.floor(L.graceMs / 15_000)); // 0..105s 都在宽限里
    expect(h.state.apiFails).toBeGreaterThanOrEqual(4);
    expect(h.calls.restart).toBe(0);
    await h.round(); // 120s：出宽限，累计失败已够
    expect(h.calls.restart).toBe(1);
  });

  test("PID 变化后计数清零并重新宽限", async () => {
    let pid = 100;
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL], pid: () => pid });
    await h.rounds(GRACE_ROUNDS + 3);
    pid = 200; // 部署重启了 bridge
    await h.round();
    expect(h.state.apiFails).toBe(1);
    expect(h.state.pidSince).toBe(h.now - 15_000);
    await h.rounds(3);
    expect(h.calls.restart).toBe(0); // 失败 4 次但还在新 PID 的宽限里
  });
});

describe("重启节流", () => {
  const stuckApi = { stuck: true as const, reason: "api" as const, detail: "x", lastOkAt: null };

  test("距上次重启不到 15 分钟不再重启", () => {
    const s = { ...initialWatchdogState(), restarts: [T0] };
    expect(decideRound(s, stuckApi, "on", T0 + 14 * MIN).action).toBe("cooldown");
    expect(decideRound(s, stuckApi, "on", T0 + 15 * MIN).action).toBe("restart");
  });

  test("1 小时内第 4 次只报警不重启，报警每小时最多通知一次", () => {
    const s = { ...initialWatchdogState(), restarts: [T0, T0 + 15 * MIN, T0 + 30 * MIN] };
    const a = decideRound(s, stuckApi, "on", T0 + 45 * MIN);
    expect(a.action).toBe("alarm");
    expect(a.notify).toBe(true);
    const b = decideRound(a.state, stuckApi, "on", T0 + 50 * MIN);
    expect(b.action).toBe("alarm");
    expect(b.notify).toBe(false);
    // 第一次重启滑出 1 小时窗口后恢复重启
    expect(decideRound(b.state, stuckApi, "on", T0 + 61 * MIN).action).toBe("restart");
  });

  test("端到端：重启后 PID 不变也不会 15 分钟内再重启", async () => {
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL] });
    await h.rounds(GRACE_ROUNDS + 4 + 20); // 再 20 轮 = 5 分钟
    expect(h.calls.restart).toBe(1);
    expect(h.actions).toContain("cooldown");
  });
});

describe("中继判据", () => {
  const stepMs = 15_000;
  const roundsFor = (ms: number) => Math.ceil(ms / stepMs) + 1;

  test("enabled 为假不判", async () => {
    const h = harness({ probes: [relay({ enabled: false })] });
    await h.rounds(roundsFor(30 * MIN));
    expect(h.calls.restart).toBe(0);
  });

  test("connected 为假但重连在前进，不判", async () => {
    // 模拟 relay-client 的重连循环：offline(retryAt=未来) ↔ connecting(null)，签名不断变化
    const flip: ProbeResult[] = [];
    for (let i = 0; i < roundsFor(30 * MIN); i++) {
      flip.push(i % 2 ? relay({ state: "connecting" }) : relay({ state: "offline", retryAt: T0 + i * stepMs + 10_000 }));
    }
    const h = harness({ probes: flip });
    await h.rounds(flip.length);
    expect(h.calls.restart).toBe(0);
  });

  test("在等一个未来的 retryAt（致命错误退避）不判", async () => {
    const h = harness({ probes: [relay({ retryAt: T0 + 60 * MIN })] });
    await h.rounds(roundsFor(30 * MIN));
    expect(h.calls.restart).toBe(0);
  });

  test("state 为 null / closed 不判（宁可漏报）", async () => {
    for (const state of [null, "closed"]) {
      const h = harness({ probes: [relay({ state })] });
      await h.rounds(roundsFor(30 * MIN));
      expect(h.calls.restart).toBe(0);
    }
  });

  test("卡住满 10 分钟判：retryAt 过期不刷新", async () => {
    const h = harness({ probes: [relay({ state: "offline", retryAt: T0 - MIN })] });
    await h.rounds(roundsFor(L.relayStuckMs) - 2);
    expect(h.calls.restart).toBe(0);
    await h.rounds(2);
    expect(h.calls.restart).toBe(1);
    expect(h.calls.notify[0]).toContain("中继");
  });

  test("connecting 卡 10 分钟（握手挂住）判", async () => {
    const h = harness({ probes: [relay({ state: "connecting" })] });
    await h.rounds(roundsFor(L.relayStuckMs));
    expect(h.calls.restart).toBe(1);
  });

  test("期间连上一次就重新计时", async () => {
    const stuck = relay({ state: "connecting" });
    const probes = [...Array(30).fill(stuck), relay({ connected: true, state: "online" }), ...Array(30).fill(stuck)];
    const h = harness({ probes });
    await h.rounds(61); // 两段各 7.5 分钟
    expect(h.calls.restart).toBe(0);
  });
});

describe("三档开关与部署", () => {
  test("observe 只记录：重启 0 次，每种原因每小时最多通知一次", async () => {
    const h = harness({ mode: "observe", probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL] });
    await h.rounds(GRACE_ROUNDS + 4 * 10); // 40 次失败 = 判 10 次
    expect(h.calls.restart).toBe(0);
    expect(h.actions.filter((a) => a === "observe").length).toBe(10);
    expect(h.calls.log.length).toBe(10);
    expect(h.calls.notify.length).toBe(1);
    expect(h.calls.notify[0]).toContain("本该重启");
  });

  test("off 不探测：探测 0 次", async () => {
    const h = harness({ mode: "off", probes: [FAIL] });
    await h.rounds(50);
    expect(h.calls.probe).toBe(0);
    expect(h.calls.restart).toBe(0);
  });

  test("deploy-full 在跑时本轮跳过", async () => {
    let deploying = false;
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL], deploy: () => deploying });
    await h.rounds(GRACE_ROUNDS + 3);
    deploying = true;
    const probesBefore = h.calls.probe;
    await h.rounds(5);
    expect(h.actions.slice(-5)).toEqual(Array(5).fill("skipped"));
    expect(h.calls.probe).toBe(probesBefore);
    expect(h.calls.restart).toBe(0);
  });

  test("bridge 没在跑（查不到 PID）不判，交给 launchd", async () => {
    const h = harness({ probes: [FAIL], pid: () => null });
    await h.rounds(30);
    expect(h.calls.probe).toBe(0);
    expect(h.calls.restart).toBe(0);
  });

  test("重启失败照样通知并带原因", async () => {
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL] });
    h.deps.restart = async () => { throw new Error("kickstart boom"); };
    await h.rounds(GRACE_ROUNDS + 4);
    expect(h.calls.notify[0]).toContain("kickstart boom");
  });
});

describe("解析", () => {
  test("开关缺省 / 坏值 = observe", () => {
    expect(parseWatchdogMode(undefined)).toBe("observe");
    expect(parseWatchdogMode("ON")).toBe("observe");
    expect(parseWatchdogMode("on")).toBe("on");
    expect(parseWatchdogMode("off")).toBe("off");
  });

  test("launchctl list 的 PID", () => {
    expect(parseLaunchctlPid('{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"PID" = 4242;\n};')).toBe(4242);
    expect(parseLaunchctlPid('{\n\t"LastExitStatus" = 0;\n};')).toBeNull();
  });

  test("observeRound 纯函数：不改入参", () => {
    const s = initialWatchdogState();
    observeRound(s, 1, FAIL, T0);
    expect(s).toEqual(initialWatchdogState());
  });
});
