/** PEERINFO1 [验收线 3]：探测读方解析对方的 instance，记进 presence；形状不对整块丢、在线判断不变；对方没带时与改前相同。 */
import { describe, expect, test } from "bun:test";
import type { PeerInstanceInfo } from "../src/lib/peer-instance-info";
import { mergeProbe, probeResultOf } from "../src/lib/peer-presence";

const T1 = "2026-10-14T05:00:00.000Z";
const T2 = "2026-10-14T05:01:00.000Z";
const INFO: PeerInstanceInfo = { version: "2.33.0", commit: "d9427176deff576232a2b47e0c0dc3a6bb0afd31", channel: "beta", switches: { centerReplicaPull: "observe" } };
const AGENTS = [{ name: "agent-a", status: "active" }];

describe("读方：instance", () => {
  test("带合法 instance：presence 记下，带取到时间", () => {
    const r = probeResultOf(200, { ok: true, agents: AGENTS, instance: INFO }, 5);
    expect(r).toEqual({ ok: true, latencyMs: 5, agents: AGENTS, instance: INFO });
    const p = mergeProbe(undefined, r, T1);
    expect(p).toMatchObject({ online: true, instance: INFO, instanceAt: T1 });
  });

  test("instance 形状不对：整块丢、记一行日志，在线判断与 agent 列表照常", () => {
    const logs: string[] = [];
    const bad = probeResultOf(200, { agents: AGENTS, instance: { ...INFO, commit: "/Users/x" } }, 5, (l) => logs.push(l));
    expect(bad).toEqual(probeResultOf(200, { agents: AGENTS }, 5));
    expect(logs.length).toBe(1);
    expect(mergeProbe(undefined, bad, T1)).toEqual(mergeProbe(undefined, probeResultOf(200, { agents: AGENTS }, 5), T1));
  });

  test("对方没带 instance：探测结果和 presence 与改前相同（没有新字段）", () => {
    const r = probeResultOf(200, { agents: AGENTS }, 5);
    expect(r).toEqual({ ok: true, latencyMs: 5, agents: [{ name: "agent-a", status: "active" }] });
    const p = mergeProbe(undefined, r, T1);
    expect(p).toEqual({ online: true, checkedAt: T1, lastOnlineAt: T1, latencyMs: 5, remoteAgents: r.ok ? r.agents : [], agentsAt: T1, authRejected: false, error: undefined });
  });

  test("之后探测：网络失败保留上次的 instance；对方不再带就清掉；401 清掉", () => {
    const on = mergeProbe(undefined, { ok: true, latencyMs: 5, agents: [], instance: INFO }, T1);
    expect(mergeProbe(on, { ok: false, error: "timeout" }, T2)).toMatchObject({ online: false, instance: INFO, instanceAt: T1 });
    const gone = mergeProbe(on, { ok: true, latencyMs: 5, agents: [] }, T2);
    expect("instance" in gone || "instanceAt" in gone).toBe(false);
    const rej = mergeProbe(on, { ok: false, error: "http 401" }, T2);
    expect("instance" in rej || "instanceAt" in rej).toBe(false);
  });
});
