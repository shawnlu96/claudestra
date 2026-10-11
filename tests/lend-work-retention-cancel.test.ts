import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderDir, orderDirName, removeOrderDir } from "../src/lib/lend-clone.js";
import { checkBackup, preservedBackups, preserveOrderWork } from "../src/lib/lend-disk-preserve.js";
import { getMeta, getOrder, openLendJournal, recordAsked, type LendRow, type LendState } from "../src/lib/lend-journal.js";
import { trashSettled } from "../src/lib/lend-trash.js";
import {
  endedResult, listUnownedEndedWork, reclaimEndedWork, STOPPED_RETENTION_MS as DAY, sweepStoppedWork, type EndedReclaimDeps, type ProcessFact,
  type ReclaimTarget,
} from "../src/lib/lend-work-retention.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { testChildEnv } from "./test-env.js";

const cleanups: (() => void)[] = [];
afterEach(async () => { await trashSettled(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const NOW = 10 * DAY;
type Shape = "never" | "ran" | "handed" | "sent" | "acked";

function git(cwd: string, ...args: string[]): string {
  const env = testChildEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@example.invalid",
    GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@example.invalid" });
  const r = Bun.spawnSync(["git", ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "retention-cancel-"));
  const root = join(home, "lend");
  const db = openLendJournal(join(root, "journal.sqlite"));
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const lines: string[] = [], retired: ReclaimTarget[] = [];
  const work = (id: string) => orderDir(id, root, "work"), push = (id: string) => orderDir(id, root, "push");

  /** A journal row in the shape each ending really leaves behind, plus both checkouts on disk. */
  function add(id: string, state: LendState, shape: Shape = "ran", at = NOW - 1000): LendRow {
    recordAsked(db, { orderId: id, peer: "test", fp: null, family: "codex", preview: {} }, at);
    const ran = shape !== "never", handed = shape === "handed" || shape === "sent" || shape === "acked";
    db.query(`UPDATE lend_orders SET state = ?, leaseGen = 1, dir = ?, agent = ?, sessionId = ?, startedAt = ?, work = ?, payload = ?, receipt = ?, updatedAt = ?
      WHERE orderId = ?`).run(state, work(id), ran ? workerName(id) : null, ran ? `sess-${id}` : null, ran ? at + 1 : null,
      handed ? JSON.stringify({ head: "abc", summary: "一行摘要", selfCheck: "自查" }) : null,
      shape === "sent" || shape === "acked" ? JSON.stringify({ ok: true }) : null, shape === "acked" ? JSON.stringify({ sig: "x" }) : null, at, id);
    for (const dir of [work(id), push(id)]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "keep"), `${id}-${dir}`); }
    return getOrder(db, id)!;
  }

  /** A real repository in the work checkout: one commit that was never pushed, a modified tracked file and an untracked one. */
  function repo(id: string): string {
    const dir = work(id);
    git(dir, "init", "-q", "-b", "lend/x");
    writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
    git(dir, "add", "src.ts");
    git(dir, "commit", "-q", "-m", "worker: unpushed commit");
    writeFileSync(join(dir, "src.ts"), "export const a = 2; // WIP\n");
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "wip.md"), "untracked draft\n");
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    return git(dir, "rev-parse", "HEAD");
  }

  /** The existing reclaim (lend-clone removeOrderDir) stands in for the LIFE1 retire entry: this module never removes by itself. */
  function deps(extra: Partial<EndedReclaimDeps> = {}): EndedReclaimDeps {
    return {
      db, root, now: () => NOW, mode: "enforce", ownedSince: 0, index: new Map(), exited: () => "exited", log: (m) => lines.push(m),
      retire: (t) => { retired.push(t); removeOrderDir(t.orderId, root); removeOrderDir(t.orderId, root, "push"); },
      ...extra,
    };
  }
  const gone = (id: string) => !existsSync(work(id)) && !existsSync(push(id));
  const intact = (id: string) => readFileSync(join(work(id), "keep"), "utf8") === `${id}-${work(id)}` && existsSync(join(push(id), "keep"));
  return { home, root, db, lines, retired, work, push, add, repo, deps, gone, intact };
}

