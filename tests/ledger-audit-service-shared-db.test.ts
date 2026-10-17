/**
 * 巡检补 executor_idle 时长时用的是 openLedger() 的进程级缓存连接（bridge/ledger-audit-service.ts withIdleNotes）。
 * 这一轮跑完连接必须还能用：关掉它会让整个 bridge 的台账读写都报 closed database。
 */
import { expect, test } from "bun:test";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { StoredFinding } from "../src/lib/ledger-audit-store.js";
import { openLedger } from "../src/lib/ledger-store.js";

const idle: StoredFinding = {
  key: "k-idle", project: "p", taskId: "T1", rule: "executor_idle" as StoredFinding["rule"], firstSeen: 100, lastSeen: 100, resolvedAt: null,
  since: 100, detail: "执行者空闲", suggestion: "看看", notify: "pm", notifiedAt: null, queuedAs: null, changedAt: 100,
};

test("executor_idle 补时长后，共用的台账连接仍可用", async () => {
  const shared = openLedger();
  const d: LedgerAuditDeps = {
    clients: new Map([["pm-ch", { ws: {} as never, channelId: "pm-ch" }]]),
    deliver: async () => ({ outcome: { kind: "sent" } }),
    hold: () => {},
    lastMessageSource: { set: () => {} },
    channelOf: (to) => (to === "pm" ? "pm-ch" : undefined),
    busy: async () => false,
    failureTargets: () => [{ project: "p", to: "pm" }],
    runManager: async (...args) => (args.includes("--json") ? { ok: true, projects: [{ project: "p" }], pending: [idle] } : { ok: true }),
    pmTodo: { mode: () => "off", record: () => {}, observe: () => {} },
  };
  await ledgerAuditTicker(d)();
  expect(openLedger()).toBe(shared);
  expect(shared.query("select 1 as one").get()).toEqual({ one: 1 });
});
