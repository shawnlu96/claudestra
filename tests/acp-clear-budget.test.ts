import { describe, expect, test } from "bun:test";
import { ClearBudget, clearCallPlan, hostClearBudget, observeClearBudget } from "../src/lib/acp/clear-budget.js";
import { applyAcpLaunchConfig } from "../src/lib/acp/apply-config.js";
import { commitAcpClear, rotateAcpHost } from "../src/lib/acp/clear.js";
import { acpRuntime } from "../src/lib/acp/host-runtime.js";
import { RpcLostError } from "../src/lib/acp/rpc.js";
import type { AcpSession } from "../src/lib/acp/session.js";
import { AcpTurnLoop } from "../src/lib/acp/turn.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STAGES = ["new", "model", "effort", "bootstrap", "registry", "watcher"] as const;
type Stage = typeof STAGES[number];

function rig(o: { limit?: number; legacy?: boolean; pi?: boolean; lost?: Stage; expired?: Stage; late?: boolean; sent?: boolean; readyAdvance?: number;
  alive?: () => boolean; rebind?: (frame: Record<string, unknown>, ms: number) => Promise<boolean> } = {}) {
  let now = 1_000;
  const budget = o.legacy ? undefined : new ClearBudget(now + (o.limit ?? 270_000), () => now, () => now);
  const calls: { stage: Stage; ms: number | undefined }[] = [];
  const failed: boolean[] = [], prompts: string[] = [];
  const durations: Record<Stage, number> = { new: 90_000, model: 20_000, effort: 20_000, bootstrap: 60_000, registry: 30_000, watcher: 30_000 };
  let registryId = "old", currentId = "old", ready = 0, rotating = false;
  const step = async (stage: Stage, ms?: number) => {
    calls.push({ stage, ms });
    if (o.lost === stage) { now += ms ?? 30_000; throw new RpcLostError(`${stage} 丢回包`, o.sent ?? true); }
    now += o.expired === stage ? 270_000 : durations[stage];
  };
  const session = {
    sessionId: "old",
    create: async (_cwd: string, ms: number) => (await step("new", ms), session.sessionId = "new"),
    setConfig: async (id: string, _value: string, ms: number) => (await step(id === "model" ? "model" : "effort", ms), { ok: true }),
    prompt: async (_text: string, ms: number) => (await step("bootstrap", ms), { kind: "done" }),
  } as unknown as AcpSession;
  const loop = new AcpTurnLoop({ prompt: async (text) => (prompts.push(text), { kind: "done" }),
    reportStop: async () => ({}), onFailure() {}, log() {} });
  const run = () => rotateAcpHost({ session, loop, ready: true, pending: false, oldId: "old", cwd: "/tmp", budget,
    bootstrap: acpRuntime(o.pi ? "pi" : "codex").clearBootstrap, then: { text: "restore", opId: "restore-once" },
    configure: (s, b) => applyAcpLaunchConfig(s, "model", "effort", true, () => {}, b),
    rotateRegistry: async (_old, fresh, ms) => { await step("registry", ms); registryId = fresh; return { ok: true }; },
    begin() { rotating = true; }, end() { rotating = false; }, failed: (changed) => void failed.push(changed),
    committed: (id) => commitAcpClear({ budget, sessionId: id, previousSessionId: "old", channelId: "test", alive: o.alive ?? (() => false),
      update: () => { currentId = id; }, ready: () => { ready++; now += o.readyAdvance ?? 0; if (!rotating) loop.resume(); },
      request: o.rebind ?? (async (_f, ms) => { await step("watcher", ms); if (o.late) now += 30_000; return true; }),
    }),
  });
  return { run, calls, failed, prompts, loop, budget, advance: (ms: number) => { now += ms; },
    facts: () => ({ now, registryId, currentId, ready }) };
}

