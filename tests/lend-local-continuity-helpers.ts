/**
 * i28-STALELEASE1 harness on a real ledger through the scheduler tick, the pool CLI and the lend CLI (lend-fix-start.test.ts's
 * harness with a local Claude author and a Codex reviewer): the build is lent to "mate", PM withdraws it (lend-cancel leaves the
 * write lease held), placement falls back to this machine, the local author delivers on the card's own branch, review sends it to fix.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import type { Gh } from "../src/lib/lend-fix-reassign-pr.js";
import { ghFixStartProbe } from "../src/lib/lend-fix-start.js";
import { setStaleLeasePolicy, STALE_LEASE_KEY } from "../src/lib/lend-local-continuity.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

export const E2E_MS = 30_000;
export const FP = "abcd-ef01-2345-6789";
export const LEND_BRANCH = "lend/T1-abcd";
export const CARD_BRANCH = "feat/t1";
export const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }];
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });

export async function ready(mode: RecoveryMode) {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const policy: { maxActiveWorkers: number; remote: RemotePolicy } = { maxActiveWorkers: 2, remote: WRITE };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  const gh: string[][] = [];
  const relayGh: Gh = async (args) => {
    gh.push(args);
    const ref = args[1]?.match(/^repos\/o\/r\/git\/ref\/heads\/(.+)$/);
    const h = ref ? heads[ref[1]] : null;
    return !ref ? ok("") : h?.ok ? ok(h.head) : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)", timedOut: false };
  };
  const startProbe = ghFixStartProbe({ peerFp: async (peer) => peer === "mate" ? FP : null,
    remoteHead: async () => { throw new Error("fix head must use gh API"); } }, relayGh);
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      ...startProbe },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend, relayGh }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = () => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, slots: { codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } },
    paused: null, grant: { until: f.tickDeps.now() + 3 * 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  const sw = { mode, reads: 0 };
  setStaleLeasePolicy(f.db, (_p, k) => { expect(k).toBe(STALE_LEASE_KEY); sw.reads++; return { mode: sw.mode, manualAfterMs: null, source: "config" }; });
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  await toBuild(f);
  return { f, cli, tick, hello, heads, gh, policy, sw, events, orders: () => listLendOrders(f.db, "T1") };
}
export type P = Awaited<ReturnType<typeof ready>>;

export const ofOp = (p: P, op: string) => p.events().filter((e) => e.data.op === op);
export const authorRow = (p: P) => p.f.db.query("SELECT agent, sessionId, family, transport, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author'").all();

/** Build lent to mate, withdrawn by PM, rebuilt here by agent-task-one on feat/t1 (H2), one P1 → fix; mate's write lease still held. */
export async function toStaleFix(p: P) {
  p.hello();
  await p.tick();
  expect(p.orders()).toEqual([expect.objectContaining({ peer: "mate", step: "write", status: "pooled" })]);
  expect(await p.cli("pm", "lend-cancel", "T1", "--reason", "mate 的 worker 登录失效")).toMatchObject({ ok: true });
  p.policy.remote = { ...WRITE, mode: "off" }; // mate unusable: placement lands on this machine
  for (let i = 0; i < 4 && !p.f.intents().some((x) => x.node === "write" && x.recipient === "agent-task-one" && x.status === "done"); i++) await p.tick();
  expect(p.f.intents().some((x) => x.node === "write" && x.recipient === "agent-task-one" && x.status === "done")).toBe(true);
  p.f.db.run("UPDATE tasks SET branch = ? WHERE id = 'T1'", [CARD_BRANCH]); // the local author's worktree branch
  expect(await p.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2)).toMatchObject({ ok: true });
  for (let i = 0; i < 4 && !p.f.intents().some((x) => x.action === "review" && x.status === "done"); i++) await p.tick();
  expect(await p.f.review("changes", H2, [P1])).toMatchObject({ ok: true });
  await p.tick(); // → fix
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: H2, branch: CARD_BRANCH, agent: "agent-task-one" });
  expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", branch: LEND_BRANCH, state: "held" });
  p.policy.remote = WRITE; // mate is back in the borrow list: today the fix would be pooled to it
  p.hello();
}
