/**
 * GATESWAP1 shared fixture (no test cases here): the CIRES1 shape on a real temp ledger, driven only through the scheduler tick, the
 * pool / lend CLI and the outbound gate. Peer "mate" lends Claude only and writes the card (head H2); this machine's agent pool has
 * Codex; the local Codex reviewer finds one P1 whose report trips the gate, so the fix back to mate is refused. Replaced ports only:
 * clock, transport, lifecycle (session create / worktree), quota and the recovery policy; the eligibility and the CONV2 chain are real.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { expect } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import type { RecoveryMode, RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { setLocalSwapPorts } from "../src/lib/recovery-fix-local-swap.js";
import { setRemoteConvergenceContext } from "../src/lib/fix-strategy-remote-context.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { convergenceProbe } from "./fix-strategy-helpers.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

export const BRANCH = "lend/T1-abcd";
export const MIN = 60_000;
export const H3 = "3".repeat(40);
type Slots = { codex: { total: number; busy: number }; claude: { total: number; busy: number } };
export const CLAUDE_FREE: Slots = { codex: { total: 0, busy: 0 }, claude: { total: 2, busy: 0 } };
export const CLAUDE_BUSY: Slots = { codex: { total: 0, busy: 0 }, claude: { total: 2, busy: 2 } };
/** A secret-looking line the outbound gate refuses whatever GATE4 cuts (tests/scheduler-dispatch-block.test.ts). */
export const leaked = () => `# 审查报告\nP1：两个 tick 抢同一个意图\n别处粘来的 secret ${randomBytes(32).toString("hex")}`;
export const CLEAN = "# 审查报告\nP1：两个 tick 抢同一个意图（复现见 tests/x.test.ts）";

export const goodQuota = (usedPct = 20): InventoryQuota => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null,
  windows: [{ id: "weekly", kind: "weekly", usedPct, resetsAtMs: null, resetPassed: false }] } as InventoryQuota);

