/**
 * dispatch-recovery-WAKESTOP1：生命周期停掉的绑定 worker（registry status=stopped、sessionId 不变），派单前按恢复键 wakeStopped
 * 先 `manager resume <agent> <sessionId> <cwd>` 再发帧（scheduler-wake-stopped.ts，接在 sendVia 里）。
 * on 唤醒后发；observe 不唤醒、同一绑定只记一条观察；off 照旧。ACP / session 不一致 / 不是 stopped 不唤醒。
 * 唤醒失败不发帧、按未投递拒收并写明原因，同一绑定连续 3 次失败交 PM；stopped 时拒收原因写「已停止」。
 * 走真的调度 tick + 真的 messagePort / channel worker，只换掉 bridge 和 manager resume。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { messagePort, sendVia } from "../src/lib/scheduler-auto-ports.js";
import { boundRef } from "../src/lib/scheduler-auto-tick.js";
import { WAKE_FAILED, wakeGaveUp } from "../src/lib/scheduler-wake-stopped.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createChannelWorker } from "../src/lib/worker-message.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const policyOf = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => {
  expect(key).toBe("wakeStopped");
  return { mode, manualAfterMs: null, source: "config" };
};
const readReg = (f: F) => JSON.parse(readFileSync(f.registryPath, "utf8")) as { agents: Record<string, Record<string, unknown>> };
const registryRow = (f: F) => (agent: string): RegistryAgent | undefined => {
  const a = readReg(f).agents[agent];
  return a ? { name: agent, ...a } as RegistryAgent : undefined;
};
const patchAgent = (f: F, agent: string, patch: Record<string, unknown>) => {
  const reg = readReg(f);
  reg.agents[agent] = { ...reg.agents[agent], ...patch };
  writeFileSync(f.registryPath, JSON.stringify(reg));
};

/** bridge 照实际行为：目标 stopped 就按「不在 registry」类型化拒收（没发出），否则送达。 */
function fakeBridge(f: F) {
  const frames: string[] = [];
  const bridge = (async (req: { targetName: string }) => {
    if (readReg(f).agents[req.targetName]?.status === "stopped") {
      return { ok: false, sent: false, error: `Agent '${req.targetName}' 不存在或未在 registry 中`, rejected: "target" };
    }
    frames.push(req.targetName);
    return { ok: true, result: { targetChannelId: "ch-one" } };
  }) as unknown as NonNullable<Parameters<typeof sendVia>[2]>["bridge"];
  return { frames, bridge };
}

/** manager resume：ok 时把 registry 行改回 running（像真的 resume 那样），否则按给的失败答复。 */
function fakeManager(f: F, answer: () => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({ ok: true, ready: true })) {
  const calls: string[][] = [];
  const manager = async (...args: string[]) => {
    calls.push(args);
    const r = await answer();
    if (r.ok === true) patchAgent(f, args[1], { status: "running" });
    return r;
  };
  return { calls, manager };
}

/** 作者 agent-task-one（tmux、claude-code）到了 build、下一 tick 要派单；worker 换成真的 messagePort + 放弃闸。 */
async function stoppedAtBuild(mode: RecoveryMode, answer?: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const f = autoFixture();
  await toBuild(f);
  patchAgent(f, "agent-task-one", { status: "stopped" });
  const policy = policyOf(mode);
  const { frames, bridge } = fakeBridge(f), { calls, manager } = fakeManager(f, answer);
  const row = registryRow(f);
  f.tickDeps.worker = (ref: SessionRef) => wakeGaveUp({ db: f.db, policy }, ref, row(ref.agent)) ?? createChannelWorker({
    sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
    ledger: { result: (r, probe) => ledgerResult(f.db, r, probe) },
    port: { ...messagePort(f.db, row, undefined, undefined, { wake: { db: f.db, manager, policy, timeoutMs: 200 }, bridge }), status: async () => "idle" },
  });
  const lastReceipt = () => f.db.query("SELECT status, receipt FROM scheduler_intents WHERE action IN ('dispatch','review') ORDER BY eventSeq DESC LIMIT 1")
    .get() as { status: string; receipt: string };
  return { f, frames, calls, lastReceipt };
}

const observations = (f: F) => f.db.query(`SELECT text FROM events WHERE kind = 'note' AND json_extract(data, '$.mechanism') = 'wakeStopped'`).all() as { text: string }[];

