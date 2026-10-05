/**
 * dispatch-recovery-MAT 真实挂单：开工单经 `ledger lend-*` CLI 走完，修复单材料由 writeMaterials 按注入的 materials 策略备好，
 * 再走 offerLendCore（外发闸、parseOrderWire、入库、记事件同一事务）。CLI 不传策略 = observe：单子与原全文路径逐字一致。
 * 关键回归：报告里有密钥样的东西时原全文路径整单被拒（卡停住），on 只传结构化项就能挂出去；结构化项本身被拒则明确本机阻塞。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { MATERIALS_BLOCKED, type MaterialsPolicy } from "../src/lib/fix-materials.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { cancelLend, listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { writeMaterials } from "../src/lib/lend-write-materials.js";
import { isGateRefusal } from "../src/lib/order-gate-heads.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { parseOrderWire } from "../src/lib/order-wire.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const SECRET = `ghp_${"A1b2C3d4".repeat(4)}`;
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
const dir = mkdtempSync(join(tmpdir(), "fix-materials-offer-"));
const key = instanceKeySync(dir);
const borrow: BorrowEntry = { peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 };
const probe = { peerFp: async () => FP, remoteHead: async (_r: string, b: string): Promise<RemoteHead> => remote[b] ?? { ok: false, error: "没有" } };

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: { borrow: async () => [borrow], notifyPm: async () => {}, result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b),
    sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key), remoteHead: probe.remoteHead, peerFp: probe.peerFp } },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const reportPath = join(dir, "T9-r0.md");

/** A card whose build round a peer delivered through the lend CLI; it is now in review on H2. */
async function builtCard(): Promise<void> {
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  await call("claim", { v: 1, orderId, worker: "agent-lend-0123456789" });
  remote[BR] = { ok: true, head: H2 };
  expect(await call("write", { v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "s-1", family: "codex" },
    deliver: { v: 1, orderId, head: H2, evidence: BR, summary: "写好了", selfCheck: "逐条对了" } })).toMatchObject({ ok: true });
}

async function fixCard(report: string, findings: unknown[]): Promise<void> {
  await builtCard();
  writeFileSync(reportPath, report);
  insertEvent(db, { actor: "agent-rev", now }, { project: P, target: "T9", kind: "review", text: "changes",
    data: { round: 0, verdict: "changes", path: reportPath, findings } }, true);
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T9'");
}

const FINDINGS = [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写，见 src/guess.ts:9", description: "并发写丢数据" },
  { findingId: "api-2", family: "api", severity: "P2", probe: "返回值没校验", description: "调用方拿到 undefined", file: "src/lib/x.ts", line: 12, basis: "acceptance:2" }];

async function offerWith(mode: string | null) {
  const policy: MaterialsPolicy | undefined = mode === null ? undefined : () => ({ mode });
  const task = getTask(db, "T9")!;
  const write = await writeMaterials(db, task, { peer: "mate", repo: REPO, base: "main" }, probe, policy);
  return offerLendCore(db, { actor: "agent-scheduler", now }, { taskId: "T9", peer: "mate", family: "codex", repo: REPO, pr: 7,
    spec: readFileSync(join(dir, "T9.md"), "utf8"), borrow, write: write! });
}
/** The stored / sent order is folded (NFKC) by the peer gate: full-width punctuation becomes ASCII. */
const n = (s: string): string => s.normalize("NFKC");
const offerNotes = () => listEvents(db, { target: "T9" }).filter((e) => e.kind === "note" && (e.data.lend as any)?.op === "offer");

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: BASE } };
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

