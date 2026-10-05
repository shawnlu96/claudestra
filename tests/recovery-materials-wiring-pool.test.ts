/**
 * dispatch-recovery-MATW：调度服务自动挂池（schedulerAutoTick → manager `scheduler-pool` → poolWrite）与 PM lend-offer 读同一份
 * CFG materials 策略。真 tick、真 CLI、真动态加载的替身 CFG 模块；对方收到的单子取自 lend-claim 应答。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const BASE_SHA = "b".repeat(40);
const FP = "abcd-ef01-2345-6789";
const BRANCH = "lend/T1-abcd";
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const SECRET = `ghp_${"A1b2C3d4".repeat(4)}`;
const n = (s: string): string => s.normalize("NFKC");
const LABEL = n("修复材料（结构化必需项，不是审查报告原文）：");
const FULL = n("上一轮审查报告原文：\n");

const g = globalThis as { __matwPoolPolicy?: (project: string) => unknown; __matwPoolCalls?: string[] };

async function ready(mode: (project: string) => unknown, readerAt?: "missing") {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents["agent-rv-t1"].transport;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const cfg = join(f.dir, "recovery-policy.ts");
  writeFileSync(cfg, `export function recoveryPolicy(project, mechanism) {
  (globalThis.__matwPoolCalls ??= []).push(project + ":" + mechanism);
  return globalThis.__matwPoolPolicy(project);
}\n`);
  g.__matwPoolPolicy = mode;
  g.__matwPoolCalls = [];
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow = [{ peer: "mate", projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }];
  const policy = { maxActiveWorkers: 2, remote: WRITE };
  const remote: Record<string, RemoteHead> = { main: { ok: true, head: BASE_SHA } };
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    recoveryReader: pathToFileURL(readerAt ? join(f.dir, "absent", "recovery-policy.ts") : cfg),
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      peerFp: async () => FP, remoteHead: async (_repo: string, branch: string) => remote[branch] ?? { ok: false as const, error: "没有这个分支" } },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = () => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
    paused: null, grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  const lendCall = (op: string, body: unknown) => cli("owner", op, "--", "mate", JSON.stringify(body));
  await toBuild(f);
  return { f, cli, tick, hello, lendCall, remote, orders: () => listLendOrders(f.db, "T1") };
}
type Ready = Awaited<ReturnType<typeof ready>>;

/** Build → mate writes H2 → local Claude reviewer → one P1 recorded with `findings` at `report` → fix. */
async function toFix(p: Ready, report: string, findings: unknown[]): Promise<string> {
  p.hello();
  await p.tick();
  const [order] = p.orders();
  await p.lendCall("lend-claim", { v: 1, orderId: order.orderId, worker: "w1" });
  p.remote[BRANCH] = { ok: true, head: H2 };
  await p.lendCall("lend-write", { v: 1, orderId: order.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-1", family: "codex" },
    deliver: { v: 1, orderId: order.orderId, head: H2, evidence: BRANCH, summary: "实现了 x", selfCheck: "单测全绿" } });
  await p.tick();
  await p.tick();
  await p.tick();
  const path = join(p.f.dir, "report.md"), rows = join(p.f.dir, "p1.json");
  writeFileSync(path, report);
  writeFileSync(rows, JSON.stringify(findings));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", rows, "--path", path)).toMatchObject({ ok: true });
  await p.tick();
  expect(p.f.task().stage).toBe("fix");
  return path;
}

/** The fix order the scheduler pooled, as the peer receives it. */
async function pooledFix(p: Ready) {
  p.hello();
  expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
  const fix = p.orders().at(-1)!;
  expect(fix).toMatchObject({ step: "fix", peer: "mate" });
  const r = await p.lendCall("lend-claim", { v: 1, orderId: fix.orderId, worker: "fixer" });
  expect(r).toMatchObject({ ok: true });
  return { wire: r.order as { inputs: string[]; findings: { probe: string }[] }, text: r.text as string };
}
const notes = (p: Ready) => listEvents(p.f.db, { target: "T1" }).filter((e) => e.kind === "note" && (e.data.lend as any)?.op === "offer" &&
  (e.data.lend as any).step === "fix").map((e) => (e.data.lend as any).materials);
