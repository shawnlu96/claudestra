import { describe, expect, test } from "bun:test";
import { mergeProbe, probeErrorOf, probeResultOf } from "../src/lib/peer-presence";

describe("在线 peer 列表：探测结果合并", () => {
  const T1 = "2026-09-24T10:00:00.000Z";
  const T2 = "2026-09-24T10:01:00.000Z";

  test("探测成功：在线，记延迟、对方开放的 agent、上次在线时间", () => {
    const p = mergeProbe(undefined, { ok: true, latencyMs: 42, agents: [{ name: "agent-a", status: "active" }] }, T1);
    expect(p).toMatchObject({ online: true, checkedAt: T1, lastOnlineAt: T1, latencyMs: 42 });
    expect(p.remoteAgents?.map((a) => a.name)).toEqual(["agent-a"]);
  });

  test("之后探测失败：离线 + 原因，但保留上次在线时间和上次看到的 agent", () => {
    const on = mergeProbe(undefined, { ok: true, latencyMs: 42, agents: [{ name: "agent-a" }] }, T1);
    const off = mergeProbe(on, { ok: false, error: "timeout" }, T2);
    expect(off).toMatchObject({ online: false, error: "timeout", lastOnlineAt: T1, checkedAt: T2 });
    expect(off.latencyMs).toBeUndefined();
    expect(off.remoteAgents?.length).toBe(1);
  });

  test("单向 peer（没有出站地址）：online=null，不算离线；来访时间保留", () => {
    const p = mergeProbe({ online: null, lastInboundAt: T1 }, null, T2);
    expect(p).toMatchObject({ online: null, lastInboundAt: T1, checkedAt: T2 });
  });

  test("对方响应：非 2xx 算离线（token 被吊销时用不了）；非 JSON / 缺字段按空列表", () => {
    expect(probeResultOf(401, { ok: false }, 10)).toEqual({ ok: false, error: "http 401" });
    expect(probeResultOf(200, null, 10)).toEqual({ ok: true, latencyMs: 10, agents: [] });
    expect(probeResultOf(200, { agents: [{ name: "x" }, { bad: 1 }, null] }, 10)).toEqual({ ok: true, latencyMs: 10, agents: [{ name: "x", status: undefined }] });
  });

  test("fetch 错误归类：超时 / 被拒 / 其它原文截断", () => {
    expect(probeErrorOf({ name: "TimeoutError", message: "The operation timed out." })).toBe("timeout");
    expect(probeErrorOf({ code: "ConnectionRefused", message: "Unable to connect" })).toBe("refused");
    expect(probeErrorOf(new Error("certificate has expired"))).toBe("certificate has expired");
  });
});
