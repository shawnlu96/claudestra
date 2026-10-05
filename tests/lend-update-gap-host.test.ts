/**
 * UPDW production ports (src/lib/lend-update-gap-host.ts) and the launcher ↔ tick race across two real processes on one
 * temporary journal: the CFG updateGap read for the project owning this checkout (missing project / reader / unknown key all
 * observe), the reached probe (release version, beta ancestry in a scratch git repo), update liveness, the no-journal launcher
 * path, and a launcher flip landing between the tick's read and its close never being undone.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { gapPolicyPort, launcherBeginGapUpdate, launcherGapWaiting, launcherUpdateGate, reachedTarget, updateLive } from "../src/lib/lend-update-gap-host.js";
import { gapTick, launcherGapStep, readGap, type GapPort, type UpdateTarget } from "../src/lib/lend-update-gap.js";
import { cfgReaderPath } from "../src/lib/recovery-materials-wiring.js";
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

  test("the real CFG reader on this tree never answers on for an unconfigured host", async () => {
    const s = setup(null);
    const p = await gapPolicyPort({ projectsPath: s.projectsPath, repoRoot: s.repo, reader: cfgReaderPath() })();
    expect(p.mode).toBe("observe"); // default observe, or observe-with-diagnostic until UGCFG registers the key
  });
});

describe("reachedTarget / updateLive", () => {
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

  test("marker present or update.lock held by a live pid = live; dead pid / nothing = not live", () => {
    const d = tmp("gap-live-"), marker = join(d, "m.json"), lock = join(d, "update.lock");
    expect(updateLive(marker, lock)).toBe(false);
    writeFileSync(lock, String(process.pid));
    expect(updateLive(marker, lock)).toBe(true);
    writeFileSync(lock, "99999999");
    expect(updateLive(marker, lock)).toBe(false);
    writeFileSync(marker, "{}");
    expect(updateLive(marker, lock)).toBe(true);
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
    const on: GapPort = { policy: async () => ({ mode: "on" }), reached: async () => false, updateLive: () => false };
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
    const on: GapPort = { policy: async () => ({ mode: "on" }), reached: async () => false, updateLive: () => false };
    await gapTick(db, on, now, noop);
    await gapTick(db, { ...on, policy: async () => ({ mode: "off" }) }, now, noop);
    expect(readGap(db)).toBeNull();
    expect(await launcherProcess(path)).toEqual({ go: true, flipped: false });
    expect(readGap(db)).toBeNull();
    db.close();
  });
});