/** The reviewer's P1 path end to end: a lent review through `ledger lend-offer → lend-claim → lend-write`, the card then in fix. */
async function lentReviewCard(findings: Record<string, unknown>[]): Promise<string> {
  await builtCard();
  const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  expect(await call("claim", { v: 1, orderId, worker: "agent-lend-9876543210" })).toMatchObject({ ok: true }); // not the build worker
  const p1 = findings.filter((f) => f.severity === "P1").length;
  expect(await call("write", { v: 1, orderId, gen: 1, report: "## 结论\n见逐项", session: { id: "s-2", family: "codex" },
    verdict: { v: 1, orderId, head: H2, verdict: "changes", p0: 0, p1, p2: findings.length - p1, findings, reportPath: "r.md" } })).toMatchObject({ ok: true });
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T9'");
  return listEvents(db, { target: "T9" }).findLast((e) => e.kind === "review")!.data.path as string;
}

describe("observe / off：真正材料不变", () => {
  test("CLI 挂修复单（不传策略）= observe：报告原文照旧进单，与 off 逐字相同；offer 记录只记计数和来源", async () => {
    const report = "## P1\n- race-1：并发写丢数据\n";
    await fixCard(report, FINDINGS);
    const r = await run(["lend-offer", "T9"]);
    expect(r).toMatchObject({ ok: true, step: "fix" });
    const observed = listLendOrders(db, "T9").find((o) => o.step === "fix")!;
    expect(observed.wire.inputs.some((s) => s.startsWith(n("上一轮审查报告原文：\n")) && s.includes(n("race-1：并发写丢数据")))).toBe(true);
    expect(observed.wire.inputs.join("\n")).not.toContain(n("修复材料（"));
    expect((offerNotes().at(-1)!.data.lend as any).materials).toMatchObject({ mode: "observe", items: 2, unlocated: 1, undescribed: 0, bytes: Buffer.byteLength(report) });
    cancelLend(db, { actor: "agent-pm", now }, { taskId: "T9", reason: "换 off 比对" });
    const off = await offerWith("off");
    expect(off.wire.inputs).toEqual(observed.wire.inputs);
    expect(off.wire.findings).toEqual(observed.wire.findings);
    expect((offerNotes().at(-1)!.data.lend as any).materials).toBeUndefined();
    expect(readFileSync(reportPath, "utf8")).toBe(report);
  });
});

