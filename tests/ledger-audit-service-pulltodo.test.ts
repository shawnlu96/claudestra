/**
 * agents-PULLTODO1：巡检发现按 pmTodoPull 只进 pm-todo（bridge/ledger-audit-service.ts）。全部流量在本文件里截住，不接真 bridge。
 */
import { describe, expect, test } from "bun:test";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import type { StoredFinding } from "../src/lib/ledger-audit-store.js";
import type { AuditTodoPort } from "../src/lib/pm-todo-audit.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

const finding = (key: string, notify: string, over: Partial<StoredFinding> = {}): StoredFinding => ({
  key, project: "p", taskId: "T1", rule: "pm_held" as StoredFinding["rule"], firstSeen: 100, lastSeen: 100, resolvedAt: null, since: 100,
  detail: "卡住了", suggestion: "看看", notify, notifiedAt: null, queuedAs: null, changedAt: 100, ...over,
});

function harness(mode: RecoveryMode, pending: unknown[], over: Partial<LedgerAuditDeps> & { recordThrows?: boolean; extra?: Record<string, unknown> } = {}) {
  const sent: Envelope[] = [], calls: string[][] = [], recorded: string[] = [], observed: string[] = [];
  const pmTodo: AuditTodoPort = {
    mode: () => mode,
    record: (list) => { if (over.recordThrows) throw new Error("台账忙"); recorded.push(...list.map((f) => f.key)); },
    observe: (list) => { observed.push(...list.map((f) => f.key)); },
  };
  const d: LedgerAuditDeps = {
    clients: new Map([["pm-ch", { ws: {} as never, channelId: "pm-ch" }], ["disp-ch", { ws: {} as never, channelId: "disp-ch" }]]),
    deliver: async (env) => { sent.push(env); return { outcome: { kind: "sent" } }; },
    hold: () => {},
    lastMessageSource: { set: () => {} },
    channelOf: (to) => ({ pm: "pm-ch", disp: "disp-ch" } as Record<string, string>)[to],
    busy: async () => false,
    failureTargets: () => [{ project: "p", to: "pm" }],
    runManager: async (...args) => {
      calls.push(args);
      if (args.includes("--json")) return { ok: true, projects: [{ project: "p" }], pending, ...over.extra };
      return { ok: true };
    },
    pmTodo,
    ...over,
  };
  return { d, sent, calls, recorded, observed, tick: ledgerAuditTicker(d) };
}
const acks = (calls: string[][]) => calls.filter((c) => c.includes("--ack"));

describe("[验收线 1] pmTodoPull 对巡检推送的分流", () => {
  test("on：发给当班 PM 的发现只记 pm-todo、照常 ack，不调 deliver；发给调度助理的照旧推", async () => {
    const h = harness("on", [finding("k-pm", "pm"), finding("k-disp", "disp")]);
    await h.tick();
    expect(h.recorded).toEqual(["k-pm"]);
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["disp"]);
    expect(String(h.sent[0]!.content)).not.toContain("k-pm");
    expect(acks(h.calls).flat()).toContain("k-pm@100");
    expect(acks(h.calls).flat()).toContain("k-disp@100");
  });

  test("off：与改前一致——推给 PM，不记条目也不记观察", async () => {
    const h = harness("off", [finding("k-pm", "pm")]);
    await h.tick();
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["pm"]);
    expect([h.recorded, h.observed]).toEqual([[], []]);
  });

  test("[验收线 4] observe：照旧推送，另记一条观察", async () => {
    const h = harness("observe", [finding("k-pm", "pm")]);
    await h.tick();
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["pm"]);
    expect(h.recorded).toEqual([]);
    expect(h.observed).toEqual(["k-pm"]);
  });

  test("pm-todo 写不进去：照旧推送，不吞", async () => {
    const h = harness("on", [finding("k-pm", "pm")], { recordThrows: true });
    await h.tick();
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["pm"]);
    expect(acks(h.calls)).toHaveLength(1);
  });

  test("读不到当班 PM：全按改前推送", async () => {
    const h = harness("on", [finding("k-pm", "pm")], { failureTargets: () => { throw new Error("台账不可用"); } });
    await h.tick();
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["pm"]);
    expect(h.recorded).toEqual([]);
  });

  test("on：经 ledgerAuditEscalator 升级的发现照旧推给 PM", async () => {
    const escalate = [{ key: "k-disp", taskId: "T1", rule: "pm_held", notifiedAt: 50, from: "disp", to: "pm", detail: "卡住了", mode: "on" }];
    const h = harness("on", [], { extra: { escalate } });
    await h.tick();
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["pm"]);
    expect(String(h.sent[0]!.content)).toContain("60 分钟");
    expect(h.recorded).toEqual([]);
  });

  test("on：巡检自身连续失败照旧推给 PM", async () => {
    const h = harness("on", []);
    h.d.runManager = async () => ({ ok: false, error: "坏了" });
    const tick = ledgerAuditTicker(h.d);
    for (let i = 0; i < 3; i++) await tick();
    expect(h.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["pm"]);
    expect(String(h.sent[0]!.content)).toContain("ledger-audit-failure");
  });
});
