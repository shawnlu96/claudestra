import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { openLedger, closeLedger, getTask } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setFrozen } from "../src/lib/ledger-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { runLedger } from "../src/manager/ledger.js";
import { startPlacement, type StartPlacementIO } from "../src/lib/scheduler-placement-start.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";
import { specResumeTick } from "../src/lib/scheduler-spec-resume.js";
import { localAgentPool } from "../src/lib/scheduler-agent-pool-ledger.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); } });

function fixture(mode: "on" | "observe" | "off" = "on", capacities = [4, 4]) {
  const dir = mkdtempSync(join(tmpdir(), "place-start-")); dirs.push(dir);
  const path = join(dir, "ledger.sqlite");
  let db = openLedger(path), now = 1000;
  const remote: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, localPriority: "off", repo: "o/r" };
  const borrow: BorrowEntry[] = ["a", "b"].map((peer) => ({ peer, projects: ["p", "q"], roles: ["write", "review"], maxOpen: 20 }));
  const hello = (peer: string, total: number, over: Record<string, unknown> = {}) => recordHello(db, peer, null, {
    v: 1, proto: 2, boot: String(now++), seq: 1, paused: null,
    slots: { codex: { total, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: 100000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 100, ordersLeftToday: 100 }, ...over,
  } as Parameters<typeof recordHello>[3], now);
  capacities.forEach((n, i) => hello(["a", "b"][i], n));
  const pm = { agent: "pm", sessionId: "s-pm", family: "claude-code" as const, channelId: "ch-pm" };
  const io: StartPlacementIO = {
    policy: () => ({ remote, maxWorkers: 0 }), borrow: async () => borrow, originRepo: async () => "o/r", now: () => now,
    reservations: { mode },
  };
  const registry: Record<string, object> = { pm: { channelId: "ch-pm", projectId: "p", runtime: "claude-code" } };
  const ledger = (...args: string[]) => runLedger(args, { db, actor: "pm", projectIds: ["p", "q"], now: () => now++,
    autoDispatch: () => true, autoProjects: () => ["p", "q"], loadRegistry: async () => ({ socket: "", agents: registry }) as never, saveRegistry: async () => {} });
  for (const project of ["p", "q"]) setMeta(db, { actor: "owner" }, { project, key: "pms", value: ["pm"] });
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  const deps: DagToolDeps = {
    db: () => db, callerProject: () => "p", manager: async (args) => {
      if (args[0] === "ledger") return ledger(...args.slice(1));
      if (args[0] === "create") registry[`agent-${args[1]}`] = { runtime: "claude-code", sessionId: "s-author", projectId: "p" };
      return { ok: true };
    },
    startEnv: () => ({ ledgerDir: dir, worktreeRoot: join(dir, "wt"), projectDirs: async () => [join(dir, "repo")],
      agentNames: () => Object.keys(registry), exists: existsSync, branchExists: async () => false, autoReady: () => null,
      template: () => null, placement: (db, q) => startPlacement(db, io, q) }),
    stepIO: () => ({ exists: existsSync, read: (p) => existsSync(p) ? readFileSync(p, "utf8") : null,
      write: (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); },
      remove: (p) => rmSync(p, { force: true }), symlink: () => {}, agentExists: (a) => !!registry[a],
      git: async (_dir, args) => {
        if (args[0] === "rev-parse" && args.at(-1)?.startsWith("refs/heads/")) return { ok: false, out: "" };
        if (args[0] === "worktree" && args[1] === "add") mkdirSync(args.at(-2)!, { recursive: true }); return { ok: true, out: "1".repeat(40) }; } }),
  };
  const tools = dagToolHandlers(deps);
  const plan = async (slug = "batch", project = "p") => {
    const r = await tools.plan_feature(pm, { slug, project, title: slug, ownerWords: "approved", nodes: Array.from({ length: 8 }, (_, i) =>
      ({ key: `n${i}`, oneLine: `write ${i}`, fileGlobs: [`src/${slug}-${i}.ts`] })) });
    expect(r).toMatchObject({ ok: true });
  };
  const start = (i: number, extra: Record<string, unknown> = {}, slug = "batch") =>
    tools.start_node(pm, { featureId: slug, key: `n${i}`, spec: "# approved scope", ...extra });
  return { get db() { return db; }, dir, io, remote, borrow, hello, ledger, plan, start,
    restart: () => { closeLedger(path); db = openLedger(path); },
    peers: () => borrowPeers(db, "p", borrow, now), task: (i: number) => getTask(db, `batch-n${i}`)!,
  };
}

