/**
 * RVHEX1 第 2 条锁：短哈希只约束审查员怎么写，闸不放宽。审查员仍在 description 里贴完整 64 位摘要时，
 * 修复材料（on，结构化项含审查方原文说明）照旧被外发闸整单拒收、本机阻塞；报告和结论不被改写。
 * 挂单夹具照 tests/fix-materials-offer.test.ts（真实 lend CLI + writeMaterials + offerLendCore）。
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
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
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
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
const dir = mkdtempSync(join(tmpdir(), "review-hash-line-materials-"));
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

async function offerWith(mode: string | null) {
  const policy: MaterialsPolicy | undefined = mode === null ? undefined : () => ({ mode });
  const task = getTask(db, "T9")!;
  const write = await writeMaterials(db, task, { peer: "mate", repo: REPO, base: "main" }, probe, policy);
  return offerLendCore(db, { actor: "agent-scheduler", now }, { taskId: "T9", peer: "mate", family: "codex", repo: REPO, pr: 7,
    spec: readFileSync(join(dir, "T9.md"), "utf8"), borrow, write: write! });
}
beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: BASE } };
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

const DIGEST = "5d41402abc4b2a76b9719d911017c592ae0b6c1f4e6d3a0b2c7e8f9a1b2c3d4e"; // 64 位 sha256 摘要样（LIFE4 事件 52935 的形状）
/**
 * 独立的小写整串已由 GATE3（order-gate-heads.ts）截成 12 位，那条规则不改；这里用它不截的两种写法（贴在路径里、大写），
 * 正是审查员照抄实测输出时会写出来的样子。
 */
const UNCUT = [`实测输出见 /tmp/notice/${DIGEST}.log，和期望不一致`, `实测输出摘要 ${DIGEST.toUpperCase()}，和期望不一致`];
const SESSION = "Q7mB2pL9rX4cN6vT8sJ1kH5wZ3yD0fG2"; // Synthetic mixed-case evidence id; never a production session.
const PRIVATE_TEXT = [`证据位置 /tmp/evidence/${SESSION}/probe.log`, `当前审查会话 ${SESSION}`];
const LONG = [{ findingId: "notice-history", family: "history", severity: "P1", probe: "跑 bun test tests/x.test.ts", basis: "acceptance:1",
  description: UNCUT[0] }];

describe("RVHEX1 反例：description 带完整 64 位十六进制", () => {
  for (const description of UNCUT) test(`修复材料照旧被外发闸拒收、本机阻塞，报告与结论原文不改：${description.slice(0, 12)}`, async () => {
    const report = "## P1\n- notice-history\n";
    await fixCard(report, [{ ...LONG[0], description }]);
    const err = await offerWith("on").then(() => null, (e: Error) => e);
    expect(err?.message.startsWith(MATERIALS_BLOCKED)).toBe(true);
    expect(err?.message).toContain("长十六进制");
    expect(isGateRefusal(err!.message)).toBe(true);
    expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
    expect(readFileSync(reportPath, "utf8")).toBe(report);
    const stored = listEvents(db, { target: "T9" }).findLast((e) => e.kind === "review")!.data.findings as typeof LONG;
    expect(stored[0].description).toBe(description);
  });

  test("同一条只写前 16 位：修复材料挂得出去", async () => {
    await fixCard("## P1\n- notice-history\n", [{ ...LONG[0], description: `实测输出见 /tmp/notice/${DIGEST.slice(0, 16)}.log，和期望不一致` }]);
    const o = await offerWith("on");
    expect(o).toMatchObject({ step: "fix", status: "pooled" });
    expect(o.wire.inputs.join("\n")).toContain(DIGEST.slice(0, 16));
  });
});

describe("RVPATH1 本机证据路径与会话展示边界", () => {
  for (const field of ["probe", "description"] as const) for (const text of PRIVATE_TEXT) {
    test(`原 ${field} 携完整证据标识仍拒收，原报告/结论不改：${text.slice(0, 12)}`, async () => {
      const report = `## P1\n${text}\n`;
      const original = [{ ...LONG[0], description: "[验收线 1] 复现失败", [field]: text }];
      await fixCard(report, original);
      const err = await offerWith("on").then(() => null, (e: Error) => e);
      expect(err?.message.startsWith(MATERIALS_BLOCKED)).toBe(true);
      expect(err?.message).toContain("随机串");
      expect(isGateRefusal(err!.message)).toBe(true);
      expect(listLendOrders(db, "T9").filter((o) => o.step === "fix")).toEqual([]);
      expect(readFileSync(reportPath, "utf8")).toBe(report);
      expect(listEvents(db, { target: "T9" }).findLast((e) => e.kind === "review")!.data.findings).toEqual(original);
    });
  }

  test("安全正文原样进入真实修复材料和渲染，完整值仍留本机工件", async () => {
    const text = `证据见 <scratchpad>/probe.log;当前审查会话 ${SESSION.slice(0, 8)}`;
    const report = `## P1\n${text}\n`;
    const original = [{ ...LONG[0], probe: text, description: text }];
    const artifact = join(dir, "probe.log");
    writeFileSync(artifact, PRIVATE_TEXT.join("\n"));
    await fixCard(report, original);
    const o = await offerWith("on");
    expect(o).toMatchObject({ step: "fix", status: "pooled", head: H2 });
    expect(o.text).toContain(text);
    expect(o.wire.inputs.join("\n")).toContain(text);
    expect(parseOrderWire(JSON.parse(JSON.stringify(o.wire))).ok).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe(report);
    expect(readFileSync(artifact, "utf8")).toBe(PRIVATE_TEXT.join("\n"));
    expect(listEvents(db, { target: "T9" }).findLast((e) => e.kind === "review")!.data.findings).toEqual(original);
  });
});