test("cancel / stopped / done / released are told apart, and a cancel is not read as no output", () => {
  const f = fixture();
  const of = (state: LendState, shape: Shape) => endedResult(f.add(`${state}-${shape}`, state, shape));
  expect(of("cancelled", "never")).toEqual({ kind: "cancelled", result: "none" });
  expect(of("cancelled", "ran")).toEqual({ kind: "cancelled", result: "unknown" });
  expect(of("cancelled", "handed")).toEqual({ kind: "cancelled", result: "pending" });
  expect(of("cancelled", "sent")).toEqual({ kind: "cancelled", result: "pending" });
  expect(of("stopped", "ran")).toEqual({ kind: "stopped", result: "unknown" });
  expect(of("stopped", "handed")).toEqual({ kind: "stopped", result: "pending" });
  expect(of("acked", "acked")).toEqual({ kind: "done", result: "delivered" });
  expect(of("acked", "sent")).toEqual({ kind: "done", result: "pending" }); // no receipt on the row: delivery is not proven
  expect(of("released", "never")).toEqual({ kind: "released", result: "none" });
  expect(of("released", "ran")).toEqual({ kind: "released", result: "unknown" });
  for (const state of ["asked", "claimed", "cloned", "started", "result_pending", "declined"] as LendState[]) expect(of(state, "ran")).toBeNull();
});

test("old path: removing the checkout at cancel leaves a late PM nothing to recover", async () => {
  const f = fixture();
  f.add("old", "cancelled");
  f.repo("old");
  removeOrderDir("old", f.root); removeOrderDir("old", f.root, "push"); // what the cancel settlement does today
  await trashSettled();
  expect(f.gone("old")).toBe(true);
  expect(preservedBackups(f.root, "old")).toEqual([]);
});

test("cancelled real repo: unpushed commit, WIP, untracked file, report, transcript and receipt are backed up byte for byte, then reclaimed", async () => {
  const f = fixture();
  const row = f.add("c1", "cancelled", "handed");
  const head = f.repo("c1");
  const transcript = join(f.home, "session.jsonl"), receipts = join(f.home, "receipts.jsonl");
  writeFileSync(transcript, '{"type":"assistant","text":"做到一半"}\n');
  writeFileSync(receipts, '{"orderId":"c1","sha256":"r"}\n');
  const packed = readFileSync(join(f.work("c1"), ".git", "HEAD"));

  const v = await reclaimEndedWork("c1", f.deps({ records: () => [{ label: "transcript", path: transcript }, { label: "receipt", path: receipts }] }));
  await trashSettled();
  expect(v).toMatchObject({ action: "reclaimed", kind: "cancelled", result: "pending" });
  expect(f.gone("c1")).toBe(true);
  expect(f.retired).toHaveLength(1);
  expect(f.retired[0]).toMatchObject({ orderId: "c1", leaseGen: 1, agent: row.agent, dirs: [f.work("c1"), f.push("c1")] });
  expect(f.retired[0].proof?.manifestSha256).toBe(v.proof!.manifestSha256);

  // Late PM, seconds or days after the cancel: the source is gone, the backup verifies on its own and plain git reads it.
  const [proof] = preservedBackups(f.root, "c1");
  expect(proof).toEqual(v.proof!);
  expect(checkBackup(proof.dir)).toEqual(proof);
  expect(JSON.parse(getMeta(f.db, "workPreserve:c1")!)).toMatchObject({ manifestSha256: proof.manifestSha256, dir: proof.dir });
  const back = join(proof.dir, "work");
  expect(git(back, "rev-parse", "HEAD")).toBe(head);
  expect(git(back, "log", "--format=%s")).toBe("worker: unpushed commit");
  expect(git(back, "status", "--porcelain")).toBe("M src.ts\n?? keep\n?? notes/");
  expect(readFileSync(join(back, "src.ts"), "utf8")).toBe("export const a = 2; // WIP\n");
  expect(readFileSync(join(back, "notes", "wip.md"), "utf8")).toBe("untracked draft\n");
  expect(readFileSync(join(back, ".git", "HEAD")).equals(packed)).toBe(true);
  expect(readFileSync(join(proof.dir, "push", "keep"), "utf8")).toBe(`c1-${f.push("c1")}`);
  const manifest = JSON.parse(readFileSync(join(proof.dir, "manifest.json"), "utf8"));
  expect(manifest.report.work).toEqual({ head: "abc", summary: "一行摘要", selfCheck: "自查" });
  expect(manifest.skipped).toEqual(["work/node_modules"]);
  expect(existsSync(join(back, "node_modules"))).toBe(false);
  // The originals of the chat record and the receipt are untouched and still readable; the copies are the same bytes.
  expect(readFileSync(transcript, "utf8")).toBe('{"type":"assistant","text":"做到一半"}\n');
  expect(readFileSync(receipts, "utf8")).toBe('{"orderId":"c1","sha256":"r"}\n');
  expect(readFileSync(join(proof.dir, "records", "0-session.jsonl")).equals(readFileSync(transcript))).toBe(true);
  expect(readFileSync(join(proof.dir, "records", "1-receipts.jsonl")).equals(readFileSync(receipts))).toBe(true);
  expect(lstatSync(proof.dir).mode & 0o077).toBe(0);
});

