/**
 * dispatch-recovery-MATW：PM 的 `ledger lend-offer` 生产入口经 recovery-materials-wiring 拿 CFG recoveryPolicy(project, "materials")。
 * reader 是真动态加载的模块文件（测试只换模块位置：tmp 里的替身 CFG，按 globalThis 钩子答策略）；默认位置在 main 上不存在 = 未安装。
 * 对方实际收到的单子取自 lend-claim 的应答（bridge 原样转给对方的 body）。
 */
import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { MATERIALS_BLOCKED } from "../src/lib/fix-materials.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { cfgReaderPath, materialsPolicyPort } from "../src/lib/recovery-materials-wiring.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", Q = "other-project";
const BASE = "b".repeat(40), H2 = "c".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const SECRET = `ghp_${"A1b2C3d4".repeat(4)}`;
const dir = mkdtempSync(join(tmpdir(), "matw-"));
const key = instanceKeySync(dir);

type Hook = (project: string, mechanism: string) => unknown;
const g = globalThis as { __matwPolicy?: Hook; __matwCalls?: string[] };
/** 替身 CFG：与正式 reader 同一导出名；每次读都现问钩子（不缓存） */
const FAKE_CFG = join(dir, "recovery-policy.ts");
writeFileSync(FAKE_CFG, `export function recoveryPolicy(project, mechanism) {
  (globalThis.__matwCalls ??= []).push(project + ":" + mechanism);
  return globalThis.__matwPolicy(project, mechanism);
}\n`);
const READER = pathToFileURL(FAKE_CFG);
const MISSING = pathToFileURL(join(dir, "nope", "recovery-policy.ts"));
const modes = (m: Record<string, unknown>): Hook => (project) => ({ mode: m[project] ?? "off", manualAfterMs: null });

let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
let reader: URL | undefined;
const borrow: BorrowEntry = { peer: "mate", projects: [P, Q], roles: ["review", "write"], maxOpen: 4 };
const deps = (actor: string) => ({
  db, actor, projectIds: [P, Q], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: { borrow: async () => [borrow], notifyPm: async () => {}, ...(reader ? { recoveryReader: reader } : {}),
    result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_r: string, b: string): Promise<RemoteHead> => remote[b] ?? { ok: false, error: "没有" }, peerFp: async () => FP } },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const n = (s: string): string => s.normalize("NFKC");
const LABEL = n("修复材料（结构化必需项，不是审查报告原文）：");
const FULL = n("上一轮审查报告原文：\n");

const FINDINGS = [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写", description: "并发写丢数据" },
  { findingId: "api-2", family: "api", severity: "P2", probe: "返回值没校验", description: "调用方拿到 undefined", file: "src/lib/x.ts", line: 12 }];

/** A card in `project` whose build mate delivered through the lend CLI, then one review with `findings` at `report`: in fix. */
async function fixCard(id: string, project: string, report: string, findings: unknown[]): Promise<string> {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = ?", [id]);
  const { orderId, branch } = await run(["lend-offer", id, "--peer", "mate", "--repo", REPO]);
  await call("claim", { v: 1, orderId, worker: "agent-lend-0123456789" });
  remote[branch] = { ok: true, head: H2 };
  expect(await call("write", { v: 1, orderId, gen: 1, branch, pr: 7, session: { id: "s-1", family: "codex" },
    deliver: { v: 1, orderId, head: H2, evidence: branch, summary: "写好了", selfCheck: "逐条对了" } })).toMatchObject({ ok: true });
  const path = join(dir, `${id}-r0.md`);
  writeFileSync(path, report);
  insertEvent(db, { actor: "agent-rev", now }, { project, target: id, kind: "review", text: "changes",
    data: { round: 0, verdict: "changes", path, findings } }, true);
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = ?", [id]);
  return path;
}