describe("WAKESTOP1 派单前唤醒被停掉的绑定 worker", () => {
  test("[验收线 1] on：stopped、session 一致的 tmux worker 先 resume(agent, sessionId, cwd)，成功后再发帧", async () => {
    const { f, frames, calls } = await stoppedAtBuild("on");
    try {
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(calls).toEqual([["resume", "agent-task-one", "s-one", f.dir]]);
      expect(frames).toEqual(["agent-task-one"]);
    } finally { f.close(); }
  });

  test("[验收线 2] observe：不 resume，帧照旧被拒（原因写已停止），同一绑定多次派单只记一条观察", async () => {
    const { f, frames, calls, lastReceipt } = await stoppedAtBuild("observe");
    try {
      for (let i = 0; i < 3; i++) { await f.tick(); f.advance(11 * 60_000); }
      expect(calls).toEqual([]);
      expect(frames).toEqual([]);
      expect(observations(f)).toHaveLength(1);
      expect(observations(f)[0].text).toContain("agent-task-one/s-one");
      expect(lastReceipt()).toMatchObject({ status: "cancelled", receipt: expect.stringContaining("已停止") });
    } finally { f.close(); }
  });

  test("[验收线 2] off：不 resume、不记观察，帧照旧被拒；拒收原因写已停止而不是「不在 registry」", async () => {
    const { f, frames, calls, lastReceipt } = await stoppedAtBuild("off");
    try {
      await f.tick();
      expect(calls).toEqual([]);
      expect(frames).toEqual([]);
      expect(observations(f)).toHaveLength(0);
      const r = lastReceipt();
      expect(r.status).toBe("cancelled");
      expect(r.receipt).toContain("未投递");
      expect(r.receipt).toContain("绑定 worker agent-task-one 已停止");
      expect(r.receipt).not.toContain("不在 registry");
      expect(r.receipt).not.toContain("未在 registry");
    } finally { f.close(); }
  });

  test("[验收线 4] resume 失败不发帧、按未投递拒收带原因；同一绑定连续 3 次失败交 PM（manual + 通知）", async () => {
    const { f, frames, calls, lastReceipt } = await stoppedAtBuild("on", () => ({ ok: false, error: "tmux 窗口起不来" }));
    try {
      for (let i = 1; i <= 3; i++) {
        await f.tick();
        expect(calls).toHaveLength(i);
        expect(lastReceipt()).toMatchObject({ status: "cancelled", receipt: expect.stringContaining(`未投递`) });
        expect(lastReceipt().receipt).toContain(`${WAKE_FAILED}：resume 失败：tmux 窗口起不来`);
        expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
        f.advance(11 * 60_000);
      }
      expect(frames).toEqual([]);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("连续 3 次") });
      expect(calls).toHaveLength(3); // 交 PM 后不再空转
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(f.notices).toEqual([expect.stringContaining(WAKE_FAILED)]);
    } finally { f.close(); }
  });

  test("[验收线 4] resume 超时、ready=false 都算唤醒失败，不发帧", async () => {
    for (const [answer, why] of [
      [() => new Promise<Record<string, unknown>>(() => {}), "resume 超过"],
      [() => ({ ok: true, ready: false }), "ready=false"],
      [() => { throw new Error("spawn 崩了"); }, "spawn 崩了"],
    ] as const) {
      const { f, frames, lastReceipt } = await stoppedAtBuild("on", answer as () => Record<string, unknown>);
      try {
        await f.tick();
        expect(frames).toEqual([]);
        expect(lastReceipt().receipt).toContain(WAKE_FAILED);
        expect(lastReceipt().receipt).toContain(why);
      } finally { f.close(); }
    }
  });

  test("[验收线 4] 中途有人手动拉起（不再 stopped）：旧的失败不再计数，照常派", async () => {
    const { f, frames } = await stoppedAtBuild("on", () => ({ ok: false, error: "x" }));
    try {
      for (let i = 0; i < 3; i++) { await f.tick(); f.advance(11 * 60_000); }
      patchAgent(f, "agent-task-one", { status: "running" });
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(frames).toEqual(["agent-task-one"]);
    } finally { f.close(); }
  });
});

describe("[验收线 3] 不唤醒：ACP、session 不一致、不是 stopped，行为照旧", () => {
  async function direct(patch: Record<string, unknown>, sessionId = "s-one") {
    const f = autoFixture();
    await toBuild(f);
    await f.tick(); // 派出 build 单，拿到一张真的意图当 key
    const key = f.intents().at(-1)!.id;
    patchAgent(f, "agent-task-one", patch);
    const { frames, bridge } = fakeBridge(f), { calls, manager } = fakeManager(f);
    const r = await sendVia(registryRow(f), () => true, { wake: { db: f.db, manager, policy: policyOf("on") }, bridge })("agent-task-one", sessionId, "x", key);
    return { f, r, frames, calls };
  }

  test("ACP worker 停了也不 resume（ACP 自己拉起）", async () => {
    const { f, r, calls } = await direct({ status: "stopped", transport: "acp" });
    try {
      expect(calls).toEqual([]);
      expect(r).toMatchObject({ ok: false, delivered: false, reason: expect.stringContaining("未在 registry") }); // ACP 原样
    } finally { f.close(); }
  });

  test("sessionId 不一致：不 resume，照旧在 bridge 前拒收", async () => {
    const { f, r, calls, frames } = await direct({ status: "stopped" }, "s-old");
    try {
      expect(calls).toEqual([]);
      expect(frames).toEqual([]);
      expect(r).toEqual({ ok: false, delivered: false, reason: "agent-task-one 的当前 session 不是台账绑定的 s-old" });
    } finally { f.close(); }
  });

  test("status 不是 stopped：不 resume，直接发", async () => {
    for (const status of [undefined, "running", "active"]) {
      const { f, r, calls, frames } = await direct({ status });
      try {
        expect(calls).toEqual([]);
        expect(frames).toEqual(["agent-task-one"]);
        expect(r).toMatchObject({ ok: true });
      } finally { f.close(); }
    }
  });

  test("没有 cwd 的 stopped 行不唤醒；没传 wake（ACP 端口）也不唤醒", async () => {
    const { f, calls } = await direct({ status: "stopped", cwd: "" });
    try { expect(calls).toEqual([]); } finally { f.close(); }
  });
});