test("repeat is idempotent: same proof, no second retire, before and after the checkout is gone", async () => {
  const f = fixture();
  const row = f.add("again", "cancelled");
  const id = { orderId: "again", state: row.state, leaseGen: row.leaseGen, agent: row.agent, sessionId: row.sessionId, createdAt: row.createdAt };
  const first = preserveOrderWork({ root: f.root, identity: id, now: NOW });
  expect(preserveOrderWork({ root: f.root, identity: id, now: NOW + 5 })).toEqual(first);
  const v1 = await reclaimEndedWork("again", f.deps());
  const v2 = await reclaimEndedWork("again", f.deps());
  expect([v1.action, v2.action]).toEqual(["reclaimed", "reclaimed"]);
  expect(v1.proof).toEqual(first);
  expect(v2.proof).toEqual(first);
  expect(f.retired).toHaveLength(1);
  expect(preservedBackups(f.root, "again")).toHaveLength(1);
});

test("concurrent cancels of one order retire it once", async () => {
  const f = fixture();
  f.add("race", "cancelled");
  const d = f.deps({ exited: async () => { await Bun.sleep(5); return "exited" as const; } });
  const out = await Promise.all([reclaimEndedWork("race", d), reclaimEndedWork("race", d), reclaimEndedWork("race", d)]);
  expect(out.map((v) => v.action).sort()).toEqual(["kept", "kept", "reclaimed"]);
  expect(f.retired).toHaveLength(1);
  expect(checkBackup(out.find((v) => v.proof)!.proof!.dir).files).toBe(2);
});

test("default is observe and unowned: nothing is written, removed or handed to retire; historical orders are only listed", async () => {
  const f = fixture();
  f.add("hist", "cancelled");
  f.add("obs", "cancelled");
  const base = f.deps();
  const { mode: _mode, ownedSince: _since, ...defaults } = base;
  expect(await reclaimEndedWork("hist", defaults)).toMatchObject({ action: "listed", kind: "cancelled", result: "unknown" });
  expect(await reclaimEndedWork("obs", { ...defaults, ownedSince: 0 })).toMatchObject({ action: "observed", why: "enforce 下会先保全再回收" });
  expect(await reclaimEndedWork("hist", f.deps({ ownedSince: NOW }))).toMatchObject({ action: "listed" }); // enforce, but created before ownership began
  expect(f.retired).toEqual([]);
  expect(f.intact("hist") && f.intact("obs")).toBe(true);
  expect(existsSync(join(f.root, "preserved"))).toBe(false);
  expect(getMeta(f.db, "workPreserve:obs")).toBeNull();
  expect(listUnownedEndedWork(f.db, f.root).map((r) => r.orderId).sort()).toEqual(["hist", "obs"]);
  expect(listUnownedEndedWork(f.db, f.root, 0)).toEqual([]);
});

