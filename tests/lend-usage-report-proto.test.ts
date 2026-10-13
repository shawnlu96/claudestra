/** LENDUSAGE1 r2: LEND_PROTO 3→4 must keep the hello-gated write paths open for an upgraded peer (manual Claude write, reborrow). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { offerLend, reclaimLend } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { offerWithAuthorFamily } from "../src/lib/lend-cli-author-family.js";
import { assertReborrowAuthority, captureReborrowFacts } from "../src/lib/lend-reborrow-facts.js";
import { LEND_PROTO } from "../src/lib/lend-wire-v2-schema.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";

const project = "p", taskId = "PROTO", peer = "mate", repo = "owner/repo", fp = "abcd-ef01-2345-6789", now = 100_000;
const head = "b".repeat(40), pm = { actor: "agent-pm", now };
const borrow: BorrowEntry = { peer, projects: [project], roles: ["write"], maxOpen: 4 };
let db: Database, seq = 0;

const hello = (proto: number) => recordHello(db, peer, fp, { v: 1, proto, boot: "test-boot", seq: ++seq,
  grant: { until: now + 100_000, repos: [repo], roles: ["write"], ordersPerDay: 10, ordersLeftToday: 10 },
  slots: { codex: { total: 4, busy: 0 }, claude: { total: 4, busy: 0 } }, paused: null }, now);
const stored = () => (db.query("SELECT proto FROM lend_peers WHERE peer = ?").get(peer) as { proto: number }).proto;
const input = (family: "claude" | "codex") => ({ taskId, peer, repo, family, pr: null, spec: "Implement the card", borrow,
  write: { fp, base: "main", baseSha: head, report: "" } });

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now }, { project, key: "pms", value: [pm.actor] });
  const task = createTask(db, { actor: "owner", now: now - 100 }, { project, id: taskId, title: "Proto", kind: "code" }).row;
  setTask(db, { actor: "owner", now }, { id: taskId, rev: task.rev, patch: { branch: "lend/PROTO-abcd", headSHA: head } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = ?", [taskId]);
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES (?, ?, 'code', 2, 'manual', 'claude', 'manual', 1, 1, 1)`, [taskId, project]);
});
afterEach(() => closeLedger(":memory:"));

describe("[验收线 2] hello proto 4 keeps write capability checks", () => {
  test("this build announces 4", () => expect(LEND_PROTO).toBe(4));

  test.each([3, 4])("manual Claude write order accepts a proto %i hello", (proto) => {
    hello(proto);
    expect(offerWithAuthorFamily(db, pm, getTask(db, taskId)!, input("claude"))).toMatchObject({ family: "claude", peer });
  });

  test("manual Claude write order still refuses a proto 2 hello", () => {
    hello(2);
    expect(() => offerWithAuthorFamily(db, pm, getTask(db, taskId)!, input("claude"))).toThrow("v3");
  });

  test.each([["claude", 3], ["claude", 4], ["codex", 2], ["codex", 3], ["codex", 4]] as const)("reborrow %s accepts proto %i", (family, proto) => {
    db.run("UPDATE task_workflows SET authorFamily = ?", [family]);
    hello(3);
    offerLend(db, { ...pm, now: now - 20 }, input(family));
    reclaimLend(db, pm, { taskId, reason: "preserve checkpoint before resuming" });
    db.run("UPDATE tasks SET stage = 'fix' WHERE id = ?", [taskId]);
    hello(proto);
    expect(stored()).toBe(proto);
    const facts = captureReborrowFacts(db, taskId, peer, repo);
    expect(facts.family).toBe(family);
    expect(() => assertReborrowAuthority(db, facts, pm.actor, borrow, fp, now)).not.toThrow();
  });

  test("reborrow Claude still refuses proto 2", () => {
    hello(3);
    offerLend(db, { ...pm, now: now - 20 }, input("claude"));
    reclaimLend(db, pm, { taskId, reason: "preserve checkpoint before resuming" });
    db.run("UPDATE tasks SET stage = 'fix' WHERE id = ?", [taskId]);
    hello(2);
    expect(stored()).toBe(2);
    expect(() => assertReborrowAuthority(db, captureReborrowFacts(db, taskId, peer, repo), pm.actor, borrow, fp, now)).toThrow("hello");
  });
});
