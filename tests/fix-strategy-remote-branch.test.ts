import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClone } from "../src/lib/lend-clone.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { pushWork } from "../src/lib/lend-push.js";
import { recordAsked, advance, openLendJournal, LEND_JOURNAL_PATH } from "../src/lib/lend-journal.js";
import { orderWireOf, parseOrderWire } from "../src/lib/order-wire.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe, resultDeps } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { writeLendDeliver } from "../src/lib/ledger-lend-result.js";
import type { DeliverRequest } from "../src/lib/lend-wire.js";
import { testChildEnv } from "./test-env.js";
import { isolatedStateSuite } from "./isolated-state.js";

// pushWork 只读默认 journal 核绑定，只能走默认路径：整文件在独立状态目录的子进程里跑（i28-TJ1）
const { test } = isolatedStateSuite(import.meta.path);

function git(cwd: string, args: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: testChildEnv(env), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("real git custom-branch clone and fast-forward push require journal binding and reject an independently advanced remote head", async () => {
  const root = mkdtempSync(join(tmpdir(), "conv3-git-")), repo = join(root, "git", "o", "r.git"), seed = join(root, "seed"), lend = join(root, "lend");
  const env = { PATH: process.env.PATH!, HOME: root, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_LAB_ROOT: root,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@invalid",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@invalid" };
  expect(LEND_JOURNAL_PATH).not.toContain("/Users/shawn/.claude-orchestrator/");
  mkdirSync(repo, { recursive: true }); mkdirSync(seed);
  const db = openLendJournal(), orderId = `lend:T1:cv:${Date.now()}`, branch = "feat/T1";
  try {
    git(repo, ["init", "--bare", "-q", "-b", "main"], env); git(seed, ["init", "-q", "-b", branch], env);
    writeFileSync(join(seed, "code.txt"), "before\n"); git(seed, ["add", "code.txt"], env); git(seed, ["commit", "-q", "-m", "base"], env);
    const head = git(seed, ["rev-parse", "HEAD"], env); git(seed, ["push", "-q", repo, `${branch}:${branch}`], env);
    const wire = { ...orderWireOf({ taskId: "T1", specRev: 1, head, round: 4, node: "fix", step: "fix", dedupKey: orderId,
      inputs: ["fix"], outputs: ["commit"], acceptance: ["test"], writeBack: "deliver" }, { repo: "o/r", pr: 7 }),
      convergence: { kind: "fix" as const, intentId: "swap", branch, peer: "Peer", proto: 3 as const, held: true as const } };
    expect(parseOrderWire(wire).ok).toBe(true);
    const now = Date.now(); recordAsked(db, { orderId, peer: "A", fp: null, family: "codex", preview: {} }, now);
    advance(db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 3600_000,
      wire: { order: wire as unknown as Record<string, unknown>, text: "bound write order", write: { branch, base: "main" } } }, now);
    const clone = await prepareClone({ orderId, repo: "o/r", pr: 7, head, write: { branch, name: "test", email: "test@invalid" } }, { root: lend, env });
    expect(clone.ok).toBe(true); if (!clone.ok) throw new Error(clone.reason);
    advance(db, orderId, "claimed", "cloned", { dir: clone.dir }, now);
    writeFileSync(join(clone.dir, "fix.txt"), "fixed\n"); git(clone.dir, ["add", "fix.txt"], env); git(clone.dir, ["commit", "-q", "-m", "fix"], env);
    const fixed = git(clone.dir, ["rev-parse", "HEAD"], env), target = { orderId, repo: "o/r", branch, base: "main", cloneDir: clone.dir, orderHead: head, head: fixed };
    expect(await pushWork({ ...target, branch: "feat/unbound" }, { root: lend, env })).toMatchObject({ ok: false });
    db.run("UPDATE lend_orders SET leaseUntil = 1 WHERE orderId = ?", [orderId]);
    expect(await pushWork(target, { root: lend, env })).toMatchObject({ ok: false });
    db.run("UPDATE lend_orders SET leaseUntil = ? WHERE orderId = ?", [now + 3600_000, orderId]);
    writeFileSync(join(seed, "competing.txt"), "competitor\n"); git(seed, ["add", "competing.txt"], env); git(seed, ["commit", "-q", "-m", "competing"], env);
    const competing = git(seed, ["rev-parse", "HEAD"], env); git(seed, ["push", "-q", repo, `${branch}:${branch}`], env);
    expect(await pushWork(target, { root: lend, env })).toMatchObject({ ok: false, reason: "remote card branch head changed or cannot be verified" });
    expect(git(repo, ["rev-parse", branch], env)).toBe(competing);
    git(repo, ["update-ref", `refs/heads/${branch}`, head, competing], env);
    expect(await pushWork(target, { root: lend, env, run: async (argv, opts) => {
      const result = await runBounded(argv, opts);
      return argv[1] === "push" && result.code === 0 ? { ...result, code: 1, stderr: "response lost after publication" } : result;
    } })).toMatchObject({ ok: false, retry: true });
    expect(git(repo, ["rev-parse", branch], env)).toBe(fixed);
    expect(await pushWork(target, { root: lend, env })).toEqual({ ok: true });

  } finally {
    db.run("DELETE FROM lend_orders WHERE orderId = ?", [orderId]);
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});

for (const invalid of ["branch", "ended-lease", "old-proto", "lease-changes-during-head-check"] as const) {
  test(`A refuses a custom-branch delivery with ${invalid}`, async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f), intent = p.plan(); p.deps.localFamilyWait = () => "本机不接codex";
      await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps); await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      const o = remoteOrder(f.db, intent.id)!;
      claimLend(f.db, f.at("owner"), "Peer", { v: 1, orderId: o.orderId, worker: "writer" }, () => p.context.borrow[0]);
      const head = "5".repeat(40), req: DeliverRequest = { v: 1, orderId: o.orderId, gen: 1, branch: "feat/T1", pr: 7,
        session: { id: "new-peer-session", family: "codex" }, deliver: { v: 1, orderId: o.orderId, head, evidence: "report.md",
          summary: "复现测试：race，先红后绿", selfCheck: "checked" } };
      if (invalid === "branch") f.db.run("UPDATE tasks SET branch = 'feat/other' WHERE id = 'T1'");
      if (invalid === "ended-lease") f.db.run("UPDATE lend_write_leases SET state = 'ended' WHERE taskId = 'T1'");
      if (invalid === "old-proto") f.db.run("UPDATE lend_peers SET proto = 2 WHERE peer = 'Peer'");
      const deps = { ...resultDeps, peerFp: async () => "abcd-bbbb-cccc-dddd", remoteHead: async () => {
        if (invalid === "lease-changes-during-head-check") f.db.run("UPDATE lend_write_leases SET state = 'ended' WHERE taskId = 'T1'");
        return { ok: true as const, head };
      } };
      await expect(writeLendDeliver(f.db, f.at("owner"), "Peer", req, "body", deps)).rejects.toThrow();
      expect(f.task().stage).toBe("fix"); expect(f.task().headSHA).toBe(o.head);
    } finally { f.close(); }
  });
}

