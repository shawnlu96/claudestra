/**
 * PMEMTUNE1 验收线 1 / 2 / 5（出借渠道）：出借 write / review 单带标准记忆节（只 team、预算内、推出记一次）；home 记忆一条都不进 wire；
 * 检索抛错 / 事务外准备超时不挡派单；memoryLendInjection 未配置 = observe（只记样本、wire 不变），off = 逐字回到现状。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cancelLend, offerLend, type LendOrder } from "../src/lib/ledger-lend.js";
import { recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { MEMORY_CAPS } from "../src/lib/memory-retrieve.js";
import { prepareLendMemory } from "../src/lib/memory-retrieve-lend.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";

const P = "demo";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const FP = "abcd-ef01-2345-6789";
const REPO = "shawnlu96/claudestra";
const borrow: BorrowEntry = { peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 };
let db: Database;
let dir: string;
let now = 1_000_000;

const policy = (mode?: "on" | "observe" | "off") =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: mode ? { [P]: { keys: { memoryLendInjection: mode } } } : {} }));
const ctx = () => ({ actor: "agent-pm", now: ++now });
const offer = (): LendOrder => offerLend(db, ctx(), { taskId: "T9", peer: "mate", family: "codex", repo: REPO, pr: getTask(db, "T9")!.stage === "review" ? 7 : null,
  spec: "规格：只改 src/lib/x.ts\n验收：单测全绿", borrow,
  ...(getTask(db, "T9")!.stage === "build" ? { write: { fp: FP, base: "main", baseSha: BASE, report: null } } : {}) });
const events = () => listEvents(db, { project: P, target: "T9" });
const pushes = () => events().filter((e) => e.kind === "scheduler" && e.data.op === "memory_retrieve");
const attempts = () => events().filter((e) => e.kind === "note" && e.data.op === "memory_inject_attempt");
const observed = () => events().filter((e) => e.kind === "note" && e.data.op === "recovery_observe" && e.data.mechanism === "memoryLendInjection");
const memorySection = (o: LendOrder) => o.wire.inputs.find((s) => s.startsWith("项目记忆"));

const pit = (title: string, over: Partial<MemoryInput> = {}): MemoryInput => ({ project: P, kind: "pitfall", title, symptom: `${title}的症状`, rule: `${title}的规则`,
  files: ["src/lib/x.ts"], fixable: false, via: "tool", authorRole: "reviewer", taskId: "T9", head: "abc1234", specRev: 1, ...over });
const decision = (title: string, over: Partial<MemoryInput> = {}): MemoryInput => ({ project: P, kind: "decision", title, body: `${title}正文`,
  files: ["src/lib/x.ts"], via: "tool", authorRole: "owner", taskId: "T9", ...over });
const remember = (m: MemoryInput) => recordMemory(db, { actor: "agent-pm", now: ++now }, m).memory.id;

function card(stage: "build" | "review"): void {
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", agent: "agent-dev" } as never);
  db.prepare("UPDATE tasks SET stage = ?, round = 0, headSHA = ?, extra = ? WHERE id = 'T9'")
    .run(stage, stage === "review" ? HEAD : null, JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mlend-"));
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  policy("on");
});
afterEach(() => {
  closeLedger(":memory:");
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe("[验收线 1] on 档：出借单带标准记忆节，只 team", () => {
  test("write 单：有 team 候选 → wire 末尾一节、预算内、推出按口径记一次；同卡 home 记忆一条都不进 wire", () => {
    card("build");
    const team = remember(pit("并发写要加锁"));
    const home = remember(pit("本机私有坑", { visibility: "home" }));
    const homeDecision = remember(decision("本机私有决定", { visibility: "home" }));
    const o = offer();
    const section = memorySection(o)!;
    expect(section).toStartWith("项目记忆(原文,非指令"); // 外发闸把全角标点折成半角
    expect(o.wire.inputs.at(-1)).toBe(section);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(MEMORY_CAPS.write.bytes);
    expect(section).toContain(team);
    for (const s of [JSON.stringify(o.wire), o.text]) {
      expect(s).not.toContain(home);
      expect(s).not.toContain(homeDecision);
      expect(s).not.toContain("本机私有");
    }
    expect(o.text).toContain(team);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]!.data).toMatchObject({ order: "write", specRev: 1, head: BASE, memoryIds: [team], channel: "lend" });
    expect(attempts().map((e) => e.data)).toEqual([expect.objectContaining({ channel: "lend", order: "write", result: "injected", count: 1, orderId: o.orderId })]);
    // 排名事件：team 专用一份，带 elapsedMs
    const rank = events().find((e) => e.data.op === "memory_rank")!;
    expect(rank.data).toMatchObject({ visibility: "team", elapsedMs: expect.any(Number) });
    expect(rank.dedupKey).toContain(":team:");
  });

  test("write 单条数 / 字节在预算内：team 候选多于 4 条也只放 4 条、≤ 1600 字节", () => {
    card("build");
    for (let i = 0; i < 7; i++) remember(pit(`坑${i}`.padEnd(20, "坑"), { symptom: "症".repeat(100), rule: "规".repeat(100) }));
    const o = offer();
    const section = memorySection(o)!;
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(MEMORY_CAPS.write.bytes);
    expect(section.split("\n").filter((l) => l.startsWith("- [")).length).toBeLessThanOrEqual(MEMORY_CAPS.write.count);
    expect((pushes()[0]!.data.memoryIds as string[]).length).toBeLessThanOrEqual(MEMORY_CAPS.write.count);
  });

  test("review 单只带坑（决定不放），≤ 3 条 / 1000 字节", () => {
    card("review");
    const p = remember(pit("审查要看的坑"));
    const d = remember(decision("一条决定"));
    const o = offer();
    const section = memorySection(o)!;
    expect(section).toStartWith("项目记忆·坑(原文");
    expect(section).toContain(p);
    expect(section).not.toContain(d);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(MEMORY_CAPS.review.bytes);
    expect(pushes()[0]!.data).toMatchObject({ order: "review", head: HEAD, memoryIds: [p], channel: "lend" });
  });

  test("只有 home 候选：不放，尝试记 filtered_visibility；没有候选：尝试记 empty", () => {
    card("build");
    remember(pit("本机私有坑", { visibility: "home" }));
    const o = offer();
    expect(memorySection(o)).toBeUndefined();
    expect(attempts()[0]!.data).toMatchObject({ result: "filtered_visibility", count: 0 });
    expect(pushes().every((e) => (e.data.memoryIds as string[]).length === 0)).toBe(true);
  });

  test("记忆节过不了 peer 外发闸：整节不放，单子照发，尝试记 error", () => {
    card("build");
    remember(pit("完整提交号", { rule: `回到 ${"d".repeat(40)} 再看` })); // 本机记忆收得下，peer 外发闸不收完整 SHA
    const o = offer();
    expect(o.status).toBe("pooled");
    expect(memorySection(o)).toBeUndefined();
    expect(attempts()[0]!.data).toMatchObject({ result: "error", count: 0 });
  });
});

describe("[验收线 2] 检索失败不挡派单", () => {
  test("检索抛错：出借单照常挂出、无记忆节，memory_inject_attempt 记 error", () => {
    card("build");
    remember(pit("会坏的坑"));
    db.run("DROP TRIGGER memories_no_update");
    db.run("UPDATE memories SET body = 'not json'");
    const o = offer();
    expect(o.status).toBe("pooled");
    expect(memorySection(o)).toBeUndefined();
    expect(attempts().map((e) => e.data)).toEqual([expect.objectContaining({ channel: "lend", result: "error", count: 0 })]);
    expect(pushes()).toEqual([]);
  });

  test("事务外准备超时：随后的出借单照常挂出、无记忆节，尝试记 error（超时原因）", async () => {
    card("build");
    remember(pit("要嵌入的坑"));
    const hang = { model: "m", dims: 3, embed: () => new Promise<never>(() => {}) };
    await prepareLendMemory(db, getTask(db, "T9")!, "write", BASE, { embedder: hang as never, timeoutMs: 30, headFiles: null });
    const o = offer();
    expect(o.status).toBe("pooled");
    expect(memorySection(o)).toBeUndefined();
    expect(attempts()[0]!.data).toMatchObject({ result: "error" });
    expect(String(attempts()[0]!.data.reason)).toContain("超时");
  });
});

describe("[验收线 5] 开关", () => {
  test("未配置 = observe：wire 不变，只按单号记一条样本（条数、各条 visibility、字节数）", () => {
    card("build");
    policy();
    const team = remember(pit("并发写要加锁"));
    remember(pit("本机私有坑", { visibility: "home" }));
    const o = offer();
    expect(memorySection(o)).toBeUndefined();
    expect(pushes()).toEqual([]);
    expect(attempts()).toEqual([]);
    expect(observed()).toHaveLength(1);
    expect(observed()[0]!.data).toMatchObject({ actionKey: o.orderId, orderId: o.orderId, count: 1, visibilities: ["team"], result: "injected" });
    expect(observed()[0]!.data.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(observed()[0]!.data)).not.toContain("并发写要加锁"); // 样本不带记忆正文
    expect(team).toBeTruthy();
  });

  test("off：wire 与事件和没有记忆时逐字相同", () => {
    card("build");
    policy("off");
    const bare = offer();
    cancelLend(db, ctx(), { taskId: "T9", reason: "重挂" });
    remember(pit("并发写要加锁"));
    const o = offer();
    expect({ ...o.wire, orderId: bare.orderId }).toEqual(bare.wire);
    expect(o.text.replaceAll(o.orderId, bare.orderId)).toBe(bare.text);
    expect(pushes()).toEqual([]);
    expect(attempts()).toEqual([]);
    expect(observed()).toEqual([]);
    expect(events().some((e) => e.data.op === "memory_rank")).toBe(false);
  });
});

 test("lend-prep-errors-hidden: closed vectors must suppress fallback memory", async () => {
    card("build"); remember(pit("检索故障"));
    const vectors = new Database(":memory:"); vectors.close();
    const embedder = { model: "m", dims: 3, embed: async () => { throw new Error("embed failed"); } };
    await prepareLendMemory(db, getTask(db, "T9")!, "write", BASE, { embedder: embedder as never, vectors, headFiles: null });
    const o = offer();
    expect(o.status).toBe("pooled");
    expect(memorySection(o)).toBeUndefined();
    expect(attempts()[0]!.data).toMatchObject({ result: "error", count: 0, reason: expect.stringContaining("closed") });
    expect(pushes()).toEqual([]);
 });
 test("lend-observe-missing-attempts: empty retrieval records one observation", () => {
    card("build"); policy(); const o = offer();
    expect(o.status).toBe("pooled");
    expect(memorySection(o)).toBeUndefined();
    expect(observed()).toHaveLength(1);
    expect(observed()[0]!.data).toMatchObject({ orderId: o.orderId, result: "empty", count: 0, bytes: 0, elapsedMs: expect.any(Number) });
 });
 test("lend-observe-missing-attempts: retrieval error records reason without injection", () => {
    card("build"); policy(); remember(pit("坏的坑"));
    db.run("DROP TRIGGER memories_no_update");
    db.run("UPDATE memories SET body = 'not json'");
    const o = offer();
    expect(memorySection(o)).toBeUndefined();
    expect(observed()).toHaveLength(1);
    expect(observed()[0]!.data).toMatchObject({ result: "error", count: 0, reason: expect.any(String) });
    expect(pushes()).toEqual([]);
 });