describe("ACP clear shared deadline", () => {
  test("复现 post-ready-check-1：ready 已确认后跨过期限不反判失败、不杀适配器", async () => {
    const r = rig({ readyAdvance: 20_001 });
    expect(await r.run()).toEqual({ ok: true, sessionId: "new" });
    expect(r.failed).toEqual([]);
    await Bun.sleep(0);
    expect(r.prompts).toEqual(["restore"]);
  });
  test("复现：90+40+60+30+30=250s 成功，bridge 不再用 225s 提前判不明", async () => {
    const r = rig();
    const plan = clearCallPlan("test", 1, { mode: () => "on", now: () => 1_000 });
    expect(plan).toEqual({ timeoutMs: 270_000, fields: { clearBudgetVersion: 1, deadline: 271_000 } });
    expect(await r.run()).toEqual({ ok: true, sessionId: "new" });
    expect(r.facts()).toEqual({ now: 251_000, registryId: "new", currentId: "new", ready: 1 });
    expect(r.calls.map((c) => c.ms)).toEqual([90_000, 20_000, 20_000, 60_000, 30_000, 30_000]);
    await Bun.sleep(0);
    expect(r.prompts).toEqual(["restore"]);
    expect(r.loop.slotStatus("restore-once")).toMatchObject({ state: "ended", outcome: "done" });
  });

  test("每阶段耗尽：不再启动下一阶段，then 从未提交", async () => {
    for (const expired of STAGES) {
      const r = rig({ expired });
      expect((await r.run()).ok).toBe(false);
      expect(r.calls.map((c) => c.stage)).toEqual(STAGES.slice(0, STAGES.indexOf(expired) + 1));
      expect(r.loop.slotStatus("restore-once").state).toBe("gone");
      expect(r.failed).toEqual(["registry", "watcher"].includes(expired) ? [] : [true]);
    }
  });

  test("逐阶段丢回包：sent/changed 保守处理，无重复首轮或新阶段", async () => {
    for (const lost of STAGES) {
      const r = rig({ lost });
      const result = await r.run();
      expect(result.ok).toBe(false);
      expect(r.failed).toEqual(lost === "watcher" ? [] : [true]);
      expect(r.calls.map((c) => c.stage)).toEqual(STAGES.slice(0, STAGES.indexOf(lost) + 1));
      expect(r.loop.slotStatus("restore-once").state).toBe("gone");
      if (lost === "watcher") expect(result.sessionId).toBe("new");
    }
    const unsent = rig({ lost: "new", sent: false });
    expect((await unsent.run()).ok).toBe(false);
    expect(unsent.failed).toEqual([false]);
  });

  test("剩余时间约束 registry 与 watcher；期限边界为零时不发起 new", async () => {
    const r = rig({ limit: 221_000 });
    expect((await r.run()).ok).toBe(false);
    expect(r.calls.at(-1)).toEqual({ stage: "watcher", ms: 1_000 });
    expect(r.facts().ready).toBe(0);
    const expired = rig({ limit: 0 });
    expect((await expired.run()).ok).toBe(false);
    expect(expired.calls).toEqual([]);
    expect(expired.failed).toEqual([false]);
  });

  test("watcher 迟确认：registry 已换不报成功，不提交 then、不再重绑", async () => {
    const r = rig({ late: true });
    expect(await r.run()).toMatchObject({ ok: false, sessionId: "new" });
    expect(r.facts()).toMatchObject({ registryId: "new", currentId: "new", ready: 0 });
    expect(r.calls.filter((c) => c.stage === "watcher")).toHaveLength(1);
    expect(r.loop.slotStatus("restore-once").state).toBe("gone");
  });

  test("Pi 无引导；旧 bridge 对新宿主仍用原阶段上限", async () => {
    const pi = rig({ pi: true });
    expect((await pi.run()).ok).toBe(true);
    expect(pi.calls.map((c) => c.stage)).toEqual(["new", "model", "effort", "registry", "watcher"]);
    const old = rig({ legacy: true });
    expect((await old.run()).ok).toBe(true);
    expect(old.calls.map((c) => c.ms)).toEqual([90_000, 20_000, 20_000, 60_000, undefined, 30_000]);
  });

  test("时钟倒退不延长预算；前跳耗尽；非法 deadline 拒绝", () => {
    let wall = 1_000, mono = 0;
    const b = new ClearBudget(271_000, () => wall, () => mono);
    wall = -100_000; mono = 260_000;
    expect(b.timeout(30_000)).toBe(10_000);
    wall = 271_000;
    expect(() => b.timeout(1)).toThrow("预算已耗尽");
    for (const bad of [NaN, Infinity, 1.2, "271000"]) expect(() => new ClearBudget(bad as number)).toThrow("deadline 无效");
    const bound = new ClearBudget(Number.MAX_SAFE_INTEGER, () => 0, () => 0);
    expect(bound.timeout(Infinity)).toBe(270_000);
  });
});