test("a guessed cv order number is not branch authorization, and malformed bindings are refused by the strict wire", () => {
  const head = "1".repeat(40), wire = orderWireOf({ taskId: "T1", specRev: 1, head, round: 1, node: "fix", step: "fix", dedupKey: "cv",
    inputs: [], outputs: [], acceptance: [], writeBack: "deliver" });
  expect(parseOrderWire({ ...wire, convergence: { kind: "fix", intentId: "swap", branch: "../main", peer: "P", proto: 3, held: true } }).ok).toBe(false);
  const binding = { kind: "fix", intentId: "swap", branch: "feat/T1", peer: "借出方", proto: 3, held: true };
  expect(parseOrderWire({ ...wire, convergence: binding }).ok).toBe(true);
  expect(parseOrderWire({ ...wire, convergence: { ...binding, peer: "0123456789abcdef0123456789abcdef01234567" } }).ok).toBe(false);
  expect(parseOrderWire({ ...wire, convergence: { ...binding, held: false } }).ok).toBe(false);
  expect(parseOrderWire({ ...wire, convergence: { kind: "arbitration", intentId: "arbiter", disputeSeq: 2, findingId: "finding",
    excludedSessions: ["lend:借出方:old-order"] }, node: "arbitration", step: "review" }).ok).toBe(true);
  const deliver = { v: 1, orderId: "ordinary", gen: 1, branch: "feat/T1", pr: 7, session: { id: "session", family: "codex" },
    deliver: { v: 1, orderId: "ordinary", head, evidence: "report.md", summary: "fixed", selfCheck: "checked" } };
  expect(parseLendRequest("result", deliver).ok).toBe(false);
});
