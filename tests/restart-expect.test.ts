/**
 * i28-S1c：`manager restart --expect` 拿锁后的复核。真台账（autoFixture）+ 假的 registry / 探活 / 宿主心跳；
 * 「子进程拿锁之前」用假 restart 模拟：调度服务的最后一次 eligible() 通过之后改状态，再按 manager 那一侧的 expectSkip 核。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AgentSupervisor, type SuperviseDeps } from "../src/lib/agent-supervisor.js";
import type { ActivityRecord } from "../src/lib/agent-supervisor-activity.js";
import { encodeExpect, parseExpect } from "../src/lib/agent-supervisor-expect.js";
import { recordSupervise, superviseEvents } from "../src/lib/agent-supervisor-ledger.js";
import { HOUR_MS, workKeyOf } from "../src/lib/agent-supervisor-policy.js";
import { supervisedAgents } from "../src/lib/agent-supervisor-scope.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { WorkerLiveness } from "../src/lib/worker-liveness.js";
import { expectArg, expectSkip, markExpectSkips, type RecheckDeps } from "../src/manager/restart-expect.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const AGENT = "agent-task-one";
const CONFIG: SchedulerConfig = {
  enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } },
};
const ROW: RegistryAgent = { name: AGENT, channelId: "ch-one", sessionId: "s-one", projectId: "p", runtime: "claude-code", status: "active" };

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

/** 一张已派出、还没交付的 build 单（agent-task-one 在监护名单里），加一份两边共用的可变世界 */
async function world(opts: { row?: RegistryAgent } = {}) {
  const f: F = autoFixture();
  cleanup.push(() => f.close());
  await toBuild(f);
  await f.tick();
  const w = {
    f, now: 10 * HOUR_MS, config: CONFIG, registry: [opts.row ?? ROW], live: "no_window" as WorkerLiveness,
    activity: null as ActivityRecord | null, closed: 0,
  };
  const recheck: RecheckDeps = {
    config: () => w.config, registry: () => w.registry, db: () => f.db, calls: () => [], held: () => undefined,
    probe: async () => w.live, activity: () => w.activity, now: () => w.now, close: () => void w.closed++,
  };
  const workKey = () => workKeyOf(supervisedAgents({ config: CONFIG, registry: w.registry, db: f.db, calls: [], held: () => undefined, now: w.now })[0].work);
  return { w, recheck, workKey };
}

const raw = (workKey: string, down = "no_window", over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, agent: AGENT, sessionId: "s-one", down, workKey, ...over });