test("复现 watcher-stale-1：重绑真失败与期限耗尽后仍对账真实 watcher，普通消息恢复且不补发 then", async () => {
  const { startWatching, pushEntries, stopWatching } = await import("../src/bridge/jsonl-watcher.js");
  const realSet = globalThis.setTimeout;
  const retries: { fire(): void; clear(): void }[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
    const timer = realSet(fn, ms, ...args);
    if (ms === 3_000) retries.push({ fire: fn, clear: () => clearTimeout(timer) });
    return timer;
  }) as typeof setTimeout;
  try {
    for (const reason of ["false", "lost", "expired"] as const) {
      const channelId = `local-clear-recovery-${reason}`, agent = `agent-clear-recovery-${reason}`;
      const discord = {} as never;
      await startWatching(agent, "/tmp", "old", channelId, discord, { transport: "acp" });
      let attempts = 0, alive = true;
      const frames: Record<string, unknown>[] = [];
      const r = rig({ alive: () => alive, rebind: async (frame) => {
        attempts++; frames.push(frame);
        if (attempts === 1) {
          if (reason === "expired") r.advance(270_000);
          if (reason === "lost") throw new Error("重绑帧丢失");
          return false;
        }
        if (attempts === 2) return false;
        await startWatching(agent, "/tmp", String(frame.sessionId), channelId, discord, { transport: "acp", rebind: true });
        return true;
      } });
      try {
        expect(await r.run()).toMatchObject({ ok: false, sessionId: "new" });
        await r.loop.submit("ordinary", `message-${reason}`);
        expect((await pushEntries(channelId, [], discord, "new")).ok).toBe(false);
        expect(r.prompts).toEqual([]);
        for (let i = 0; i < 2; i++) {
          const retry = retries.shift();
          expect(retry).toBeDefined();
          retry!.clear(); retry!.fire();
          await Bun.sleep(0);
        }
        expect((await pushEntries(channelId, [], discord, "new")).ok).toBe(true);
        expect(r.facts().ready).toBe(1);
        expect(r.prompts).toEqual(["ordinary"]);
        expect(r.failed).toEqual([]);
        expect(r.loop.slotStatus("restore-once").state).toBe("gone");
        expect(frames[0]).toHaveProperty("deadline");
        expect(frames.slice(1).every((f) => !("deadline" in f))).toBe(true);
      } finally { alive = false; stopWatching(agent); }
    }
  } finally {
    for (const r of retries) r.clear();
    globalThis.setTimeout = realSet;
  }
});

