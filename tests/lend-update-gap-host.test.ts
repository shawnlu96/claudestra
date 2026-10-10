/**
 * UPDW production ports (src/lib/lend-update-gap-host.ts) and the launcher ↔ tick race across two real processes on one
 * temporary journal: the CFG updateGap read for the project owning this checkout (missing project / reader / unknown key all
 * observe; the real reader's on / observe / off reach a real tick), the reached probe (release version, beta ancestry in a scratch git repo), the update completion record (real
 * update-inflight marker files judged by updateVerdict against a scratch git repo), the no-journal launcher
 * path, and a launcher flip landing between the tick's read and its close never being undone.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMeta, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { gapPolicyPort, launcherBeginGapUpdate, launcherGapWaiting, launcherUpdateGate, reachedTarget, updateState } from "../src/lib/lend-update-gap-host.js";
import { gapTick, launcherGapStep, readGap, type GapPort, type UpdateTarget } from "../src/lib/lend-update-gap.js";
import { cfgReaderPath } from "../src/lib/recovery-materials-wiring.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { testChildEnv } from "./test-env.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const T: UpdateTarget = { channel: "release", ref: "9.9.9", label: "v9.9.9" };

function setup(reader: string | null) {
  const dir = tmp("gap-host-"), repo = join(dir, "repo");
  mkdirSync(repo);
  const projectsPath = join(dir, "projects.json");
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "cstra", name: "c", dirs: [repo] }, { id: "other", name: "o", dirs: [join(dir, "x")] }] }));
  const at = join(dir, "reader.ts");
  if (reader !== null) writeFileSync(at, reader);
  return { dir, repo, projectsPath, reader: at };
}

/** The real recovery-policy.json (tests/preload.ts points the state dir at a temp dir, so this never touches the host's). */
function writePolicy(projects: Record<string, unknown>): void {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects }));
}

describe("gapPolicyPort: CFG updateGap for the project owning REPO_ROOT", () => {
  const answering = (body: string) => `export function recoveryPolicy(project, mechanism) { ${body} }`;

  test("reads the owning project's configured mode with key updateGap", async () => {
    const s = setup(answering(`return project === "cstra" && mechanism === "updateGap" ? { mode: "on", source: "config" } : { mode: "off", source: "config" };`));
    expect(await gapPolicyPort({ projectsPath: s.projectsPath, repoRoot: s.repo, reader: s.reader })()).toEqual({ mode: "on" });
    expect(await gapPolicyPort({ projectsPath: s.projectsPath, repoRoot: join(s.repo, "sub"), reader: s.reader })()).toEqual({ mode: "on" });
  });

  test("no owning project / reader missing / no export / throws / unknown key (source error) / bad value → observe with a diagnostic", async () => {
    const cases: [string, string | null, string | undefined][] = [
      ["no project", answering(`return { mode: "on" };`), "/elsewhere"],
      ["missing reader", null, undefined],
      ["no export", "export const x = 1;", undefined],
      ["throws", answering(`throw new Error("boom");`), undefined],
      ["unknown key", answering(`return { mode: "off", source: "error", diagnostic: "未知恢复键 updateGap" };`), undefined],
      ["bad value", answering(`return { mode: "yes" };`), undefined],
    ];
    for (const [why, reader, root] of cases) {
      const s = setup(reader);
      const p = await gapPolicyPort({ projectsPath: s.projectsPath, repoRoot: root ?? s.repo, reader: s.reader })();
      expect([why, p.mode, !!p.diag]).toEqual([why, "observe", true]);
    }
  });

  // updateGap is registered on main by UGCFG (PM ruling UPDW; src/lib/recovery-policy.ts RECOVERY_KEYS) and this card only
  // reads that one key through the real reader: a checkout without the registration fails here instead of silently observing.
  test("the real CFG reader: recovery-policy.json on / observe / off for the owning project reach the gap; absent = observe, no diagnostic", async () => {
    const s = setup(null);
    const read = () => gapPolicyPort({ projectsPath: s.projectsPath, repoRoot: s.repo, reader: cfgReaderPath() })();
    rmSync(RECOVERY_POLICY_PATH, { force: true });
    expect(await read()).toEqual({ mode: "observe" }); // absent = observe, no diagnostic
    for (const mode of ["on", "off", "observe"] as const) {
      writePolicy({ cstra: { mode: "off", keys: { updateGap: mode } }, other: { mode: "on" } });
      expect(await read()).toEqual({ mode });
    }
    rmSync(RECOVERY_POLICY_PATH, { force: true });
  });

  test("the real CFG chain drives the tick: off opens nothing, observe records the plan only, on opens the gap and holds intake", async () => {
    const s = setup(null);
    const policy = gapPolicyPort({ projectsPath: s.projectsPath, repoRoot: s.repo, reader: cfgReaderPath() });
    const port: GapPort = { policy, reached: async () => false, updateState: async () => ({ kind: "none" }) };
    const db = openLendJournal(join(s.dir, "journal.sqlite"));
    recordAsked(db, { orderId: "o1", peer: "p", fp: null, family: "codex", preview: {} }, 1);
    db.query("UPDATE lend_orders SET state = 'claimed' WHERE orderId = 'o1'").run();
    const now = Date.now(), lines: string[] = [], log = (m: string) => lines.push(m);
    launcherGapStep(db, T, ["w"], now);
    writePolicy({ cstra: { keys: { updateGap: "off" } } });
    expect(await gapTick(db, port, now, log)).toEqual({ held: false, line: null });
    expect([readGap(db), !!getMeta(db, "updateGap:observed"), lines]).toEqual([null, false, []]);
    writePolicy({ cstra: { keys: { updateGap: "observe" } } });
    const v = await gapTick(db, port, now, log);
    expect([v.held, readGap(db), !!getMeta(db, "updateGap:observed")]).toEqual([false, null, true]);
    expect(lines).toEqual([expect.stringContaining("observe")]);
    expect(v.line).not.toContain("未知恢复键"); // a plain read of the configured value carries no diagnostic
    writePolicy({ cstra: { keys: { updateGap: "on" } } });
    expect((await gapTick(db, port, now, log)).held).toBe(true);
    expect(readGap(db)).toMatchObject({ phase: "draining", target: T });
    db.close();
    rmSync(RECOVERY_POLICY_PATH, { force: true });
  });
});

