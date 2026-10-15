/** SWAPFIX1 9a: another old local author's clean tree at the target is taken over as it is; anything less stays tree-refused. */
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixTreePath, openFixWorktree, type FixTreeTarget, type ForeignTreePort } from "../src/lib/fix-strategy-worktree.js";
import { git, type Git } from "../src/lib/scheduler-review-worktree.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { setSelfHealPolicy } from "../src/lib/fix-swap-halfbuilt-sample.js";
import { convergenceProbe, fourRoundFix } from "./fix-strategy-helpers.js";
import { peerAuthor, remoteProbe } from "./fix-strategy-remote-helpers.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
setDefaultTimeout(60_000);
const realGit: Git = (args) => git(args);

/** origin + main tree; the card branch pushed at the 4th fix head; the old author's linked tree sits at the canonical target. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "convfor-"))), origin = join(root, "origin.git"), main = join(root, "main");
  mkdirSync(main); sh(root, "init", "-q", "--bare", origin);
  sh(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "a.txt"), "base\n"); sh(main, "add", "a.txt"); sh(main, "commit", "-qm", "base");
  sh(main, "remote", "add", "origin", origin); sh(main, "push", "-q", "origin", "main");
  sh(main, "checkout", "-qb", "feat/T1");
  const heads = [1, 2, 3, 4].map((n) => { writeFileSync(join(main, "a.txt"), `fix ${n}\n`); sh(main, "commit", "-qam", `fix ${n}`); return sh(main, "rev-parse", "HEAD"); });
  sh(main, "push", "-q", "origin", "feat/T1"); sh(main, "checkout", "-q", "main"); sh(main, "branch", "-qD", "feat/T1");
  sh(main, "fetch", "-q", "origin");
  const wt = join(root, "worktrees"); mkdirSync(wt);
  const dir = fixTreePath(wt, "T1")!;
  sh(main, "worktree", "add", "-q", "-b", "feat/T1", dir, heads[3]); // the old author's tree: no saved start of this intent
  return { root, main, head: heads[3], heads, wt, dir, close: () => rmSync(root, { recursive: true, force: true }) };
}

function port(mode: RecoveryMode, live: string | null = null) {
  const samples: string[] = [];
  const p: ForeignTreePort = { mode: () => mode, live: () => live, sample: (m, d) => void samples.push(`${m}:${d}`) };
  return { p, samples };
}
const target = (r: ReturnType<typeof repo>, foreign?: ForeignTreePort): FixTreeTarget => ({ taskId: "T1", branch: "feat/T1", head: r.head, root: r.wt, foreign });

test("a clean old author linked tree on the card branch at the reviewed head with no live session is taken over as it is", async () => {
  const r = repo();
  try {
    const { p, samples } = port("on");
    const before = [sh(r.dir, "rev-parse", "HEAD"), sh(r.dir, "status", "--porcelain=v2", "--branch", "--untracked-files=all")];
    expect(await openFixWorktree(realGit, r.main, target(r, p), r.dir)).toEqual({ dir: r.dir }); // [验收线 2]
    expect([sh(r.dir, "rev-parse", "HEAD"), sh(r.dir, "status", "--porcelain=v2", "--branch", "--untracked-files=all")]).toEqual(before);
    expect(samples).toEqual([`on:${r.dir}`]);
  } finally { r.close(); }
});

test("uncommitted edits, another HEAD, the branch on another commit, a live session or a non-linked tree stay tree-refused", async () => {
  for (const broken of ["dirty", "untracked", "head", "detached", "live", "clone"] as const) {
    const r = repo();
    try {
      if (broken === "dirty") writeFileSync(join(r.dir, "a.txt"), "wip\n");
      if (broken === "untracked") writeFileSync(join(r.dir, "new.txt"), "wip\n");
      if (broken === "head") { writeFileSync(join(r.dir, "a.txt"), "more\n"); sh(r.dir, "commit", "-qam", "unpushed"); } // the local branch moves too
      if (broken === "detached") sh(r.dir, "checkout", "-q", "--detach", r.heads[2]);
      if (broken === "clone") { sh(r.main, "worktree", "remove", "--force", r.dir); sh(r.root, "clone", "-q", "-b", "feat/T1", join(r.root, "origin.git"), r.dir); }
      const { p, samples } = port("on", broken === "live" ? "agent-old-author" : null);
      const out = await openFixWorktree(realGit, r.main, target(r, p), r.dir);
      expect(out).toMatchObject({ manual: expect.stringContaining("已被占用") }); // [验收线 2]
      expect(samples).toEqual([]);
      if (broken === "dirty") expect(sh(r.dir, "status", "--porcelain")).toContain("a.txt");
    } finally { r.close(); }
  }
});

test("off and no port keep the old refusal; observe records the would-be takeover and still refuses", async () => {
  for (const mode of ["off", "observe", "none"] as const) {
    const r = repo();
    try {
      const { p, samples } = port(mode === "none" ? "on" : mode);
      const out = await openFixWorktree(realGit, r.main, target(r, mode === "none" ? undefined : p), r.dir);
      expect(out).toMatchObject({ manual: expect.stringContaining("已被占用") }); // [验收线 4]
      expect(samples).toEqual(mode === "observe" ? [`observe:${r.dir}`] : []);
    } finally { r.close(); }
  }
});

test("the family-swap replacement author is created in the old author's tree under fixLocalSwap=on and sampled once", async () => {
  const r = repo(), f = await fourRoundFix(r.heads);
  try {
    const p = remoteProbe(f); peerAuthor(f, "claude");
    setSelfHealPolicy(f.db, () => ({ mode: "on", manualAfterMs: null, source: "config" }));
    p.deps.worktreeRoot = r.wt;
    p.context.source = r.main;
    p.deps.authorTree = (source, t, recorded) => openFixWorktree(realGit, source, t, recorded);
    const intent = p.plan();
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" }); // [验收线 2]
    expect(getIntent(f.db, intent.id)?.status).toBe("done");
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:creating`)?.data.dir).toBe(r.dir);
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`)).toBeNull();
    const samples = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fix_swap_selfheal");
    expect(samples.map((e) => e.data)).toMatchObject([{ mechanism: "fixLocalSwap", action: "tree-adopt", head: r.head, dir: r.dir }]);
  } finally { f.close(); r.close(); }
});

// SWAPFIX1 r1 review (tree-final-proof): the takeover's permission is read again after ready()'s origin await, before the hand-over.
test("a live session or the switch turning off during the final origin read keeps the old tree refused", async () => {
  for (const race of ["live", "off", "observe"] as const) {
    const r = repo();
    try {
      let reads = 0, live: string | null = null, mode: RecoveryMode = "on";
      const samples: string[] = [];
      const p: ForeignTreePort = { mode: () => mode, live: () => live, sample: (m, d) => void samples.push(`${m}:${d}`) };
      const origin = async (_cwd: string, _branch: string) => {
        if (++reads === 2) { if (race === "live") live = "agent-another-author"; else mode = race; } // ready()'s read, after the proof
        return { ok: true as const, head: r.head };
      };
      expect(await openFixWorktree(realGit, r.main, target(r, p), r.dir, origin)).toMatchObject({ manual: expect.any(String) }); // [验收线 2]
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(samples.filter((s) => s.startsWith("on:"))).toEqual([]);
    } finally { r.close(); }
  }
});

// SWAPFIX1 r1 review (local-tree-port): the local family swap (fixSwapStep, no peer) gets the same port; off is the old refusal.
async function localSwap(mode: "on" | "off") {
  const r = repo(), f = await fourRoundFix(r.heads), p = convergenceProbe(f);
  setSelfHealPolicy(f.db, () => ({ mode, manualAfterMs: null, source: "config" }));
  p.deps.worktreeRoot = r.wt;
  p.edit((reg) => { for (const a of Object.values(reg.agents) as { cwd?: string }[]) a.cwd = r.main; });
  f.db.run("UPDATE tasks SET branch = 'feat/T1' WHERE id = 'T1'"); // the card's formal branch, as a pushed fix card has // the old author works in the main checkout
  p.deps.authorTree = (source, t, recorded) => openFixWorktree(realGit, source, t, recorded, async () => ({ ok: true, head: r.head }));
  return { r, f, p, intent: p.plan() };
}

test("the local family swap takes over a clean old author tree under fixLocalSwap=on", async () => {
  const { r, f, p, intent } = await localSwap("on");
  try {
    let out: Awaited<ReturnType<typeof fixSwapStep>> = { ok: true, step: "waiting", detail: "" };
    for (let n = 0; n < 4 && out.step !== "session"; n++) out = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(out).toMatchObject({ step: "session" }); // [验收线 2]
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:creating`)?.data.dir).toBe(r.dir);
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`)).toBeNull();
    const samples = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fix_swap_selfheal");
    expect(samples.map((e) => e.data)).toMatchObject([{ mechanism: "fixLocalSwap", action: "tree-adopt", dir: r.dir }]);
  } finally { f.close(); r.close(); }
});

test("the local family swap under fixLocalSwap=off still refuses the old author tree word for word", async () => {
  const { r, f, p, intent } = await localSwap("off");
  try {
    for (let n = 0; n < 4 && getIntent(f.db, intent.id)?.status !== "unknown"; n++) await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(getIntent(f.db, intent.id)).toMatchObject({ status: "unknown", receipt: expect.stringContaining("已被占用") }); // [验收线 4]
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`)).not.toBeNull();
    expect(p.effects.some((s) => s.startsWith("create:"))).toBe(false);
    expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "fix_swap_selfheal" || e.data.op === "recovery_observe")).toBe(false);
  } finally { f.close(); r.close(); }
});

// SWAPFIX1 r2 review: the takeover is re-proved at the final bind (tree-final-proof) and on a later tick that skips the tree open
// because the create was already claimed (tree-adoption-resume); the takeover is journaled on the intent for that.
test("the switch turning off while the local swap's create runs leaves the new session unbound", async () => {
  const { r, f, p, intent } = await localSwap("on");
  try {
    const manager = p.deps.manager;
    p.deps.manager = async (...args) => {
      const out = await manager(...args);
      if (args[0] === "create") setSelfHealPolicy(f.db, () => ({ mode: "off", manualAfterMs: null, source: "config" }));
      return out;
    };
    let out: Awaited<ReturnType<typeof fixSwapStep>> = { ok: true, step: "waiting", detail: "" };
    for (let n = 0; n < 4 && !p.effects.some((e) => e.startsWith("create:")); n++) out = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(out).toMatchObject({ step: "waiting", detail: expect.stringContaining("fixLocalSwap 已不在 on") }); // [验收线 4]
    expect(getIntent(f.db, intent.id)?.status).toBe("submitted");
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:replacement`)).toBeNull();
  } finally { f.close(); r.close(); }
});

test("a later tick that only confirms the claimed create re-proves the journaled takeover before binding", async () => {
  for (const late of ["live", "off", "still"] as const) {
    const { r, f, p, intent } = await localSwap("on");
    try {
      const manager = p.deps.manager;
      p.deps.manager = async (...args) => { // the first create leaves only the placeholder, no session id yet
        const out = await manager(...args);
        if (args[0] === "create") p.edit((reg) => { delete reg.agents[args[1]].sessionId; });
        return out;
      };
      for (let n = 0; n < 4 && !p.effects.some((e) => e.startsWith("create:")); n++) await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      const name = p.effects.find((e) => e.startsWith("create:"))!.slice("create:".length);
      expect(getEventByDedup(f.db, `scheduler:${intent.id}:tree-adopt`)?.data.dir).toBe(r.dir);
      p.edit((reg) => {
        reg.agents[name].sessionId = `session:${name}`; // the create is confirmed on the next tick
        if (late === "live") reg.agents["agent-another-author"] = { cwd: r.dir, sessionId: "s-other", status: "active" };
      });
      if (late === "off") setSelfHealPolicy(f.db, () => ({ mode: "off", manualAfterMs: null, source: "config" }));
      const out = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      if (late === "still") {
        expect(out).toMatchObject({ step: "session" }); // [验收线 2]
        expect(getIntent(f.db, intent.id)?.status).toBe("done");
      } else {
        expect(out).toMatchObject({ step: "waiting", detail: expect.stringContaining(late === "live" ? "agent-another-author" : "fixLocalSwap 已不在 on") }); // [验收线 2]
        expect(getIntent(f.db, intent.id)?.status).toBe("submitted");
        expect(getEventByDedup(f.db, `scheduler:${intent.id}:replacement`)).toBeNull();
      }
    } finally { f.close(); r.close(); }
  }
});
