import { expect, test } from "bun:test";
import { emptyQuotaState } from "../src/lib/quota-state";
import { teamQuota } from "../src/lib/team-quota";
import { handleTeamApi } from "../src/bridge/local-api/team";
import type { Principal } from "../src/lib/principals";

test("cache-only projection: missing, expired and uncertain are unknown; no identifiers leave cache", () => {
  const state = emptyQuotaState();
  expect(teamQuota(state, 1000).map((q) => q.used)).toEqual([null, null]);
  state.current.codex = "private-account";
  state.accounts["private-account"] = {
    provider: "codex", identity: "bound", uncertain: false, rateLimitedUntil: null, lastSeenAt: 1000, health: {},
    snapshots: { codex_usage: { observedAt: 1000, data: { plan: null, limitReached: false, balance: null, resetCredits: null, windows: [
      { id: "5h", kind: "session", usedPct: 72, resetsAtMs: 999999, windowMinutes: 300, severity: null, scopeModel: null },
    ] } } },
  };
  expect(teamQuota(state, 1000)[1].used).toBe(72);
  expect(JSON.stringify(teamQuota(state, 1000))).not.toContain("private-account");
  expect(teamQuota(state, 301001)[1].used).toBeNull();
  state.accounts["private-account"].uncertain = true;
  expect(teamQuota(state, 1000)[1].used).toBeNull();
});

test("team cache endpoint rejects peer and scoped principals before reading", async () => {
  const base: Principal = { id: "token:test", role: "external", agents: ["worker"], createdAt: "2026-01-01" };
  for (const principal of [base, { ...base, agents: ["*"], peer: "P" }]) {
    const response = await handleTeamApi(new Request("http://local/api/v1/team/quota"), "/team/quota", principal);
    expect(response?.status).toBe(403);
  }
  expect(await handleTeamApi(new Request("http://local/other"), "/other", base)).toBeNull();
});
