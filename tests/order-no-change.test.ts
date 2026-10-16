/**
 * CINOOP1 · noChange 的格式与传输：严格解析（未知 kind / 空理由 / 畸形证据拒）、DeliverWire 与出借请求里原样不丢、提交端
 * （lend submit）同 head 只收带 noChange 的、接收端（ledger lend-write）独立再核；普通交付口不吃 noChange；标准答复文案与长度约束。
 * 出借 journal 在临时目录，台账是内存库，远端 head / CI 读口都是假的。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CiNoChangePort } from "../src/lib/ci-no-change-evidence.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import { submitLendWork, type SubmitterDeps } from "../src/lib/lend-submit.js";
import { noChangeHeadRefusal, noChangeStepRefusal, parseNoChange, parseNoChangeText, runRef, type NoChange } from "../src/lib/order-no-change.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { standardAnswers } from "../src/lib/order-standard-answers.js";
import { parseDeliverWire } from "../src/lib/order-wire.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";

const REPO = "shawnlu96/claudestra";
const RUN = `https://github.com/${REPO}/actions/runs/38899963794`;
const H = "a".repeat(40), BASE = "b".repeat(40), H2 = "c".repeat(40), M = "d".repeat(40);
const OOS: NoChange = { kind: "out_of_scope_ci", reason: "范围外时序波动", run: RUN, files: ["tests/web-dom-now-home.test.ts"] };
const MR: NoChange = { kind: "main_already_resolved", reason: "main 已绿", sourceRun: `https://github.com/${REPO}/actions/runs/800`, mainHead: M,
  mainRun: `https://github.com/${REPO}/actions/runs/900` };

describe("格式：严格解析", () => {
  test("两种 kind 都收；字段顺序固定、文件排序（同一份解析后逐字节一样）", () => {
    expect(parseNoChange({ files: ["tests/b.ts", "tests/a.ts"], run: RUN, reason: " r ", kind: "out_of_scope_ci" }))
      .toEqual({ ok: true, value: { kind: "out_of_scope_ci", reason: "r", run: RUN, files: ["tests/a.ts", "tests/b.ts"] } });
    expect(parseNoChange(MR)).toEqual({ ok: true, value: MR });
    expect(runRef(`${RUN}/attempts/2`)).toEqual({ repo: REPO, runId: 38899963794, attempt: 2 });
    expect(parseNoChangeText(JSON.stringify(OOS))).toEqual({ ok: true, value: OOS });
  });

  test("拒：未知 kind、多 / 少字段、空理由、多行理由、畸形 run 链接、坏文件路径 / 重复 / 空列表、坏 mainHead、两个 run 不同仓库、非 JSON", () => {
    const bad = (v: unknown, re: RegExp) => { const r = parseNoChange(v); expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(re); };
    bad({ ...OOS, kind: "flaky" }, /kind/);
    bad({ ...OOS, extra: 1 }, /不认识/);
    bad({ kind: "out_of_scope_ci", reason: "r", run: RUN }, /缺字段/);
    bad({ ...OOS, reason: "  " }, /理由/);
    bad({ ...OOS, reason: "a\nb" }, /单行/);
    bad({ ...OOS, run: "https://evil.example/actions/runs/1" }, /run/);
    bad({ ...OOS, run: `${RUN}/job/1` }, /run/);
    bad({ ...OOS, files: ["../etc/passwd"] }, /files/);
    bad({ ...OOS, files: ["/abs.ts"] }, /files/);
    bad({ ...OOS, files: ["a.ts", "a.ts"] }, /重复/);
    bad({ ...OOS, files: [] }, /files/);
    bad({ ...MR, mainHead: "D".repeat(40) }, /mainHead/);
    bad({ ...MR, mainRun: "https://github.com/x/y/actions/runs/9" }, /仓库/);
    bad(null, /对象/);
    expect(parseNoChangeText("{not json").ok).toBe(false);
  });

  test("head 规则：同 head 不带理由拒；带 noChange 换了 head 也拒；out_of_scope_ci 只给修复单", () => {
    expect(noChangeHeadRefusal(H, H, undefined)).toMatch(/没有新提交/);
    expect(noChangeHeadRefusal(H, H2, OOS)).toMatch(/订单起点/);
    expect(noChangeHeadRefusal(H, H, OOS)).toBeNull();
    expect(noChangeHeadRefusal(H, H2, undefined)).toBeNull();
    expect(noChangeStepRefusal("write", OOS)).toMatch(/修复单/);
    expect(noChangeStepRefusal("write", MR)).toBeNull();
    expect(noChangeStepRefusal("review", MR)).toMatch(/开工/);
  });
});

describe("传输：DeliverWire 原样带着，不带时逐字节同旧", () => {
  const wire = { v: 1 as const, orderId: "lend:T9:s1:r1:a0", head: H, evidence: "e", summary: "无需改码", selfCheck: "自查" };
  test("带 noChange 解析后完整保留；不带时没有这个键；畸形的整份拒", () => {
    expect(parseDeliverWire({ ...wire, noChange: OOS })).toEqual({ ok: true, value: { ...wire, noChange: OOS } });
    const plain = parseDeliverWire(wire);
    expect(plain.ok && "noChange" in plain.value).toBe(false);
    expect(parseDeliverWire({ ...wire, noChange: { ...OOS, reason: "" } })).toMatchObject({ ok: false, error: expect.stringMatching(/noChange/) });
  });
});

describe("提交端：lend submit 写单", () => {
  let jdb: Database;
  const dir = mkdtempSync(join(tmpdir(), "no-change-submit-"));
  const deps = (head: string): SubmitterDeps => ({ cwd: dir, pid: 10, agentSession: () => "s1", panePid: async () => 7, ancestors: async () => [7], headOf: async () => head });
  function started(step: "write" | "fix"): void {
    jdb = openLendJournal(join(mkdtempSync(join(tmpdir(), "no-change-journal-")), "j.sqlite"));
    recordAsked(jdb, { orderId: "o1", peer: "a", fp: null, family: "claude", preview: {} });
    advance(jdb, "o1", "asked", "claimed", { leaseGen: 1, wire: { order: { step, head: H, taskId: "T9", round: 1, specRev: 1 }, text: "t", write: { branch: "lend/T9-ab", base: "main" } } });
    advance(jdb, "o1", "claimed", "cloned", { dir });
    advance(jdb, "o1", "cloned", "started", { agent: "agent-lend-1", sessionId: "s1" });
  }
  afterEach(() => jdb?.close());

  test("同 head 不带 noChange 拒；带合法 noChange 收（只算提交端已接收）且原样落 journal；同一份重交幂等、换一份拒", async () => {
    started("fix");
    expect(await submitLendWork(jdb, "o1", { summary: "x", selfCheck: "y" }, deps(H))).toMatchObject({ ok: false, error: expect.stringMatching(/订单起点/) });
    const r = await submitLendWork(jdb, "o1", { summary: "无需改码", selfCheck: "自查", noChange: OOS }, deps(H));
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(getOrder(jdb, "o1")).toMatchObject({ state: "result_pending", work: { head: H, noChange: OOS } });
    expect(await submitLendWork(jdb, "o1", { summary: "无需改码", selfCheck: "自查", noChange: OOS }, deps(H))).toMatchObject({ ok: true, duplicate: true });
    expect(await submitLendWork(jdb, "o1", { summary: "无需改码", selfCheck: "自查", noChange: { ...OOS, reason: "另一个" } }, deps(H))).toMatchObject({ ok: false });
  });

  test("带 noChange 却有新提交拒；开工单不收 out_of_scope_ci；noChange 不带截图", async () => {
    started("fix");
    expect(await submitLendWork(jdb, "o1", { summary: "x", selfCheck: "y", noChange: OOS }, deps(H2))).toMatchObject({ ok: false, error: expect.stringMatching(/订单起点/) });
    jdb.close();
    started("write");
    expect(await submitLendWork(jdb, "o1", { summary: "x", selfCheck: "y", noChange: OOS }, deps(H))).toMatchObject({ ok: false, error: expect.stringMatching(/修复单/) });
    expect(await submitLendWork(jdb, "o1", { summary: "x", selfCheck: "y", noChange: MR, ui: { summary: "s", shots: [] } }, deps(H))).toMatchObject({ ok: false });
    expect(await submitLendWork(jdb, "o1", { summary: "x", selfCheck: "y", noChange: MR }, deps(H))).toMatchObject({ ok: true });
  });
});

describe("接收端：ledger lend-write 独立再核", () => {
  const P = "claude-orchestrator", FP = "abcd-ef01-2345-6789", BR = "lend/T9-abcd";
  const dir = mkdtempSync(join(tmpdir(), "no-change-recv-"));
  const key = instanceKeySync(dir);
  let db: Database;
  let mode: RecoveryMode;
  let remote: Record<string, RemoteHead>;
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];
  const port: CiNoChangePort = { headChecks: async () => [], run: async () => { throw new Error("不该读"); }, prFiles: async () => [], mainHead: async () => M,
    mainRuns: async () => [{ id: 900, attempt: 1, status: "completed", conclusion: "success", headSha: M, url: `https://github.com/${REPO}/actions/runs/900`, createdAt: 2 }] };
  const deps = (actor: string) => ({ db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 1_000_000,
    lend: { borrow: async () => borrow, notifyPm: async () => {}, result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b),
      sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key), remoteHead: async (_r: string, b: string) => remote[b] ?? { ok: false, error: "无" },
      peerFp: async () => FP, noChangePort: port, noChangePolicy: () => ({ mode, manualAfterMs: null, source: "config" as const }) } } });
  const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
  const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
  const body = (orderId: string, head: string, noChange?: NoChange) => ({ v: 1, orderId, gen: 1, branch: BR, pr: null, session: { id: "s", family: "codex" },
    deliver: { v: 1, orderId, head, evidence: BR, summary: "无需改码", selfCheck: "自查", ...(noChange ? { noChange } : {}) } });

  async function lent(source: boolean): Promise<string> {
    db.query("INSERT INTO features (id,project,title,status,currentVersion,createdBy,createdAt,updatedAt) VALUES ('F1',?,'merge','active',1,'owner',1,1)").run(P);
    createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T9", title: "T9", kind: "code", spec: join(dir, "T9.md"), agent: "agent-dev" } as never);
    db.run("UPDATE tasks SET stage = 'build', round = 0, featureId = 'F1' WHERE id = 'T9'");
    db.query("INSERT INTO dag_versions (featureId,version,reasonKind,proposedBy,createdAt,nodes) VALUES ('F1',1,'initial','owner',1,?)").run(JSON.stringify([{ key: "main-red", taskId: "T9" }]));
    insertEvent(db, { actor: "scheduler", now: 1 }, { project: P, target: "", kind: "scheduler", text: "main 红", data: { op: "main_red_fix_node",
      source: source ? "mainRedFix" : "pm", workflow: "push", checks: "[]", featureId: "F1", key: "main-red", taskId: "T9", faultKey: null, runId: 800, mainSha: M } }, true);
    const { orderId } = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
    await call("claim", { v: 1, orderId, worker: "agent-lend-0123456789" });
    // 挂单只收 PM 手动卡；MAINRED1 卡之后由调度器接管（自动流程）——直接补流程行，模拟交付时的状态
    db.query(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt)
      VALUES ('T9',?,'code',1,'auto','claude','x',1,1,1,1)`).run(P);
    return orderId;
  }

  beforeEach(() => {
    db = openLedger(":memory:");
    mode = "on";
    remote = { main: { ok: true, head: BASE } };
    writeFileSync(join(dir, "T9.md"), "规格：修 main\n验收：main 绿");
    setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-pm"] });
  });
  afterEach(() => closeLedger(":memory:"));

  test("同 head 不带 noChange 仍拒；带 noChange 换 head 拒；开工单的 out_of_scope_ci 拒；都不写事件", async () => {
    const orderId = await lent(true);
    const n = listEvents(db, { target: "T9" }).length;
    expect(await call("write", body(orderId, BASE))).toMatchObject({ ok: false, current: { lend: "invalid" } });
    remote[BR] = { ok: true, head: H2 };
    expect(await call("write", body(orderId, H2, MR))).toMatchObject({ ok: false, current: { lend: "invalid" } });
    expect(await call("write", body(orderId, BASE, OOS))).toMatchObject({ ok: false, current: { lend: "invalid" } });
    expect(listEvents(db, { target: "T9" }).length).toBe(n);
  });

  test("普通写单（没有 MAINRED1 来源）同 head 带 main_already_resolved 也拒，卡不动", async () => {
    const orderId = await lent(false);
    expect(await call("write", body(orderId, BASE, MR))).toMatchObject({ ok: false, current: { lend: "invalid" }, error: expect.stringMatching(/MAINRED1/) });
    expect(getTask(db, "T9")).toMatchObject({ stage: "build" });
  });

  test("MAINRED1 生成卡 + 当前 main 绿：签回执、结出借单、同笔取消卡；同一份重发回原回执；off 时不收", async () => {
    mode = "off";
    const orderId = await lent(true);
    expect(await call("write", body(orderId, BASE, MR))).toMatchObject({ ok: false, error: expect.stringMatching(/off/) });
    expect(getTask(db, "T9")).toMatchObject({ stage: "build" });
    mode = "on";
    const r = await call("write", body(orderId, BASE, MR));
    expect(r).toMatchObject({ ok: true, receipt: { orderId, taskId: "T9" } });
    expect(getTask(db, "T9")).toMatchObject({ stage: "cancelled", round: 0 });
    expect(listLendOrders(db, "T9")[0]).toMatchObject({ status: "done", eventSeq: r.receipt.eventSeq });
    expect(await call("write", body(orderId, BASE, MR))).toMatchObject({ ok: true, receipt: r.receipt });
  });
});

describe("普通交付口与标准答复", () => {
  test("ledger-write deliver 不吃 noChange（专用事务之外不当普通交付推 review）", () => {
    const db = openLedger(":memory:");
    try {
      createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code" } as never);
      expect(() => deliver(db, { actor: "owner", now: 2 }, { taskId: "T1", headSHA: H, noChange: OOS })).toThrow(/专用事务/);
    } finally { closeLedger(":memory:"); }
  });

  test("写 / 修复单的范围外红文案指向 noChange、不承诺直接合并或一定恢复；整段不比旧版长；审查单不带", () => {
    const author = standardAnswers("author");
    const line = author.split("\n").find((l) => l.includes("范围外测试红"))!;
    expect(line).toMatch(/不推空提交/);
    expect(line).toMatch(/noChange/);
    expect(line).toMatch(/run 链接、失败文件、理由/);
    expect(line).toMatch(/CI 全绿才同轮恢复/);
    expect(line).not.toMatch(/直接合|自动重跑|一定恢复/);
    expect(Buffer.byteLength(author)).toBeLessThanOrEqual(1019);
    expect(author.length).toBeLessThanOrEqual(497);
    expect(standardAnswers("review")).not.toContain("noChange");
    expect(standardAnswers("author", undefined, ["cargo test"])).not.toContain("noChange");
  });
});
