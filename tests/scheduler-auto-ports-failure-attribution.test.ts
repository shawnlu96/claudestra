/**
 * 回合失败卡归哪张调度单（scheduler-auto-ports.ts codexFailure）：按宿主报的失败时刻 / 会话（extra.failedAt / sessionId，lib/acp/host.ts），
 * 不按 bridge 写卡的 createdAt。迟到的旧帧（失败早于本单认领、写卡晚于认领）、换会话前的失败都不归到在途这张单；老宿主不报失败时刻 = unknown，
 * 交 PM 但不说成本单失败。当前回合的失败照旧归本单、退人工通知 PM；额度 / 登录卡不变。
 * turnState 按 acpPort 的接法把绑定会话传进 codexFailure。
 */
import { describe, expect, test } from "bun:test";
import { openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { boundRef } from "../src/lib/scheduler-auto-tick.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker } from "../src/lib/worker-acp.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const lastIntent = (f: F) => f.db.query("SELECT * FROM scheduler_intents ORDER BY eventSeq DESC LIMIT 1").get() as SchedulerIntent;

/** 审查单已认领、发给 agent-rv-t1（绑定会话 s-rv）；card(at) 在认领之后才写进台账，extra 由调用方给 */
async function reviewSent(extra: (claimedAt: number) => Record<string, unknown>, kind: "owner_action" | "decide" = "owner_action") {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick(); // ensure reviewer
  const send = async () => {
    const claimedAt = (f.db.query("SELECT ts FROM events WHERE dedupKey LIKE 'scheduler:%:submitted' ORDER BY seq DESC LIMIT 1").get() as { ts: number }).ts;
    openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind, title: kind === "decide" ? "usage limit" : "Codex 回合失败",
      context: "This request was blocked by cyber policy.", extra: extra(claimedAt) }, claimedAt + 1_000);
    return { ok: true as const, messageId: "m" };
  };
  f.tickDeps.worker = () => createAcpWorker({
    sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
    ledger: { result: (ref, probe) => ledgerResult(f.db, ref, probe) },
    port: { prompt: send, turnState: async (a, sid) => ({ live: "idle", lastFailure: codexFailure(f.db, a, sid) }), cancel: async () => ({ ok: true, evidence: "c" }) },
  });
  expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
  return f;
}

describe("回合失败卡按宿主报的失败时刻 / 会话归单", () => {
  test("当前会话、认领之后失败：归本单，退人工、PM 收到一次", async () => {
    const f = await reviewSent((claimedAt) => ({ failure: "error", sessionId: "s-rv", failedAt: claimedAt + 500 }));
    try {
      expect(codexFailure(f.db, "agent-rv-t1", "s-rv")).toMatchObject({ failure: { kind: "error" }, afterKey: lastIntent(f).id });
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("回合失败") });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(f.notices).toEqual([expect.stringContaining("cyber policy")]);
    } finally { f.close(); }
  });

  const stale: [string, (claimedAt: number) => Record<string, unknown>][] = [
    ["迟到旧帧：失败远早于认领（写卡在认领之后）", () => ({ failure: "error", sessionId: "s-rv", failedAt: 1 })],
    ["同一会话、失败就在认领前一刻", (claimedAt) => ({ failure: "error", sessionId: "s-rv", failedAt: claimedAt - 1 })],
    ["换会话前的失败：卡上会话不是绑定会话（时刻在认领之后）", (claimedAt) => ({ failure: "error", sessionId: "s-old", failedAt: claimedAt + 500 })],
  ];
  for (const [name, extra] of stale) {
    test(`${name}：不归在途这张单，调度不退人工、PM 不收通知`, async () => {
      const f = await reviewSent(extra);
      try {
        expect(codexFailure(f.db, "agent-rv-t1", "s-rv")).toBeUndefined();
        expect(await f.tick()).toMatchObject({ step: "waiting" });
        expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
        expect(f.notices).toEqual([]);
      } finally { f.close(); }
    });
  }

  const unattributed: [string, (claimedAt: number) => Record<string, unknown>][] = [
    ["老宿主不报失败时刻", () => ({ failure: "error" })],
    // 宿主 initialize / attach 失败时会话还没建（lib/acp/host.ts fail → sendFailure）：有 failedAt 无 sessionId，证明不了是绑定会话上的
    ["宿主未建会话就失败：有失败时刻、缺 sessionId（时刻在认领之后）", (claimedAt) => ({ failure: "error", failedAt: claimedAt + 500 })],
    ["sessionId 为空串", (claimedAt) => ({ failure: "error", sessionId: "", failedAt: claimedAt + 500 })],
    ["有会话、缺失败时刻", () => ({ failure: "error", sessionId: "s-rv" })],
  ];
  for (const [name, extra] of unattributed) test(`${name}：unknown（afterKey null），交 PM 写明归不到派单，不说成本单回合失败`, async () => {
    const f = await reviewSent(extra);
    try {
      expect(codexFailure(f.db, "agent-rv-t1", "s-rv")).toMatchObject({ failure: { kind: "error" }, afterKey: null });
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("归不到派单上的失败") });
      expect(f.notices).toHaveLength(1);
    } finally { f.close(); }
  });

  test("额度卡不变：按写卡时刻归本单", async () => {
    const f = await reviewSent(() => ({ quota: true }), "decide");
    try {
      expect(codexFailure(f.db, "agent-rv-t1", "s-rv")).toMatchObject({ failure: { kind: "quota" }, afterKey: lastIntent(f).id });
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("撞额度") });
    } finally { f.close(); }
  });
});