/** What the peer receives: the claim answer's order body (the bridge passes it through). */
async function sent(id: string): Promise<{ wire: { inputs: string[]; findings: { findingId: string; probe: string }[] }; text: string }> {
  const o = listLendOrders(db, id).findLast((x) => x.step === "fix")!;
  const r = await call("claim", { v: 1, orderId: o.orderId, worker: "agent-lend-9999999999" });
  expect(r).toMatchObject({ ok: true });
  return { wire: r.order, text: r.text };
}
const materialsOf = (id: string) => listEvents(db, { target: id }).filter((e) => e.kind === "note" && (e.data.lend as any)?.op === "offer" &&
  (e.data.lend as any).step === "fix").map((e) => (e.data.lend as any).materials);

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: BASE } };
  reader = READER;
  g.__matwPolicy = modes({ [P]: "on" });
  g.__matwCalls = [];
  for (const p of [P, Q]) setMeta(db, { actor: "owner", now }, { project: p, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("reader 加载（真动态 import）", () => {
  test("CFG（#597）已在 main 上：无参 port 读到正式位置的真模块，给出合法模式；位置不存在的「未安装」由下面 MISSING 各条覆盖", async () => {
    expect(cfgReaderPath()).toBe(join(import.meta.dir, "..", "src", "lib", "recovery-policy.ts"));
    const r = await materialsPolicyPort();
    expect(r).toMatchObject({ reader: "loaded", diag: null });
    expect(["on", "observe", "off"]).toContain(r.policy!(P, "materials").mode);
  });

  test("装好：每次调用现读；非法值 / 抛错 / 缺导出 / 加载失败 都让 port 抛（fix-materials 据此按 off）", async () => {
    const r = await materialsPolicyPort(READER);
    expect(r).toMatchObject({ reader: "loaded", diag: null });
    expect(r.policy!(P, "materials")).toEqual({ mode: "on" });
    g.__matwPolicy = modes({ [P]: "observe" });
    expect(r.policy!(P, "materials")).toEqual({ mode: "observe" });
    expect(g.__matwCalls).toEqual([`${P}:materials`, `${P}:materials`]);
    g.__matwPolicy = () => ({ mode: "ON" });
    expect(() => r.policy!(P, "materials")).toThrow("不合法");
    g.__matwPolicy = () => null;
    expect(() => r.policy!(P, "materials")).toThrow("不合法");
    g.__matwPolicy = () => { throw new Error("配置坏了"); };
    expect(() => r.policy!(P, "materials")).toThrow("配置坏了");
    const noExport = join(dir, "no-export.ts"), syntax = join(dir, "syntax.ts");
    writeFileSync(noExport, "export const other = 1;\n");
    writeFileSync(syntax, "export function recoveryPolicy( {\n");
    for (const f of [noExport, syntax]) {
      const b = await materialsPolicyPort(pathToFileURL(f));
      expect(b.reader).toBe("broken");
      expect(b.diag).toContain("off");
      expect(() => b.policy!(P, "materials")).toThrow();
    }
  });
});

describe("打包后的入口（bun build --target=bun）", () => {
  test("入口照两个 manager 的写法以 macro 取 reader 位置：产物仍指源码树的 src/lib，没有模块 = observe，装上后现读出模式", async () => {
    // 源码树副本（wiring + repo-root）；reviewer 复现的错位：产物里 SRC_DIR = <outdir>/..，无参 port 会去找 <root>/lib
    const root = realpathSync(mkdtempSync(join(tmpdir(), "matw-build-"))), lib = join(root, "src", "lib"), out = join(root, "dist");
    mkdirSync(lib, { recursive: true });
    for (const f of ["recovery-materials-wiring.ts", "repo-root.ts"]) copyFileSync(join(import.meta.dir, "../src/lib", f), join(lib, f));
    writeFileSync(join(root, "src", "entry.ts"), `import { materialsPolicyPort } from "./lib/recovery-materials-wiring.js";
import { cfgReaderPath } from "./lib/recovery-materials-wiring.js" with { type: "macro" };
const at = cfgReaderPath(), r = await materialsPolicyPort(at), bare = await materialsPolicyPort();
const bareAt = ${JSON.stringify(join(root, "lib", "recovery-policy.ts"))};
console.log(JSON.stringify({ at, reader: r.reader, mode: r.policy ? r.policy("p", "materials").mode : null, bare: bare.diag?.includes(bareAt) ?? false }));\n`);
    const build = Bun.spawnSync([process.execPath, "build", join(root, "src", "entry.ts"), "--target=bun", "--outdir", out]);
    expect(build.exitCode).toBe(0);
    const runIt = (file: string) => JSON.parse(Bun.spawnSync([process.execPath, file], { stderr: "pipe" }).stdout.toString().trim().split("\n").at(-1)!);
    const formal = join(lib, "recovery-policy.ts");
    expect(runIt(join(out, "entry.js"))).toEqual({ at: formal, reader: "missing", mode: null, bare: true });
    writeFileSync(formal, "export const recoveryPolicy = (p, m) => ({ mode: m === 'materials' ? 'on' : 'off', manualAfterMs: null });\n");
    expect(runIt(join(out, "entry.js"))).toEqual({ at: formal, reader: "loaded", mode: "on", bare: true });
    expect(runIt(join(root, "src", "entry.ts"))).toEqual({ at: formal, reader: "loaded", mode: "on", bare: false });
  });
});

describe("lend-offer 生产入口", () => {
  test("on：对方收到结构化必需项 + 来源证明，原 description 逐字保真；报告全文不发、本机字节不变", async () => {
    const report = `## P1\n- race-1：复现时用了 ${SECRET}\n`;
    const path = await fixCard("T1", P, report, FINDINGS);
    const r = await run(["lend-offer", "T1"]);
    expect(r).toMatchObject({ ok: true, step: "fix" });
    expect(r.materialsDiag).toBeUndefined();
    const { wire, text } = await sent("T1");
    const body = [JSON.stringify(wire), text].join("\n");
    expect(body).not.toContain("ghp_");
    expect(wire.inputs.some((s) => s.startsWith(FULL))).toBe(false);
    const material = wire.inputs.find((s) => s.startsWith(LABEL))!;
    expect(material).toContain(n("问题说明（审查方原文）：\n> 并发写丢数据"));
    expect(material).toContain(n("问题说明（审查方原文）：\n> 调用方拿到 undefined"));
    expect(material).toContain(n("位置：src/lib/x.ts:12"));
    expect(material).toMatch(/报告 sha256 前 12 位 [0-9a-f]{12}/);
    expect(wire.findings.map((f) => f.probe)).toEqual(["两进程同时写", "返回值没校验"]);
    expect(materialsOf("T1")).toEqual([expect.objectContaining({ mode: "on", items: 2, undescribed: 0, bytes: Buffer.byteLength(report) })]);
    expect(readFileSync(path, "utf8")).toBe(report);
    expect(g.__matwCalls).toContain(`${P}:materials`);
  });

  for (const mode of ["observe", "off"] as const) {
    test(`${mode}：对方收到的仍是旧路径全文，与另一种模式逐字相同`, async () => {
      g.__matwPolicy = modes({ [P]: mode });
      await fixCard("T1", P, "## P1\n- race-1：并发写丢数据\n", FINDINGS);
      expect(await run(["lend-offer", "T1"])).toMatchObject({ ok: true, step: "fix" });
      const mine = await sent("T1");
      expect(mine.wire.inputs.some((s) => s.startsWith(FULL) && s.includes(n("race-1：并发写丢数据")))).toBe(true);
      expect(mine.wire.inputs.join("\n")).not.toContain(LABEL);
      // observe records would-send counts; off records nothing
      expect(materialsOf("T1")).toEqual([mode === "observe" ? expect.objectContaining({ mode: "observe", items: 2, undescribed: 0 }) : undefined]);
      // the other mode on a second card of the same shape sends the same inputs
      g.__matwPolicy = modes({ [P]: mode === "observe" ? "off" : "observe" });
      await fixCard("T2", P, "## P1\n- race-1：并发写丢数据\n", FINDINGS);
      expect(await run(["lend-offer", "T2"])).toMatchObject({ ok: true });
      expect((await sent("T2")).wire.inputs.slice(1)).toEqual(mine.wire.inputs.slice(1));
    });
  }

  test("reader 未安装（模块位置不存在）：observe，原全文照发，结果带诊断", async () => {
    reader = MISSING;
    await fixCard("T1", P, "## P1\n- race-1\n", FINDINGS);
    const r = await run(["lend-offer", "T1"]);
    expect(r).toMatchObject({ ok: true, step: "fix" });
    expect(r.materialsDiag).toContain("未安装");
    expect((await sent("T1")).wire.inputs.some((s) => s.startsWith(FULL))).toBe(true);
    expect(materialsOf("T1")).toEqual([expect.objectContaining({ mode: "observe" })]);
    expect(g.__matwCalls).toEqual([]);
  });

  test("策略读坏 / 非法值 = off：旧全文路径，offer 不记材料", async () => {
    for (const [id, hook] of [["T1", () => { throw new Error("坏"); }], ["T2", () => ({ mode: "yes" })]] as const) {
      g.__matwPolicy = hook;
      await fixCard(id, P, "## P1\n- race-1\n", FINDINGS);
      expect(await run(["lend-offer", id])).toMatchObject({ ok: true, step: "fix" });
      expect((await sent(id)).wire.inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(materialsOf(id)).toEqual([undefined]);
    }
  });

  test("缺真正 description（本机记的旧审查）：on 也不拿 probe 顶，原全文 fallback，记录写明 undescribed", async () => {
    await fixCard("T1", P, "## P1\n- race-1：并发写丢数据\n", FINDINGS.map(({ description: _d, ...f }) => f));
    expect(await run(["lend-offer", "T1"])).toMatchObject({ ok: true });
    const { wire } = await sent("T1");
    expect(wire.inputs.some((s) => s.startsWith(FULL))).toBe(true);
    expect(wire.inputs.join("\n")).not.toContain(LABEL);
    expect(materialsOf("T1")).toEqual([expect.objectContaining({ mode: "on", fallback: "undescribed", undescribed: 2 })]);
  });

  test("敏感的必需 description：on 整单过闸被拒，本机阻塞，不出单、不改发全文", async () => {
    const path = await fixCard("T1", P, "## P1\n- race-1\n", [{ ...FINDINGS[0], description: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
    const r = await run(["lend-offer", "T1"]);
    expect(r.ok).toBe(false);
    expect(String(r.error).startsWith(MATERIALS_BLOCKED)).toBe(true);
    expect(listLendOrders(db, "T1").filter((o) => o.step === "fix")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("## P1\n- race-1\n");
  });

  test("读策略时卡上又记了新审查（CAS）：事务里核对拒挂，不发旧项", async () => {
    const path = await fixCard("T1", P, "## P1\n- race-1\n", FINDINGS);
    g.__matwPolicy = (project) => {
      insertEvent(db, { actor: "agent-rev", now }, { project, target: "T1", kind: "review", text: "changes",
        data: { round: 0, verdict: "changes", path: `${path}.new`, findings: FINDINGS.slice(1) } }, true);
      return { mode: "on", manualAfterMs: null };
    };
    const r = await run(["lend-offer", "T1"]);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("重新挂单");
    expect(listLendOrders(db, "T1").filter((o) => o.step === "fix")).toEqual([]);
  });

  test("重复挂单被拒；换一份 reader 副本（重启）后重挂：同一份结构化材料，来源仍指同一审查事件", async () => {
    await fixCard("T1", P, "## P1\n- race-1\n", FINDINGS);
    expect(await run(["lend-offer", "T1"])).toMatchObject({ ok: true });
    const first = listLendOrders(db, "T1").findLast((o) => o.step === "fix")!;
    expect(await run(["lend-offer", "T1"])).toMatchObject({ ok: false });
    expect(listLendOrders(db, "T1").filter((o) => o.step === "fix")).toHaveLength(1);
    const copy = join(dir, "restart-recovery-policy.ts");
    copyFileSync(FAKE_CFG, copy);
    reader = pathToFileURL(copy);
    expect(await run(["lend-reoffer", "T1", "--reason", "核对了材料"])).toMatchObject({ ok: true });
    const second = listLendOrders(db, "T1").findLast((o) => o.step === "fix")!;
    expect(second.orderId).not.toBe(first.orderId);
    const material = (o: typeof first) => o.wire.inputs.find((s) => s.startsWith(LABEL));
    expect(material(second)).toBeDefined();
    expect(material(second)).toBe(material(first));
    const notes = materialsOf("T1");
    expect(notes).toHaveLength(2);
    expect(notes[1].eventSeq).toBe(notes[0].eventSeq);
  });

  test("不同项目各按自己的模式：P on 发结构化，Q 读到 off 走全文", async () => {
    g.__matwPolicy = modes({ [P]: "on", [Q]: "off" });
    await fixCard("T1", P, "## P1\n- race-1\n", FINDINGS);
    await fixCard("T2", Q, "## P1\n- race-1\n", FINDINGS);
    expect(await run(["lend-offer", "T1"])).toMatchObject({ ok: true });
    expect(await run(["lend-offer", "T2"])).toMatchObject({ ok: true });
    expect((await sent("T1")).wire.inputs.some((s) => s.startsWith(LABEL))).toBe(true);
    const q = (await sent("T2")).wire.inputs;
    expect(q.some((s) => s.startsWith(FULL))).toBe(true);
    expect(q.join("\n")).not.toContain(LABEL);
    expect(g.__matwCalls).toEqual(expect.arrayContaining([`${P}:materials`, `${Q}:materials`]));
  });

  test("build 单不读策略、单子与以前一样", async () => {
    const spec = join(dir, "T1.md");
    writeFileSync(spec, "规格");
    createTask(db, { actor: "owner", now }, { project: P, id: "T1", title: "T1", kind: "code", spec, agent: "agent-dev" } as never);
    db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T1'");
    expect(await run(["lend-offer", "T1", "--peer", "mate", "--repo", REPO])).toMatchObject({ ok: true, step: "write" });
    expect(g.__matwCalls).toEqual([]);
  });
});
