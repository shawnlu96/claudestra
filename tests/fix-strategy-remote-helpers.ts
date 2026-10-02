/** Remote convergence fixtures inject every filesystem, transport and notification boundary. */
import { expect } from "bun:test";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { setRemoteConvergenceContext, type RemoteConvergenceContext } from "../src/lib/fix-strategy-remote-context.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { P1, type autoFixture } from "./scheduler-auto-helpers.js";
import type { ResultRequest } from "../src/lib/lend-wire.js";
import type { LendOrder } from "../src/lib/ledger-lend.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";

const FP = "abcd-bbbb-cccc-dddd";
let helloSeq = 0;
export function remoteProbe(f: ReturnType<typeof autoFixture>, peers = ["Peer"]) {
  f.db.run("UPDATE tasks SET branch = 'feat/T1', pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'");
  const p = convergenceProbe(f), notices: string[] = [];
  const context: RemoteConvergenceContext = { lifecycle: p.deps, source: f.dir, spec: "Acceptance: reproduce the race, then fix it", maxWorkers: 2,
    remote: { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 },
    borrow: peers.map((peer) => ({ peer, projects: ["p"], roles: ["write", "review"], maxOpen: 8 })),
    notify: async (text) => { notices.push(text); }, remoteHead: async () => ({ ok: true, head: f.task().headSHA! }) };
  setRemoteConvergenceContext(f.db, context);
  for (const peer of peers) hello(f, peer);
  return { ...p, context, notices };
}

export function hello(f: ReturnType<typeof autoFixture>, peer: string, proto = 3, families = { codex: 3, claude: 0 }) {
  recordHello(f.db, peer, FP, { v: 1, proto, boot: "testboot", seq: ++helloSeq, grant: { until: 1e12, roles: ["write", "review"],
    repos: ["o/r"], ordersPerDay: 100, ordersLeftToday: 100 }, slots: { codex: { total: families.codex, busy: 0 }, claude: { total: families.claude, busy: 0 } },
    paused: null }, f.tickDeps.now());
}

export function peerAuthor(f: ReturnType<typeof autoFixture>, family: "claude" | "codex" = "codex") {
  holdWriteLease(f.db, f.task(), { peer: "Peer", fp: FP, repo: "o/r", branch: "feat/T1" }, f.tickDeps.now());
  f.db.run("UPDATE tasks SET assigneeKind = 'peer_agent', assignee = ?, agent = NULL WHERE id = 'T1'", [`${FP}/old-worker`]);
  f.db.run("UPDATE scheduler_sessions SET transport = 'peer', agent = 'old-worker@Peer', sessionId = 'old-peer-session', family = ? WHERE taskId = 'T1' AND role = 'author'", [family]);
  f.db.run("UPDATE task_workflows SET authorFamily = ? WHERE taskId = 'T1'", [family]);
}

export function runningOrder(f: ReturnType<typeof autoFixture>, status = "claimed") {
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
    status, worker, leaseGen, leaseUntil, leaseMs, createdBy, createdAt, updatedAt, branch, base)
    VALUES ('old-running', 'T1', 'p', 'Peer', 'claude', 'fix', ?, ?, ?, 'o/r', '{}', '', '', ?, 'old-worker', 1, 1e12, 10000, 'scheduler', 1, 1, 'feat/T1', 'main')`)
    .run(f.task().specRev, f.task().round, f.task().headSHA!, status);
}

export function verdictRequest(o: LendOrder, verdict: "upheld" | "overturned" = "overturned"): ResultRequest {
  const value = { v: 1, orderId: o.orderId, gen: o.leaseGen, report: "A concrete assertion establishes the finding result.",
    session: { id: "fresh-arbiter-session", family: o.family }, arbitration: { verdict, head: o.head, specRev: o.specRev, round: o.round },
    verdict: { v: 1, orderId: o.orderId, head: o.head, verdict: verdict === "upheld" ? "changes" : "pass", p0: 0, p1: 0, p2: 0,
      findings: [], reportPath: "report.md" } };
  const parsed = parseLendRequest("result", value);
  expect(parsed.ok).toBe(true);
  return parsed.ok ? parsed.value as ResultRequest : (() => { throw new Error(parsed.error); })();
}

export const resultDeps = { reportDir: () => "/isolated/reviews", writeReport: () => {}, sign: () => ({ key: "test-key", sig: "test-signature" }) };

export async function arbitrationFixture(peers?: string[]) {
  const f = await repeatedFix(), head = "3".repeat(40);
  await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", head,
    "--disputes", JSON.stringify([{ findingId: P1.findingId, reason: "probe lacks an assertion" }]));
  await f.tick(); await f.review("changes", head, [P1]);
  const p = remoteProbe(f, peers), intent = p.plan();
  return { f, p, intent };
}
