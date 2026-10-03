/**
 * Real temp ledger for dispatch-recovery-R1 (tests/scheduler-dispatch-block*.test.ts): one auto card whose fix goes back to the
 * write-lease holder "mate" through the scheduler tick, the pool CLI and the lend CLI (harness of tests/lend-fix-reassign.test.ts).
 * `toFix(report)` drives build → mate delivers H2 → local Claude review with `report` → fix, lease at mate, task.agent cleared.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { Grant } from "../src/lib/lend-wire-v2.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const BRANCH = "lend/T1-abcd";
export const MIN = 60_000;
export const E2E_MS = 30_000;
type Slots = { codex: { total: number; busy: number }; claude: { total: number; busy: number } };
export const FREE: Slots = { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } };
/** The unified family pool (scheduler.json agents): this machine has no Codex, so a fix can only go back to mate. */
const POOL: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r", agents: { claude: 1, codex: 0 } };

export async function blockFixture(remote: RemotePolicy = POOL, pendingRestate?: string) {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents["agent-rv-t1"].transport;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }];
  const policy = { maxActiveWorkers: 2, remote: { ...remote } };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  const notices: string[] = [];
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      peerFp: async (peer: string) => (peer === "mate" ? "abcd-ef01-2345-6789" : null),
      remoteHead: async (_repo: string, branch: string) => heads[branch] ?? { ok: false as const, error: "没有这个分支" } },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow,
    notifyPm: async (_t: unknown, text: string) => { notices.push(text); } };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = (slots: Slots = FREE, grant: Partial<Grant> = {}) =>
    recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, slots, paused: null,
      grant: { until: f.tickDeps.now() + 3 * 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50, ...grant } }, f.tickDeps.now());
  const lendCall = (op: string, body: unknown) => cli("owner", op, "--", "mate", JSON.stringify(body));
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const orders = () => listLendOrders(f.db, "T1");
  const fixes = () => orders().filter((o) => o.step === "fix");
  const refusals = () => events().filter((e) => e.data.op === "gate_refused");
  /** A new local review of the same round and head (PM re-ran it with another report): the fix order's material changed. */
  const rereview = (report: string) => {
    const path = join(f.dir, `report-${seq++}.md`);
    writeFileSync(path, report);
    const last = events().filter((e) => e.kind === "review").at(-1)!;
    insertEvent(f.db, f.at("agent-rv-t1"), { project: "p", target: "T1", kind: "review", text: "本机复核", data: { ...last.data, path } }, true);
  };
  if (pendingRestate !== undefined) {
    expect(await cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", "1", "--template", "code", "--version", "3",
      "--mode", "auto", "--author-family", "claude", "--fallback", "只报错不修", "--reason", "验证待答复复述")).toMatchObject({ ok: true });
    await f.tick();
    await f.tick();
    expect(await cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", pendingRestate)).toMatchObject({ ok: true });
    await f.tick();
    expect(f.task().stage).toBe("build");
  } else await toBuild(f);
  return { f, cli, tick, hello, lendCall, heads, policy, events, orders, fixes, refusals, rereview, notices };
}
export type Fx = Awaited<ReturnType<typeof blockFixture>>;

/** Build → mate writes H2 (PR #7) → the local Claude reviewer finds one P1 with `report` → fix; lease at mate, no task.agent. */
export async function toFix(p: Fx, report: string) {
  p.hello();
  p.policy.remote.agents = { claude: 0, codex: 0 };
  await p.tick();
  const [build] = p.orders();
  expect(build).toMatchObject({ peer: "mate", step: "write" });
  expect(await p.lendCall("lend-claim", { v: 1, orderId: build!.orderId, worker: "w1" })).toMatchObject({ ok: true });
  p.heads[BRANCH] = { ok: true, head: H2 };
  expect(await p.lendCall("lend-write", { v: 1, orderId: build!.orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-mate", family: "codex" },
    deliver: { v: 1, orderId: build!.orderId, head: H2, evidence: BRANCH, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
  p.policy.remote.agents = { claude: 1, codex: 0 };
  await p.tick(); // pool_done
  await p.tick(); // reviewer session (claude)
  await p.tick(); // review order
  const path = join(p.f.dir, "report-r1.md");
  writeFileSync(path, report);
  const findings = join(p.f.dir, "p1.json");
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", path)).toMatchObject({ ok: true });
  await p.tick(); // → fix
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: H2 });
  p.f.db.run("UPDATE tasks SET agent = NULL WHERE id = 'T1'");
}
