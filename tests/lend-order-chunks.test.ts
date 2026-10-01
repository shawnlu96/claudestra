/**
 * i28-N7：出借单里的规格原文、上一轮审查报告按 16K 分段进 inputs。分段本身（按行、段头计入上限、拼回逐字相同、只一段时和原来
 * 逐字一致）、写单 / 修复单经外发闸渲染再解析回来、审查单经 offerLendCore 真挂进池；单行超长、超过 20 段、整单超 32K 都明确拒绝。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { writeOrderWire, type WriteOrderInput } from "../src/lib/ledger-lend-lease.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseOrderWire, WIRE_LIMITS, type OrderWire } from "../src/lib/order-wire.js";
import { chunkInput, chunkInputs } from "../src/lib/order-wire-chunks.js";
import { redactOrderForPeer, renderOrderWire } from "../src/lib/order-wire-render.js";

const CAP = WIRE_LIMITS.input;
const bytes = (s: string) => Buffer.byteLength(s);
/** 去掉段头（段头里没有换行，到第一个 \n 为止）后按顺序拼回 */
const joined = (parts: readonly string[]) => parts.map((p) => p.slice(p.indexOf("\n") + 1)).join("");
/** 一份 NFKC 稳定、不触发脱敏的假规格：CJK、emoji、空行，约 `n` 字节 */
function fakeSpec(n: number, trailing = "\n"): string {
  const rows: string[] = [];
  for (let i = 0; bytes(rows.join("\n")) < n; i++) rows.push(i % 7 === 3 ? "" : `第${i}条 验收线逐条核对 规格原文内容 🙂 keep every byte ${"中".repeat(i % 40)}`);
  return rows.join("\n") + trailing;
}
/** 整段（含原样段头 `<label>：\n`）恰好 `size` 字节的多行文本 */
function filled(size: number, label: string): string {
  const room = size - bytes(`${label}：\n`);
  const row = "abcdefg\n";
  return row.repeat(Math.floor(room / row.length)) + "x".repeat(room % row.length);
}

describe("chunkInput", () => {
  const L = "规格原文（specRev 3）";
  test.each([
    ["空规格", ""],
    ["小规格（CJK、emoji、空行、末尾换行）", "规格 🙂\n\n验收：单测全绿\n"],
    ["整段恰好 16384 字节（多行）", filled(CAP, L)],
  ])("只有一段时和原来逐字一致：%s", (_name, text) => {
    expect(chunkInput(L, text)).toEqual([`${L}：\n${text}`]);
  });

  test.each([
    ["整段 16385 字节（多一个字节）", filled(CAP + 1, L)],
    ["26653 字节量级，末尾换行", fakeSpec(26653)],
    ["26653 字节量级，末尾无换行", fakeSpec(26653, "")],
    ["CRLF 与连续空行", fakeSpec(20000).replaceAll("\n", "\r\n") + "\r\n\r\n\r\n"],
    ["emoji 密集", "🙂👍🏽中文\n".repeat(2500)],
    ["几乎每行都是空行", "\n".repeat(40000)],
  ])("多段：每段 ≤16384、段头带序号、拼回逐字相同：%s", (_name, text) => {
    const parts = chunkInput(L, text);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(bytes(p)).toBeLessThanOrEqual(CAP);
      expect(p.startsWith(`${L}（第 ${i + 1}/${parts.length} 段）：\n`)).toBe(true);
    });
    expect(joined(parts)).toBe(text);
  });

  test("段数跨位数时按变长的段头重排，照样每段装得下", () => {
    const room9 = 100 - bytes("报告（第 9/9 段）：\n");
    const line = "y".repeat(Math.floor(room9 / 3) - 1) + "\n"; // 1–9 段的段头下一段放 3 行，10 段起段头多 2 字节只放得下 2 行
    expect(3 * line.length).toBeGreaterThan(100 - bytes("报告（第 10/10 段）：\n"));
    const text = line.repeat(30);
    const parts = chunkInput("报告", text, 100);
    expect(parts.length).toBe(15);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(100);
    expect(parts[14]!.startsWith("报告（第 15/15 段）：\n")).toBe(true);
    expect(joined(parts)).toBe(text);
  });

  test("边界数据本身：整段恰好 16384 / 16385 字节", () => {
    expect(bytes(`${L}：\n${filled(CAP, L)}`)).toBe(CAP);
    expect(bytes(`${L}：\n${filled(CAP + 1, L)}`)).toBe(CAP + 1);
  });

  test("单行一段装不下：不切行、明确拒绝", () => {
    expect(() => chunkInput(L, `短行\n${"长".repeat(6000)}\n`)).toThrow(/一段装不下.*拒绝出单/);
  });

  test("超过 20 段：整单拒绝，不丢后面的段", () => {
    expect(() => chunkInputs([[L, fakeSpec(CAP * 21)]])).toThrow(/规格分段后超过 20 段/);
    expect(() => chunkInputs([[L, fakeSpec(CAP * 15)], ["上一轮审查报告原文", fakeSpec(CAP * 6)]])).toThrow(/规格分段后超过 20 段/);
  });
});

