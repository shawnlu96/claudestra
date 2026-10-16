/** peer-WEBLOCAL1：中继模式下当前机器被记成 LOCAL_FP 的自愈判定（web/features/machines/machine-heal.ts） */
import { describe, expect, test } from "bun:test";
import { planRelayHeal } from "@/features/machines/machine-heal";
import type { MachineRecord } from "@/lib/machines";

const rec = (fp: string, lastUsedAt: number): MachineRecord => ({ fp, name: fp, addedAt: 0, lastUsedAt });

describe("planRelayHeal", () => {
  test("[验收线 2] 当前 = LOCAL_FP、另有真实机器：删 LOCAL_FP，切到最近用过的真实机器", () => {
    const list = [rec("local", 300), rec("aaaa-1111", 100), rec("bbbb-2222", 200)];
    expect(planRelayHeal(list, "local")).toEqual({ action: "switch", drop: "local", to: "bbbb-2222" });
  });
  test("[验收线 2] 当前 = LOCAL_FP、没有别的机器 → 删掉后去 /pair", () => {
    expect(planRelayHeal([rec("local", 1)], "local")).toEqual({ action: "pair", drop: "local" });
  });
  test("当前是真实机器 / 没有当前机器：不动（不删任何记录）", () => {
    const list = [rec("local", 300), rec("aaaa-1111", 100)];
    expect(planRelayHeal(list, "aaaa-1111")).toEqual({ action: "keep" });
    expect(planRelayHeal([], null)).toEqual({ action: "keep" });
  });
});