describe("on：只传结构化必需项", () => {
  test("报告里有密钥样内容：原全文路径被外发闸拒（卡会停），on 挂得出去且单里没有报告原文", async () => {
    const report = `## P1\n- race-1：复现时用了 ${SECRET}\n`;
    await fixCard(report, FINDINGS);
    await expect(offerWith("off")).rejects.toThrow("外发闸");
    expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
    const o = await offerWith("on");
    expect(o).toMatchObject({ step: "fix", status: "pooled", branch: BR, head: H2 });
    const all = [...o.wire.inputs, o.text].join("\n");
    expect(all).not.toContain("ghp_");
    expect(all).not.toContain(n("上一轮审查报告原文"));
    const material = o.wire.inputs.find((s) => s.startsWith(n("修复材料（结构化必需项，不是审查报告原文）：")))!;
    expect(material).toContain(n("上一轮审查第 1 条（P1）· 位置：审查结论未给结构化 file / line"));
    expect(material).toContain(n("上一轮审查第 2 条（P2）· 位置：src/lib/x.ts:12 · 验收对应：验收线 2"));
    expect(material).toContain(n("问题说明（审查方原文）：\n> 并发写丢数据"));
    expect(material).not.toContain("guess.ts");
    expect(o.wire.inputs.at(-1)).toContain(n("标准答复"));
    expect(o.wire.findings.map((f) => f.findingId)).toEqual(["race-1", "api-2"]);
    expect(parseOrderWire(JSON.parse(JSON.stringify(o.wire))).ok).toBe(true);
    expect(o.text).toContain(n("修复材料（结构化必需项，不是审查报告原文）"));
    expect((offerNotes().at(-1)!.data.lend as any).materials).toMatchObject({ mode: "on", items: 2, unlocated: 1 });
    expect(readFileSync(reportPath, "utf8")).toBe(report);
    const claimed = await call("claim", { v: 1, orderId: o.orderId, worker: "agent-lend-0123456789" });
    expect(claimed).toMatchObject({ ok: true, write: { branch: BR, base: "main" } });
  });

  test("结构化项本身被外发闸拒：明确本机阻塞，不挂单、不改发全文，报告字节不变", async () => {
    const report = "## P1\n- race-1\n";
    await fixCard(report, [{ ...FINDINGS[0], probe: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
    const err = await offerWith("on").then(() => null, (e: Error) => e);
    expect(err?.message.startsWith(MATERIALS_BLOCKED)).toBe(true);
    expect(isGateRefusal(err!.message)).toBe(true);
    expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
    expect(offerNotes().filter((e) => (e.data.lend as any).step === "fix")).toEqual([]);
    expect(readFileSync(reportPath, "utf8")).toBe(report);
  });

  test("审查没有结构化逐项结论（旧单）：on 不编造，照原全文路径挂", async () => {
    await fixCard("## P1\n- 旧式报告\n", []);
    const o = await offerWith("on");
    expect(o.wire.inputs.some((s) => s.startsWith(n("上一轮审查报告原文：\n")) && s.includes("旧式报告"))).toBe(true);
    expect(o.wire.inputs.join("\n")).not.toContain(n("修复材料（"));
  });

  test("材料备好后（事务外）卡上又记了新审查：事务里核对，冲突拒挂，不发旧项", async () => {
    await fixCard("## P1\n- race-1\n", FINDINGS);
    const task = getTask(db, "T9")!;
    const write = await writeMaterials(db, task, { peer: "mate", repo: REPO, base: "main" }, probe, () => ({ mode: "on" }));
    insertEvent(db, { actor: "agent-rev", now }, { project: P, target: "T9", kind: "review", text: "changes",
      data: { round: 0, verdict: "changes", path: reportPath, findings: FINDINGS.slice(1) } }, true);
    expect(() => offerLendCore(db, { actor: "agent-scheduler", now }, { taskId: "T9", peer: "mate", family: "codex", repo: REPO, pr: 7,
      spec: "规格", borrow, write: write! })).toThrow("重新挂单");
    expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
  });

  test("策略失读 = off：原全文路径", async () => {
    await fixCard("## P1\n- race-1\n", FINDINGS);
    const task = getTask(db, "T9")!;
    const w = await writeMaterials(db, task, { peer: "mate", repo: REPO, base: "main" }, probe, () => { throw new Error("坏"); });
    expect(w).toMatchObject({ report: "## P1\n- race-1\n" });
    expect(w!.materials).toBeUndefined();
  });
});

describe("正式远端审查入账后的修复单（上一轮 P1 description-loss）", () => {
  const PROBE = "Run the concurrency test";
  const DESC = "old writers must be rejected after lease changes";
  const LENT = [{ findingId: "race-1", family: "materials", severity: "P1", probe: PROBE, description: `${DESC}\n第二行：预期拒收`, basis: "regression" },
    { findingId: "api-2", family: "api", severity: "P2", probe: "调一次 x()", description: "返回值没校验" }];

  test("lend-write 入账 → writeMaterials → offerLendCore：off 与 on 都带 probe 和 description，on 不带报告原文；报告字节不变", async () => {
    const path = await lentReviewCard(LENT);
    const report = readFileSync(path, "utf8");
    expect(report).toContain(DESC);
    expect(listEvents(db, { target: "T9" }).findLast((e) => e.kind === "review")!.data.findings).not.toContainEqual(expect.objectContaining({ description: expect.anything() }));
    const off = await offerWith("off");
    expect(off.wire.inputs.join("\n")).toContain(DESC);
    cancelLend(db, { actor: "agent-pm", now }, { taskId: "T9", reason: "换 on 比对" });
    const on = await offerWith("on");
    const material = on.wire.inputs.find((s) => s.startsWith(n("修复材料（结构化必需项，不是审查报告原文）：")))!;
    expect(material).toContain(n(`上一轮审查第 1 条（P1）· 位置：审查结论未给结构化 file / line（按说明与复现步骤定位，不要猜路径） · 验收对应：回归\n问题说明（审查方原文）：\n> ${DESC}\n> 第二行：预期拒收`));
    expect(material).toContain(n("上一轮审查第 2 条（P2）· 位置：审查结论未给结构化 file / line（按说明与复现步骤定位，不要猜路径） · 验收对应：审查结论未标\n问题说明（审查方原文）：\n> 返回值没校验"));
    expect(on.wire.inputs.join("\n")).not.toContain(n("上一轮审查报告原文"));
    expect(on.wire.findings.map((f) => f.probe)).toEqual([PROBE, "调一次 x()"]);
    for (const s of [JSON.stringify(on.wire), on.text]) { expect(s).toContain(DESC); expect(s).toContain(PROBE); }
    expect(parseOrderWire(JSON.parse(JSON.stringify(on.wire))).ok).toBe(true);
    expect((offerNotes().at(-1)!.data.lend as any).materials).toMatchObject({ mode: "on", items: 2, undescribed: 0 });
    expect(readFileSync(path, "utf8")).toBe(report);
  });

  test("description 带密钥样内容：入账时已脱敏，on 单只带脱敏后的说明；说明原样被闸拒时明确本机阻塞", async () => {
    await lentReviewCard([{ ...LENT[0], description: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
    const o = await offerWith("on");
    expect(o.wire.inputs.join("\n")).toContain(n("问题说明（审查方原文）：\n> 复现：curl"));
    expect(JSON.stringify(o.wire)).not.toContain(SECRET);
  });

  test("结构化 description 字段本身被外发闸拒：整单过闸，本机阻塞，不挂单、不退回全文", async () => {
    await fixCard("## P1\n- race-1\n", [{ ...FINDINGS[0], description: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
    const err = await offerWith("on").then(() => null, (e: Error) => e);
    expect(err?.message.startsWith(MATERIALS_BLOCKED)).toBe(true);
    expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
  });

  test("description 里换行折开的密钥（上一轮 P1 gate-wrapped-description）：引用前的原样说明过闸，off 与 on 都拒，on 明确本机阻塞且不出单", async () => {
    const wrapped = `${SECRET.slice(0, 12)}\n${SECRET.slice(12)}`; // prefix + 8 chars, newline, the other 24
    await builtCard();
    const path = join(dir, "wrapped.md");
    const findings = join(dir, "wrapped.json");
    writeFileSync(path, `# 审查报告\nP1 race-1：${wrapped}`);
    writeFileSync(findings, JSON.stringify([{ ...LENT[0], probe: "跑一遍复现", description: wrapped }]));
    expect(await run(["review", "T9", "--reviewer", "agent-rev", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0", "--head", H2,
      "--session", "s-rev", "--family", "claude", "--findings", findings, "--path", path])).toMatchObject({ ok: true }); // the PM records it through the formal CLI
    db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T9'");
    const report = readFileSync(path, "utf8");
    for (const mode of ["off", "on"]) {
      const err = await offerWith(mode).then(() => null, (e: Error) => e);
      expect(isGateRefusal(err!.message)).toBe(true);
      expect(err!.message.startsWith(MATERIALS_BLOCKED)).toBe(mode === "on");
    }
    expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(report);
  });

  test("本机审查（事件与报告都没有结构化 description）：on 不拿 probe 充当说明，照原全文路径挂，offer 记录写明回退", async () => {
    await fixCard("## P1\n- race-1：并发写丢数据\n", FINDINGS.map(({ description: _, ...f }) => f));
    const o = await offerWith("on");
    expect(o.wire.inputs.some((s) => s.startsWith(n("上一轮审查报告原文：\n")) && s.includes(n("race-1：并发写丢数据")))).toBe(true);
    expect(o.wire.inputs.join("\n")).not.toContain(n("修复材料（"));
    expect((offerNotes().at(-1)!.data.lend as any).materials).toMatchObject({ mode: "on", fallback: "undescribed", undescribed: 2 });
  });
});