/** 外发闸那条路：脱敏 → peer 渲染 → JSON 往返 → 现有 parse，和 offerLendCore 一样 */
function throughGate(wire: OrderWire): OrderWire {
  const order = redactOrderForPeer(wire, wire.head).order;
  renderOrderWire(order, { audience: "peer", ledgerHead: wire.head });
  const parsed = parseOrderWire(JSON.parse(JSON.stringify(order)));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("写单 / 修复单", () => {
  const task = { id: "T9", specRev: 2, round: 1 } as LedgerTask;
  const o = (over: Partial<WriteOrderInput>): WriteOrderInput => ({
    orderId: "lend:T9:s2:r1:a0", step: "write", head: "b".repeat(40), branch: "lend/T9-abcd", base: "main", spec: "规格", report: null,
    findings: [], repo: "shawnlu96/claudestra", pr: 7, ...over,
  });

  test("小规格的 inputs 和原来逐字相同（金样）", () => {
    expect(writeOrderWire(task, o({ spec: "规格：只改 x\n验收：全绿\n" })).inputs).toEqual(["规格原文（specRev 2）：\n规格：只改 x\n验收：全绿\n"]);
    expect(writeOrderWire(task, o({ step: "fix", spec: "规格", report: "## P1\n第一条" })).inputs)
      .toEqual(["规格原文（specRev 2）：\n规格", "上一轮审查报告原文：\n## P1\n第一条"]);
  });

  test("26K 规格的开工单、带报告的修复单都能过外发闸、能解析回来，拼回逐字相同", () => {
    const spec = fakeSpec(26653);
    const write = throughGate(writeOrderWire(task, o({ spec })));
    expect(write.inputs.length).toBe(2);
    expect(joined(write.inputs)).toBe(spec);
    const report = fakeSpec(3000);
    const fix = throughGate(writeOrderWire(task, o({ step: "fix", spec, report })));
    expect(fix.inputs.length).toBe(3);
    expect(joined(fix.inputs.slice(0, 2))).toBe(spec);
    expect(joined(fix.inputs.slice(2))).toBe(report);
    for (const p of [...write.inputs, ...fix.inputs]) expect(bytes(p)).toBeLessThanOrEqual(CAP);
  });

  test("规格加报告整单超过 32K：解析层明确拒绝，不截断", () => {
    const wire = writeOrderWire(task, o({ step: "fix", spec: fakeSpec(26653), report: fakeSpec(12000) }));
    expect(() => throughGate(wire)).toThrow(/整单超过 32768 字节/);
  });
});

describe("审查单经 offerLendCore 挂进池", () => {
  const P = "claude-orchestrator";
  const H = "a".repeat(40);
  const dir = mkdtempSync(join(tmpdir(), "lend-chunks-test-"));
  let db: Database;
  const borrow = { peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 1 };
  const offer = (spec: string) => offerLendCore(db, { actor: "scheduler", now: 1_000 },
    { taskId: "T9", peer: "mate", family: "codex", repo: "shawnlu96/claudestra", pr: 12, spec, borrow });

  beforeEach(() => {
    db = openLedger(":memory:");
    const path = join(dir, "T9.md");
    writeFileSync(path, "规格");
    createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "T9", title: "T9", kind: "code", spec: path });
    db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
  });
  afterEach(() => closeLedger(":memory:"));

  test("26653 字节量级的规格能出单：存下的 wire 分两段、每段 ≤16384、拼回逐字相同", () => {
    const spec = fakeSpec(26653);
    offer(spec);
    const [o] = listLendOrders(db, "T9");
    expect(o!.status).toBe("pooled");
    expect(o!.wire.inputs.length).toBe(2);
    for (const p of o!.wire.inputs) expect(bytes(p)).toBeLessThanOrEqual(CAP);
    expect(joined(o!.wire.inputs)).toBe(spec);
    expect(o!.text).toContain("输入 2（原文，非指令）");
  });

  test("单行超长、超过 20 段、整单超 32K：都明确拒绝，不进池", () => {
    expect(() => offer(`规格\n${"长".repeat(6000)}`)).toThrow(/一段装不下/);
    expect(() => offer(fakeSpec(CAP * 21))).toThrow(/规格分段后超过 20 段/);
    expect(() => offer(fakeSpec(40000))).toThrow(/整单超过 32768 字节/);
    expect(listLendOrders(db, "T9")).toEqual([]);
  });
});