test("ownership needs the order's own worker name, order directory and a lease generation", async () => {
  const f = fixture();
  for (const id of ["name", "dir", "gen"]) f.add(id, "cancelled");
  f.db.query("UPDATE lend_orders SET agent = 'my-own-agent' WHERE orderId = 'name'").run();
  f.db.query("UPDATE lend_orders SET dir = ? WHERE orderId = 'dir'").run(f.home);
  f.db.query("UPDATE lend_orders SET leaseGen = NULL WHERE orderId = 'gen'").run();
  for (const id of ["name", "dir", "gen"]) {
    expect((await reclaimEndedWork(id, f.deps())).action).toBe("listed");
    expect(f.intact(id)).toBe(true);
  }
  expect(f.retired).toEqual([]);
});

test("live, unreadable or card-linked workers and unfinished orders are kept", async () => {
  const f = fixture();
  for (const fact of ["alive", "unknown"] as ProcessFact[]) {
    f.add(fact, "cancelled");
    expect(await reclaimEndedWork(fact, f.deps({ exited: () => fact }))).toMatchObject({ action: "kept", why: "worker 进程还在或状态读不到" });
  }
  f.add("card", "cancelled");
  expect((await reclaimEndedWork("card", f.deps({ index: new Map([[workerName("card"), { taskId: "T1" }]]) }))).action).toBe("kept");
  f.add("live", "started");
  expect((await reclaimEndedWork("live", f.deps())).action).toBe("kept");
  expect((await reclaimEndedWork("missing", f.deps())).action).toBe("kept");
  for (const id of ["alive", "unknown", "card", "live"]) expect(f.intact(id)).toBe(true);
  expect(f.retired).toEqual([]);
  expect(existsSync(join(f.root, "preserved"))).toBe(false);
});

test("a late claim, a new generation, a revived worker or a late write after the backup all void it", async () => {
  const f = fixture();
  const second = (id: string, then: () => void) => {
    let n = 0;
    return f.deps({ exited: () => { if (++n === 2) then(); return "exited"; } });
  };
  f.add("claim", "cancelled");
  const lateClaim = f.deps({ preserve: (i) => { const p = preserveOrderWork(i); f.db.query("UPDATE lend_orders SET state = 'started' WHERE orderId = 'claim'").run(); return p; } });
  expect(await reclaimEndedWork("claim", lateClaim)).toMatchObject({ action: "kept", why: "保全后订单换了状态 / 代数 / 会话，不回收" });
  f.add("gen", "cancelled");
  const newGen = f.deps({ preserve: (i) => { const p = preserveOrderWork(i); f.db.query("UPDATE lend_orders SET leaseGen = 2 WHERE orderId = 'gen'").run(); return p; } });
  expect((await reclaimEndedWork("gen", newGen)).action).toBe("kept");
  f.add("revived", "cancelled");
  let n = 0;
  expect(await reclaimEndedWork("revived", f.deps({ exited: () => (++n === 1 ? "exited" : "alive") }))).toMatchObject({ action: "kept", why: "保全后 worker 进程又出现或状态读不到" });
  f.add("write", "cancelled");
  expect((await reclaimEndedWork("write", second("write", () => writeFileSync(join(f.work("write"), "late"), "written after the copy")))).action).toBe("kept");
  expect(readFileSync(join(f.work("write"), "late"), "utf8")).toBe("written after the copy");
  for (const id of ["claim", "gen", "revived", "write"]) expect(f.intact(id)).toBe(true);
  expect(f.retired).toEqual([]);
  // The proof of the old generation does not vouch for the new one.
  expect((await reclaimEndedWork("gen", f.deps())).proof!.identity.leaseGen).toBe(2);
});