test("复现 rebind-expire-1：watcher 已装好后据实回成功并收尾旧事件", async () => {
  const { REGISTRY_PATH } = await import("../src/lib/registry.js");
  const { rebindAcpWatcher } = await import("../src/bridge/acp-rebind.js");
  const { startWatching, pushEntries, stopWatching } = await import("../src/bridge/jsonl-watcher.js");
  const { emitEvent, replayEventsSince, forgetAgent } = await import("../src/bridge/event-bus.js");
  const saved = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : undefined;
  const agent = "agent-clear-installed", channelId = "local-clear-installed", discord = {} as never;
  let checks = 0;
  const budget = { timeout() { if (++checks > 2) throw new Error("安装后到期"); return 30_000; } } as unknown as ClearBudget;
  try {
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {
      [agent]: { channelId, sessionId: "new", cwd: "/tmp", status: "active", transport: "acp", runtime: "codex" },
    } }));
    await startWatching(agent, "/tmp", "old", channelId, discord, { transport: "acp" });
    emitEvent({ agent, chatId: channelId, type: "assistant_text", data: { sid: "acp:old", text: "old text" } });
    expect(await rebindAcpWatcher(channelId, "new", discord, "old", budget)).toEqual({ ok: true });
    expect((await pushEntries(channelId, [], discord, "new")).ok).toBe(true);
    expect(checks).toBe(2);
    expect(replayEventsSince(0).some((e) => e.agent === agent && e.data.sid === "acp:old")).toBe(false);
  } finally {
    stopWatching(agent); forgetAgent(agent);
    if (saved === undefined) rmSync(REGISTRY_PATH, { force: true });
    else writeFileSync(REGISTRY_PATH, saved);
  }
});

