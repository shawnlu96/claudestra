/**
 * dispatch-recovery-MAT 纯逻辑：策略 port 的缺省 / 失读、结构化项只读真实字段（不从 probe 猜路径 / 验收线）、来源引用、渲染与插入位置。
 * 真实挂单（外发闸、parser、台账、worker 看到的单）在 tests/fix-materials-offer.test.ts。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { fixMaterials, materialsMode, materialsNote, materialsText, withMaterials, type FixMaterials } from "../src/lib/fix-materials.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { chunkInputs } from "../src/lib/order-wire-chunks.js";
import type { OrderWire } from "../src/lib/order-wire.js";
import type { ReviewFinding } from "../src/lib/scheduler-review.js";

const REPORT = "## P1\n- F1 在 src/guess.ts:99 附近\n";
const review = (seq: number, path: string, findings: unknown[]): LedgerEvent =>
  ({ seq, kind: "review", data: { path, findings } }) as unknown as LedgerEvent;
const F1 = { findingId: "F1", family: "race", severity: "P1", probe: "两进程同时写，见 src/guess.ts:99 [验收线 3]" };
const F2 = { findingId: "F2", family: "api", severity: "P2", probe: "返回值没校验", file: "src/lib/x.ts", line: 12, basis: "acceptance:2" };

describe("materialsMode", () => {
  test("没有 port = observe；on / observe / off 原样；未知值、port 抛错 = off", () => {
    expect(materialsMode(undefined, "p")).toBe("observe");
    for (const mode of ["on", "observe", "off"] as const) expect(materialsMode(() => ({ mode }), "p")).toBe(mode);
    expect(materialsMode(() => ({ mode: "ON" }), "p")).toBe("off");
    expect(materialsMode(() => { throw new Error("坏配置"); }, "p")).toBe("off");
    const seen: unknown[] = [];
    materialsMode((project, mechanism) => (seen.push([project, mechanism]), { mode: "on" }), "proj");
    expect(seen).toEqual([["proj", "materials"]]);
  });
});

describe("fixMaterials", () => {
  test("只读真实 file / line / basis 字段；probe 里的路径与 [验收线] 标记不拿来当定位", () => {
    const m = fixMaterials("on", [review(3, "/r.md", [F1, F2])], "/r.md", REPORT)!;
    expect(m.items).toEqual([
      { findingId: "F1", severity: "P1", file: null, line: null, basis: null },
      { findingId: "F2", severity: "P2", file: "src/lib/x.ts", line: 12, basis: "acceptance:2" },
    ]);
    expect(m.source).toEqual({ eventSeq: 3, sha256: createHash("sha256").update(REPORT).digest("hex"), bytes: Buffer.byteLength(REPORT) });
    expect(materialsNote(m)).toEqual({ mode: "on", items: 2, unlocated: 1, eventSeq: 3, sha256: m.source.sha256.slice(0, 12), bytes: m.source.bytes });
  });

  test("不合格的 file（命令、绝对路径外的怪字符）与非正整数 line 视为缺失；没有 file 的 line 不单独算定位", () => {
    const rows = [{ ...F1, file: "rm -rf /; x", line: 3 }, { ...F2, findingId: "F3", line: 0 }, { ...F2, findingId: "F4", file: undefined, line: 5 }];
    const m = fixMaterials("on", [review(1, "/r.md", rows)], "/r.md", REPORT)!;
    expect(m.items.map((i) => [i.file, i.line])).toEqual([[null, null], ["src/lib/x.ts", null], [null, null]]);
  });

  test("取报告路径对得上的最后一条审查；坏行丢掉；没有结构化项 = null（走原全文路径）", () => {
    const events = [review(1, "/old.md", [F2]), review(2, "/r.md", [F1, { findingId: 7 }]), review(4, "/other.md", [F2])];
    expect(fixMaterials("observe", events, "/r.md", REPORT)!.items.map((i) => i.findingId)).toEqual(["F1"]);
    expect(fixMaterials("on", [review(2, "/r.md", [])], "/r.md", REPORT)).toBeNull();
    expect(fixMaterials("on", [review(2, "/x.md", [F1])], "/r.md", REPORT)).toBeNull();
  });
});

describe("materialsText / withMaterials", () => {
  const m = fixMaterials("on", [review(9, "/r.md", [F1, F2])], "/r.md", REPORT) as FixMaterials;
  const findings = [F2, F1] as ReviewFinding[];

  test("按派单 findings 的位置点名、缺定位明说、带不可变来源；不含报告原文", () => {
    const text = materialsText(m, findings);
    expect(text).toContain(`本机台账审查事件 #9，报告 sha256 前 12 位 ${m.source.sha256.slice(0, 12)}、${m.source.bytes} 字节`);
    expect(text).toContain("- 上一轮审查第 2 条（P1）· 位置：审查结论未给结构化 file / line（按描述复现定位，不要猜路径） · 验收对应：审查结论未标");
    expect(text).toContain("- 上一轮审查第 1 条（P2）· 位置：src/lib/x.ts:12 · 验收对应：验收线 2");
    expect(text).not.toContain("guess.ts");
    expect(text).not.toContain("F1");
  });

  test("必需项对不上派单 findings：明确本机阻塞，不退回全文", () => {
    expect(() => materialsText(m, [F2] as ReviewFinding[])).toThrow("本机阻塞");
  });

  test("插在标准答复（最后一个输入）之前，其余输入不动", () => {
    const wire = { inputs: ["规格原文：\nx", "标准答复"] } as OrderWire;
    const out = withMaterials(wire, m, findings, chunkInputs);
    expect(out.inputs).toHaveLength(3);
    expect(out.inputs[0]).toBe("规格原文：\nx");
    expect(out.inputs[1]!.startsWith("修复材料（结构化必需项，不是审查报告原文）：\n来源：")).toBe(true);
    expect(out.inputs[2]).toBe("标准答复");
  });
});
