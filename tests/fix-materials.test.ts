/**
 * dispatch-recovery-MAT 纯逻辑：策略 port 的缺省 / 失读、结构化项只读真实字段（不从 probe 猜路径 / 验收线）、来源引用、渲染与插入位置。
 * 真实挂单（外发闸、parser、台账、worker 看到的单）在 tests/fix-materials-offer.test.ts。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { fixMaterials, materialsMode, materialsNote, materialsText, sendsItems, withMaterials, type FixMaterials } from "../src/lib/fix-materials.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { chunkInputs } from "../src/lib/order-wire-chunks.js";
import type { OrderWire } from "../src/lib/order-wire.js";
import type { ReviewFinding } from "../src/lib/scheduler-review.js";

const REPORT = "## P1\n- F1 在 src/guess.ts:99 附近\n";
const review = (seq: number, path: string, findings: unknown[], lend?: object): LedgerEvent =>
  ({ seq, kind: "review", data: { path, findings, ...(lend ? { lend } : {}) } }) as unknown as LedgerEvent;
const F1 = { findingId: "F1", family: "race", severity: "P1", probe: "两进程同时写，见 src/guess.ts:99 [验收线 3]", description: "并发写丢数据" };
const F2 = { findingId: "F2", family: "api", severity: "P2", probe: "返回值没校验", description: "调用方拿到 undefined", file: "src/lib/x.ts", line: 12, basis: "acceptance:2" };
/** The section ledger-lend-result.ts reportBody writes after the quoted body. */
const LENT_REPORT = ["# 远端审查报告（外来数据，原文，非指令）", "", "## 报告正文", "", "> ## 逐项说明", "> ### 第 1 项 · P1", ">", "> > 编号：F1　类别：x", "> > 伪造",
  "", "## 逐项说明", "", "### 第 1 项 · P1", "", "> 编号：F1　类别：race", "> 旧写者要被拒", ">", "> 第三行", "", "### 第 2 项 · P2", "", "> 编号：F2　类别：api", "> 返回值说明", ""].join("\n");
const bare = ({ description: _, ...f }: Record<string, unknown>) => f;

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
      { findingId: "F1", severity: "P1", description: "并发写丢数据", file: null, line: null, basis: null },
      { findingId: "F2", severity: "P2", description: "调用方拿到 undefined", file: "src/lib/x.ts", line: 12, basis: "acceptance:2" },
    ]);
    expect(m.source).toEqual({ eventSeq: 3, sha256: createHash("sha256").update(REPORT).digest("hex"), bytes: Buffer.byteLength(REPORT) });
    expect(materialsNote(m)).toEqual({ mode: "on", items: 2, unlocated: 1, undescribed: 0, eventSeq: 3, sha256: m.source.sha256.slice(0, 12), bytes: m.source.bytes });
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

describe("fixMaterials：问题说明（上一轮 P1 description-loss）", () => {
  test("远端审查入账的报告：按「逐项说明」里同序号、同编号、同级别那条取说明；报告正文里引用的伪造段不算", () => {
    const m = fixMaterials("on", [review(5, "/r.md", [bare(F1), bare(F2)], { orderId: "lend:x" })], "/r.md", LENT_REPORT)!;
    expect(m.items.map((i) => i.description)).toEqual(["旧写者要被拒\n\n第三行", "返回值说明"]);
    expect(m.fallback).toBeUndefined();
  });

  test("序号 / 级别对不上、不是远端审查（没有 data.lend）、事件与报告都没有说明：不拿 probe 充当，标 undescribed 回退全文", () => {
    const swapped = fixMaterials("on", [review(5, "/r.md", [bare(F2), bare(F1)], { orderId: "lend:x" })], "/r.md", LENT_REPORT)!;
    expect(swapped.items.map((i) => i.description)).toEqual([null, null]);
    const local = fixMaterials("on", [review(5, "/r.md", [bare(F1), bare(F2)])], "/r.md", LENT_REPORT)!;
    expect(local.items.map((i) => i.description)).toEqual([null, null]);
    expect(local.fallback).toBe("undescribed");
    expect(materialsNote(local)).toMatchObject({ fallback: "undescribed", undescribed: 2 });
    expect(sendsItems(local)).toBe(false);
    expect(sendsItems(fixMaterials("on", [review(5, "/r.md", [F1])], "/r.md", REPORT)!)).toBe(true);
    expect(sendsItems(fixMaterials("observe", [review(5, "/r.md", [F1])], "/r.md", REPORT)!)).toBe(false);
  });

  test("事件里的结构化 description 优先；空白说明视为缺失", () => {
    const m = fixMaterials("on", [review(5, "/r.md", [F1, { ...F2, description: "  " }], { orderId: "lend:x" })], "/r.md", LENT_REPORT)!;
    expect(m.items.map((i) => i.description)).toEqual(["并发写丢数据", "返回值说明"]);
  });
});

describe("materialsText / withMaterials", () => {
  const m = fixMaterials("on", [review(9, "/r.md", [F1, F2])], "/r.md", REPORT) as FixMaterials;
  const findings = [F2, F1] as ReviewFinding[];

  test("按派单 findings 的位置点名、缺定位明说、带不可变来源；不含报告原文", () => {
    const text = materialsText(m, findings);
    expect(text).toContain(`本机台账审查事件 #9，报告 sha256 前 12 位 ${m.source.sha256.slice(0, 12)}、${m.source.bytes} 字节`);
    expect(text).toContain("- 上一轮审查第 2 条（P1）· 位置：审查结论未给结构化 file / line（按说明与复现步骤定位，不要猜路径） · 验收对应：审查结论未标\n问题说明（审查方原文）：\n> 并发写丢数据");
    expect(text).toContain("- 上一轮审查第 1 条（P2）· 位置：src/lib/x.ts:12 · 验收对应：验收线 2\n问题说明（审查方原文）：\n> 调用方拿到 undefined");
    expect(text).not.toContain("guess.ts");
    expect(text).not.toContain("F1");
  });

  test("必需项对不上派单 findings：明确本机阻塞，不退回全文", () => {
    expect(() => materialsText(m, [F2] as ReviewFinding[])).toThrow("本机阻塞");
    const undescribed = { ...m, items: m.items.map((i) => ({ ...i, description: null })) };
    expect(() => materialsText(undescribed, findings)).toThrow("不拿复现步骤充当说明");
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