test("failed backup, unreadable file and special file keep the checkout; a lost lease escapes instead of being swallowed", async () => {
  const f = fixture();
  f.add("fail", "cancelled");
  expect(await reclaimEndedWork("fail", f.deps({ preserve: () => { throw new Error("disk full"); } }))).toMatchObject({ action: "kept", why: "保全 / 回收失败：disk full" });
  expect(f.lines.join("\n")).toContain("disk full");
  f.add("lease", "cancelled");
  await expect(reclaimEndedWork("lease", f.deps({ active: () => { throw new SchedulerStopped(); } }))).rejects.toBeInstanceOf(SchedulerStopped);
  f.add("retire", "cancelled");
  expect((await reclaimEndedWork("retire", f.deps({ retire: () => { throw new Error("retire entry refused"); } }))).action).toBe("kept");
  if (process.getuid?.() !== 0) {
    f.add("unread", "cancelled");
    const secret = join(f.work("unread"), "secret");
    writeFileSync(secret, "x");
    chmodSync(secret, 0o000);
    expect((await reclaimEndedWork("unread", f.deps())).action).toBe("kept");
    chmodSync(secret, 0o600);
    expect(f.intact("unread")).toBe(true);
    expect(preservedBackups(f.root, "unread")).toEqual([]);
  }
  for (const id of ["fail", "lease", "retire"]) expect(f.intact(id)).toBe(true);
  expect(f.retired).toEqual([]);
  expect(preservedBackups(f.root, "retire")).toHaveLength(1); // the backup stands; only the reclaim did not happen
});

test("restart: a backup interrupted before its proof proves nothing, is resumed in place and then succeeds", async () => {
  const f = fixture();
  f.add("crash", "cancelled");
  // The tree is copied, then a record cannot be read: the same on-disk state as a process killed before the proof was written.
  const broken = await reclaimEndedWork("crash", f.deps({ records: () => [{ label: "transcript", path: join(f.home, "nope.jsonl") }] }));
  expect(broken.action).toBe("kept");
  const home = join(f.root, "preserved", orderDirName("crash"));
  expect(preservedBackups(f.root, "crash")).toEqual([]);
  expect(existsSync(home)).toBe(true);
  expect(f.intact("crash")).toBe(true);
  expect(f.retired).toEqual([]);
  const v = await reclaimEndedWork("crash", f.deps());
  expect(v.action).toBe("reclaimed");
  expect(preservedBackups(f.root, "crash")).toEqual([v.proof!]);
});

test("damaged manifest, damaged bytes or a missing proof refuse; nothing is repaired or removed on their behalf", async () => {
  const f = fixture();
  for (const [id, damage] of [
    ["manifest", (dir: string) => writeFileSync(join(dir, "manifest.json"), "{not json")],
    ["bytes", (dir: string) => { chmodSync(join(dir, "work", "keep"), 0o600); writeFileSync(join(dir, "work", "keep"), "tampered"); }],
    ["proof", (dir: string) => writeFileSync(join(dir, "proof.json"), "")],
  ] as const) {
    f.add(id, "stopped", "ran", NOW - DAY);
    const kept = await reclaimEndedWork(id, f.deps());
    expect(kept.action).toBe("preserved");
    damage(kept.proof!.dir);
    expect(() => checkBackup(kept.proof!.dir)).toThrow();
    expect((await reclaimEndedWork(id, f.deps())).action).toBe("kept");
    expect(preservedBackups(f.root, id)).toEqual([]);
  }
  expect(sweepStoppedWork(f.db, { root: f.root, now: NOW, log: (m) => f.lines.push(m), proof: { mode: "enforce", ownedSince: 0 } })).toBe(3);
  for (const id of ["manifest", "bytes", "proof"]) expect(f.intact(id)).toBe(true);
  expect(f.lines.filter((l) => l.includes("到期但不清"))).toHaveLength(3);
});

