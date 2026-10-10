import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { CONFIG_PATH } from "../src/lib/paths.ts";
import { setLang } from "../src/lib/config-store.ts";
import {
  WATCHDOG_LIMITS as L, decideRound, initialWatchdogState, observeRound, parseLaunchctlPid, parseWatchdogMode, readWatchdogMode, runWatchdogRound,
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
    restart: async () => (calls.restart++, "restarted"),
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

  test("第 3 次重启后的冷却期里再卡住：立即报警（先判 1 小时上限再判冷却）", () => {
    const s = { ...initialWatchdogState(), restarts: [T0, T0 + 15 * MIN, T0 + 30 * MIN] };
    const a = decideRound(s, stuckApi, "on", T0 + 32 * MIN);
    expect(a.action).toBe("alarm");
    expect(a.notify).toBe(true);
    expect(a.state.restarts.length).toBe(3);
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

  test("探测期间部署起来并换了 PID：本轮作废，不重启新进程，新 PID 重新宽限", async () => {
    let pid = 100;
    let deploying = false;
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL], pid: () => pid, deploy: () => deploying });
    await h.rounds(GRACE_ROUNDS + 3); // apiFails = 3
    expect(h.state.apiFails).toBe(3);
    const probe = h.deps.probe;
    h.deps.probe = async () => { deploying = true; pid = 200; return probe(); };
    expect(await h.round()).toBe("skipped");
    expect(h.calls.restart).toBe(0);
    h.deps.probe = probe;
    deploying = false;
    // 部署完新 PID 一直失败：宽限内不判，宽限后再攒满 4 次才重启
    await h.rounds(GRACE_ROUNDS - 1);
    expect(h.calls.restart).toBe(0);
    await h.rounds(4);
    expect(h.calls.restart).toBe(1);
  });

  test("探测期间只换了 PID（manager update 等不持锁的重启）：本轮作废、计数清零", async () => {
    let pid = 100;
    const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL], pid: () => pid });
    await h.rounds(GRACE_ROUNDS + 3);
    const probe = h.deps.probe;
    h.deps.probe = async () => { pid = 200; return probe(); };
    expect(await h.round()).toBe("skipped");
    expect(h.calls.restart).toBe(0);
    expect(h.state).toMatchObject({ pid: 200, apiFails: 0 });
  });

  test("重启时拿不到部署锁 / 锁内发现 PID 已变：不重启、不记重启次数、不发「已重启」", async () => {
    for (const r of ["deploying", "pid-changed"] as const) {
      const h = harness({ probes: [...Array(GRACE_ROUNDS).fill(OK), FAIL] });
      h.deps.restart = async () => r;
      await h.rounds(GRACE_ROUNDS + 4);
      expect(h.actions.at(-1)).toBe("skipped");
      expect(h.state.restarts.length).toBe(0);
      expect(h.state.apiFails).toBe(0);
      expect(h.calls.notify.length).toBe(0);
    }
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

describe("开关持久", () => {
  test("setLang 等 set*（读改写）之后 on / off 仍保持；缺省仍按 observe", async () => {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    try {
      for (const mode of ["on", "off"] as const) {
        writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh", bridgeWatchdog: mode }));
        await setLang("en");
        expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).bridgeWatchdog).toBe(mode);
        expect(readWatchdogMode()).toBe(mode);
      }
      writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh" }));
      await setLang("en");
      expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).bridgeWatchdog).toBeUndefined();
      expect(readWatchdogMode()).toBe("observe");
    } finally {
      rmSync(CONFIG_PATH, { force: true });
    }
  });
});

describe("重启节流按实际重启时间", () => {
  /** 判卡住那次探测耗时 slowMs；重启换 PID 并模拟生产的 8 秒等待；记下每次 restart() 被调用的真实时钟 */
  function timed(slowMs: number) {
    let now = T0;
    let pid = 100;
    let slow = true;
    const restartsAt: number[] = [];
    const deps: WatchdogDeps = {
      mode: () => "on",
      deployRunning: () => false,
      bridgePid: async () => pid,
      probe: async () => {
        if (slow) now += slowMs;
        return { ok: false, error: "HTTP 503" };
      },
      restart: async () => {
        restartsAt.push(now);
        pid++;
        now += 8_000;
        return "restarted";
      },
      log: () => {},
      notify: async () => {},
      now: () => now,
    };
    /** 构造「已过宽限、再失败一次就判卡住」的状态，在 at 时刻跑一轮 */
    const stuckRoundAt = async (prev: WatchdogState, at: number, probeSlow: boolean) => {
      now = at;
      slow = probeSlow;
      const s: WatchdogState = { ...prev, pid, pidSince: at - L.graceMs - MIN, apiFails: L.apiFailures - 1 };
      return runWatchdogRound(s, deps);
    };
    return { restartsAt, stuckRoundAt };
  }

  test("restart-clock：首次探测耗时 5 秒，之后探测立即返回，实际间隔不足 15 分钟不重启", async () => {
    const h = timed(L.probeTimeoutMs);
    const r1 = await h.stuckRoundAt(initialWatchdogState(), T0, true);
    expect(r1.action).toBe("restart");
    // 按探测起点算正好 15 分钟，按实际重启时间只过了 14 分 55 秒
    const r2 = await h.stuckRoundAt(r1.state, T0 + L.restartGapMs, false);
    expect(r2.action).toBe("cooldown");
    expect(h.restartsAt).toHaveLength(1);
  });

  test("restart-clock：1 小时窗口按实际重启时间算，59 分 55 秒内不会有第 4 次", async () => {
    const h = timed(L.probeTimeoutMs);
    let st = (await h.stuckRoundAt(initialWatchdogState(), T0, true)).state;
    for (const at of [16, 32]) st = (await h.stuckRoundAt(st, T0 + at * MIN, false)).state;
    expect(h.restartsAt).toHaveLength(3);
    const r4 = await h.stuckRoundAt(st, T0 + L.restartWindowMs, false);
    expect(r4.action).toBe("alarm");
    expect(h.restartsAt).toHaveLength(3);
  });

  test("重启历史不早于 restart() 被调用的时刻", async () => {
    const h = timed(L.probeTimeoutMs);
    const r = await h.stuckRoundAt(initialWatchdogState(), T0, true);
    expect(r.state.restarts.at(-1)!).toBeGreaterThanOrEqual(h.restartsAt[0]!);
  });
});
