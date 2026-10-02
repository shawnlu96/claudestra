/**
 * PM 定 wire-ownership：deliver.memoryRefs 与 finding.pitfall 的严格 wire 解析（order-wire.ts 接线、逻辑在 memory-tools-wire.ts），
 * 以及新旧 peer 互通：旧版发来缺字段照收；发给不认这两个字段的旧版前去掉，旧版的严格解析照收。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { commitLendResult } from "../src/lib/lend-submit.js";
import { routeLendTool } from "../src/lib/lend-tools.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { withoutMemoryFields } from "../src/lib/memory-tools-wire.js";
import { parseDeliverWire, parseVerdictWire } from "../src/lib/order-wire.js";

const H = "a".repeat(40);
const DELIVER = { v: 1, orderId: "T1:write:r0", head: H, evidence: "evidence.md", summary: "一行", selfCheck: "逐条" };
const FINDING = { findingId: "F1", family: "tx", severity: "P1", probe: "复现", description: "说明" };
const VERDICT = { v: 1, orderId: "T1:review:r1", head: H, verdict: "changes", p0: 0, p1: 1, p2: 0, findings: [FINDING], reportPath: "r.md" };

/** 旧版（没有记忆字段的）对端的严格解析：多一个不认识的键就整单拒——用真解析器摘掉记忆字段后再比 */
const oldPeerAccepts = (raw: Record<string, unknown>, kind: "deliver" | "verdict") => {
  if ("memoryRefs" in raw) return false;
  if (kind === "verdict" && (raw.findings as Record<string, unknown>[]).some((f) => "pitfall" in f)) return false;
  return (kind === "deliver" ? parseDeliverWire(raw) : parseVerdictWire(raw)).ok;
};

describe("deliver.memoryRefs", () => {
  test("可选：缺字段照收（旧对端），解析结果里也没有这个键", () => {
    const r = parseDeliverWire(DELIVER);
    expect(r.ok && !("memoryRefs" in r.value)).toBe(true);
  });
  test("给了就严格收：applied / irrelevant / wrong，wrong 要 note", () => {
    const refs = [{ id: "ab12-m6", use: "applied" }, { id: "ab12-d9", use: "irrelevant" }, { id: "ab12-m2", use: "wrong", note: "规矩已过时" }];
    expect(parseDeliverWire({ ...DELIVER, memoryRefs: refs })).toMatchObject({ ok: true, value: { memoryRefs: refs } });
  });
  for (const [why, refs] of [
    ["wrong 不带 note", [{ id: "ab12-m2", use: "wrong" }]],
    ["use 不认识", [{ id: "ab12-m2", use: "maybe" }]],
    ["多给字段", [{ id: "ab12-m2", use: "applied", actor: "pm" }]],
    ["id 格式不对", [{ id: "m2", use: "applied" }]],
    ["id 重复", [{ id: "ab12-m2", use: "applied" }, { id: "ab12-m2", use: "irrelevant" }]],
    ["note 超长", [{ id: "ab12-m2", use: "wrong", note: "x".repeat(301) }]],
    ["note 多行", [{ id: "ab12-m2", use: "wrong", note: "a\nb" }]],
    ["不是数组", { id: "ab12-m2" }],
    ["超过 20 项", Array.from({ length: 21 }, (_, i) => ({ id: `ab12-m${i + 1}`, use: "applied" }))],
  ] as const) {
    test(`拒：${why}`, () => {
      const r = parseDeliverWire({ ...DELIVER, memoryRefs: refs });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("memoryRefs");
    });
  }
});

describe("findings[].pitfall", () => {
  test("可选：缺字段照收，输出不带 pitfall", () => {
    const r = parseVerdictWire(VERDICT);
    expect(r.ok && !("pitfall" in r.value.findings[0]!)).toBe(true);
  });
  test("P1 标 true 保留；false 与缺省同义、不保留", () => {
    expect(parseVerdictWire({ ...VERDICT, findings: [{ ...FINDING, pitfall: true }] })).toMatchObject({ ok: true, value: { findings: [{ findingId: "F1", pitfall: true }] } });
    const r = parseVerdictWire({ ...VERDICT, findings: [{ ...FINDING, pitfall: false }] });
    expect(r.ok && !("pitfall" in r.value.findings[0]!)).toBe(true);
  });
  test("拒：非布尔、非 P1 标 true", () => {
    expect(parseVerdictWire({ ...VERDICT, findings: [{ ...FINDING, pitfall: "yes" }] }).ok).toBe(false);
    expect(parseVerdictWire({ ...VERDICT, p1: 0, p2: 1, findings: [{ ...FINDING, severity: "P2", pitfall: true }] }).ok).toBe(false);
  });
});

