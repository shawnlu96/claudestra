/** web/lib/api/fleet.ts 的「存记忆 + Compact」：只对一个 agent 发 save-compact；403 收起按钮、提示走字典（T35 r2 P2-4 / P2-6） */
import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { COMPACT_DENIED, fleetAccess, requestCompact, type FleetReport } from "@/lib/api/fleet";
import { FLEET_DICT } from "@/lib/i18n-dict-fleet";

const report = (x: Partial<FleetReport>): FleetReport =>
  ({ runId: "fl_x", dryRun: false, action: { kind: "save-compact" }, targets: [], results: [], excluded: [], summary: "", ...x }) as FleetReport;

describe("requestCompact", () => {
  test("只对这一个 agent 发 save-compact；已执行 / 已排队算成，其余算没成", async () => {
    const seen: unknown[] = [];
    const run = async (body: unknown) => (seen.push(body), report({ results: [{ agent: "agent-a", outcome: "queued", detail: "忙，已排队" }] }));
    expect(await requestCompact("agent-a", run)).toEqual({ ok: true, text: "忙，已排队" });
    expect(seen).toEqual([{ action: { kind: "save-compact" }, select: { agents: ["agent-a"] } }]);
    const failed = async () => report({ results: [{ agent: "agent-a", outcome: "failed", detail: "有草稿" }] });
    expect(await requestCompact("agent-a", failed)).toEqual({ ok: false, text: "有草稿" });
    const excluded = async () => report({ excluded: [{ name: "agent-a", reason: "不在线" }] });
    expect(await requestCompact("agent-a", excluded)).toEqual({ ok: false, text: "不在线" });
  });

  test("403：提示是字典里的键（有英文），这台设备随后按没权限处理、不再去问", async () => {
    expect(FLEET_DICT[COMPACT_DENIED]).toBeTruthy();
    const denied = async (): Promise<FleetReport> => {
      throw new ApiError("forbidden", 403);
    };
    expect(await requestCompact("agent-a", denied)).toEqual({ ok: false, text: COMPACT_DENIED });
    expect(await fleetAccess()).toBe(false);
    const broken = async (): Promise<FleetReport> => {
      throw new Error("网络断了");
    };
    expect(await requestCompact("agent-a", broken)).toEqual({ ok: false, text: "网络断了" });
  });
});

test("fleetAccess：问不到（断网、老 bridge 没这个端点）按不能处理，按钮不显示（PM 09-29：结果未知一律隐藏）", async () => {
  const { machines } = await import("@/lib/machines");
  const real = machines.current.bind(machines);
  machines.current = () => ({ fp: "unreachable-fp" }) as ReturnType<typeof real>;
  try {
    expect(await fleetAccess()).toBe(false);
  } finally {
    machines.current = real;
  }
});