test("eight formal start_node cards balance before claim, survive restart and duplicate calls, and reach snapshot", async () => {
  const f = fixture(); await f.plan();
  const placed: string[] = [];
  for (let i = 0; i < 8; i++) {
    expect(await f.start(i)).toMatchObject({ ok: true });
    placed.push(String(f.task(i).extra.placement));
    f.restart();
    expect(await f.start(i)).toMatchObject({ ok: true, duplicate: true });
  }
  expect(placed).toEqual(["peer:a", "peer:b", "peer:a", "peer:b", "peer:a", "peer:b", "peer:a", "peer:b"]);
  expect(f.peers().map((p) => p.open)).toEqual([4, 4]);
  expect(f.peers().map((p) => p.v2!.slots.codex)).toEqual([0, 0]);
  const snap = autoSnapshot(f.db, f.task(0), { registry: [], maxWorkers: 0, now: 2000, pool: { remote: f.remote, borrow: f.borrow } });
  expect(planScheduler(snap)).toMatchObject({ kind: "intent", action: "stage", targetStage: "build" });
  expect(snap.pool!.peers[0].open).toBe(3); // Own preparation must not make the next write wait on itself.
});

test("explicit local start persists the pin before spec recovery", async () => {
  const f = fixture(); await f.plan();
  expect(await f.start(0, { placement: "local" })).toMatchObject({ ok: true });
  expect(f.task(0).extra.placement).toBe("local");
  expect(localAgentPool(f.db, "p", { claude: 4, codex: 4 }).running).toEqual({ claude: 1, codex: 0 });
  expect(localAgentPool(f.db, "p", { claude: 4, codex: 4 }, "batch-n0").running).toEqual({ claude: 0, codex: 0 });
});

test("different capacities fill actual room and a fixed peer refuses when its reservations exhaust it", async () => {
  const f = fixture("on", [1, 3]); await f.plan();
  for (let i = 0; i < 4; i++) expect(await f.start(i)).toMatchObject({ ok: true });
  expect([0, 1, 2, 3].map((i) => f.task(i).extra.placement)).toEqual(["peer:a", "peer:b", "peer:b", "peer:b"]);
  expect(await f.start(4, { placement: "peer:a" })).toMatchObject({ ok: false });
  expect(f.task(4)).toBeNull();
});

test("cancellation releases only its preparation; cross-project cards share the same peer capacity", async () => {
  const f = fixture("on", [1, 1]); await f.plan(); await f.plan("other", "q");
  expect(await f.start(0)).toMatchObject({ ok: true });
  expect(await f.start(0, {}, "other")).toMatchObject({ ok: true, placement: "peer:b" });
  expect(await f.start(1)).toMatchObject({ ok: false });
  expect(await f.ledger("stage", "batch-n0", "--from", "restate", "--to", "cancelled", "--text", "cancel prepared card"))
    .toMatchObject({ ok: true });
  expect(await f.start(1)).toMatchObject({ ok: true, placement: "peer:a" });
});