describe("ACP clear compatibility and rollback", () => {
  test("默认 on，on/observe/off、未知版本均按契约，observe 不改业务结果", () => {
    expect(recoveryPolicy("test", "acpClearBudget", "/nonexistent/acp-clear-policy").mode).toBe("on");
    let observed = 0;
    for (const mode of ["on", "observe", "off"] as const) {
      const plan = clearCallPlan("test", 1, { mode: () => mode, observe: () => { observed++; }, now: () => 0 });
      expect(plan.timeoutMs).toBe(mode === "on" ? 270_000 : 225_000);
      expect(Object.keys(plan.fields).length).toBe(mode === "on" ? 2 : 0);
    }
    expect(observed).toBe(1);
    for (const version of [undefined, true, "1", 2, {}]) {
      expect(clearCallPlan("test", version, { mode: () => "on" })).toEqual({ timeoutMs: 225_000, fields: {} });
    }
    expect(hostClearBudget({ deadline: Date.now() + 1_000 }, "test", () => "on")).toBeUndefined();
    expect(hostClearBudget({}, "test", () => "on")).toBeUndefined();
    expect(hostClearBudget({ clearBudgetVersion: 1, deadline: Date.now() + 1_000 }, "test", () => "on")).toBeInstanceOf(ClearBudget);
  });

  test("运行中回退：新动作重读，已接收的 deadline 不延长", async () => {
    let mode: RecoveryMode = "on";
    const source = () => mode;
    const on = clearCallPlan("test", 1, { mode: source });
    mode = "off";
    expect(clearCallPlan("test", 1, { mode: source }).timeoutMs).toBe(225_000);
    expect(hostClearBudget(on.fields, "test", source)).toBeUndefined();
    const r = rig({ expired: "model" });
    expect((await r.run()).ok).toBe(false);
    expect(r.calls.map((c) => c.stage)).toEqual(["new", "model"]);
    mode = "on";
    expect(clearCallPlan("test", 1, { mode: source }).timeoutMs).toBe(270_000);
  });

  test("上游恢复档位组合不覆盖本卡键；observe/off 的 clear 帧保持旧形状", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-clear-budget-"));
    try {
      const path = join(dir, "policy.json");
      for (const upstream of ["on", "observe", "off"] as const) {
        for (const own of ["on", "observe", "off"] as const) {
          writeFileSync(path, JSON.stringify({ projects: { test: { mode: upstream, keys: { acpClearBudget: own, teamBody: upstream } } } }));
          const p = clearCallPlan("test", 1, { mode: () => recoveryPolicy("test", "acpClearBudget", path).mode, observe() {} });
          expect(p.timeoutMs).toBe(own === "on" ? 270_000 : 225_000);
          if (own !== "on") expect(p.fields).toEqual({});
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("observe 样本按目标与版本去重，无正文或敏感值", () => {
    const db = openLedger(":memory:");
    try {
      observeClearBudget("opaque-target", db);
      observeClearBudget("opaque-target", db);
      observeClearBudget("other-target", db);
      const rows = db.query("SELECT target, data FROM events WHERE json_extract(data, '$.mechanism') = 'acpClearBudget'").all();
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain("opaque-target");
      expect(JSON.stringify(rows)).not.toContain("other-target");
      expect(JSON.stringify(rows)).toContain("protocol-1");
    } finally { closeLedger(":memory:"); }
  });
});

test("真实 bridge 接线：显式能力绑定当前 socket，250s 回包成功，270s 丢包不明；旧宿主 225s", async () => {
  const bridge = await import("../src/bridge/acp-link.js");
  const { setExtensionSocket } = await import("../src/bridge/pi-abort.js");
  const realSet = globalThis.setTimeout;
  const scheduled: { ms: number; fire(): void; clear(): void }[] = [];
  const frames: Record<string, any>[] = [];
  const socket = { send: (s: string) => { frames.push(JSON.parse(s)); } };
  const channelId = "local-clear-budget-wire";
  let current = socket;
  setExtensionSocket((ch) => ch === channelId ? current : undefined, {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never, hold: () => { throw new Error("unused"); },
  });
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
    const timer = realSet(fn, ms, ...args);
    if (ms === 270_000 || ms === 225_000) scheduled.push({ ms, fire: fn, clear: () => clearTimeout(timer) });
    return timer;
  }) as typeof setTimeout;
  const respond = (frame: Record<string, any>, sid: string) => bridge.onAcpFrame({
    type: "acp_call_result", channelId, id: frame.id, ok: true, sessionId: sid,
  }, current, {} as never);
  try {
    const advertise = (ws = current, version: unknown = 1) => bridge.onAcpFrame({
      type: "acp_config", channelId, clearBudgetVersion: version, configOptions: [],
    }, ws, {} as never);
    await advertise();
    const success = bridge.acpClear(channelId, { text: "restore", opId: "one" });
    const f = frames.at(-1)!;
    expect(f).toMatchObject({ type: "acp_call", op: "clear", clearBudgetVersion: 1, deadline: expect.any(Number) });
    expect(scheduled.at(-1)?.ms).toBe(270_000);
    const r = rig();
    expect((await r.run()).ok).toBe(true);
    expect(r.facts().now - 1_000).toBe(250_000);
    await respond(f, "new");
    expect(await success).toEqual({ ok: true, sessionId: "new" });
    const lost = bridge.acpClear(channelId);
    scheduled.at(-1)!.fire();
    expect(await lost).toMatchObject({ ok: false, uncertain: true });
    await respond(frames.at(-1)!, "late"); // A late success must not create another request or replay then.
    expect(frames).toHaveLength(2);
    const previous = current;
    current = { send: socket.send };
    await advertise(previous); // Displaced host cannot give its successor a capability.
    const old = bridge.acpClear(channelId);
    expect(scheduled.at(-1)?.ms).toBe(225_000);
    expect(Object.keys(frames.at(-1)!).sort()).toEqual(["id", "op", "type"]);
    await respond(frames.at(-1)!, "legacy");
    expect(await old).toMatchObject({ ok: true, sessionId: "legacy" });
    await advertise(current, "1");
    const malformed = bridge.acpClear(channelId);
    expect(scheduled.at(-1)?.ms).toBe(225_000);
    bridge.onAcpHostGone(channelId, current);
    expect(await malformed).toMatchObject({ ok: false, uncertain: true });
  } finally {
    bridge.onAcpHostGone(channelId, current);
    for (const t of scheduled) t.clear();
    globalThis.setTimeout = realSet;
  }
});
