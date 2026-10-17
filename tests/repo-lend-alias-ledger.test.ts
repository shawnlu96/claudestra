import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { setRepoAliasForTest } from "../src/lib/repo-alias.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { offerLend, pollLend, cancelLend, claimLend, leaseLend } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { offerWithAuthorFamily } from "../src/lib/lend-cli-author-family.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";

const old = "shawnlu96/claudestra", renamed = "floka-ai/floka", now = 100_000;
const peer = "mate", fp = "abcd-ef01-2345-6789", head = "b".repeat(40);
const pm = { actor: "agent-pm", now };
const borrow: BorrowEntry = { peer, projects: ["p"], roles: ["write", "review"], maxOpen: 4 };
afterEach(() => { setRepoAliasForTest({ mode: null, sink: null }); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

function fixture(repo: string, grant: string) {
  // LENDBACK1's lendReturnLocal (on by default) drops the pin on every not-started return (tests/lend-return-local.test.ts);
  // with it off, send-back keeps the pin exactly when the peer's grant still covers the repo — the alias rule under test here.
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendReturnLocal: "off" } } } }));
  const db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now }, { project: "p", key: "pms", value: [pm.actor] });
  createTask(db, { actor: "owner", now }, { project: "p", id: "ALIAS", title: "Alias", kind: "code" });
  db.run("UPDATE tasks SET extra = ?", [JSON.stringify({ placement: "peer:mate" })]);
  db.run("UPDATE tasks SET stage = 'build', headSHA = ? WHERE id = 'ALIAS'", [head]);
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('ALIAS', 'p', 'code', 2, 'manual', 'claude', 'manual', 1, 1, 1)`);
  recordHello(db, peer, fp, { v: 1, proto: 3, boot: "test-boot", seq: 1, paused: null,
    grant: { until: now + 100_000, repos: [grant], roles: ["write", "review"], ordersPerDay: 10, ordersLeftToday: 10 },
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 4, busy: 0 } } }, now);
  const input = { taskId: "ALIAS", peer, repo, family: "claude" as const, pr: null, spec: "Implement alias",
    borrow, write: { fp, base: "main", baseSha: head, report: "" } };
  return { db, input };
}

function releaseUnstarted(db: ReturnType<typeof openLedger>, orderId: string) {
  claimLend(db, pm, peer, { v: 1, orderId, worker: "writer" }, () => borrow);
  leaseLend(db, pm, peer, { v: 1, orderId, gen: 1, action: "release", reason: "not_started", detail: null });
}

for (const mode of ["off", "observe", "on"] as const) {
  for (const [repo, grant] of [[old, renamed], [renamed, old], [old, old],
    ["shawnlu96/other", renamed], ["floka-ai/other", old], ["fork/floka", old], ["fork/claudestra", renamed]]) {
    const allowed = repo === grant || mode === "on" && [old, renamed].includes(repo);
    test(`[2,4] ${mode}: pool and send-back authorization ${repo} -> ${grant}`, () => {
      setRepoAliasForTest({ mode, sink: () => {} });
      const { db, input } = fixture(repo, grant);
      try {
        const order = offerLend(db, pm, input);
        const req = { v: 1 as const, capacity: { families: { claude: 4 }, busy: {}, roles: ["write" as const],
          repos: [grant], ordersLeftToday: 10 } };
        const result = pollLend(db, peer, req, () => borrow, now);
        expect(result.orders.length).toBe(allowed ? 1 : 0);
        if (allowed) expect(result.orders[0].repo).toBe(repo);
        releaseUnstarted(db, order.orderId);
        expect(getTask(db, "ALIAS")!.extra.placement).toBe(allowed ? "peer:mate" : undefined);
      } finally { closeLedger(":memory:"); }
    });
    test(`[2,4] ${mode}: send-back alone preserves only authorized placement ${repo} -> ${grant}`, () => {
      setRepoAliasForTest({ mode, sink: () => {} });
      const { db, input } = fixture(repo, grant);
      try {
        const order = offerLend(db, pm, input);
        releaseUnstarted(db, order.orderId);
        expect(getTask(db, "ALIAS")!.extra.placement).toBe(allowed ? "peer:mate" : undefined);
      } finally { closeLedger(":memory:"); }
    });
    test(`[3,4] ${mode}: held lease alone ${repo} -> ${grant}`, () => {
      setRepoAliasForTest({ mode, sink: () => {} });
      const { db, input } = fixture(repo, repo);
      try {
        offerLend(db, pm, input);
        cancelLend(db, pm, { taskId: "ALIAS", reason: "reoffer" });
        db.run("UPDATE lend_write_leases SET repo = ?", [grant]);
        const write = () => offerWithAuthorFamily(db, pm, getTask(db, "ALIAS")!, input);
        if (allowed) expect(write()).toMatchObject({ repo });
        else expect(write).toThrow("仓库与挂单不符");
      } finally { closeLedger(":memory:"); }
    });
    test(`[3,4] ${mode}: manual writer grant and held lease ${repo} -> ${grant}`, () => {
      setRepoAliasForTest({ mode, sink: () => {} });
      const { db, input } = fixture(repo, grant);
      try {
        const order = offerLend(db, pm, input);
        cancelLend(db, pm, { taskId: "ALIAS", reason: "test reoffer with held lease" });
        db.run("UPDATE lend_write_leases SET repo = ?", [grant]);
        const write = () => offerWithAuthorFamily(db, pm, getTask(db, "ALIAS")!, input);
        if (allowed) expect(write()).toMatchObject({ repo, family: "claude", branch: order.branch });
        else expect(write).toThrow();
        expect(db.query("SELECT repo FROM lend_write_leases").get()).toEqual({ repo: grant });
      } finally { closeLedger(":memory:"); }
    });
  }
}