export async function swapFixture(opts: { mode?: RecoveryMode; manualStallHours?: number } = {}) {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }];
  const remote: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r", agents: { claude: 0, codex: 0 } };
  const policy = { maxActiveWorkers: 2, remote };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  const notices: string[] = [];
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      peerFp: async (peer: string) => (peer === "mate" ? "abcd-ef01-2345-6789" : null),
      remoteHead: async (_repo: string, branch: string) => heads[branch] ?? { ok: false as const, error: "没有这个分支" } },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const state = { mode: opts.mode ?? "on" as RecoveryMode, quota: goodQuota() as InventoryQuota | Error, quotaReads: 0 };
  const recovery = (): RecoveryPolicy => ({ mode: state.mode, manualAfterMs: opts.manualStallHours ? opts.manualStallHours * 3_600_000 : null, source: "config" });
  const probe = convergenceProbe(f);
  delete probe.deps.readReport; // the real report file: the material must carry the reviewer's original text (git diff stays a port)
  const context = { lifecycle: probe.deps, remote, borrow, source: f.dir, spec: "规格：只改 src/lib/x.ts", maxWorkers: 2,
    notify: async (text: string) => { notices.push(`convergence:${text}`); },
    remoteHead: async (_repo: string, branch: string) => heads[branch] ?? { ok: false as const, error: "没有这个分支" } };
  setRemoteConvergenceContext(f.db, context);
  const ports = { policy: () => recovery(), lifecycle: probe.deps, codexLine: () => 80,
    quota: async () => { state.quotaReads++; if (state.quota instanceof Error) throw state.quota; return state.quota; } };
  setLocalSwapPorts(f.db, ports);
  // Same seam as tests/scheduler-review-swap.test.ts: the real review-swap step with archive / kill / ensure ports.
  const swapEffects: string[] = [];
  const reviewSwapDeps: ReviewSwapDeps = { registryPath: f.registryPath, active: () => {},
    agents: async () => probe.deps.registry().map((r) => ({ name: r.name, status: r.status, sessionId: r.sessionId, cwd: r.cwd, window: r.status !== "stopped", pending: false })),
    agent: async (cmd, agent) => {
      swapEffects.push(`${cmd}:${agent}`);
      if (cmd === "archive") return { ok: true, archived: ["old.jsonl"] };
      probe.edit((r) => { r.agents[agent].status = "stopped"; });
      return { ok: true };
    },
    ensure: async (task, family) => {
      swapEffects.push(`ensure:${family}`);
      probe.edit((r) => Object.assign(r.agents["agent-rv-t1"], { runtime: family === "codex" ? "codex" : "claude-code",
        transport: family === "codex" ? "acp" : "tmux", sessionId: `s-rv-${family}`, status: "active" }));
      return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: "agent-rv-t1", sessionId: `s-rv-${family}`, family,
        transport: family === "codex" ? "acp" : "tmux" } };
    } };
  const deps = { ...f.tickDeps, borrow: async () => borrow, recoveryPolicy: () => recovery(),
    manager: async (...args: string[]) => args[1] === "scheduler-review-swap"
      ? reviewSwapStep(f.db, f.at("scheduler"), args[2], Number(args[4]), reviewSwapDeps) : cli("scheduler", ...args.slice(1)),
    notifyPm: async (_t: unknown, text: string) => { notices.push(text); } };
  let tickDb = f.db;
  /** A scheduler restart: a fresh ledger handle, so every in-memory map of the tick is gone; only the ledger remains. */
  const restart = () => { tickDb = f.reader.get()!; setLocalSwapPorts(tickDb, ports); setRemoteConvergenceContext(tickDb, context); };
  const tick = async () => {
    const r = await schedulerAutoTick(tickDb, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = (slots: Slots = CLAUDE_FREE, repos = ["o/r"]) =>
    recordHello(f.db, "mate", null, { v: 1, proto: 3, boot: "boot-mate", seq: ++seq, slots, paused: null,
      grant: { until: f.tickDeps.now() + 30 * 3_600_000, roles: ["review", "write"], repos, ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  const lendCall = (op: string, body: unknown) => cli("owner", op, "--", "mate", JSON.stringify(body));
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const orders = () => listLendOrders(f.db, "T1");
  const later = async (ms: number, slots: Slots = CLAUDE_FREE, repos?: string[]) => { f.advance(ms); hello(slots, repos); return tick(); };
  const observes = () => events().filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "fixLocalSwap");
  const swaps = () => f.db.query("SELECT id, status, action FROM scheduler_intents WHERE action = 'fix_swap'").all() as { id: string; status: string; action: string }[];
  const has = (k: string) => !!getEventByDedup(f.db, k);
  await toBuild(f);
  return { f, cli, tick, restart, swapEffects, hello, lendCall, heads, policy, remote, events, orders, notices, borrow, state, probe, context, later, observes, swaps, has };
}
export type Sx = Awaited<ReturnType<typeof swapFixture>>;

/** Build → mate writes H2 in Claude → local Codex review finds P1 with `report` → fix; lease at mate, no task.agent. */
export async function toFix(p: Sx, report: string) {
  p.hello();
  await p.tick();
  const [build] = p.orders();
  expect(build).toMatchObject({ peer: "mate", step: "write", family: "claude" });
  expect(await p.lendCall("lend-claim", { v: 1, orderId: build!.orderId, worker: "w1" })).toMatchObject({ ok: true });
  p.heads[BRANCH] = { ok: true, head: H2 };
  expect(await p.lendCall("lend-write", { v: 1, orderId: build!.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-mate", family: "claude" },
    deliver: { v: 1, orderId: build!.orderId, head: H2, evidence: BRANCH, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
  p.remote.agents = { claude: 1, codex: 1 };
  await p.tick(); await p.tick(); await p.tick();
  const path = join(p.f.dir, "report-r1.md");
  writeFileSync(path, report);
  const findings = join(p.f.dir, "p1.json");
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", H2, "--session", "s-rv", "--family", "codex", "--findings", findings, "--path", path)).toMatchObject({ ok: true });
  await p.tick();
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: H2 });
  p.f.db.run("UPDATE tasks SET agent = NULL WHERE id = 'T1'");
}
