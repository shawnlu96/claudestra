/** Real manager/ledger subprocesses write; the convergence tick holds a query-only reader and injected notification port. */
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";
import { remoteProbe, peerAuthor } from "./fix-strategy-remote-helpers.js";
import { testChildEnv } from "./test-env.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { driveConvergence } from "../src/lib/fix-strategy-tick.js";
import { sendNotice } from "../src/lib/scheduler-auto-tick.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { encodeLease, SCHEDULER_LEASE_ENV } from "../src/lib/scheduler-lease-env.js";
import { WIRE_MAX_BYTES } from "../src/lib/order-wire.js";
import { fitDigest } from "../src/lib/order-wire-fit-history.js";

const ROOT = join(import.meta.dir, ".."), MANAGER = join(ROOT, "src", "manager.ts");
const report = (n: number) => "review evidence with a concrete assertion\n".repeat(n);
const findings = Array.from({ length: 4 }, (_, i) => ({ ...P1, findingId: `race-${i}`, description: `Race ${i} loses a write` }));

async function sizeFixture(currentLines = 180) {
  const f = autoFixture(), reports = [report(610), report(currentLines)];
  const paths = [join(f.dir, "round1.md"), join(f.dir, "round2.md")];
  paths.forEach((p, i) => writeFileSync(p, reports[i]));
  await toBuild(f); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick(); await f.tick();
  expect(await f.review("changes", H1, findings, ["--path", paths[0]])).toMatchObject({ ok: true });
  await f.tick(); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
  await f.tick();
  expect(await f.review("changes", H2, findings, ["--path", paths[1]])).toMatchObject({ ok: true });
  await f.tick();
  const p = remoteProbe(f); peerAuthor(f); const intent = p.plan();
  for (const dir of ["home", "tmp", "run", "bin"]) mkdirSync(join(f.dir, dir));
  const spec = join(f.dir, "spec.md"); writeFileSync(spec, "Specification and acceptance criteria.\n".repeat(145));
  f.db.query("UPDATE tasks SET spec = ? WHERE id = 'T1'").run(spec);
  writeFileSync(join(f.dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [f.dir], createdAt: "" }] }));
  writeFileSync(join(f.dir, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true, projects: { p: {
    maxActiveWorkers: 0, repoDir: f.dir, requiredChecks: ["check"], remote: { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 },
  } } }));
  writeFileSync(join(f.dir, "lend.json"), JSON.stringify({ version: 2, enabled: false, lend: [], borrow: p.context.borrow }));
  writeFileSync(join(f.dir, "peers.json"), JSON.stringify({ httpPeers: [{ name: "Peer", addedAt: "" }], pendingInvites: [] }));
  recordHello(f.db, "Peer", "abcd-bbbb-cccc-dddd", { v: 1, proto: 3, boot: "size-test", seq: 1,
    grant: { until: Date.now() + 600000, roles: ["write", "review"], repos: ["o/r"], ordersPerDay: 100, ordersLeftToday: 100 },
    slots: { codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null }, Date.now());
  // Only diff --stat is expected. Any attempt to reach a peer, network or model through git fails this fixture.
  const git = join(f.dir, "bin", "git");
  writeFileSync(git, '#!/bin/sh\ncase " $* " in *" --stat "*) echo "repair diff: assertion fixed";; *) exit 71;; esac\n');
  chmodSync(git, 0o755);
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const env = testChildEnv({ HOME: join(f.dir, "home"), TMPDIR: join(f.dir, "tmp"), PATH: `${join(f.dir, "bin") }:/usr/bin:/bin`,
    CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: join(f.dir, "run"), CLAUDESTRA_SCHEDULER_SERVICE: "1",
    [SCHEDULER_LEASE_ENV]: encodeLease({ singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const calls: string[][] = [];
  let entry = MANAGER;
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    calls.push(args);
    const proc = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const last = out.trim().split("\n").at(-1)!;
    try { return JSON.parse(last); } catch { throw new Error(`CLI produced no JSON: ${out}\n${err}`); }
  };
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite")), db = reader.get()!, notices: string[] = [];
  const card = { db, task: f.task(), opts: { registry: [], maxWorkers: 0 }, deps: { ...f.tickDeps, manager,
    notifyPm: async (_task: unknown, text: string) => { notices.push(text); } } };
  const tick = () => driveConvergence(card, getIntent(db, intent.id)!, sendNotice);
  const legacy = () => {
    const dir = join(f.dir, "old-code"); mkdirSync(dir);
    cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const path = join(dir, "src", "lib", "fix-strategy-remote-order.ts"), text = readFileSync(path, "utf8");
    const old = text.replace(/    const redacted = redactOrderForPeer\(raw, task.headSHA\).order;[\s\S]*?    const parsed = [^\n]+;/,
      "    const parsed = parseOrderWire(redactOrderForPeer(raw, task.headSHA).order);");
    if (old === text) throw new Error("legacy offer boundary was not restored");
    writeFileSync(path, old); entry = join(dir, "src", "manager.ts");
  };
  const close = () => { reader.close(); singleton.release(); maintenance.release(); f.close(); };
  return { f, intent, reports, paths, db, notices, calls, manager, card, tick, legacy, close };
}

test("legacy parser at the production offer boundary leaves the >32KB intent pending with zero events and notices", async () => {
  const p = await sizeFixture();
  try {
    p.legacy();
    expect(await p.tick()).toMatchObject({ step: "held" });
    const before = listEvents(p.db, { project: "p", target: "T1" }).length;
    for (let i = 0; i < 3; i++) {
      const result = await p.tick();
      expect(result).toMatchObject({ step: "held" });
      expect(result?.detail).toContain("32768");
    }
    expect(listEvents(p.db, { project: "p", target: "T1" })).toHaveLength(before);
    expect(getIntent(p.db, p.intent.id)?.status).toBe("pending");
    expect(remoteOrder(p.db, p.intent.id)).toBeNull(); expect(p.notices).toHaveLength(0);
  } finally { p.close(); }
});

test("production convergence CLI fits LIFE3 r2 long history and four P1s into a pooled order", async () => {
  const p = await sizeFixture();
  try {
    expect(() => p.db.exec("UPDATE tasks SET title = 'bad' WHERE id = 'T1'")).toThrow();
    expect(await p.tick()).toMatchObject({ step: "pooled" });
    const order = remoteOrder(p.db, p.intent.id)!;
    expect(Buffer.byteLength(JSON.stringify(order.wire))).toBeLessThanOrEqual(WIRE_MAX_BYTES);
    const inputs = order.wire.inputs.join("\n");
    expect(inputs).toContain("第 1 轮摘要");
    expect(inputs).toContain(fitDigest(p.reports[0]).slice(0, 16));
    expect(inputs).not.toContain(fitDigest(p.reports[0]));
    const fit = listEvents(p.db, { project: "p", target: "T1" }).findLast((e) => e.data.orderId === order.orderId)!.data.fit;
    expect(fit).toMatchObject({ digests: [{ kind: "report", sha256: fitDigest(p.reports[0]) }] });
    console.info("LSIZE1 pooled measurements", JSON.stringify(fit));
    expect(inputs).toContain(p.reports[1]);
    expect(order.wire.findings).toHaveLength(4);
    expect(order.wire.findings.map((f) => f.probe)).toEqual(findings.map((f) => f.probe));
    expect(getIntent(p.db, p.intent.id)?.status).toBe("submitted");
    expect(p.notices).toHaveLength(0);
  } finally { p.close(); }
});

test("unfittable convergence rolls back its offer then records one reason and notifies PM once over three ticks", async () => {
  const p = await sizeFixture(900);
  try {
    // Prepare materials once before observing the offer transaction's rollback.
    const failure = await p.manager("ledger", "scheduler-convergence", p.intent.id, "--max-workers", "0");
    expect(failure).toMatchObject({ ok: false, code: "too_large", current: { limit: WIRE_MAX_BYTES, stage: "probe" } });
    console.info("LSIZE1 unfittable measurements", JSON.stringify(failure.current));
    expect(String(failure.error)).toContain("字节");
    expect(getIntent(p.db, p.intent.id)?.status).toBe("pending");
    const before = listEvents(p.db, { project: "p", target: "T1" }).length;
    const replay = await p.manager("ledger", "scheduler-convergence", p.intent.id, "--max-workers", "0");
    expect(replay).toMatchObject({ ok: false, code: "too_large" });
    expect(listEvents(p.db, { project: "p", target: "T1" })).toHaveLength(before);
    for (let i = 0; i < 3; i++) expect(await p.tick()).toMatchObject({ step: "held" });
    const events = listEvents(p.db, { project: "p", target: "T1" });
    expect(events.filter((e) => e.data.op === "plan_rejected" && e.data.code === "too_large")).toHaveLength(1);
    expect(events.filter((e) => e.data.op === "fix_strategy")).toHaveLength(0);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]).toContain("specRev 1");
    expect(remoteOrder(p.db, p.intent.id)).toBeNull();
    expect(getIntent(p.db, p.intent.id)?.status).toBe("pending");
    writeFileSync(p.f.task().spec!, readFileSync(p.f.task().spec!, "utf8") + "Changed bytes, same specification revision and round.\n");
    await p.tick();
    expect(listEvents(p.db, { project: "p", target: "T1" }).filter((e) => e.data.code === "too_large")).toHaveLength(1);
    expect(p.notices).toHaveLength(1);
  } finally { p.close(); }
});

test("a failed PM notification uses the existing unsent retry queue without duplicating the event", async () => {
  const p = await sizeFixture(900);
  try {
    let attempts = 0;
    p.card.deps.notifyPm = async (_task, text) => {
      if (++attempts === 1) throw new Error("isolated PM port offline");
      p.notices.push(text);
    };
    for (let i = 0; i < 3; i++) await p.tick();
    expect(attempts).toBe(2); expect(p.notices).toHaveLength(1);
    expect(listEvents(p.db, { project: "p", target: "T1" }).filter((e) => e.data.code === "too_large")).toHaveLength(1);
  } finally { p.close(); }
});
