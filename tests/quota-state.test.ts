/**
 * quota-state.json 读回的深校验（lib/quota-state.ts normalizeQuotaState）：形状不对的那一块丢掉，其余照用。
 */

import { describe, expect, test } from "bun:test";
import { emptyQuotaState, normalizeQuotaState, type AccountState } from "../src/lib/quota-state.js";

const account = (over: Record<string, unknown> = {}): AccountState => ({
  provider: "codex",
  identity: "bound",
  uncertain: false,
  rateLimitedUntil: null,
  lastSeenAt: 1,
  snapshots: { codex_usage: { data: { plan: null, limitReached: false, balance: null, resetCredits: null, windows: [] }, observedAt: 1 } },
  health: { codex_usage: { lastCode: null, lastAttemptAt: 1, failures: 0, cooldownUntil: null, authFingerprint: null, paused: false } },
  ...over,
} as AccountState);

describe("normalizeQuotaState", () => {
  test("正常状态原样通过", () => {
    const s = { ...emptyQuotaState(), current: { codex: "k" }, accounts: { k: account() } };
    expect(normalizeQuotaState(structuredClone(s))).toEqual(s);
  });

  test("外层不对 → 整份按空", () => {
    expect(normalizeQuotaState(null)).toEqual(emptyQuotaState());
    expect(normalizeQuotaState({ v: 2 })).toEqual(emptyQuotaState());
    expect(normalizeQuotaState({ ...emptyQuotaState(), accounts: [] })).toEqual(emptyQuotaState());
  });

  test("坏账户整条丢掉；坏快照 / 坏健康 / 未知端点只丢那一项", () => {
    const s = {
      ...emptyQuotaState(),
      current: { codex: "k", claude: 5, evil: "x" },
      accounts: {
        k: account({
          snapshots: {
            codex_usage: { data: { windows: [null] }, observedAt: 1 },
            codex_reset_credits: { data: { credits: [{ key: "a", expiresAtMs: 2 }] }, observedAt: 1 },
            bogus: { data: {}, observedAt: 1 },
          },
          health: { codex_usage: { failures: "x" }, codex_reset_credits: account().health.codex_usage },
        }),
        bad: { provider: "evil", identity: "bound" },
        noSeen: account({ lastSeenAt: "yesterday" }),
      },
    };
    const n = normalizeQuotaState(s);
    expect(n.current).toEqual({ codex: "k" });
    expect(Object.keys(n.accounts)).toEqual(["k"]);
    expect(Object.keys(n.accounts.k.snapshots)).toEqual(["codex_reset_credits"]);
    expect(Object.keys(n.accounts.k.health)).toEqual(["codex_reset_credits"]);
  });

  test("提醒账本：坏条目丢掉", () => {
    const good = { id: "n", kind: "expiry", accountKey: "k", createdAt: 1, channels: { push: { status: "sent", attempts: 1, lastAt: 1 }, discord: { status: "pending", attempts: 0, lastAt: null } } };
    const s = {
      ...emptyQuotaState(),
      credHealth: { claude: { code: "keychain_denied", at: 1, until: null }, codex: { code: 1 } },
      reminders: {
        credits: { a: { expiresAtMs: 1, coveredH: [72] }, b: { expiresAtMs: "x", coveredH: [] } },
        exhausted: { w: 1, v: "x" },
        outbox: [good, { id: "bad" }, null],
      },
    };
    const n = normalizeQuotaState(s);
    expect(Object.keys(n.credHealth)).toEqual(["claude"]);
    expect(Object.keys(n.reminders.credits)).toEqual(["a"]);
    expect(n.reminders.exhausted).toEqual({ w: 1 });
    expect(n.reminders.outbox).toEqual([good] as never);
  });
});