test("stopped: backed up first, removed only by the 24-hour sweep, and age alone never proves it removable", async () => {
  const f = fixture();
  f.add("kept", "stopped", "handed", NOW - DAY);
  f.add("bare", "stopped", "ran", NOW - DAY);
  f.add("empty", "stopped", "never", NOW - DAY);
  f.add("hist", "stopped", "ran", NOW - DAY);
  f.db.query("UPDATE lend_orders SET createdAt = 1 WHERE orderId = 'hist'").run();
  const policy = { mode: "enforce" as const, ownedSince: 2 };
  const v = await reclaimEndedWork("kept", f.deps(policy));
  expect(v).toMatchObject({ action: "preserved", kind: "stopped", result: "pending" });
  expect(f.retired).toEqual([]);
  expect(f.intact("kept")).toBe(true);
  expect(sweepStoppedWork(f.db, { root: f.root, now: NOW, log: (m) => f.lines.push(m), proof: policy })).toBe(4);
  await trashSettled();
  expect(f.gone("kept")).toBe(true); // proven backup
  expect(f.gone("empty")).toBe(true); // no worker ever ran
  expect(f.gone("hist")).toBe(true); // not owned by this policy: the existing rule still applies
  expect(f.intact("bare")).toBe(true); // 24 hours old, result unknown, no backup
  expect(f.lines.join("\n")).toContain("stopped 单 bare 到期但不清：结果未知且没有可核的保全");
  expect(checkBackup(v.proof!.dir)).toEqual(v.proof!);
  // Without the policy (production default) the sweep is exactly the existing age rule.
  expect(sweepStoppedWork(f.db, { root: f.root, now: NOW, log: (m) => f.lines.push(m) })).toBe(1);
  await trashSettled();
  expect(f.gone("bare")).toBe(true);
});

test("done with a verified receipt and released without a worker are reclaimed without a backup", async () => {
  const f = fixture();
  f.add("done", "acked", "acked");
  f.add("rel", "released", "never");
  for (const id of ["done", "rel"]) {
    const v = await reclaimEndedWork(id, f.deps());
    expect(v.action).toBe("reclaimed");
    expect(v.proof).toBeUndefined();
  }
  expect(f.retired.map((t) => t.proof)).toEqual([null, null]);
  expect(existsSync(join(f.root, "preserved"))).toBe(false);
  // A released order that had already named a worker may hold its files: backed up like a cancel.
  f.add("rel2", "released", "ran");
  expect((await reclaimEndedWork("rel2", f.deps())).proof?.files).toBe(2);
});

test("symlinks: a linked order directory or backup root refuses, and links inside the checkout are recorded, never followed", async () => {
  const f = fixture();
  const victim = join(f.home, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "private"), "outside the lend root");
  f.add("leaf", "cancelled");
  rmSync(f.work("leaf"), { recursive: true });
  symlinkSync(victim, f.work("leaf"));
  expect((await reclaimEndedWork("leaf", f.deps())).action).toBe("kept");
  f.add("root", "cancelled");
  symlinkSync(victim, join(f.root, "preserved"));
  expect((await reclaimEndedWork("root", f.deps())).action).toBe("kept");
  expect(existsSync(join(victim, orderDirName("root")))).toBe(false);
  rmSync(join(f.root, "preserved"));
  expect(f.retired).toEqual([]);
  expect(f.intact("root")).toBe(true);

  f.add("inner", "cancelled");
  symlinkSync(victim, join(f.work("inner"), "out"));
  symlinkSync("nowhere", join(f.work("inner"), "dangling"));
  const v = await reclaimEndedWork("inner", f.deps());
  expect(v.action).toBe("reclaimed");
  const back = join(v.proof!.dir, "work");
  expect(lstatSync(join(back, "out")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(back, "out"))).toBe(victim);
  expect(readlinkSync(join(back, "dangling"))).toBe("nowhere");
  expect(v.proof!.files).toBe(2); // the two `keep` files; nothing behind the link was copied
  expect(readFileSync(join(victim, "private"), "utf8")).toBe("outside the lend root");
});