describe("reachedTarget / updateState", () => {
  test("release compares versions; beta checks ancestry in a real git repo; unreadable = null", async () => {
    expect(await reachedTarget(T, "/", async () => "9.9.9")).toBe(true);
    expect(await reachedTarget(T, "/", async () => "9.9.8")).toBe(false);
    expect(await reachedTarget(T, "/", async () => { throw new Error("x"); })).toBeNull();
    const repo = tmp("gap-git-");
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { env: testChildEnv() });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "a");
    const a = git("rev-parse", "HEAD").stdout.toString().trim();
    git("commit", "-q", "--allow-empty", "-m", "b");
    const b = git("rev-parse", "HEAD").stdout.toString().trim();
    git("checkout", "-q", a);
    expect(await reachedTarget({ channel: "beta", ref: a, label: "a" }, repo)).toBe(true);
    expect(await reachedTarget({ channel: "beta", ref: b, label: "b" }, repo)).toBe(false);
    expect(await reachedTarget({ channel: "beta", ref: "f".repeat(40), label: "?" }, repo)).toBeNull();
  });

  test("update.lock live = running; the marker is judged like manager update's resume; only a finished / spent one is none", async () => {
    const d = tmp("gap-state-"), marker = join(d, "m.json"), abandoned = join(d, "ab.json"), lock = join(d, "update.lock");
    const repo = join(d, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { env: testChildEnv() });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "a");
    const from = git("rev-parse", "HEAD").stdout.toString().trim();
    git("commit", "-q", "--allow-empty", "-m", "b");
    const target = git("rev-parse", "HEAD").stdout.toString().trim();
    const now = Date.parse("2026-10-05T12:00:00Z"), reloadAt = "2026-10-05T11:50:00.000Z";
    let starts: Record<string, number | null | "unloaded"> = { bridge: now - 60_000, launcher: now - 60_000 };
    const st = (o: { repo?: string } = {}) => updateState(T, { marker, abandoned, lock, repo: o.repo ?? repo, now: () => now, alive: (pid) => pid === process.pid, daemonStarts: async () => starts });
    const base = { pid: 99999999, channel: "release", target, targetLabel: "v9.9.9", fromHead: from, startedAt: "2026-10-05T11:40:00.000Z" };
    const mark = (m: Record<string, unknown>) => writeFileSync(marker, JSON.stringify({ ...base, ...m }));

    expect(await st()).toEqual({ kind: "none" });
    writeFileSync(lock, String(process.pid));
    expect(await st()).toEqual({ kind: "running" });
    writeFileSync(lock, "99999999"); // dead holder
    mark({ step: "built" });
    expect(await st()).toEqual({ kind: "unfinished", step: "built" }); // HEAD at target, tail owed
    mark({ step: "reloading", reloadAt });
    starts = { bridge: now - 60_000, launcher: Date.parse(reloadAt) - 3_600_000 }; // launcher not restarted since the reload
    expect(await st()).toEqual({ kind: "unfinished", step: "reloading" });
    starts = { bridge: now - 60_000, launcher: now - 60_000 }; // every daemon restarted after reloadAt = done (launcher bootout killed update)
    expect(await st()).toEqual({ kind: "none" });
    mark({ step: "checkout", pid: process.pid, startedAt: new Date(now - 60_000).toISOString() });
    expect(await st()).toEqual({ kind: "running" });
    git("checkout", "-q", from);
    mark({ step: "installed" });
    expect(await st()).toEqual({ kind: "none" }); // rolled back / never switched: the old code runs, nothing owed
    git("commit", "-q", "--allow-empty", "-m", "elsewhere");
    expect((await st()).kind).toBe("abandoned"); // HEAD moved elsewhere: cannot be finished
    expect((await st({ repo: join(d, "nowhere") })).kind).toBe("unknown");
    writeFileSync(marker, "{torn");
    expect((await st()).kind).toBe("unknown");
    rmSync(marker);
    writeFileSync(abandoned, JSON.stringify({ pid: 1, target, targetLabel: "v1.0.0", fromHead: from, step: "reloading", abandonReason: "x" }));
    expect(await st()).toEqual({ kind: "none" }); // an older, unrelated target
    writeFileSync(abandoned, JSON.stringify({ pid: 1, target, targetLabel: "v9.9.9", fromHead: from, step: "reloading", abandonReason: "补过 reload 仍没起来" }));
    expect(await st()).toEqual({ kind: "abandoned", why: "补过 reload 仍没起来" });
  });
});