const DESCRIBED = { ...P1, description: "两个 tick 同时认领同一意图，第二个应被 CAS 拒" };

describe("调度服务自动挂池的修复单", () => {
  test("on：对方收到结构化项，原 description 保真；报告全文（含密钥样内容）不发、本机不变", async () => {
    const p = await ready(() => ({ mode: "on", manualAfterMs: null }));
    try {
      const report = `# 审查报告\nP1：复现用了 ${SECRET}`;
      const path = await toFix(p, report, [DESCRIBED]);
      const { wire, text } = await pooledFix(p);
      expect([JSON.stringify(wire), text].join("\n")).not.toContain("ghp_");
      expect(wire.inputs.some((s) => s.startsWith(FULL))).toBe(false);
      expect(wire.inputs.find((s) => s.startsWith(LABEL))).toContain(n(`问题说明（审查方原文）：\n> ${DESCRIBED.description}`));
      expect(wire.findings.map((f) => f.probe)).toEqual([P1.probe]);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "on", items: 1, undescribed: 0 })]);
      expect(readFileSync(path, "utf8")).toBe(report);
      expect(g.__matwPoolCalls).toContain("p:materials");
    } finally { p.f.close(); }
  });

  test("observe：全文照发，offer 只记 would-send", async () => {
    const p = await ready(() => ({ mode: "observe", manualAfterMs: null }));
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图", [DESCRIBED]);
      const { wire } = await pooledFix(p);
      expect(wire.inputs.some((s) => s.startsWith(FULL) && s.includes(n("P1：两个 tick 抢同一个意图")))).toBe(true);
      expect(wire.inputs.join("\n")).not.toContain(LABEL);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "observe", items: 1 })]);
    } finally { p.f.close(); }
  });

  test("reader 未安装：observe，全文照发（与改动前同一条路）", async () => {
    const p = await ready(() => ({ mode: "on", manualAfterMs: null }), "missing");
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图", [DESCRIBED]);
      const { wire } = await pooledFix(p);
      expect(wire.inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "observe" })]);
      expect(g.__matwPoolCalls).toEqual([]);
    } finally { p.f.close(); }
  });

  test("策略读坏 = off：全文照发，不记材料", async () => {
    const p = await ready(() => { throw new Error("配置坏了"); });
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图", [DESCRIBED]);
      const { wire } = await pooledFix(p);
      expect(wire.inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(notes(p)).toEqual([undefined]);
    } finally { p.f.close(); }
  });

  test("缺 description：on 也回退全文，记 undescribed", async () => {
    const p = await ready(() => ({ mode: "on", manualAfterMs: null }));
    try {
      await toFix(p, "# 审查报告\nP1：两个 tick 抢同一个意图", [P1]);
      const { wire } = await pooledFix(p);
      expect(wire.inputs.some((s) => s.startsWith(FULL))).toBe(true);
      expect(notes(p)).toEqual([expect.objectContaining({ mode: "on", fallback: "undescribed" })]);
    } finally { p.f.close(); }
  });

  test("敏感的必需 description：on 被外发闸拒，不出修复单，不改发全文", async () => {
    const p = await ready(() => ({ mode: "on", manualAfterMs: null }));
    try {
      await toFix(p, "# 审查报告\nP1", [{ ...P1, description: `复现：curl -H 'Authorization: Bearer ${SECRET}'` }]);
      p.hello();
      await p.tick();
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
    } finally { p.f.close(); }
  });

  test("项目读到的模式只作用于它自己：读策略时传的是卡所在项目", async () => {
    const p = await ready((project) => ({ mode: project === "p" ? "observe" : "on", manualAfterMs: null }));
    try {
      await toFix(p, "# 审查报告\nP1：x", [DESCRIBED]);
      const { wire } = await pooledFix(p);
      expect(wire.inputs.join("\n")).not.toContain(LABEL);
      expect(new Set(g.__matwPoolCalls)).toEqual(new Set(["p:materials"]));
    } finally { p.f.close(); }
  });
});
