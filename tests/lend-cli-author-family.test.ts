/** Real isolated manager CLI, local bare Git remote and synthetic peer; no production config or actor override. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { writeLab, writeResources } from "./lend-write-fixture.js";

let resources: ReturnType<typeof writeResources>;
let lab: ReturnType<typeof writeLab>;
let db: ReturnType<typeof openLedger>;
let dbPath: string;
let fp: string;
let seq: number;
const manager = join(import.meta.dir, "../src/manager.ts");
const cli = (...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", manager, "ledger", ...args],
    { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" });
  const output = r.stdout.toString().trim().split("\n").at(-1)!;
  if (!output) throw new Error(r.stderr.toString());
  return JSON.parse(output) as Record<string, any>;
};
const peerCall = (ep: string, body: object) => cli(`lend-${ep}`, "--", "mate", JSON.stringify(body));
const offer = (...args: string[]) => cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--family", "claude", ...args);
const orders = () => listLendOrders(db, "T1");
function workflow(family: string | null = "claude") {
  db.run("DELETE FROM task_workflows WHERE taskId = 'T1'");
  if (family) db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T1', 'p', 'code', 2, 'manual', ?, 'manual', 1, 1, 1)`, [family]);
}
function hello(over: Record<string, unknown> = {}) {
  return peerCall("hello", { v: 1, proto: 3, boot: "fixture-boot", seq: ++seq, paused: null,
    slots: { claude: { total: 2, busy: 0 }, codex: { total: 2, busy: 0 } },
    grant: { until: Date.now() + 3600_000, roles: ["write", "review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 }, ...over });
}
function config(roles = ["write", "review"]) {
  writeFileSync(join(lab.env.CLAUDESTRA_STATE_DIR, "lend.json"), JSON.stringify({ version: 2, enabled: true, lend: [],
    borrow: [{ peer: "mate", fp, projects: ["p"], roles, maxOpen: 4 }] }));
}
function fixture() {
  resources = writeResources();
  lab = writeLab(resources);
  const state = lab.env.CLAUDESTRA_STATE_DIR;
  mkdirSync(join(lab.root, "peer"));
  const key = instanceKeySync(join(lab.root, "peer"))!;
  fp = keyFingerprint(key.publicKey);
  writeFileSync(join(state, "peers.json"), JSON.stringify({ httpPeers: [{ name: "mate", fp, publicKey: key.publicKey, addedAt: "" }], pendingInvites: [] }));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [lab.seed], createdAt: "" }] }));
  config();
  dbPath = join(state, "ledger.sqlite");
  db = openLedger(dbPath);
  const spec = join(lab.root, "T1.md");
  writeFileSync(spec, "Implement the card; validate the result.");
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "T1", kind: "code", spec });
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T1'");
  workflow();
  seq = 0;
  expect(hello()).toMatchObject({ ok: true });
}
beforeEach(fixture);
afterEach(async () => { closeLedger(dbPath); await resources.dispose(); });

function deliverBuild(family = "claude") {
  const o = orders().at(-1)!;
  expect(peerCall("claim", { v: 1, orderId: o.orderId, worker: "writer" })).toMatchObject({ ok: true, write: { base: "main" } });
  lab.git(lab.seed, "checkout", "-B", o.branch!, o.head);
  const head = lab.commit(lab.seed, `change-${orders().length}.txt`);
  lab.git(lab.seed, "push", "-q", lab.bare, o.branch!);
  const payload = { v: 1, orderId: o.orderId, gen: 1, branch: o.branch, pr: 7, session: { id: "peer-session", family },
    deliver: { v: 1, orderId: o.orderId, head, evidence: o.branch, summary: "Implemented", selfCheck: "Validated" } };
  return { head, payload, result: peerCall("write", payload) };
}

test("explicit Claude build → claim → deliver records real family and pinned identity; fix keeps Claude", () => {
  expect(offer()).toMatchObject({ ok: true, family: "claude", step: "write", base: "main" });
  const o = orders()[0];
  expect(o).toMatchObject({ family: "claude", head: lab.main, specRev: 1, round: 0, base: "main" });
  expect(getWriteLease(db, "T1")).toMatchObject({ state: "held", peer: "mate", fp });
  const wrong = deliverBuild("codex");
  expect(wrong.result).toMatchObject({ ok: false, current: { lend: "invalid" } });
  expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "deliver")).toHaveLength(0);
  wrong.payload.session.family = "claude";
  expect(peerCall("write", wrong.payload)).toMatchObject({ ok: true });
  expect(remoteHeadFamily(db, getTask(db, "T1")!)).toBe("claude");
  expect(listEvents(db, { target: "T1" }).find((e) => e.kind === "deliver")?.actor).toBe(`${fp}/writer`);
  const report = join(lab.root, "review.md");
  writeFileSync(report, "Fix the reviewed issue.");
  db.run(`INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, 'owner', 'p', 'T1', 'review', ?)`,
    [Date.now(), JSON.stringify({ path: report, findings: [] })]);
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T1'");
  workflow("codex"); // the delivered author, not the old workflow preference, owns the fix
  expect(offer()).toMatchObject({ ok: true, family: "claude", step: "fix" });
  expect(orders().at(-1)).toMatchObject({ head: wrong.head, round: 1, branch: o.branch });
  expect(deliverBuild().result).toMatchObject({ ok: true });
}, 30_000);

test("reclaimed new build starts at original remote head while PR base remains main", () => {
  expect(offer()).toMatchObject({ ok: true });
  const first = deliverBuild();
  expect(first.result).toMatchObject({ ok: true });
  lab.git(lab.seed, "push", "-q", lab.bare, `${first.head}:refs/heads/recovery-start`);
  expect(cli("lend-reclaim", "T1", "--reason", "recover")).toMatchObject({ ok: true });
  db.run("UPDATE tasks SET stage = 'build', round = 2 WHERE id = 'T1'");
  expect(offer("--base", "recovery-start")).toMatchObject({ ok: true, base: "main", family: "claude" });
  expect(orders().at(-1)).toMatchObject({ head: first.head, base: "main", round: 2 });
  expect(deliverBuild().result).toMatchObject({ ok: true });
}, 30_000);

test.each(["missing", "v2", "stale", "revoked", "role", "repo", "family", "busy", "expired", "paused", "fingerprint", "bad-json",
  "unknown-author", "wrong-author", "stale-workflow", "borrow", "missing-spec", "missing-head", "secret"])("refuses %s without a new order or lease", (bad) => {
  if (bad === "missing") db.run("DELETE FROM lend_peers");
  if (bad === "v2") expect(hello({ proto: 2 })).toMatchObject({ ok: true });
  if (bad === "stale") db.run("UPDATE lend_peers SET helloAt = 0");
  if (bad === "revoked") expect(hello({ grant: null })).toMatchObject({ ok: true });
  if (["role", "repo", "expired"].includes(bad)) {
    expect(hello({ grant: { until: bad === "expired" ? 1 : Date.now() + 3600_000, roles: bad === "role" ? ["review"] : ["write"],
      repos: bad === "repo" ? ["other/repo"] : ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } })).toMatchObject({ ok: true });
  }
  if (["family", "busy"].includes(bad)) expect(hello({ slots: {
    claude: { total: bad === "family" ? 0 : 2, busy: bad === "busy" ? 2 : 0 }, codex: { total: 2, busy: 0 },
  } })).toMatchObject({ ok: true });
  if (bad === "paused") expect(hello({ paused: { reason: "paused", until: Date.now() + 3600_000 } })).toMatchObject({ ok: true });
  if (bad === "fingerprint") db.run("UPDATE lend_peers SET fp = 'aaaa-bbbb-cccc-dddd'");
  if (bad === "bad-json") db.run("UPDATE lend_peers SET slots = '{'");
  if (bad === "unknown-author") workflow(null);
  if (bad === "wrong-author") workflow("codex");
  if (bad === "stale-workflow") db.run("UPDATE task_workflows SET specRev = 99");
  if (bad === "borrow") config(["review"]);
  if (bad === "missing-spec") db.run("UPDATE tasks SET spec = 'missing.md'");
  if (bad === "secret") writeFileSync(join(lab.root, "T1.md"), "token: ghp_" + "Ab12".repeat(8));
  expect(offer(...(bad === "missing-head" ? ["--base", "absent"] : []))).toMatchObject({ ok: false });
  expect(orders()).toEqual([]);
  expect(getWriteLease(db, "T1")).toBeNull();
}, 15_000);

test.each(["pooled", "claimed", "unknown", "lease-peer", "lease-repo"])("%s refuses a second write without changing existing rows", (state) => {
  expect(offer()).toMatchObject({ ok: true });
  const id = orders()[0].orderId;
  if (state === "claimed" || state === "unknown") {
    expect(peerCall("claim", { v: 1, orderId: id, worker: "writer" })).toMatchObject({ ok: true });
    if (state === "unknown") expect(peerCall("lease", {
      v: 1, orderId: id, gen: 1, action: "release", reason: "stopped", detail: null,
    })).toMatchObject({ ok: true });
  }
  if (state.startsWith("lease-")) {
    expect(cli("lend-cancel", "T1", "--reason", "fixture cancel")).toMatchObject({ ok: true });
    if (state === "lease-peer") db.run("UPDATE lend_write_leases SET peer = 'other'");
    else db.run("UPDATE lend_write_leases SET repo = 'other/repo'");
  }
  const before = orders(), lease = getWriteLease(db, "T1");
  expect(offer()).toMatchObject({ ok: false, code: "conflict" });
  expect(orders()).toEqual(before);
  expect(getWriteLease(db, "T1")).toEqual(lease);
}, 15_000);

test("a refused reoffer preserves the original order; default Codex still works without hello or workflow", () => {
  expect(offer()).toMatchObject({ ok: true });
  expect(hello({ grant: null })).toMatchObject({ ok: true });
  const before = orders(), lease = getWriteLease(db, "T1");
  expect(cli("lend-reoffer", "T1", "--peer", "mate", "--repo", "o/r", "--family", "claude", "--reason", "recheck"))
    .toMatchObject({ ok: false });
  expect(orders()).toEqual(before);
  expect(getWriteLease(db, "T1")).toEqual(lease);
  expect(cli("lend-reclaim", "T1", "--reason", "recover")).toMatchObject({ ok: true });
  workflow(null);
  db.run("DELETE FROM lend_peers");
  expect(cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r")).toMatchObject({ ok: true, family: "codex" });
}, 15_000);

test("delivered Codex beats a Claude workflow for the next build; the flag cannot invent Claude provenance", () => {
  expect(cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r")).toMatchObject({ ok: true, family: "codex" });
  expect(deliverBuild("codex").result).toMatchObject({ ok: true });
  expect(cli("lend-reclaim", "T1", "--reason", "recover")).toMatchObject({ ok: true });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  const before = orders(), lease = getWriteLease(db, "T1");
  expect(offer()).toMatchObject({ ok: false, code: "forbidden" });
  expect(orders()).toEqual(before);
  expect(getWriteLease(db, "T1")).toEqual(lease);
}, 15_000);

test.each(["grant", "family", "specRev", "round", "head", "borrow", "pin", "pin-read", "read-error"])("material I/O changing %s is checked again before any write", async (change) => {
  const { runLedger } = await import("../src/manager/ledger.js");
  let currentFp: string | null = fp;
  let roles: ("write" | "review")[] = ["write", "review"];
  const result = await runLedger(["lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--family", "claude"], {
    db, actor: "owner", projectIds: ["p"], now: Date.now,
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
    lend: { borrow: async () => [{ peer: "mate", projects: ["p"], roles, maxOpen: 4 }], notifyPm: async () => {}, result: {
      reportDir: () => lab.root, writeReport: writeFileSync, sign: () => null, peerFp: async () => currentFp,
      remoteHead: async () => {
        if (change === "grant") db.run("UPDATE lend_peers SET grant = NULL");
        if (change === "family") workflow("codex");
        if (change === "specRev") db.run("UPDATE tasks SET specRev = specRev + 1");
        if (change === "round") db.run("UPDATE tasks SET round = round + 1");
        if (change === "head") db.run("UPDATE tasks SET headSHA = ?", ["a".repeat(40)]);
        if (change === "pin") currentFp = "aaaa-bbbb-cccc-dddd";
        if (change === "pin-read") currentFp = null;
        if (change === "borrow") roles = ["review"];
        if (change === "read-error") return { ok: false as const, error: "fixture read failure" };
        return { ok: true as const, head: lab.main };
      },
    } },
  });
  expect(result).toMatchObject({ ok: false });
  expect(orders()).toEqual([]);
  expect(getWriteLease(db, "T1")).toBeNull();
});