test("observe is default, reports shadow choices, off produces no reservations; placement reads never mutate ledger", async () => {
  const f = fixture("observe"); await f.plan();
  delete f.io.reservations;
  expect(await f.start(0)).toMatchObject({ ok: true, placement: "peer:a" });
  const observations: { actual: string; proposed: string }[] = [];
  f.io.reservations = { mode: "observe", observe: (x) => observations.push(x) };
  const before = f.db.query("SELECT COUNT(*) AS n FROM events").get();
  for (let i = 0; i < 8; i++) await startPlacement(f.db, f.io, { project: "p", repoDir: f.dir, fileGlobs: ["src/free.ts"], want: "auto" });
  expect(f.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(before);
  expect(observations).toEqual(Array(8).fill({ actual: "peer:a", proposed: "peer:b" }));
  expect(f.peers().map((p) => p.open)).toEqual([0, 0]);
  f.io.reservations = { mode: "off" };
  expect(await f.start(1)).toMatchObject({ ok: true, placement: "peer:a" });
  expect(f.task(1).extra.placementReservation).toBeUndefined();
});

test("on preparations become pooled/claimed/unknown exactly once; withdrawal never recreates a reservation", async () => {
  const f = fixture("on", [1, 0]); await f.plan();
  expect(await f.start(0)).toMatchObject({ ok: true });
  // Only transport is injected: the formal task/workflow above is the actual start_node product.
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, step, family, repo, pr, head, round, specRev,
    status, leaseMs, createdBy, wire, text, sha256, createdAt, updatedAt)
    VALUES ('order', 'batch-n0', 'p', 'a', 'write', 'codex', 'o/r', 0, ?, 0, 1, 'pooled', 60000, 'scheduler', '{}', '', '', 1000, 1000)`)
    .run("1".repeat(40));
  for (const status of ["pooled", "claimed", "unknown"]) {
    f.db.query("UPDATE lend_orders SET status=? WHERE orderId='order'").run(status);
    expect(f.peers()[0].open).toBe(1);
    expect(f.peers()[0].v2!.slots.codex).toBe(0);
    f.restart();
  }
  f.db.query("UPDATE lend_orders SET status='cancelled' WHERE orderId='order'").run();
  expect(f.peers()[0].open).toBe(0);
  expect(f.peers()[0].v2!.slots.codex).toBe(1);
  f.db.query("UPDATE lend_orders SET status='pooled' WHERE orderId='order'").run();
  f.db.query("UPDATE tasks SET extra=json_remove(extra,'$.placementReservation') WHERE id='batch-n0'").run();
  // A first on-mode preparation must also see the real family load of pre-policy orders.
  expect(await f.start(1)).toMatchObject({ ok: false });
});

test("legacy priority/role gates and current grant/repo/hello/paused gates stay effective", async () => {
  const f = fixture(); await f.plan();
  f.borrow[0].priority = "off";
  expect(await f.start(0)).toMatchObject({ ok: true, placement: "peer:b" });
  f.borrow[1].roles = ["review"];
  expect(await f.start(1)).toMatchObject({ ok: false });
  f.borrow[1].roles = ["write"];
  for (const over of [
    { grant: null },
    { grant: { until: 1, repos: ["o/r"], roles: ["write"], ordersPerDay: 100, ordersLeftToday: 100 } },
    { grant: { until: 100000, repos: ["wrong/repo"], roles: ["write"], ordersPerDay: 100, ordersLeftToday: 100 } },
    { grant: { until: 100000, repos: ["o/r"], roles: ["review"], ordersPerDay: 100, ordersLeftToday: 100 } },
    { paused: { reason: "maintenance", until: 100000 } },
  ]) {
    f.hello("b", 4, over);
    expect(await f.start(1)).toMatchObject({ ok: false });
    expect(f.task(1)).toBeNull();
  }
  f.hello("b", 4);
  f.db.query("UPDATE lend_peers SET helloAt=-10000000 WHERE peer='b'").run();
  expect(await f.start(1)).toMatchObject({ ok: false });
});

test("unified on reservations balance families while retaining CAP1 retired-role/priority/maxOpen compatibility", async () => {
  const f = fixture(); await f.plan();
  f.remote.agents = { claude: 0, codex: 0 };
  for (const b of f.borrow) { b.roles = []; b.priority = "off"; b.maxOpen = 0; }
  for (let i = 0; i < 8; i++) expect(await f.start(i)).toMatchObject({ ok: true, placement: `peer:${i % 2 ? "b" : "a"}` });
  const peers = borrowPeers(f.db, "p", f.borrow, 2000, true);
  expect(peers.map((p) => p.v2!.slots)).toEqual([{ claude: 0, codex: 0 }, { claude: 0, codex: 0 }]);
  expect(peers.map((p) => p.v2!.familyBusy!.codex)).toEqual([4, 4]);
});

test("concurrent formal preparation uses the createTask transaction; rejection writes nothing and cancellation releases", async () => {
  const f = fixture("on", [1, 0]);
  const reservation = await startPlacement(f.db, f.io, { project: "p", repoDir: f.dir, fileGlobs: ["src/x.ts"], want: "auto" });
  expect(reservation.where).toBe("peer");
  if (reservation.where !== "peer") throw new Error("no peer");
  const input = { project: "p", title: "prepared", kind: "code", extra: { placement: "peer:a", repo: "o/r", placementReservation: reservation.reservation } };
  const script = `
    import { openLedger, LedgerError } from './src/lib/ledger-store.ts';
    import { createTask } from './src/lib/ledger-write.ts';
    const db=openLedger(process.argv[1]);
    try { createTask(db, {actor:'owner', now:2000}, JSON.parse(process.argv[2])); console.log('ok'); }
    catch(e) { if (!(e instanceof LedgerError)) throw e; console.log(e.code); }
    finally { db.close(); }
  `;
  const rows = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "--eval", script, join(f.dir, "ledger.sqlite"), JSON.stringify({ ...input, id: `race${i}` })],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [code, text, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code, err).toBe(0); return text.trim();
  }));
  expect(rows.filter((r) => r === "ok")).toHaveLength(1);
  expect(rows.filter((r) => r === "busy")).toHaveLength(7);
  expect(f.peers()[0].open).toBe(1);
  const winner = rows.indexOf("ok");
  expect(await f.ledger("stage", `race${winner}`, "--from", "spec", "--to", "cancelled", "--text", "cancel before claim")).toMatchObject({ ok: true });
  expect(f.peers()[0].open).toBe(0);
}, 30000);

test("concurrent start_node retries use remaining real seats without orphan tasks", async () => {
  const f = fixture(); await f.plan();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.start(i)));
  for (let i = 0; i < results.length; i++) {
    if (results[i].ok) continue;
    expect(f.task(i)).toBeNull();
    expect(await f.start(i)).toMatchObject({ ok: true });
  }
  expect(f.peers().map((p) => p.open)).toEqual([4, 4]);
  expect(f.db.query("SELECT COUNT(*) AS n FROM tasks WHERE stage='cancelled'").get()).toEqual({ n: 0 });
});

test("eight batches release their own durable holds without accumulating after restart", async () => {
  const f = fixture();
  for (let batch = 0; batch < 8; batch++) {
    const slug = `batch${batch}`; await f.plan(slug);
    for (let i = 0; i < 8; i++) expect(await f.start(i, {}, slug)).toMatchObject({ ok: true, placement: `peer:${i % 2 ? "b" : "a"}` });
    f.restart();
    expect(f.peers().map((p) => p.open)).toEqual([4, 4]);
    for (let i = 0; i < 8; i++) expect(await f.ledger("stage", `${slug}-n${i}`, "--from", "restate", "--to", "cancelled", "--text", "cancel batch"))
      .toMatchObject({ ok: true });
    expect(f.peers().map((p) => p.open)).toEqual([0, 0]);
  }
});


test("atomic preparation rechecks revoked grant, cooldown and owner freeze without leaving a task", async () => {
  const f = fixture();
  const selected = await startPlacement(f.db, f.io, { project: "p", repoDir: f.dir, fileGlobs: ["src/x.ts"], want: "auto" });
  if (selected.where !== "peer") throw new Error("expected peer");
  const input = { id: "stale", project: "p", title: "stale", kind: "code" as const,
    extra: { placement: `peer:${selected.peer}`, repo: "o/r", placementReservation: selected.reservation } };
  const prepare = () => createTask(f.db, { actor: "owner", now: 2000 }, input);
  f.hello("a", 4, { grant: null });
  expect(prepare).toThrow("准备放置已无余量");
  expect(() => createTask(f.db, { actor: "pm", now: 2000 }, { ...input, stage: "build" })).toThrow("只有 owner");
  f.hello("a", 4);
  f.db.query("INSERT INTO lend_peer_cooldowns (peer,family,until,reason,startedAt) VALUES ('a','codex',100000,'quota',1000)").run();
  expect(prepare).toThrow("准备放置已无余量");
  f.db.query("UPDATE lend_peer_cooldowns SET until=1").run();
  setFrozen(f.db, { actor: "owner" }, { project: "p", frozen: true, reason: "owner paused" });
  expect(prepare).toThrow("项目队列已冻结");
  expect(getTask(f.db, "stale")).toBeNull();
});


test("auto start formally created local author cannot migrate during the gap before ensure binds it", async () => {
  const f = fixture(); await f.plan();
  const peers = f.borrow.splice(0);
  f.remote.localPriority = "balance";
  f.io.policy = () => ({ remote: f.remote, maxWorkers: 4 });
  expect(await f.start(0)).toMatchObject({ ok: true });
  expect(f.task(0).extra.placement).toBeUndefined();
  f.borrow.push(...peers);
  expect(await specResumeTick({ db: f.db, projects: ["p"], repoDir: async () => f.dir,
    ledger: async () => { throw new Error("must preserve formal local author"); },
    place: (db, q) => startPlacement(db, f.io, q), notifyPm: async () => {} })).toEqual([]);
  expect(f.task(0).stage).toBe("spec");
  expect(f.task(0).extra.placement).toBeUndefined();
});
