/** Real manager processes, file ledger, isolated git and two fake authenticated peers drive `lend-offer --reborrow2`. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import { getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
import { endWriteLease, getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { classifyReserved } from "../src/lib/lend-reborrow2-marker.js";
import { writeLab, writeResources } from "./lend-write-fixture.js";

let resources: ReturnType<typeof writeResources>, lab: ReturnType<typeof writeLab>;
let db: ReturnType<typeof openLedger>, dbPath: string, fps: Record<string, string>, oldId: string, oldBranch: string;
const manager = join(import.meta.dir, "../src/manager.ts");
function parse(r: { stdout: Buffer; stderr: Buffer }) {
  const line = r.stdout.toString().trim().split("\n").at(-1);
  if (!line) throw new Error(r.stderr.toString());
  return JSON.parse(line) as Record<string, any>;
}
const cli = (...args: string[]) => parse(Bun.spawnSync([process.execPath, "--no-env-file", manager, "ledger", ...args], { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" }));
const peer = (name: string, ep: string, body: object) => cli(`lend-${ep}`, "--", name, JSON.stringify({ v: 1, ...body }));
const snapshot = () => JSON.stringify([getTask(db, "T1"), listLendOrders(db, "T1"), getWriteLease(db, "T1"), listEvents(db, { target: "T1" })]);
const rb2 = (p: string, ...extra: string[]) => cli("lend-offer", "T1", "--peer", p, "--repo", "o/r", "--reborrow2", "--ended-order", oldId, "--family", "codex", ...extra);

function fakeGh() {
  const bin = join(lab.root, "bin"); mkdirSync(bin);
  const file = join(bin, "gh");
  writeFileSync(file, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='pr'&&a[1]==='list') console.log('[]');\nelse process.exit(1);\n`);
  chmodSync(file, 0o755); lab.env.PATH = `${bin}:${lab.env.PATH}`;
}

beforeEach(() => {
  resources = writeResources(); lab = writeLab(resources);
  const state = lab.env.CLAUDESTRA_STATE_DIR;
  const keys = Object.fromEntries(["mate", "pal"].map((n) => { const d = join(lab.root, `${n}-key`); mkdirSync(d); return [n, instanceKeySync(d)!]; }));
  fps = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, keyFingerprint(k.publicKey)]));
  const configs = {
    "peers.json": { httpPeers: Object.entries(keys).map(([name, k]) => ({ name, fp: fps[name], publicKey: k.publicKey, addedAt: "" })), pendingInvites: [] },
    "registry.json": { socket: "", agents: {} },
    "projects.json": { projects: [{ id: "p", name: "p", dirs: [lab.seed], createdAt: "" }] },
    "lend.json": { version: 2, enabled: true, lend: [], borrow: ["mate", "pal"].map((p) => ({ peer: p, fp: fps[p], projects: ["p"], roles: ["write"], maxOpen: 4 })) },
  };
  for (const [name, value] of Object.entries(configs)) writeFileSync(join(state, name), JSON.stringify(value));
  dbPath = join(state, "ledger.sqlite"); db = openLedger(dbPath);
  const spec = join(lab.root, "spec.md"); writeFileSync(spec, "Keep every original acceptance line.");
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "Recovery", kind: "code", spec });
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T1'");
  for (const p of ["mate", "pal"]) {
    expect(peer(p, "hello", { proto: 3, boot: `${p}-boot`, seq: 1, paused: null, slots: { codex: { total: 4, busy: 0 }, claude: { total: 0, busy: 0 } },
      grant: { until: Date.now() + 3600_000, roles: ["write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } })).toMatchObject({ ok: true });
  }
  const offered = cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r"); expect(offered.ok).toBe(true);
  oldId = offered.orderId; oldBranch = offered.branch;
  expect(peer("mate", "claim", { orderId: oldId, worker: "writer" }).ok).toBe(true);
  fakeGh();
});
afterEach(async () => { closeLedger(dbPath); await resources.dispose(); });

test("checkout never started: cross-peer dry-run is read-only, apply binds a new branch at the original start, replay is one order", () => {
  expect(peer("mate", "lease", { orderId: oldId, gen: 1, action: "release", reason: "not_started", detail: "checkout 未启动" }).ok).toBe(true);
  expect(getWriteLease(db, "T1")?.state).toBe("ended");
  const oldRow = getLendOrder(db, oldId)!, before = snapshot();
  expect(rb2("pal")).toMatchObject({ ok: true, dryRun: true, end: "not_started", samePeer: false, oldHead: null, startHead: oldRow.head });
  expect(snapshot()).toBe(before);
  const r = rb2("pal", "--apply");
  expect(r).toMatchObject({ ok: true, peer: "pal", head: oldRow.head, supersedes: oldId });
  const claimed = peer("pal", "claim", { orderId: r.orderId, worker: "writer" });
  expect(claimed).toMatchObject({ ok: true, order: { head: oldRow.head, pr: null }, write: { base: "main", branch: `lend/T1-${fps.pal.slice(0, 4)}` } });
  expect(classifyReserved(claimed.order.acceptance)).toMatchObject({ kind: "v2", binding: { peer: "cross", end: "not_started", src: oldBranch } });
  expect(getLendOrder(db, oldId)).toEqual(oldRow);
  expect(rb2("pal", "--apply")).toMatchObject({ ok: true, duplicate: true, orderId: r.orderId });
}, 60_000);

test("push timeout: same peer resumes the pushed WIP head; cross peer and missing flags are refused without writes", () => {
  lab.git(lab.seed, "checkout", "-q", "-B", oldBranch);
  const wip = lab.commit(lab.seed, "wip.txt"); lab.git(lab.seed, "push", "-q", lab.bare, oldBranch);
  expect(peer("mate", "lease", { orderId: oldId, gen: 1, action: "release", reason: "stopped", detail: "推送超时" }).ok).toBe(true);
  expect(cli("lend-cancel", "T1", "--reason", "PM 结清推送超时").ok).toBe(true);
  endWriteLease(db, "T1", "派不回去：推送超时", Date.now());
  const before = snapshot();
  expect(rb2("pal", "--apply").ok).toBe(false);
  expect(cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--reborrow2", "--ended-order", oldId, "--apply").ok).toBe(false);
  expect(cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--reborrow", "--reborrow2", "--reclaim", "1").ok).toBe(false);
  expect(snapshot()).toBe(before);
  const r = rb2("mate", "--apply");
  expect(r).toMatchObject({ ok: true, peer: "mate", head: wip, end: "stopped", samePeer: true, oldHead: wip });
  expect(getLendOrder(db, r.orderId)?.reborrow2Basis).toMatchObject({ previousOrderId: oldId, gen: 1, samePeer: true });
}, 60_000);

test("a refused canonical write (evidence append) leaves no order and no lease projection", () => {
  expect(peer("mate", "lease", { orderId: oldId, gen: 1, action: "release", reason: "not_started", detail: "checkout 未启动" }).ok).toBe(true);
  db.run(`CREATE TRIGGER reject_rb2 BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.lend.op')='write_reborrow2' BEGIN SELECT RAISE(ABORT,'rollback probe'); END`);
  const before = snapshot();
  expect(rb2("mate", "--apply").ok).toBe(false);
  expect(snapshot()).toBe(before);
}, 60_000);