describe("launcher wiring", () => {
  test("no lend journal: exactly the old rule (go only when nothing is busy), nothing created", async () => {
    const path = join(tmp("gap-nojournal-"), "journal.sqlite");
    expect(await launcherUpdateGate(T, ["a"], 1, path)).toEqual({ go: false, why: "在忙: a" });
    expect(await launcherUpdateGate(T, [], 1, path)).toEqual({ go: true });
    expect(await launcherBeginGapUpdate(T, 1, path)).toBe(true);
    expect(await launcherGapWaiting(path)).toBe(false);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

const CHILD = (journal: string, src: string) => `
import { openLendJournal } from ${JSON.stringify(join(src, "lib/lend-journal.ts"))};
import { launcherBeginUpdate } from ${JSON.stringify(join(src, "lib/lend-update-gap.ts"))};
const db = openLendJournal(${JSON.stringify(journal)});
console.log(JSON.stringify(launcherBeginUpdate(db, ${JSON.stringify(T)}, Date.now())));
db.close();
`;

/** The launcher's begin, in its own process. */
async function launcherProcess(journal: string): Promise<{ go: boolean; flipped: boolean }> {
  const script = join(tmp("gap-child-"), "child.ts");
  writeFileSync(script, CHILD(journal, join(import.meta.dir, "..", "src")));
  const p = Bun.spawn([process.execPath, script], { env: testChildEnv({ CLAUDESTRA_STATE_DIR: tmp("gap-child-state-") }), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(err);
  return JSON.parse(out.trim().split("\n").pop()!);
}

/** A journal whose gap is ready (drained) with a fresh want. */
function readyJournal(): string {
  const path = join(tmp("gap-race-"), "journal.sqlite");
  const db = openLendJournal(path);
  recordAsked(db, { orderId: "o1", peer: "p", fp: null, family: "codex", preview: {} }, 1);
  db.query("UPDATE lend_orders SET state = 'claimed' WHERE orderId = 'o1'").run();
  launcherGapStep(db, T, ["w"], Date.now());
  db.close();
  return path;
}

describe("two processes: launcher flip vs tick close", () => {
  test("the launcher flips to updating while the tick is between its read and its close: the close is refused, the update stands", async () => {
    const path = readyJournal();
    const db = openLendJournal(path);
    const now = Date.now(), noop = () => {};
    const on: GapPort = { policy: async () => ({ mode: "on" }), reached: async () => false, updateState: async () => ({ kind: "none" }) };
    await gapTick(db, on, now, noop); // opens draining
    db.query("UPDATE lend_orders SET state = 'acked' WHERE orderId = 'o1'").run();
    await gapTick(db, on, now, noop); // drained → ready
    expect(readGap(db)!.phase).toBe("ready");
    let flip: { go: boolean; flipped: boolean } | null = null;
    const racing: GapPort = { ...on, policy: async () => { flip = await launcherProcess(path); return { mode: "off" }; } };
    const v = await gapTick(db, racing, now, noop);
    expect(flip!).toEqual({ go: true, flipped: true });
    expect(v.held).toBe(true);
    expect(readGap(db)!.phase).toBe("updating");
    db.close();
  });

  test("the tick closes first: the launcher then sees no gap and takes the old path (no flip, nothing to undo)", async () => {
    const path = readyJournal();
    const db = openLendJournal(path);
    const now = Date.now(), noop = () => {};
    const on: GapPort = { policy: async () => ({ mode: "on" }), reached: async () => false, updateState: async () => ({ kind: "none" }) };
    await gapTick(db, on, now, noop);
    await gapTick(db, { ...on, policy: async () => ({ mode: "off" }) }, now, noop);
    expect(readGap(db)).toBeNull();
    expect(await launcherProcess(path)).toEqual({ go: true, flipped: false });
    expect(readGap(db)).toBeNull();
    db.close();
  });
});