describe("拿锁前状态变了：子进程不重启", () => {
  const changes: Record<string, (x: Awaited<ReturnType<typeof world>>) => Promise<void> | void> = {
    活交付了: async ({ w }) => { expect((await w.f.cli(AGENT, "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true); },
    退回人工: async ({ w }) => { expect((await w.f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "PM 接手")).ok).toBe(true); },
    会话被换: ({ w }) => { w.registry = [{ ...ROW, sessionId: "s-new" }]; },
    窗口回来了: ({ w }) => { w.live = "running"; },
  };
  for (const [name, change] of Object.entries(changes)) {
    test(name, async () => {
      const x = await world();
      const r = raw(x.workKey());
      expect(await expectSkip(AGENT, r, x.recheck)).toBeNull(); // 没变时照常重启
      await change(x);
      const skip = await expectSkip(AGENT, r, x.recheck);
      expect(skip).toMatchObject({ name: AGENT, ok: false, skipped: expect.any(String) });
      expect(skip!.error).toContain("已跳过");
    });
  }

  test("复核通过之后的失败照旧是失败（不改记 skipped）", async () => {
    const x = await world();
    const r = raw(x.workKey());
    expect(await expectSkip(AGENT, r, x.recheck)).toBeNull();
    expect(markExpectSkips([{ name: AGENT, ok: false, error: "启动超时" }], r)).toEqual([{ name: AGENT, ok: false, error: "启动超时" }]);
  });

  test("监护开关关了也算不在名单", async () => {
    const x = await world();
    const r = raw(x.workKey());
    x.w.config = { ...CONFIG, supervise: { enabled: false, stuckMin: 20 } };
    expect((await expectSkip(AGENT, r, x.recheck))?.skipped).toContain("不在监护范围");
  });

  test("探活期间活交了：探活之后再核名单", async () => {
    const x = await world();
    const r = raw(x.workKey());
    x.recheck.probe = async () => {
      await x.w.f.cli(AGENT, "deliver", "T1", "--from", "build", "--head", H1);
      return "no_window";
    };
    expect((await expectSkip(AGENT, r, x.recheck))?.skipped).toContain("探活期间");
  });
});

describe("复核读失败：一律不重启", () => {
  const breaks: Record<string, (d: RecheckDeps) => void> = {
    "scheduler.json 读不了": (d) => { d.config = () => { throw new Error("坏 JSON"); }; },
    "registry 读不了": (d) => { d.registry = () => { throw new Error("EACCES"); }; },
    "registry 读出空的": (d) => { d.registry = () => []; },
    "台账不在": (d) => { d.db = () => null; },
    "台账打不开": (d) => { d.db = () => { throw new Error("SQLITE_CANTOPEN"); }; },
    "探活 unknown": (d) => { d.probe = async () => "unknown"; },
    "探活抛错": (d) => { d.probe = async () => { throw new Error("tmux 挂了"); }; },
  };
  for (const [name, brk] of Object.entries(breaks)) {
    test(name, async () => {
      const x = await world();
      const r = raw(x.workKey());
      brk(x.recheck);
      expect(await expectSkip(AGENT, r, x.recheck)).toMatchObject({ ok: false, skipped: expect.any(String) });
      expect(x.w.closed).toBe(1); // 台账连接照样关掉
    });
  }
});

describe("stuck（ACP 回合卡住）同一套判据", () => {
  test("还卡着 → 重启；拿锁前来了一次 update → 不重启", async () => {
    const x = await world({ row: { ...ROW, transport: "acp" } });
    const r = raw(x.workKey(), "stuck");
    const at = x.w.now - 30 * 60_000;
    x.w.live = "running";
    x.w.activity = { v: 1, agent: AGENT, sessionId: "s-one", hostPid: 1, busy: true, turnAt: at, updateAt: at, writtenAt: at };
    expect(await expectSkip(AGENT, r, x.recheck)).toBeNull();
    x.w.activity = { ...x.w.activity, updateAt: x.w.now - 1000 };
    expect((await expectSkip(AGENT, r, x.recheck))?.skipped).toContain("不是 stuck");
    x.w.live = "no_host"; // 卡住的确认之后宿主没了：否定种类变了，同样不按这条 expect 动
    expect((await expectSkip(AGENT, r, x.recheck))?.skipped).toContain("no_host");
  });
});

describe("--expect 本身：拒掉别的 agent、怪字段", () => {
  test("不带 --expect：什么都不读，照常重启", async () => {
    const touched: string[] = [];
    const spy = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return () => { throw new Error("不该读"); }; } }) as RecheckDeps;
    expect(await expectSkip(AGENT, undefined, spy)).toBeNull();
    expect(touched).toEqual([]);
  });

  test("agent 名对不上、多 / 少字段、值不对、注入字符一律拒", async () => {
    const x = await world();
    const k = x.workKey();
    const bad = [
      raw(k, "no_window", { agent: "agent-other" }),
      raw(k, "no_window", { cmd: "rm -rf /" }),
      JSON.stringify({ v: 1, agent: AGENT, sessionId: "s-one", down: "no_window" }),
      raw(k, "no_window", { v: 2 }),
      raw(k, "running"),
      raw(k, "no_window", { sessionId: "s-one\n--fork" }),
      raw(k, "no_window", { agent: `${AGENT}‮` }),
      raw(k, "no_window", { workKey: 7 }),
      raw(k, "no_window", { workKey: "x".repeat(3000) }),
      "[1]", "null", "not json", "",
    ];
    for (const b of bad) expect((await expectSkip(AGENT, b, x.recheck))?.ok, b).toBe(false);
    // 名字对得上但不是这次的目标（多目标重启时每个目标各核一次）
    expect((await expectSkip("agent-rv-t1", raw(k), x.recheck))?.skipped).toContain("不能用来重启 agent-rv-t1");
  });

  test("编码与解析互逆；只认 `--` 之前的 --expect", () => {
    const w = { agent: AGENT, sessionId: "s", down: "no_host" as const, workKey: "order:i1" };
    expect(parseExpect(encodeExpect(w), AGENT)).toEqual({ ok: true, expect: { v: 1, ...w } });
    expect(expectArg(["--", AGENT])).toBeUndefined();
    expect(expectArg(["--expect", "{}", "--", AGENT])).toBe("{}");
    expect(expectArg(["--", "--expect", "{}"])).toBeUndefined(); // 名字长得像开关也只是名字
    expect(expectArg(["--expect", "{}"])).toBe(""); // 没用 `--` 指定目标：整条拒
    expect(expectArg(["--expect", "{}", "--"])).toBe("");
    expect(expectArg(["--expect", "--", AGENT])).toBe("");
  });
});

