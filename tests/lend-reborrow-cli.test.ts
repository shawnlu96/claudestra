/** Real manager processes plus isolated git and a fake network adapter connecting the provider to canonical borrower CLI. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import { getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { writeLab, writeResources } from "./lend-write-fixture.js";
import { harness } from "./lend-harness.js";
import { advance, getOrder, recordAsked } from "../src/lib/lend-journal.js";
import { claimOrder } from "../src/lib/lend-drive.js";
let resources: ReturnType<typeof writeResources>, lab: ReturnType<typeof writeLab>;
let db: ReturnType<typeof openLedger>, dbPath: string, fp: string, reclaimSeq: number, reviewed: string, remote: string, branch: string, oldId: string;
const manager = join(import.meta.dir, "../src/manager.ts");
function parse(r: { stdout: Buffer; stderr: Buffer }) {
  const line = r.stdout.toString().trim().split("\n").at(-1);
  if (!line) throw new Error(r.stderr.toString());
  return JSON.parse(line) as Record<string, any>;
}
const argv = (...args: string[]) => [process.execPath, "--no-env-file", manager, "ledger", ...args];
const cli = (...args: string[]) => parse(Bun.spawnSync(argv(...args), { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" }));
const peer = (ep: string, body: object) => cli(`lend-${ep}`, "--", "mate", JSON.stringify({ v: 1, ...body }));
const flags = () => ["lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--reborrow", "--reclaim", String(reclaimSeq)];
const recovery = (...extra: string[]) => cli(...flags(), ...extra);
const orders = () => listLendOrders(db, "T1");
const snapshot = () => JSON.stringify([getTask(db, "T1"), orders(), getWriteLease(db, "T1"), listEvents(db, { target: "T1" })]);
function claim(id: string) { return peer("claim", { orderId: id, worker: "writer" }); }
function deliver(id: string, head: string) {
  return peer("write", { orderId: id, gen: 1, branch, pr: 7, session: { id: "real-isolated-session", family: "codex" },
    deliver: { v: 1, orderId: id, head, evidence: branch, summary: "Recovered", selfCheck: "Original requirements and findings retained" } });
}
function fakeGh() {
  const bin = join(lab.root, "bin"); mkdirSync(bin);
  const file = join(bin, "gh");
  writeFileSync(file, `#!${process.execPath}\nconst a=process.argv.slice(2);\n` +
    `if(a[0]==='pr'&&a[1]==='list') console.log(JSON.stringify([{number:7,url:'https://github.com/o/r/pull/7',` +
    `headRefName:${JSON.stringify(branch)},headRefOid:${JSON.stringify(remote)},baseRefName:'main',isCrossRepository:false}]));\nelse process.exit(1);\n`);
  chmodSync(file, 0o755); lab.env.PATH = `${bin}:${lab.env.PATH}`;
}
beforeEach(() => {
  resources = writeResources(); lab = writeLab(resources);
  const state = lab.env.CLAUDESTRA_STATE_DIR, keyDir = join(lab.root, "peer-key"); mkdirSync(keyDir);
  const key = instanceKeySync(keyDir)!; fp = keyFingerprint(key.publicKey);
  const configs = {
    "peers.json": { httpPeers: [{ name: "mate", fp, publicKey: key.publicKey, addedAt: "" }], pendingInvites: [] },
    "registry.json": { socket: "", agents: {} },
    "projects.json": { projects: [{ id: "p", name: "p", dirs: [lab.seed], createdAt: "" }] },
    "lend.json": { version: 2, enabled: true, lend: [], borrow: [{ peer: "mate", fp, projects: ["p"], roles: ["write"], maxOpen: 4 }] },
  };
  for (const [name, value] of Object.entries(configs)) writeFileSync(join(state, name), JSON.stringify(value));
  dbPath = join(state, "ledger.sqlite"); db = openLedger(dbPath);
  const spec = join(lab.root, "spec.md"); writeFileSync(spec, "Preserve checkpoints and every original acceptance.");
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "Recovery", kind: "code", spec });
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T1'");
  expect(peer("hello", { proto: 3, boot: "fixture-boot", seq: 1, paused: null,
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: Date.now() + 3600_000, roles: ["write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } })).toMatchObject({ ok: true });
  const offered = cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r"); expect(offered.ok).toBe(true);
  branch = offered.branch;
  expect(claim(offered.orderId).ok).toBe(true);
  lab.git(lab.seed, "checkout", "-B", branch);
  reviewed = lab.commit(lab.seed, "reviewed.txt"); lab.git(lab.seed, "push", "-q", lab.bare, branch);
  expect(deliver(offered.orderId, reviewed).ok).toBe(true);
  const path = join(lab.root, "original-review.md"); writeFileSync(path, "P0 keep-auth\nP1 keep-data\nOriginal acceptance remains unfinished.");
  db.run("INSERT INTO events (ts,actor,project,target,kind,data) VALUES (?, 'reviewer','p','T1','review',?)", [Date.now(), JSON.stringify({
    round: 0, verdict: "changes", path, head: reviewed, reviewerSessionId: "original-review-session", reviewerFamily: "claude",
    findings: [{ findingId: "keep-auth", family: "security", severity: "P0", probe: "auth" },
      { findingId: "keep-data", family: "data", severity: "P1", probe: "checkpoint" }],
  })]);
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T1'");
  const fix = cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r"); expect(fix.ok).toBe(true);
  oldId = fix.orderId; expect(claim(oldId).ok).toBe(true);
  remote = lab.commit(lab.seed, "unsubmitted-checkpoint.txt"); lab.git(lab.seed, "push", "-q", lab.bare, branch);
  expect(cli("lend-reclaim", "T1", "--reason", "PM recovery").ok).toBe(true);
  reclaimSeq = listEvents(db, { target: "T1" }).findLast((e) => (e.data.lend as any)?.op === "reclaim")!.seq;
  fakeGh();
});
afterEach(async () => { closeLedger(dbPath); await resources.dispose(); });

test("real CLI dry-run/apply/claim/deliver preserves original report basis and old PR main", () => {
  const before = snapshot();
  expect(recovery()).toMatchObject({ ok: true, dryRun: true, reviewedHead: reviewed, remoteHead: remote, gen: 1 });
  expect(snapshot()).toBe(before);
  const r = recovery("--apply"); expect(r).toMatchObject({ ok: true, head: remote, supersedes: oldId, base: "main" });
  expect(getTask(db, "T1")).toMatchObject({ headSHA: reviewed, stage: "fix", round: 1, pr: "https://github.com/o/r/pull/7" });
  const o = getLendOrder(db, r.orderId)!;
  expect(o.wire.inputs.join("\n")).toContain("Original acceptance remains unfinished");
  expect(o.wire.findings.map((f) => f.findingId)).toEqual(["keep-auth", "keep-data"]);
  expect(o.reborrowBasis?.ledgerHead).toBe(reviewed);
  expect(claim(o.orderId)).toMatchObject({ ok: true, order: { head: remote, pr: 7 }, write: { base: "main" } });
  const head = lab.commit(lab.seed, "fixed.txt"); lab.git(lab.seed, "push", "-q", lab.bare, branch);
  expect(deliver(o.orderId, head).ok).toBe(true);
  expect(getTask(db, "T1")).toMatchObject({ stage: "review", headSHA: head });
  expect(recovery("--apply")).toMatchObject({ ok: true, duplicate: true, orderId: o.orderId, status: "done" });
  expect(listEvents(db, { target: "T1" }).find((e) => e.kind === "review")?.data).toMatchObject({ head: reviewed, reviewerSessionId: "original-review-session" });
}, 30_000);

test.each(["active", "unknown", "different-peer", "revoked", "wrong-basis", "rollback"])("real CLI %s refuses without a partial order or lease", (bad) => {
  if (bad === "active" || bad === "unknown") db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [bad === "active" ? "claimed" : "unknown", oldId]);
  if (bad === "revoked") db.run("UPDATE lend_peers SET grant = NULL");
  if (bad === "wrong-basis") db.run("UPDATE tasks SET headSHA = ? WHERE id='T1'", ["f".repeat(40)]);
  if (bad === "rollback") db.run(`CREATE TRIGGER reject_reborrow BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.lend.op')='write_reborrow'
    BEGIN SELECT RAISE(ABORT,'rollback probe'); END`);
  const before = snapshot();
  expect(recovery("--apply", ...(bad === "different-peer" ? ["--peer", "other"] : [])).ok).toBe(false);
  expect(snapshot()).toBe(before);
}, 30_000);

test("two real CLI processes create exactly one successor", async () => {
  const run = async () => {
    const child = Bun.spawn(argv(...flags(), "--apply"), { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return parse({ stdout: Buffer.from(out), stderr: Buffer.from(err) });
  };
  const result = await Promise.all([run(), run()]);
  expect(result.every((r) => r.ok)).toBe(true);
  expect(result[0].orderId).toBe(result[1].orderId);
  expect(orders().filter((o) => o.supersedes === oldId)).toHaveLength(1);
}, 30_000);

test.each(["unknown", "pending", "missing"])("provider %s after real A claim releases canonical A lease and never starts", async (bad) => {
  const r = recovery("--apply"); expect(r.ok).toBe(true);
  const h = harness();
  try {
    const o = getLendOrder(db, r.orderId)!, old = getLendOrder(db, oldId)!;
    recordAsked(h.db, { orderId: oldId, peer: "mate", fp, family: "codex", preview: {} });
    advance(h.db, oldId, "asked", "claimed", { leaseGen: 1, wire: { order: { ...old.wire }, text: old.text, write: { branch, base: "main" } } });
    advance(h.db, oldId, "claimed", "cancelled", { ...(bad === "pending" ? { payload: { waiting: true } } : {}) });
    if (bad === "missing") h.db.run("DELETE FROM lend_orders WHERE orderId = ?", [oldId]);
    recordAsked(h.db, { orderId: o.orderId, peer: "mate", fp, family: "codex", preview: {
      taskId: o.taskId, head: o.head, repo: o.repo, pr: o.pr, step: o.step } });
    h.d.selfFp = () => fp; h.d.worker.alive = async () => "unknown";
    h.d.call = async (_p, ep, body) => ({ status: 200, body: peer(ep === "result" ? "write" : ep, body) });
    await claimOrder(getOrder(h.db, o.orderId)!, h.d);
    expect(getOrder(h.db, o.orderId)?.state).toBe("released");
    expect(getLendOrder(db, o.orderId)?.status).toBe("released");
    expect(getWriteLease(db, "T1")?.state).toBe("ended");
    expect(h.log.created).toHaveLength(0);
  } finally { h.db.close(); }
}, 30_000);

test.each(["clean", "dirty", "unpublished", "unsubmitted-report"])("real provider checkpoint preservation and formal claim: %s", async (condition) => {
  const applied = recovery("--apply"); expect(applied.ok).toBe(true);
  const old = getLendOrder(db, oldId)!, next = getLendOrder(db, applied.orderId)!;
  const code = `
    import { harness } from ${JSON.stringify(join(import.meta.dir, "lend-harness.ts"))};
    import { prepareClone } from ${JSON.stringify(join(import.meta.dir, "../src/lib/lend-clone.ts"))};
    import { advance, getOrder, recordAsked } from ${JSON.stringify(join(import.meta.dir, "../src/lib/lend-journal.ts"))};
    import { claimOrder } from ${JSON.stringify(join(import.meta.dir, "../src/lib/lend-drive.ts"))};
    import { writeFileSync, readdirSync } from 'node:fs';
    const old=${JSON.stringify(old)}, next=${JSON.stringify(next)}, condition=${JSON.stringify(condition)};
    const h=harness();
    const got=await prepareClone({orderId:old.orderId,repo:old.repo,pr:old.pr,head:next.head,
      write:{branch:old.branch,name:'fixture',email:'fixture@example.invalid'}});
    if(!got.ok) throw new Error(got.reason);
    if(condition==='dirty'||condition==='unpublished') writeFileSync(got.dir+'/unpublished.txt','checkpoint');
    if(condition==='unsubmitted-report') writeFileSync(got.dir+'/summary.txt','unsubmitted artifact');
    if(condition==='unpublished') {
      for(const args of [['add','unpublished.txt'],['commit','-qm','unpublished']]) {
        const p=Bun.spawnSync(['git',...args],{cwd:got.dir}); if(p.exitCode) throw new Error(p.stderr.toString());
      }
    }
    for(const o of [old,next]) recordAsked(h.db,{orderId:o.orderId,peer:'mate',fp:${JSON.stringify(fp)},family:o.family,
      preview:{taskId:o.taskId,head:o.head,repo:o.repo,pr:o.pr,step:o.step}});
    advance(h.db,old.orderId,'asked','claimed',{leaseGen:1,dir:got.dir,wire:{order:old.wire,text:old.text,write:{branch:old.branch,base:'main'}}});
    advance(h.db,old.orderId,'claimed','cancelled',{});
    h.d.selfFp=()=>${JSON.stringify(fp)};
    h.d.call=async(_peer,op,body)=>{
      const p=Bun.spawnSync([process.execPath,'--no-env-file',${JSON.stringify(manager)},'ledger','lend-'+(op==='result'?'write':op),
        '--','mate',JSON.stringify({v:1,...body})],{env:process.env});
      return {status:200,body:JSON.parse(p.stdout.toString().trim().split('\\n').at(-1))};
    };
    await claimOrder(getOrder(h.db,next.orderId),h.d);
    const row=getOrder(h.db,next.orderId); console.log(JSON.stringify({state:row.state,reason:row.reason,created:h.log.created.length}));
    h.db.close();
  `;
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" });
  const checked = parse(result);
  expect(checked).toMatchObject({ state: condition === "clean" ? "claimed" : "released", created: 0 });
  expect(getWriteLease(db, "T1")?.state).toBe(condition === "clean" ? "held" : "ended");
  if (condition === "clean") {
    const head = lab.commit(lab.seed, "after-real-preservation.txt"); lab.git(lab.seed, "push", "-q", lab.bare, branch);
    expect(deliver(next.orderId, head).ok).toBe(true);
  }
}, 30_000);
