import { describe, expect, test } from "bun:test";
import { contextText, executorMatches, peerWorkState, quotaTier, workState } from "../web/features/collab/team-panel-model";

describe("team panel data model", () => {
  test("missing session values stay unknown; zero context is known", () => {
    expect(workState({})).toBe("unknown");
    expect(workState({ busy: false })).toBe("idle");
    expect(workState({ busy: true })).toBe("busy");
    expect(workState({ status: "creating", busy: false })).toBe("unknown");
    expect(workState({ status: "stopped", busy: false })).toBe("stopped");
    expect(contextText(null)).toBeNull();
    expect(contextText(NaN)).toBeNull();
    expect(contextText(-1)).toBeNull();
    expect(contextText(0)).toBe("0 tokens");
  });
  test("offline, stale, missing timestamp and future timestamp suppress peer idle claims", () => {
    const now = 1_000_000;
    const peer = { name: "P", online: true, stale: false, checkedAt: new Date(now).toISOString(), agents: [] };
    expect(peerWorkState(peer, { name: "A", busy: false }, now)).toBe("idle");
    for (const patch of [{ online: false }, { online: null }, { stale: true }, { checkedAt: undefined },
      { checkedAt: new Date(now - 180_001).toISOString() }, { checkedAt: new Date(now + 1).toISOString() }]) {
      expect(peerWorkState({ ...peer, ...patch }, { name: "A", busy: false }, now)).toBe("unknown");
    }
  });
  test("executor matching includes the exact peer identity", () => {
    expect(executorMatches("agent-A@P", "P", "A")).toBe(true);
    expect(executorMatches("agent-A@P2", "P", "A")).toBe(false);
    expect(executorMatches("agent-AA@P", "P", "A")).toBe(false);
    expect(executorMatches(null, "P", "A")).toBe(false);
  });
  test("quota estimates fail unknown when cache is missing or stale", () => {
    const q = { provider: "codex", used: 50, observedAt: 1000 };
    expect(quotaTier(q, 1000)).toBe("available");
    expect(quotaTier({ ...q, used: 90 }, 1000)).toBe("busy");
    expect(quotaTier({ ...q, used: 100 }, 1000)).toBe("closed");
    expect(quotaTier({ ...q, used: null }, 1000)).toBe("unknown");
    expect(quotaTier(q, 301001)).toBe("unknown");
    expect(quotaTier(q, 999)).toBe("unknown");
  });
});