describe("监护那一侧：子进程 skipped 记 skipped，不算失败、不占额度、不报派活方", () => {
  test("拿锁前活交了 / 窗口回来：两次都 skipped；恢复后照样有 2 次重启额度", async () => {
    const x = await world();
    const { w } = x;
    let race: (() => Promise<void> | void) | null = null;
    const log = { restarts: 0, reports: 0, wires: [] as string[] };
    const deps: SuperviseDeps = {
      registry: () => w.registry, calls: () => [], held: () => undefined, probe: async () => w.live, activity: () => null, overload: () => ({}),
      record: async (rec) => ({ ok: true, duplicate: recordSupervise(w.f.db, { actor: "scheduler", now: w.now }, rec).duplicate }),
      send: async () => ({ ok: true }),
      // 生产的 restart（agent-supervisor-deps.ts）：eligible() → 拉起 manager --expect → manager 拿锁后 expectSkip
      restart: async (agent, want) => {
        const why = want.eligible();
        if (why) return { ok: false, skipped: why };
        const wire = encodeExpect({ agent, sessionId: want.sessionId, down: want.down, workKey: want.workKey });
        log.wires.push(wire);
        if (race) await race(), (race = null); // 子进程启动到拿锁之间
        const skip = await expectSkip(agent, wire, x.recheck);
        if (skip) return { ok: false, skipped: skip.skipped };
        log.restarts++;
        return { ok: true };
      },
      escalate: async () => void log.reports++, notifyCaller: async () => void log.reports++, notifyOwner: async () => void log.reports++,
      now: () => w.now, log: () => {},
    };
    const sup = new AgentSupervisor(() => {});
    const tick = async () => { w.now += 31_000; return sup.tick(w.f.db, CONFIG, deps); };
    const rounds = (n: number) => superviseEvents(w.f.db, AGENT).slice(-n).map((e) => `${e.step}/${e.phase}/${e.result ?? ""}`);

    race = () => { w.live = "running"; };
    await tick();
    expect((await tick()).outcomes[0]).toMatchObject({ step: "recovered", detail: expect.stringContaining("不是 no_window") });
    expect(rounds(2)).toEqual(["restart/claim/", "restart/done/skipped"]);
    expect(JSON.parse(log.wires[0])).toMatchObject({ v: 1, agent: AGENT, sessionId: "s-one", down: "no_window", workKey: x.workKey() });

    w.live = "no_window";
    const saved = w.registry;
    race = () => { w.registry = [{ ...ROW, sessionId: "s-new" }]; };
    await tick();
    expect((await tick()).outcomes[0]).toMatchObject({ step: "recovered", detail: expect.stringContaining("不在监护范围") });
    expect(rounds(2)).toEqual(["restart/claim/", "restart/done/skipped"]);
    expect(log).toMatchObject({ restarts: 0, reports: 0 });

    w.registry = saved;
    for (let i = 0; i < 40; i++) await tick();
    expect(log.restarts).toBe(2); // 两次 skipped 都没占额度
  });
});