describe("新旧 peer 互通", () => {
  const SESSION = { id: "s1", family: "claude" };
  test("旧 → 新：lend result 里不带记忆字段的交付 / 结论，新版 A 照收", () => {
    expect(parseLendRequest("result", { v: 1, orderId: DELIVER.orderId, gen: 1, deliver: DELIVER, branch: "lend/x-b1a2", pr: null, session: SESSION }).ok).toBe(true);
    expect(parseLendRequest("result", { v: 1, orderId: VERDICT.orderId, gen: 1, verdict: VERDICT, report: "r", session: SESSION }).ok).toBe(true);
  });
  test("新 → 新：带 memoryRefs / pitfall 的 lend result 照收且保留", () => {
    const d = parseLendRequest("result", { v: 1, orderId: DELIVER.orderId, gen: 1, deliver: { ...DELIVER, memoryRefs: [{ id: "ab12-m1", use: "applied" }] },
      branch: "lend/x-b1a2", pr: null, session: SESSION });
    expect(d).toMatchObject({ ok: true, value: { deliver: { memoryRefs: [{ id: "ab12-m1" }] } } });
    const v = parseLendRequest("result", { v: 1, orderId: VERDICT.orderId, gen: 1, verdict: { ...VERDICT, findings: [{ ...FINDING, pitfall: true }] }, report: "r", session: SESSION });
    expect(v).toMatchObject({ ok: true, value: { verdict: { findings: [{ pitfall: true }] } } });
  });
  test("新 → 旧：对端不认记忆字段时发送方省略，旧版严格解析照收；对端认就原样、不改入参", () => {
    const d = { ...DELIVER, memoryRefs: [{ id: "ab12-m1", use: "applied" }] };
    const v = { ...VERDICT, findings: [{ ...FINDING, pitfall: true }] };
    expect(oldPeerAccepts(d, "deliver")).toBe(false);
    expect(oldPeerAccepts(withoutMemoryFields(d, false), "deliver")).toBe(true);
    expect(oldPeerAccepts(withoutMemoryFields(v, false) as never, "verdict")).toBe(true);
    expect(withoutMemoryFields(d, true)).toBe(d);
    expect(d.memoryRefs.length).toBe(1);
    expect(v.findings[0]!.pitfall).toBe(true);
  });
});

describe("新 → 旧：出借结论的真实发送链（peer-memory-wire）", () => {
  const AGENT = "agent-lend-0123456789";
  /** 一张 started 的出借审查单（同 tests/lend-tools.test.ts 的 addStarted 精简版） */
  const started = () => {
    const db = openLendJournal(":memory:"), dir = mkdtempSync(join(tmpdir(), "pmem-wire-"));
    writeFileSync(join(dir, "r.md"), "# 报告");
    recordAsked(db, { orderId: VERDICT.orderId, peer: "team-a", fp: null, family: "codex", preview: {} }, 0);
    advance(db, VERDICT.orderId, "asked", "claimed", { wire: { order: { v: 1, orderId: VERDICT.orderId, taskId: "T1", step: "review", head: H }, text: "x" }, leaseGen: 7 });
    advance(db, VERDICT.orderId, "claimed", "cloned", { dir });
    advance(db, VERDICT.orderId, "cloned", "started", { agent: AGENT, sessionId: "thr-1" });
    return db;
  };
  const pitV = { ...VERDICT, findings: [{ ...FINDING, pitfall: true }] };

  test("submit_verdict 工具：带 pitfall:true 的结论照收，转给 A 的请求体里没有 pitfall，旧版严格解析照收", async () => {
    const db = started(), sent: Record<string, unknown>[] = [];
    const call = async (_peer: string, _op: string, body: Record<string, unknown>) => (sent.push(body), { status: 503, body: { ok: false } });
    const r = await routeLendTool("submit_verdict", { agent: AGENT, sessionId: "thr-1", family: "codex", verified: true } as never, pitV,
      { db, call: call as never, log: () => {}, now: () => 5_000 });
    expect(r.ok).toBe(true);
    expect(sent.length).toBe(1);
    const verdict = sent[0]!.verdict as Record<string, unknown>;
    expect(JSON.stringify(sent[0])).not.toContain("pitfall");
    expect(oldPeerAccepts(verdict, "verdict")).toBe(true);
    expect(parseLendRequest("result", { v: 1, ...sent[0] }).ok).toBe(true);
  });

  test("lend submit（commitLendResult）：落 journal 的 payload（调度服务原样重发的那份）也已去掉 pitfall", () => {
    const db = started();
    expect(commitLendResult(db, getOrder(db, VERDICT.orderId)!, { verdict: "changes", findings: pitV.findings, report: "# 报告" }, 5_000).ok).toBe(true);
    const payload = getOrder(db, VERDICT.orderId)!.payload as { verdict: Record<string, unknown> };
    expect(JSON.stringify(payload)).not.toContain("pitfall");
    expect(oldPeerAccepts(payload.verdict, "verdict")).toBe(true);
  });
});
